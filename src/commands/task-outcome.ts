import type { AgentResult } from '../agent/types.js';

/**
 * Pure decision about what a terminated agent run means for the `tasks.md`
 * checkbox and the user-visible outcome. Extracted so the contract is
 * unit-testable without booting the full `startTask` stack. A regression
 * that marks `max_iterations` or `error` as complete would silently
 * corrupt `tasks.md` — the discriminated shape below prevents that at
 * the type level: `markComplete: true` is ONLY representable on
 * `kind: 'success'`.
 */

export type TaskOutcomeKind =
  | 'success'
  | 'cancelled'
  | 'aborted_by_user'
  | 'max_iterations_hit'
  | 'runtime_error'
  | 'no_action'
  | 'finished_with_errors';

export type ToastSeverity = 'info' | 'warning' | 'error';
export type Toast = { severity: ToastSeverity; message: string };

export type TaskOutcome =
  | {
      kind: 'success';
      channelLine: string;
      toast: Toast;
      markComplete: true;
    }
  | {
      kind: Exclude<TaskOutcomeKind, 'success'>;
      channelLine: string;
      toast: Toast | null;
      markComplete: false;
    };

/**
 * Success is narrowly defined: the agent stopped cleanly
 * (`stopReason === 'stop'`), made at least one tool call, and every tool
 * call succeeded. Everything else falls through to a non-success outcome
 * whose type literally forbids `markComplete: true`, regardless of how
 * many edits landed on disk.
 */
export function decideTaskOutcome(
  result: AgentResult,
  stashHint: { kind: 'stashed' | 'clean' | 'no-git'; stashName?: string },
): TaskOutcome {
  if (
    result.stopReason === 'stop' &&
    result.toolErrors === 0 &&
    result.executedToolCalls > 0
  ) {
    return {
      kind: 'success',
      channelLine:
        `✓ Task complete via agent loop. ` +
        `${result.executedToolCalls} tool call(s), ${result.toolErrors} error(s).`,
      toast: {
        severity: 'info',
        message: `Task complete. ${result.executedToolCalls} tool call(s).`,
      },
      markComplete: true,
    };
  }

  if (result.stopReason === 'cancelled') {
    return {
      kind: 'cancelled',
      channelLine: '\n⚠ Task cancelled.',
      toast: null,
      markComplete: false,
    };
  }

  if (result.stopReason === 'aborted_by_user') {
    return {
      kind: 'aborted_by_user',
      channelLine: '\n⚠ Task aborted during tool approval.',
      toast: null,
      markComplete: false,
    };
  }

  if (result.stopReason === 'max_iterations') {
    const revert =
      stashHint.kind === 'stashed' && stashHint.stashName
        ? ` Revert with: git stash pop "${stashHint.stashName}".`
        : '';
    return {
      kind: 'max_iterations_hit',
      channelLine: '\n⚠ Agent reached max iterations without finishing.',
      toast: {
        severity: 'warning',
        message: `Task stopped — max agent iterations reached. Inspect the Caramelo output channel.${revert}`,
      },
      markComplete: false,
    };
  }

  if (result.stopReason === 'error') {
    const reason = result.error ?? 'unknown error';
    return {
      kind: 'runtime_error',
      channelLine: `\n✗ agent error: ${reason}`,
      toast: { severity: 'error', message: `Task failed: ${reason}` },
      markComplete: false,
    };
  }

  // stopReason === 'stop' but either no tool calls executed or some errored.
  if (result.executedToolCalls === 0) {
    return {
      kind: 'no_action',
      channelLine: '\n⚠ Agent finished without taking any action.',
      toast: {
        severity: 'warning',
        message: 'Task ended with no changes. See the Caramelo output channel.',
      },
      markComplete: false,
    };
  }

  return {
    kind: 'finished_with_errors',
    channelLine:
      `\n⚠ Agent finished with ${result.toolErrors} tool error(s). Task NOT marked complete.`,
    toast: {
      severity: 'warning',
      message: `Task finished with errors. ${result.toolErrors} tool call(s) failed. See the Caramelo output channel.`,
    },
    markComplete: false,
  };
}
