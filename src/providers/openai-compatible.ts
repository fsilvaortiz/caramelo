import * as vscode from 'vscode';
import type { Capability, LLMMessage, LLMOptions, LLMProvider } from './types.js';
import { parseSSEEvents, parseSSEStream } from './sse.js';
import { AuthError, NetworkError, ProviderError, isAbortError } from '../errors.js';
import { getSseTimeoutMs } from '../utils/settings.js';
import { sanitizeHeaderName, sanitizeHeaderPrefix } from '../utils/auth.js';
import type {
  AgentEvent,
  AgentMessage,
  ProviderToolCallRequest,
  Tool,
} from '../agent/types.js';

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKeyId: string | null;
  private readonly secrets: vscode.SecretStorage;
  private readonly authHeader: string;
  private readonly authPrefix: string;
  private apiKey: string | null = null;
  private abortController: AbortController | null = null;

  constructor(
    config: { id: string; name: string; endpoint: string; model: string; apiKeyId?: string; authHeader?: string; authPrefix?: string },
    secrets: vscode.SecretStorage
  ) {
    this.id = config.id;
    this.displayName = config.name;
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.model = config.model;
    this.apiKeyId = config.apiKeyId ?? null;
    this.authHeader = sanitizeHeaderName(config.authHeader, 'Authorization');
    this.authPrefix = sanitizeHeaderPrefix(config.authPrefix, 'Bearer');
    this.secrets = secrets;
  }

  async authenticate(): Promise<boolean> {
    if (!this.apiKeyId) return true;
    const key = await this.secrets.get(this.apiKeyId);
    if (!key) {
      const input = await vscode.window.showInputBox({
        prompt: `Enter API key for ${this.displayName}`,
        password: true,
      });
      if (!input) return false;
      await this.secrets.store(this.apiKeyId, input);
      this.apiKey = input;
    } else {
      this.apiKey = key;
    }
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Hitting /models only proves the endpoint is reachable; it doesn't
      // prove that the configured model is loaded (Ollama returns 200 even
      // for models that aren't pulled) or that this key can call /chat
      // through the corporate proxy. Run a tiny streaming generation so the
      // health check matches what real chats will do.
      for await (const _chunk of this.chat(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 1, signal: AbortSignal.timeout(15_000) },
      )) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async *chat(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<string> {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const signal = options?.signal
      ? anySignal(options.signal, controller.signal)
      : controller.signal;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers[this.authHeader] = this.authPrefix ? `${this.authPrefix} ${this.apiKey}` : this.apiKey;

    const body = JSON.stringify({
      model: options?.model ?? this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
    });

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new NetworkError(`${this.displayName}: request failed`, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = `${this.displayName}: ${res.status} ${res.statusText} - ${text}`;
      if (res.status === 401 || res.status === 403) throw new AuthError(message);
      throw new ProviderError(message, res.status);
    }

    if (!res.body) throw new ProviderError(`${this.displayName}: No response body`);

    const reader = res.body.getReader();
    try {
      yield* parseSSEStream(
        reader,
        (json) => {
          const obj = json as Record<string, unknown>;
          const choices = obj?.choices as Array<{ delta?: { content?: string } }> | undefined;
          return choices?.[0]?.delta?.content ?? null;
        },
        { timeoutMs: getSseTimeoutMs() },
      );
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  capabilities(): Set<Capability> {
    const caps = new Set<Capability>(['streaming']);
    // tool-calling advertises when either (a) an API key is loaded, or
    // (b) no key is needed (local endpoints like Ollama/LM Studio). The
    // actual endpoint may still refuse tool_calls; an error then
    // surfaces via the runtime's fallback-notification path.
    if (this.apiKey !== null || this.apiKeyId === null) {
      caps.add('tool-calling');
    }
    return caps;
  }

  async *chatWithTools(req: ProviderToolCallRequest): AsyncIterable<AgentEvent> {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const signal = req.signal
      ? anySignal(req.signal, controller.signal)
      : controller.signal;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers[this.authHeader] = this.authPrefix ? `${this.authPrefix} ${this.apiKey}` : this.apiKey;
    }

    const body: Record<string, unknown> = {
      model: req.model ?? this.model,
      messages: buildOpenAIMessages(req.system, req.messages),
      tools: req.tools.map(toolToOpenAI),
      stream: true,
      max_tokens: req.maxTokens ?? 4096,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new NetworkError(`${this.displayName}: request failed`, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = `${this.displayName}: ${res.status} ${res.statusText} - ${text}`;
      if (res.status === 401 || res.status === 403) throw new AuthError(message);
      throw new ProviderError(message, res.status);
    }
    if (!res.body) throw new ProviderError(`${this.displayName}: No response body`);

    // Accumulate partial tool calls by delta `index`. First chunk for each
    // index carries id + function.name; subsequent chunks append to
    // function.arguments. Flushed when finish_reason arrives OR when the
    // stream ends (some endpoints don't send finish_reason reliably).
    //
    // Discriminated shape: a tool call is "partial" until we've seen both
    // id and name. `flushToolCalls` skips partials instead of emitting
    // corrupted events — and the type system makes that skip explicit,
    // since `complete` requires both fields as strings.
    type PartialToolCall =
      | { kind: 'partial'; id?: string; name?: string; args: string }
      | { kind: 'complete'; id: string; name: string; args: string };

    const toolCalls = new Map<number, PartialToolCall>();
    let flushed = false;
    const displayName = this.displayName;

    const promoteIfReady = (tc: PartialToolCall): PartialToolCall => {
      if (tc.kind === 'complete') return tc;
      if (tc.id && tc.name) return { kind: 'complete', id: tc.id, name: tc.name, args: tc.args };
      return tc;
    };

    function* flushToolCalls(): Generator<AgentEvent> {
      if (flushed) return;
      flushed = true;
      const ordered = Array.from(toolCalls.entries()).sort((a, b) => a[0] - b[0]);
      for (const [idx, tc] of ordered) {
        if (tc.kind !== 'complete') {
          // Partial call at stream end — the model stopped mid-tool-use
          // or the server closed the stream. Better to surface than
          // silently drop so users see why nothing happened.
          yield {
            kind: 'done',
            reason: 'error',
            error:
              `${displayName}: tool_call[${idx}] is incomplete (missing ` +
              `${!tc.id ? 'id' : 'name'}) — stream likely truncated.`,
          };
          return;
        }
        let args: Record<string, unknown>;
        if (tc.args.length === 0) {
          // OpenAI normally sends "{}" but some endpoints send "" for
          // tools with no required fields. Empty string → no arguments.
          args = {};
        } else {
          try {
            const parsed = JSON.parse(tc.args);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            } else {
              yield {
                kind: 'done',
                reason: 'error',
                error: `${displayName}: tool_call[${idx}] arguments must be a JSON object (got ${typeof parsed})`,
              };
              return;
            }
          } catch (err) {
            yield {
              kind: 'done',
              reason: 'error',
              error:
                `${displayName}: tool_call[${idx}] "${tc.name}" had malformed arguments JSON: ` +
                `${(err as Error).message}. Raw fragment (first 200 B): ${tc.args.slice(0, 200)}`,
            };
            return;
          }
        }
        yield {
          kind: 'tool_call',
          call: { id: tc.id, name: tc.name, arguments: args },
        };
      }
    }

    const reader = res.body.getReader();
    try {
      for await (const event of parseSSEEvents(reader, { timeoutMs: getSseTimeoutMs() })) {
        const obj = event as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
        };
        const choice = obj.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          yield { kind: 'text', delta: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index) ?? { kind: 'partial' as const, args: '' };
            // Work on a mutable copy — `existing` may be `complete`, which
            // is readonly-ish in practice. We rebuild via promoteIfReady.
            const next: PartialToolCall =
              existing.kind === 'complete'
                ? { ...existing, args: existing.args + (tc.function?.arguments ?? '') }
                : {
                    kind: 'partial',
                    id: tc.id ?? existing.id,
                    name: tc.function?.name ?? existing.name,
                    args: existing.args + (tc.function?.arguments ?? ''),
                  };
            toolCalls.set(tc.index, promoteIfReady(next));
          }
        }
        if (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'stop') {
          yield* flushToolCalls();
          return;
        }
      }
      // Stream ended without an explicit finish_reason — flush whatever
      // tool calls we've accumulated. Some providers close the stream
      // after [DONE] without a finish_reason chunk.
      yield* flushToolCalls();
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

function toolToOpenAI(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Translate AgentMessage history into OpenAI's chat.completions format.
 *
 * - system: a top-level system message (prepended to the messages array
 *   since OpenAI takes `system` inline, unlike Anthropic).
 * - assistant with toolCalls: `tool_calls` array where `arguments` is a
 *   JSON STRING (not an object — OpenAI's distinctive choice). `content`
 *   is sent as the empty string when missing; most endpoints accept null
 *   too but "" is the safer common denominator across Ollama/LM Studio/etc.
 * - role:'tool' → { role:'tool', tool_call_id, content }.
 */
function buildOpenAIMessages(
  system: string | undefined,
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (system) out.push({ role: 'system', content: system });
  for (const msg of messages) {
    if (msg.role === 'system') {
      // Multiple system messages allowed but uncommon; pass through.
      out.push({ role: 'system', content: msg.content });
      continue;
    }
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
      continue;
    }
    // assistant
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      });
    } else {
      out.push({ role: 'assistant', content: msg.content });
    }
  }
  return out;
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
