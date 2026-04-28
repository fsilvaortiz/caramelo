import * as vscode from 'vscode';
import type { Capability, LLMMessage, LLMOptions, LLMProvider } from './types.js';
import type {
  AgentEvent,
  AgentMessage,
  ProviderToolCallRequest,
  Tool,
} from '../agent/types.js';
import { AuthError, isAbortError } from '../errors.js';

/**
 * Discriminating type predicates for vscode.lm stream parts. `instanceof`
 * would see two different class identities when tests swap the `vscode`
 * module for a stub — duck-typing on the stable public fields survives
 * that. TextPart has `value: string`; ToolCallPart has `callId`, `name`,
 * `input`.
 */
function isTextPart(p: unknown): p is { value: string } {
  return (
    typeof (p as { value?: unknown })?.value === 'string' &&
    typeof (p as { callId?: unknown })?.callId === 'undefined'
  );
}

function isToolCallPart(p: unknown): p is { callId: string; name: string; input: unknown } {
  return (
    typeof (p as { callId?: unknown })?.callId === 'string' &&
    typeof (p as { name?: unknown })?.name === 'string'
  );
}

/**
 * True when an error arose because the caller's AbortSignal fired (or
 * because the vscode CancellationToken propagated back through `sendRequest`).
 * Different from a generic provider error — the runtime uses this to
 * classify the run as `cancelled` rather than `error`.
 */
function isCancellation(err: unknown, signal: AbortSignal | undefined): boolean {
  if (isAbortError(err)) return true;
  if (signal?.aborted) return true;
  // vscode LanguageModelError carries cause === 'CancellationError' or
  // message-matches in the real extension host; best-effort match.
  const m = err instanceof Error ? err.message : String(err);
  return /cancell?ed|cancellation/i.test(m);
}

export class CopilotProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  private model: vscode.LanguageModelChat | undefined;
  private modelFamily: string;

  constructor(id: string, name: string, family: string) {
    this.id = id;
    this.displayName = name;
    this.modelFamily = family;
  }

  async authenticate(): Promise<boolean> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: this.modelFamily });
    if (models.length > 0) {
      this.model = models[0];
      return true;
    }
    return false;
  }

  async isAvailable(): Promise<boolean> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.length > 0;
  }

  async *chat(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<string> {
    // Re-select model in case family was changed
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: options?.model ?? this.modelFamily,
    });

    if (models.length === 0) {
      throw new Error('No Copilot model available. Is GitHub Copilot installed and active?');
    }

    const model = models[0];

    // vscode.lm only supports User and Assistant roles — no system role
    // Prepend system content as a User message
    const vsMessages: vscode.LanguageModelChatMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        vsMessages.push(vscode.LanguageModelChatMessage.User(`[Instructions]\n${msg.content}`));
      } else if (msg.role === 'user') {
        vsMessages.push(vscode.LanguageModelChatMessage.User(msg.content));
      } else if (msg.role === 'assistant') {
        vsMessages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
      }
    }

    const cts = new vscode.CancellationTokenSource();
    if (options?.signal) {
      options.signal.addEventListener('abort', () => cts.cancel(), { once: true });
    }

    const response = await model.sendRequest(
      vsMessages,
      {
        justification: 'Caramelo uses language models to generate and analyze specifications.',
        modelOptions: {
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
      },
      cts.token
    );

    for await (const chunk of response.text) {
      yield chunk;
    }
  }

  capabilities(): Set<Capability> {
    const caps = new Set<Capability>(['streaming']);
    // We advertise tool-calling once we've selected a model. vscode.lm
    // doesn't expose a per-model capability flag, and modern Copilot
    // families (gpt-4o, gpt-4o-mini, claude-3.5-sonnet, …) all support
    // tools; older gpt-3.5-turbo may not. If the specific model rejects
    // a tool request, the error surfaces via the runtime's fallback-
    // notification path rather than a silent downgrade.
    if (this.model) caps.add('tool-calling');
    return caps;
  }

  async *chatWithTools(req: ProviderToolCallRequest): AsyncIterable<AgentEvent> {
    const family = req.model ?? this.modelFamily;
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
    if (models.length === 0) {
      throw new AuthError(
        `No Copilot model available for family "${family}". Is GitHub Copilot installed and active?`,
      );
    }
    const model = models[0];

    const vsMessages = buildVscodeMessages(req.system, req.messages);
    const vsTools = req.tools.map(toolToVscode);

    // Bridge our AbortSignal onto vscode's CancellationToken API.
    const cts = new vscode.CancellationTokenSource();
    if (req.signal) {
      if (req.signal.aborted) cts.cancel();
      else req.signal.addEventListener('abort', () => cts.cancel(), { once: true });
    }

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(
        vsMessages,
        {
          justification: 'Caramelo agent loop: tool-calling code-editing assistant.',
          tools: vsTools,
          toolMode: vscode.LanguageModelChatToolMode.Auto,
          modelOptions: {
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
        },
        cts.token,
      );
    } catch (err) {
      // Abort/cancellation MUST propagate as a thrown error — the runtime
      // checks `signal.aborted` in its outer catch and classifies as
      // `cancelled`. Emitting `done:error` here would surface a spurious
      // "stream failed" toast on plain Cancel.
      if (isCancellation(err, req.signal)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        kind: 'done',
        reason: 'error',
        error: `${this.displayName}: ${msg}`,
      };
      return;
    }

    try {
      for await (const part of response.stream) {
        if (isTextPart(part)) {
          yield { kind: 'text', delta: part.value };
          continue;
        }
        if (isToolCallPart(part)) {
          // vscode.lm delivers `input` as a fully-parsed object (it does
          // the JSON.parse on our behalf). Still validate the shape —
          // a non-object input would break tool dispatch downstream.
          if (!part.input || typeof part.input !== 'object' || Array.isArray(part.input)) {
            yield {
              kind: 'done',
              reason: 'error',
              error:
                `${this.displayName}: tool_call "${part.name}" input was not an object ` +
                `(got ${Array.isArray(part.input) ? 'array' : typeof part.input}).`,
            };
            return;
          }
          yield {
            kind: 'tool_call',
            call: {
              id: part.callId,
              name: part.name,
              arguments: part.input as Record<string, unknown>,
            },
          };
        }
        // Other part shapes (future Copilot additions) are ignored —
        // forward compatibility without blind dispatch.
      }
    } catch (err) {
      if (isCancellation(err, req.signal)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        kind: 'done',
        reason: 'error',
        error: `${this.displayName}: stream failed — ${msg}`,
      };
    }
  }

  dispose(): void {
    this.model = undefined;
  }
}

function toolToVscode(tool: Tool): vscode.LanguageModelChatTool {
  return {
    name: tool.name,
    description: tool.description,
    // vscode.lm accepts JSON Schema verbatim under `inputSchema`.
    inputSchema: tool.inputSchema,
  };
}

/**
 * Translate AgentMessage history → vscode.LanguageModelChatMessage[].
 *
 * vscode.lm only exposes User and Assistant roles — no `system` and no
 * `tool`. We encode:
 *   - system: one prefixed User message `[Instructions]\n{system}` on the
 *     first turn (matches the existing chat() convention).
 *   - assistant without tool calls: Assistant(text).
 *   - assistant WITH tool calls: Assistant with a content array mixing
 *     LanguageModelTextPart + LanguageModelToolCallPart (same message,
 *     multiple parts).
 *   - role:'tool': User containing a LanguageModelToolResultPart linked
 *     back to the call id. Consecutive tool results aren't merged (unlike
 *     Anthropic) — vscode.lm accepts them as separate User turns.
 */
function buildVscodeMessages(
  system: string | undefined,
  messages: AgentMessage[],
): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  if (system) {
    out.push(vscode.LanguageModelChatMessage.User(`[Instructions]\n${system}`));
  }
  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push(vscode.LanguageModelChatMessage.User(`[Instructions]\n${msg.content}`));
      continue;
    }
    if (msg.role === 'user') {
      out.push(vscode.LanguageModelChatMessage.User(msg.content));
      continue;
    }
    if (msg.role === 'tool') {
      out.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(msg.toolCallId, [
            new vscode.LanguageModelTextPart(msg.content),
          ]),
        ]),
      );
      continue;
    }
    // assistant
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      if (msg.content) parts.push(new vscode.LanguageModelTextPart(msg.content));
      for (const call of msg.toolCalls) {
        parts.push(
          new vscode.LanguageModelToolCallPart(call.id, call.name, call.arguments),
        );
      }
      out.push(vscode.LanguageModelChatMessage.Assistant(parts));
    } else {
      out.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
    }
  }
  return out;
}

/**
 * Fetch all available Copilot models for the provider picker.
 */
export async function getCopilotModels(): Promise<Array<{ id: string; name: string; family: string }>> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.map((m) => ({
      id: m.id,
      name: `${m.name} (${m.family})`,
      family: m.family,
    }));
  } catch {
    return [];
  }
}
