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

export class ClaudeProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKeyId: string;
  private readonly secrets: vscode.SecretStorage;
  private readonly authHeader: string;
  private readonly authPrefix: string;
  private apiKey: string | null = null;
  private abortController: AbortController | null = null;

  constructor(
    config: { id: string; name: string; endpoint: string; model: string; apiKeyId: string; authHeader?: string; authPrefix?: string },
    secrets: vscode.SecretStorage
  ) {
    this.id = config.id;
    this.displayName = config.name;
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.model = config.model;
    this.apiKeyId = config.apiKeyId;
    this.authHeader = sanitizeHeaderName(config.authHeader, 'x-api-key');
    this.authPrefix = sanitizeHeaderPrefix(config.authPrefix, '');
    this.secrets = secrets;
  }

  async authenticate(): Promise<boolean> {
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
    if (!this.apiKey) return false;
    try {
      // Exercise the same code path as chat() so the result reflects what a
      // real generation will see: model exists, credentials accepted by the
      // streaming endpoint, custom auth headers honoured by the proxy, etc.
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
    if (!this.apiKey) throw new AuthError(`${this.displayName}: Not authenticated`);

    // Abort any previous in-flight request before starting a new one.
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const signal = options?.signal
      ? anySignal(options.signal, controller.signal)
      : controller.signal;

    const systemMessage = messages.find((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
      messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (systemMessage) body.system = systemMessage.content;
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [this.authHeader]: this.authPrefix ? `${this.authPrefix} ${this.apiKey}` : this.apiKey!,
          'anthropic-version': '2023-06-01',
        },
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

    const reader = res.body.getReader();
    try {
      yield* parseSSEStream(
        reader,
        (json) => {
          const obj = json as Record<string, unknown>;
          if (obj?.type === 'content_block_delta') {
            const delta = obj.delta as Record<string, unknown> | undefined;
            return (delta?.text as string) ?? null;
          }
          return null;
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
    // Tool-calling requires an authenticated session: the /v1/messages call
    // only works with a valid API key. Advertising it while unauthenticated
    // would let the agent loop start and fail mid-turn.
    if (this.apiKey) caps.add('tool-calling');
    return caps;
  }

  /**
   * Tool-calling variant of `chat()`. Streams a normalised AgentEvent stream
   * back to the agent runtime. Translates Anthropic's content-block streaming
   * into the provider-neutral event shape:
   *   content_block_start (type=text)      → no event (buffered)
   *   content_block_delta (text_delta)     → { kind:'text', delta }
   *   content_block_start (type=tool_use)  → capture id+name
   *   content_block_delta (input_json_delta) → accumulate partial_json
   *   content_block_stop  (tool_use block) → { kind:'tool_call', call }
   */
  async *chatWithTools(req: ProviderToolCallRequest): AsyncIterable<AgentEvent> {
    if (!this.apiKey) throw new AuthError(`${this.displayName}: Not authenticated`);

    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const signal = req.signal
      ? anySignal(req.signal, controller.signal)
      : controller.signal;

    const anthropicTools = req.tools.map(toolToAnthropic);
    const anthropicMessages = buildAnthropicMessages(req.messages);

    const body: Record<string, unknown> = {
      model: req.model ?? this.model,
      max_tokens: req.maxTokens ?? 4096,
      stream: true,
      messages: anthropicMessages,
      tools: anthropicTools,
    };
    if (req.system) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [this.authHeader]: this.authPrefix ? `${this.authPrefix} ${this.apiKey}` : this.apiKey!,
          'anthropic-version': '2023-06-01',
        },
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

    const reader = res.body.getReader();
    try {
      // Per-block scratch keyed by index so deltas accumulate to the right slot.
      const blocks = new Map<number, { kind: 'text' | 'tool_use'; id?: string; name?: string; json?: string }>();

      for await (const event of parseSSEEvents(reader, { timeoutMs: getSseTimeoutMs() })) {
        const obj = event as Record<string, unknown>;
        const type = obj?.type;

        if (type === 'content_block_start') {
          const idx = obj.index as number;
          const cb = obj.content_block as Record<string, unknown> | undefined;
          if (cb?.type === 'text') {
            blocks.set(idx, { kind: 'text' });
          } else if (cb?.type === 'tool_use') {
            blocks.set(idx, {
              kind: 'tool_use',
              id: (cb.id as string) ?? '',
              name: (cb.name as string) ?? '',
              json: '',
            });
          }
          continue;
        }

        if (type === 'content_block_delta') {
          const idx = obj.index as number;
          const block = blocks.get(idx);
          const delta = obj.delta as Record<string, unknown> | undefined;
          if (!block || !delta) continue;
          if (block.kind === 'text' && delta.type === 'text_delta') {
            const text = delta.text as string | undefined;
            if (text) yield { kind: 'text', delta: text };
          } else if (block.kind === 'tool_use' && delta.type === 'input_json_delta') {
            block.json = (block.json ?? '') + (delta.partial_json as string ?? '');
          }
          continue;
        }

        if (type === 'content_block_stop') {
          const idx = obj.index as number;
          const block = blocks.get(idx);
          if (block?.kind === 'tool_use') {
            // Tools with no required fields (e.g. list_dir) would accept
            // {} and run with wrong semantics if we silently swallowed a
            // JSON parse error. Surface it as a terminal error so the
            // runtime stops and the user sees it.
            let args: Record<string, unknown>;
            if (!block.json || block.json.length === 0) {
              args = {};
            } else {
              try {
                const parsed = JSON.parse(block.json);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  args = parsed as Record<string, unknown>;
                } else {
                  yield {
                    kind: 'done',
                    reason: 'error',
                    error:
                      `${this.displayName}: tool_use block for "${block.name}" produced non-object input ` +
                      `(got ${typeof parsed}). Cannot dispatch.`,
                  };
                  return;
                }
              } catch (err) {
                yield {
                  kind: 'done',
                  reason: 'error',
                  error:
                    `${this.displayName}: tool_use block for "${block.name}" had malformed input JSON: ` +
                    `${(err as Error).message}. Raw fragment (first 200 B): ${block.json.slice(0, 200)}`,
                };
                return;
              }
            }
            yield {
              kind: 'tool_call',
              call: { id: block.id ?? '', name: block.name ?? '', arguments: args },
            };
          }
          blocks.delete(idx);
          continue;
        }

        if (type === 'message_stop') {
          break;
        }

        if (type === 'error') {
          const err = obj.error as Record<string, unknown> | undefined;
          const msg = err?.message ? String(err.message) : 'unknown provider error';
          yield { kind: 'done', reason: 'error', error: `${this.displayName}: ${msg}` };
          return;
        }
      }
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

/** Convert our Tool (JSON Schema) into Anthropic's tool shape. */
function toolToAnthropic(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

/**
 * Translate the provider-neutral AgentMessage history into Anthropic's
 * content-block format.
 *
 * Invariant: interleaving a role:'tool' message without the matching
 * assistant turn's tool_use block earlier in the array produces an
 * Anthropic 400 "tool_use_id references a tool_use block that does not
 * exist". Consecutive role:'tool' messages MUST be merged into a single
 * user turn whose content is a tool_result array — that's the shape the
 * API accepts.
 *
 * System messages are dropped here (Anthropic takes `system` at the
 * top-level request field; the runtime passes it via request.system).
 */
function buildAnthropicMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];
  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      });
      continue;
    }

    flushToolResults();

    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }

    // assistant
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      out.push({ role: 'assistant', content });
    } else {
      out.push({ role: 'assistant', content: msg.content });
    }
  }
  flushToolResults();
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
