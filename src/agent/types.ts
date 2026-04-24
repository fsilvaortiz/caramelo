import type { FileIO } from './tools/io.js';

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

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly (string | number)[];
  items?: JSONSchemaProperty;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

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

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * Text for system/user/assistant messages; serialised tool_result payload for
   * role='tool'. May be empty on an assistant turn whose only content is
   * tool calls.
   */
  content: string;
  /** Present only on role='assistant' when the turn produced tool calls. */
  toolCalls?: AgentToolCall[];
  /** Present only on role='tool'. Links the result back to the call. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export type AgentEvent =
  | { kind: 'iteration'; index: number; reason: 'start' | 'continue' }
  | { kind: 'text'; delta: string }
  | { kind: 'tool_call'; call: AgentToolCall }
  | { kind: 'tool_result'; callId: string; toolName: string; result: ToolResult }
  | { kind: 'tool_denied'; callId: string; toolName: string; reason: string }
  | {
      kind: 'done';
      reason: 'stop' | 'max_iterations' | 'cancelled' | 'aborted_by_user' | 'error';
      error?: string;
    };

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
  capabilities(): Set<string>;
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
    capabilities?: () => Set<string>;
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
   * and every tool_result. Useful for logging + Phase B resume flows.
   */
  messages: AgentMessage[];
  stopReason:
    | 'stop'
    | 'max_iterations'
    | 'cancelled'
    | 'aborted_by_user'
    | 'error';
  error?: string;
  /** Count of tool calls actually executed (approved and not-aborted). */
  executedToolCalls: number;
  /** Count of tool_result messages that had isError=true. */
  toolErrors: number;
}
