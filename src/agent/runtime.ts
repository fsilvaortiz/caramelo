import type {
  AgentEvent,
  AgentMessage,
  AgentRequest,
  AgentResult,
  AgentToolCall,
  Tool,
  ToolCallApproval,
  ToolContext,
  ToolResult,
  ToolCallingProvider,
} from './types.js';
import { isToolCallingProvider } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { nodeFs } from './tools/io.js';

const DEFAULT_MAX_ITERATIONS = 15;
const HARD_MAX_ITERATIONS = 50;

/**
 * Drives a multi-turn agent conversation:
 *
 *   loop:
 *     provider.chatWithTools(messages, tools) → stream of events
 *       ├─ text deltas → forward to caller
 *       └─ tool_call   → collect
 *     when stream ends:
 *       if no tool calls → done (reason: 'stop')
 *       else:
 *         approval.decide(all calls)
 *         execute allowed calls (sequentially; reads in parallel is a future optimisation)
 *         append tool_result messages
 *         continue loop
 *
 * The loop yields control via `onEvent` so the output channel stays alive
 * during long runs. Cancellation: `signal.aborted` aborts immediately
 * between tool calls; provider streams also receive the signal so they abort
 * in-flight HTTP requests.
 */
export class AgentRuntime {
  async run(provider: unknown, request: AgentRequest): Promise<AgentResult> {
    if (!isToolCallingProvider(provider)) {
      throw new Error(
        "Active provider does not advertise the 'tool-calling' capability. " +
        'Switch to a provider whose capabilities() includes tool-calling ' +
        '(Claude in Phase A; OpenAI + Copilot in later phases).',
      );
    }

    const registry = new ToolRegistry(request.tools);
    const toolByName = new Map(request.tools.map((t) => [t.name, t] as const));
    const io = request.io ?? nodeFs;
    const maxIter = clamp(
      request.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      1,
      HARD_MAX_ITERATIONS,
    );
    const emit = (ev: AgentEvent): void => request.onEvent?.(ev);

    // Build the mutable message history we send to the provider each turn.
    // We accumulate all tool_result messages here; the provider receives
    // the full history every call so the model can see prior context.
    const messages: AgentMessage[] = [...request.messages];
    let executedToolCalls = 0;
    let toolErrors = 0;
    let stopReason: AgentResult['stopReason'] = 'stop';
    let errorText: string | undefined;

    for (let turn = 1; turn <= maxIter; turn++) {
      if (request.signal?.aborted) {
        stopReason = 'cancelled';
        emit({ kind: 'done', reason: 'cancelled' });
        return buildResult();
      }
      emit({ kind: 'iteration', index: turn, reason: turn === 1 ? 'start' : 'continue' });

      const providerRequest = {
        system: request.system,
        messages,
        tools: request.tools,
        model: request.model,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      };

      let assistantText = '';
      const assistantCalls: AgentToolCall[] = [];

      try {
        for await (const ev of provider.chatWithTools(providerRequest)) {
          if (ev.kind === 'text') {
            assistantText += ev.delta;
            emit(ev);
          } else if (ev.kind === 'tool_call') {
            assistantCalls.push(ev.call);
            emit(ev);
          } else if (ev.kind === 'done') {
            // Provider can emit its own `done` to flag terminal errors; bubble up.
            if (ev.reason === 'error') {
              stopReason = 'error';
              errorText = ev.error;
              emit(ev);
              return buildResult();
            }
            // Otherwise provider is just signalling end of its stream for this
            // turn — the runtime decides whether to continue.
          } else {
            // Tool results are emitted by the runtime, not the provider; but
            // we forward any extra events for observability.
            emit(ev as AgentEvent);
          }
        }
      } catch (err) {
        if (request.signal?.aborted) {
          stopReason = 'cancelled';
          emit({ kind: 'done', reason: 'cancelled' });
          return buildResult();
        }
        stopReason = 'error';
        errorText = err instanceof Error ? err.message : String(err);
        emit({ kind: 'done', reason: 'error', error: errorText });
        return buildResult();
      }

      // Persist the assistant turn so the next provider call sees the same
      // history the model produced.
      messages.push({
        role: 'assistant',
        content: assistantText,
        toolCalls: assistantCalls.length > 0 ? assistantCalls : undefined,
      });

      if (assistantCalls.length === 0) {
        stopReason = 'stop';
        emit({ kind: 'done', reason: 'stop' });
        return buildResult();
      }

      // Approval for this turn's calls.
      const approvalInput: ToolCallApproval[] = assistantCalls
        .map((call) => {
          const tool = toolByName.get(call.name);
          return tool ? ({ call, tool } as ToolCallApproval) : null;
        })
        .filter((v): v is ToolCallApproval => v !== null);

      // Calls to unknown tools short-circuit with is_error results so the
      // model gets informed and can retry with a real tool name.
      const unknownCalls = assistantCalls.filter((c) => !toolByName.has(c.name));

      let decisions: Record<string, 'allow' | 'deny' | 'abort'> = {};
      if (approvalInput.length > 0) {
        try {
          decisions = await request.approval.decide(approvalInput, {
            workspaceRoot: request.workspaceRoot,
            turnIndex: turn,
          });
        } catch (err) {
          stopReason = 'error';
          errorText = `approval policy threw: ${err instanceof Error ? err.message : String(err)}`;
          emit({ kind: 'done', reason: 'error', error: errorText });
          return buildResult();
        }
      }

      if (Object.values(decisions).some((d) => d === 'abort')) {
        // Feed back an aborted tool_result for each call so the history stays
        // balanced, but stop the loop afterwards.
        for (const call of assistantCalls) {
          const reason = 'user aborted the agent run during approval.';
          messages.push(buildToolResultMessage(call, {
            summary: `aborted: ${call.name}`,
            content: `error: ${reason}`,
            isError: true,
          }));
          emit({ kind: 'tool_denied', callId: call.id, toolName: call.name, reason });
        }
        stopReason = 'aborted_by_user';
        emit({ kind: 'done', reason: 'aborted_by_user' });
        return buildResult();
      }

      // Execute allowed calls + surface denied ones as tool_result errors so
      // the model knows the call didn't run.
      for (const call of assistantCalls) {
        if (request.signal?.aborted) {
          stopReason = 'cancelled';
          emit({ kind: 'done', reason: 'cancelled' });
          return buildResult();
        }

        if (!toolByName.has(call.name)) {
          const result: ToolResult = {
            summary: `unknown tool: ${call.name}`,
            content: `error: tool "${call.name}" is not available. Available: ${Array.from(toolByName.keys()).join(', ')}`,
            isError: true,
          };
          messages.push(buildToolResultMessage(call, result));
          emit({ kind: 'tool_result', callId: call.id, toolName: call.name, result });
          toolErrors++;
          continue;
        }

        const decision = decisions[call.id] ?? 'deny';
        if (decision === 'deny') {
          const reason = 'user declined this tool call.';
          messages.push(buildToolResultMessage(call, {
            summary: `denied: ${call.name}`,
            content: `error: ${reason}`,
            isError: true,
          }));
          emit({ kind: 'tool_denied', callId: call.id, toolName: call.name, reason });
          continue;
        }

        const toolCtx: ToolContext = {
          workspaceRoot: request.workspaceRoot,
          signal: request.signal ?? neverAbort,
          log: () => { /* today we only log via the event stream */ },
          io,
        };
        const result = await registry.execute(call, toolCtx);
        messages.push(buildToolResultMessage(call, result));
        emit({ kind: 'tool_result', callId: call.id, toolName: call.name, result });
        executedToolCalls++;
        if (result.isError) toolErrors++;
      }

      // Referencing this silences the `unknown-calls array unused` lint without
      // letting it drift: if we ever need to branch on it, the variable is here.
      void unknownCalls;
    }

    // Ran off the iteration budget.
    stopReason = 'max_iterations';
    emit({ kind: 'done', reason: 'max_iterations' });
    return buildResult();

    function buildResult(): AgentResult {
      return { messages, stopReason, error: errorText, executedToolCalls, toolErrors };
    }
  }
}

/** Convert a ToolResult into the `role:'tool'` message format the agent loop records. */
function buildToolResultMessage(call: AgentToolCall, result: ToolResult): AgentMessage {
  return {
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
    isError: result.isError,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Sentinel signal used only when the caller didn't provide one. Never aborts.
const neverAbort: AbortSignal = (() => {
  const controller = new AbortController();
  return controller.signal;
})();

// Re-export so callers can import the public surface from one module.
export type { Tool, ToolCallingProvider };
