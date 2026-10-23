import { describe, it, expect } from 'vitest';
import { runHooks, hookArguments, type HookRunnerDeps } from '../hook-runner.js';
import type { HookEntry } from '../extensions.js';

const hook = (over: Partial<HookEntry> & Pick<HookEntry, 'command'>): HookEntry => ({
  event: 'before_plan', index: 0, optional: true, enabled: true, priority: 10, ...over,
});

function makeDeps(hooks: HookEntry[], over: Partial<HookRunnerDeps> = {}) {
  const log: string[] = [];
  const deps: HookRunnerDeps = {
    isEnabled: () => true,
    loadHooks: () => hooks,
    conditionMet: () => true,
    preparePrompt: (h) => `prompt:${h.command}`,
    confirmOptional: async (h) => { log.push(`ask:${h.command}`); return true; },
    execute: async (h, prompt) => { log.push(`run:${h.command}:${prompt}`); },
    confirmContinueAfterFailure: async (h) => { log.push(`continue?:${h.command}`); return true; },
    ...over,
  };
  return { deps, log };
}

const ctx = { workspaceRoot: '/w', specName: 'feat' };

describe('runHooks', () => {
  it('runs only enabled hooks of the matching event, in the given (priority) order', async () => {
    const { deps, log } = makeDeps([
      hook({ command: 'a', optional: false }),
      hook({ command: 'other-event', event: 'after_plan', optional: false }),
      hook({ command: 'off', optional: false, enabled: false }),
      hook({ command: 'b', optional: false }),
    ]);
    const r = await runHooks('before', 'plan', ctx, deps);
    expect(r.proceed).toBe(true);
    expect(log).toEqual(['run:a:prompt:a', 'run:b:prompt:b']);
  });

  it('mandatory hooks run without asking; optional hooks are offered first', async () => {
    const { deps, log } = makeDeps([hook({ command: 'must', optional: false }), hook({ command: 'may' })]);
    await runHooks('before', 'plan', ctx, deps);
    expect(log).toEqual(['run:must:prompt:must', 'ask:may', 'run:may:prompt:may']);
  });

  it('a declined optional hook is skipped, not run', async () => {
    const { deps, log } = makeDeps([hook({ command: 'may' })], { confirmOptional: async () => false });
    const r = await runHooks('before', 'plan', ctx, deps);
    expect(log).toEqual([]);
    expect(r.outcomes).toEqual([expect.objectContaining({ status: 'skipped', reason: 'declined' })]);
  });

  it('unmet conditions skip without asking or running', async () => {
    const { deps, log } = makeDeps([hook({ command: 'gated', condition: 'env.X is set' })], { conditionMet: () => false });
    const r = await runHooks('before', 'plan', ctx, deps);
    expect(log).toEqual([]);
    expect(r.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'condition' });
  });

  it('mandatory before-hook failure asks to continue; "no" aborts and stops further hooks', async () => {
    const { deps, log } = makeDeps(
      [hook({ command: 'boom', optional: false }), hook({ command: 'later', optional: false })],
      {
        execute: async (h) => { log.push(`run:${h.command}`); if (h.command === 'boom') throw new Error('exit 1'); },
        confirmContinueAfterFailure: async (h, _e, err) => { log.push(`continue?:${h.command}:${err}`); return false; },
      },
    );
    const r = await runHooks('before', 'plan', ctx, deps);
    expect(r.proceed).toBe(false);
    expect(log).toEqual(['run:boom', 'continue?:boom:exit 1']);
  });

  it('mandatory before-hook failure + "continue" keeps going', async () => {
    const { deps, log } = makeDeps(
      [hook({ command: 'boom', optional: false }), hook({ command: 'later', optional: false })],
      { execute: async (h) => { log.push(`run:${h.command}`); if (h.command === 'boom') throw new Error('x'); } },
    );
    const r = await runHooks('before', 'plan', ctx, deps);
    expect(r.proceed).toBe(true);
    expect(log).toEqual(['run:boom', 'continue?:boom', 'run:later']);
  });

  it('a hook that cannot be prepared (not installed) is a failure, before asking or running', async () => {
    const { deps, log } = makeDeps([hook({ command: 'ghost', optional: false })], {
      preparePrompt: () => { throw new Error('not provided by any installed extension'); },
    });
    const r = await runHooks('before', 'plan', ctx, deps);
    expect(log).toEqual(['continue?:ghost']);
    expect(r.outcomes[0]).toMatchObject({ status: 'failed', error: 'not provided by any installed extension' });
  });

  it('optional or after-hook failures never block the action', async () => {
    const failing = { execute: async () => { throw new Error('nope'); } };
    const opt = makeDeps([hook({ command: 'may' })], failing);
    expect((await runHooks('before', 'plan', ctx, opt.deps)).proceed).toBe(true);
    expect(opt.log).toEqual(['ask:may']);

    const after = makeDeps([hook({ command: 'must', event: 'after_plan', optional: false })], failing);
    expect((await runHooks('after', 'plan', ctx, after.deps)).proceed).toBe(true);
    expect(after.log).toEqual([]);
  });

  it('does nothing when hook execution is disabled', async () => {
    const { deps, log } = makeDeps([hook({ command: 'a', optional: false })], { isEnabled: () => false });
    expect(await runHooks('before', 'plan', ctx, deps)).toEqual({ proceed: true, outcomes: [] });
    expect(log).toEqual([]);
  });
});

describe('hookArguments', () => {
  it('states the event and feature directory', () => {
    expect(hookArguments('after_tasks', { workspaceRoot: '/w', specName: 'login' }))
      .toBe('Invoked automatically by Caramelo as the `after_tasks` hook for feature "login" (directory: specs/login/).');
    expect(hookArguments('after_constitution', { workspaceRoot: '/w' }))
      .toBe('Invoked automatically by Caramelo as the `after_constitution` hook.');
  });
});
