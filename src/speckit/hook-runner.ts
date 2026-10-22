import type { HookEntry } from './extensions.js';

/** Spec Kit command a Caramelo action corresponds to; hooks fire on `before_<x>` / `after_<x>`. */
export type HookAction =
  | 'constitution'
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'checklist'
  | 'analyze'
  | 'converge'
  | 'implement';

export type HookTiming = 'before' | 'after';

export interface HookRunContext {
  workspaceRoot: string;
  /** Feature the action runs on, when it has one. */
  specName?: string;
}

export type HookOutcome =
  | { hook: HookEntry; status: 'ran' }
  | { hook: HookEntry; status: 'skipped'; reason: 'condition' | 'declined' }
  | { hook: HookEntry; status: 'failed'; error: string };

export interface HookRunResult {
  /** False only when a mandatory `before_` hook failed and the user chose to abort. */
  proceed: boolean;
  outcomes: HookOutcome[];
}

/** Everything with side effects is injected so the policy is testable without VS Code. */
export interface HookRunnerDeps {
  isEnabled(): boolean;
  loadHooks(workspaceRoot: string): readonly HookEntry[];
  conditionMet(hook: HookEntry, ctx: HookRunContext): boolean;
  /** Resolve and render the hook's prompt, `$ARGUMENTS` filled. Throws when it cannot run. */
  preparePrompt(hook: HookEntry, ctx: HookRunContext, event: string): string;
  /** Ask whether to run an optional hook (Spec Kit shows its `prompt`). */
  confirmOptional(hook: HookEntry, event: string): Promise<boolean>;
  execute(hook: HookEntry, prompt: string, ctx: HookRunContext, event: string): Promise<void>;
  /** A mandatory before-hook failed: continue with the action anyway? */
  confirmContinueAfterFailure(hook: HookEntry, event: string, error: string): Promise<boolean>;
}

/** Text that replaces `$ARGUMENTS`: Spec Kit hooks reuse the conversation's context; we state it. */
export function hookArguments(event: string, ctx: HookRunContext): string {
  const feature = ctx.specName ? ` for feature "${ctx.specName}" (directory: specs/${ctx.specName}/)` : '';
  return `Invoked automatically by Caramelo as the \`${event}\` hook${feature}.`;
}

/**
 * Run every enabled hook registered for `<timing>_<action>`, in priority
 * order, following Spec Kit's semantics: conditions gate execution,
 * optional hooks are offered, mandatory hooks run without asking.
 */
export async function runHooks(
  timing: HookTiming,
  action: HookAction,
  ctx: HookRunContext,
  deps: HookRunnerDeps,
): Promise<HookRunResult> {
  const outcomes: HookOutcome[] = [];
  if (!deps.isEnabled()) return { proceed: true, outcomes };

  const event = `${timing}_${action}`;
  const hooks = deps.loadHooks(ctx.workspaceRoot).filter((h) => h.event === event && h.enabled);

  for (const hook of hooks) {
    if (!deps.conditionMet(hook, ctx)) {
      outcomes.push({ hook, status: 'skipped', reason: 'condition' });
      continue;
    }

    let error: string | undefined;
    try {
      const prompt = deps.preparePrompt(hook, ctx, event);
      if (hook.optional && !(await deps.confirmOptional(hook, event))) {
        outcomes.push({ hook, status: 'skipped', reason: 'declined' });
        continue;
      }
      await deps.execute(hook, prompt, ctx, event);
      outcomes.push({ hook, status: 'ran' });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      outcomes.push({ hook, status: 'failed', error });
    }

    if (error !== undefined && timing === 'before' && !hook.optional) {
      if (!(await deps.confirmContinueAfterFailure(hook, event, error))) {
        return { proceed: false, outcomes };
      }
    }
  }
  return { proceed: true, outcomes };
}
