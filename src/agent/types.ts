import type { FileIO } from './tools/io.js';
import type { Capability } from '../providers/types.js';

/**
 * JSON Schema subset understood by all three providers (Claude's `input_schema`,
 * OpenAI's `function.parameters`, and VS Code LM's `LanguageModelChatTool.inputSchema`).
 * We deliberately support only the handful of constructs our tools need — this keeps
 * the hand-rolled validator small.
 */
export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Type-discriminated property — `items` only valid on arrays,
 * `minimum`/`maximum` only on numbers/integers, etc. Prevents authors
 * from writing `{ type: 'string', minimum: 1 }` and expecting the
 * validator to honour it.
 */
export type JSONSchemaProperty =
  | {
      type: 'string';
      description?: string;
      enum?: readonly string[];
      default?: string;
    }
  | {
      type: 'number';
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      type: 'integer';
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      type: 'boolean';
      description?: string;
      default?: boolean;
    }
  | {
      type: 'array';
      description?: string;
      items: JSONSchemaProperty;
      default?: readonly unknown[];
    }
  | {
      type: 'object';
      description?: string;
    };

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  /** Append a single short line to the output channel, without newline. */
  log(line: string): void;
  io: FileIO;
}

export interface ToolResult<T = unknown> {
  /** One-line summary for the output channel. */
  summary: string;
  /**
   * Payload sent back to the model. Strings go through verbatim; objects are
   * JSON-serialised by the provider layer. Keep it under ~8 KB to avoid
   * blowing the context window.
   */
  content: string | T;
  /** If true, the model sees `is_error: true` on the tool_result. */
  isError?: boolean;
}

export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  /** snake_case name sent to the model. */
  name: string;
  /** ≤400 chars. Describes the tool's purpose and preconditions. */
  description: string;
  /** JSON Schema draft-07 subset. */
  inputSchema: JSONSchema;
  /** True for reads (file_read, grep, glob, list_dir). Drives auto-approval. */
  readOnly: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

export interface AgentToolCall {
  /** Provider-assigned id. Echoed back with the tool_result. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Role-discriminated union: illegal combinations (e.g. `toolCalls` on a
 * user message, `toolCallId` missing on a tool message) are now
 * unrepresentable rather than caught by JSDoc alone.
 */
export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      /**
       * May be empty when the turn's only output is tool calls. Assistant
       * turns WITHOUT tool calls and empty content are still valid; the
       * loop treats them as terminal messages.
       */
      content: string;
      toolCalls?: AgentToolCall[];
    }
  | {
      role: 'tool';
      toolCallId: string;
      toolName: string;
      /** Serialised tool_result payload. */
      content: string;
      isError?: boolean;
    };

/**
 * How an agent run ended. Shared between `AgentEvent.done.reason` (the
 * stream event) and `AgentResult.stopReason` (the final return value)
 * so callers don't have to cross-walk two independent literal unions.
 */
export type StopReason = 'stop' | 'max_iterations' | 'cancelled' | 'aborted_by_user' | 'error';

export type AgentEvent =
  | { kind: 'iteration'; index: number; reason: 'start' | 'continue' }
  | { kind: 'text'; delta: string }
  | { kind: 'tool_call'; call: AgentToolCall }
  | { kind: 'tool_result'; callId: string; toolName: string; result: ToolResult }
  | { kind: 'tool_denied'; callId: string; toolName: string; reason: string }
  | { kind: 'done'; reason: StopReason; error?: string };

export interface ApprovalContext {
  workspaceRoot: string;
  /** 1-indexed turn number (matches AgentEvent.iteration.index). */
  turnIndex: number;
}

export interface ToolCallApproval {
  call: AgentToolCall;
  tool: Tool;
}

export type ApprovalDecision = 'allow' | 'deny' | 'abort';

export interface ApprovalPolicy {
  /**
   * Called once per turn with every tool call the model proposed. Returns a
   * map keyed by call.id. Missing entries default to 'deny' for safety.
   * An 'abort' for any call stops the run after this turn.
   */
  decide(
    calls: ToolCallApproval[],
    ctx: ApprovalContext,
  ): Promise<Record<string, ApprovalDecision>>;
}

export interface ProviderToolCallRequest {
  system?: string;
  messages: AgentMessage[];
  tools: Tool[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Extension of LLMProvider. Providers that advertise the `tool-calling`
 * capability implement `chatWithTools` returning a normalised AgentEvent
 * stream. `chat()` stays text-only for non-agent commands.
 */
export interface ToolCallingProvider {
  chatWithTools(req: ProviderToolCallRequest): AsyncIterable<AgentEvent>;
  capabilities(): Set<Capability>;
}

/**
 * Constitution-VI-aligned check: routes through the capability set rather
 * than duck-typing on method presence. Returns true iff the provider
 * (a) declares `tool-calling` in its capability set AND (b) exposes the
 * `chatWithTools` method at runtime.
 */
export function isToolCallingProvider(p: unknown): p is ToolCallingProvider {
  if (typeof p !== 'object' || p === null) return false;
  const provider = p as {
    capabilities?: () => Set<Capability>;
    chatWithTools?: unknown;
  };
  if (typeof provider.capabilities !== 'function') return false;
  if (typeof provider.chatWithTools !== 'function') return false;
  try {
    return provider.capabilities().has('tool-calling');
  } catch {
    return false;
  }
}

export interface AgentRequest {
  system: string;
  messages: AgentMessage[];
  tools: Tool[];
  approval: ApprovalPolicy;
  /** Default 15. Clamped to [1, 50]. */
  maxIterations?: number;
  signal?: AbortSignal;
  onEvent?(event: AgentEvent): void;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Passed through to each tool execution. */
  workspaceRoot: string;
  /** Optional injection point for tests. Defaults to nodeFs. */
  io?: FileIO;
}

export interface AgentResult {
  /**
   * The full message history after the run, including every assistant turn
   * and every tool_result. Useful for logging + future resume-run flows.
   */
  messages: AgentMessage[];
  stopReason: StopReason;
  error?: string;
  /** Count of tool calls actually executed (approved and not-aborted). */
  executedToolCalls: number;
  /** Count of tool_result messages that had isError=true. */
  toolErrors: number;
}
