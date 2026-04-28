import { describe, it, expect } from 'vitest';
import { decideTaskOutcome } from '../task-outcome.js';
import type { AgentResult } from '../../agent/types.js';

function result(overrides: Partial<AgentResult>): AgentResult {
  return {
    messages: [],
    stopReason: 'stop',
    executedToolCalls: 0,
    toolErrors: 0,
    ...overrides,
  };
}

const cleanStash = { kind: 'clean' as const };
const stash = { kind: 'stashed' as const, stashName: 'caramelo-pre-task-abc' };

describe('decideTaskOutcome', () => {
  it('success iff stop + zero errors + ≥1 executed tool call', () => {
    const o = decideTaskOutcome(
      result({ stopReason: 'stop', executedToolCalls: 3, toolErrors: 0 }),
      cleanStash,
    );
    expect(o.kind).toBe('success');
    expect(o.markComplete).toBe(true);
    expect(o.toast?.severity).toBe('info');
  });

  it('NEVER marks complete when stopReason is max_iterations', () => {
    const o = decideTaskOutcome(
      result({ stopReason: 'max_iterations', executedToolCalls: 15, toolErrors: 0 }),
      stash,
    );
    expect(o.kind).toBe('max_iterations_hit');
    expect(o.markComplete).toBe(false);
    expect(o.toast?.severity).toBe('warning');
    // Stash revert hint included.
    expect(o.toast?.message).toContain('git stash pop');
    expect(o.toast?.message).toContain('caramelo-pre-task-abc');
  });

  it('NEVER marks complete when stopReason is error', () => {
    const o = decideTaskOutcome(
      result({ stopReason: 'error', error: 'boom', executedToolCalls: 1 }),
      cleanStash,
    );
    expect(o.kind).toBe('runtime_error');
    expect(o.markComplete).toBe(false);
    expect(o.toast?.severity).toBe('error');
    expect(o.channelLine).toContain('boom');
  });

  it('silent when the user cancelled mid-run', () => {
    const o = decideTaskOutcome(result({ stopReason: 'cancelled' }), cleanStash);
    expect(o.kind).toBe('cancelled');
    expect(o.markComplete).toBe(false);
    expect(o.toast).toBeNull();
  });

  it('silent when the user aborted at the approval modal', () => {
    const o = decideTaskOutcome(result({ stopReason: 'aborted_by_user' }), cleanStash);
    expect(o.kind).toBe('aborted_by_user');
    expect(o.markComplete).toBe(false);
    expect(o.toast).toBeNull();
  });

  it('no_action when the agent stopped without calling any tool', () => {
    const o = decideTaskOutcome(
      result({ stopReason: 'stop', executedToolCalls: 0, toolErrors: 0 }),
      cleanStash,
    );
    expect(o.kind).toBe('no_action');
    expect(o.markComplete).toBe(false);
    expect(o.toast?.severity).toBe('warning');
  });

  it('finished_with_errors when tools errored but run stopped cleanly', () => {
    const o = decideTaskOutcome(
      result({ stopReason: 'stop', executedToolCalls: 5, toolErrors: 2 }),
      cleanStash,
    );
    expect(o.kind).toBe('finished_with_errors');
    expect(o.markComplete).toBe(false);
    expect(o.channelLine).toContain('2 tool error');
  });

  it('max_iterations without a stash does not include the revert hint', () => {
    const o = decideTaskOutcome(
      result({ stopReason: 'max_iterations' }),
      { kind: 'no-git' },
    );
    expect(o.toast?.message).not.toContain('git stash pop');
  });
});
