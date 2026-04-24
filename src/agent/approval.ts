import * as vscode from 'vscode';
import type {
  ApprovalContext,
  ApprovalDecision,
  ApprovalPolicy,
  ToolCallApproval,
} from './types.js';

/**
 * Allow everything without prompting. **Tests only** — install this in
 * production and the bash tool will auto-execute arbitrary commands. The
 * `autoAllAllPolicy` below is the user-facing counterpart that still
 * honours bash's always-prompt invariant.
 */
export const autoAllowPolicy: ApprovalPolicy = {
  async decide(calls): Promise<Record<string, ApprovalDecision>> {
    return Object.fromEntries(calls.map((c) => [c.call.id, 'allow'] as const));
  },
};

export interface ApprovalHooks {
  /** Batched-write prompt (auto-reads-batched-writes default policy). */
  confirmWrites(
    writes: ToolCallApproval[],
    ctx: ApprovalContext,
  ): Promise<Record<string, ApprovalDecision>>;
  /** Per-call write prompt (per-call policy). */
  confirmWrite(
    call: ToolCallApproval,
    ctx: ApprovalContext,
  ): Promise<ApprovalDecision>;
  /**
   * Per-call bash prompt. Bash is ALWAYS routed through this regardless
   * of which policy is in force — it's the only tool that can run
   * arbitrary code, so the user MUST confirm every invocation. See
   * Constitution VII ("No code path may silently auto-execute bash") and
   * FR-006.
   */
  confirmBash(
    call: ToolCallApproval,
    ctx: ApprovalContext,
  ): Promise<ApprovalDecision>;
}

/**
 * Default production policy:
 *  - reads (`readOnly=true`) auto-allowed
 *  - bash ALWAYS per-call, showing the literal command (hard-coded)
 *  - other writes batched into a single per-turn approval
 *
 * Honours `caramelo.autoApplyEdits` (treated as "allow all writes this
 * run" without a prompt) and a session-scoped override set by the
 * "don't ask again this session" QuickPick option. Auto-apply NEVER
 * upgrades bash approvals — bash always prompts.
 */
export function readOnlyAutoBatchedWritesPolicy(opts: {
  isAutoApplyEnabled(): boolean;
  setSessionAutoApply(v: boolean): void;
  hooks?: Partial<ApprovalHooks>;
  /** Override to include non-bash tools in the always-prompt set. */
  alwaysPromptTools?: Set<string>;
}): ApprovalPolicy {
  const hooks = resolveHooks(opts.hooks, opts);
  const alwaysPrompt = opts.alwaysPromptTools ?? new Set(['bash']);

  return {
    async decide(calls, ctx) {
      const out: Record<string, ApprovalDecision> = {};
      const writes: ToolCallApproval[] = [];
      const alwaysPromptCalls: ToolCallApproval[] = [];

      for (const c of calls) {
        if (c.tool.readOnly) out[c.call.id] = 'allow';
        else if (alwaysPrompt.has(c.tool.name)) alwaysPromptCalls.push(c);
        else writes.push(c);
      }

      // Bash (and any other tool in alwaysPrompt): per-call prompt.
      for (const c of alwaysPromptCalls) {
        const d = await hooks.confirmBash(c, ctx);
        out[c.call.id] = d;
        if (d === 'abort') return out;
      }

      if (writes.length === 0) return out;

      if (opts.isAutoApplyEnabled()) {
        for (const w of writes) out[w.call.id] = 'allow';
        return out;
      }

      const decisions = await hooks.confirmWrites(writes, ctx);
      // Missing entries from a custom hook default to 'deny' — safer than
      // 'allow' when the hook is incomplete. An 'abort' from the hook on
      // any one call aborts the whole run (runtime handles the cascade).
      for (const w of writes) out[w.call.id] = decisions[w.call.id] ?? 'deny';
      return out;
    },
  };
}

/**
 * Per-call policy — every non-read call gets its own modal. Used when
 * `caramelo.agent.approval === "per-call"`. Bash still goes through
 * `confirmBash`; other writes use `confirmWrite` (NOT the bash hook —
 * those have different argument shapes).
 */
export function perCallPolicy(opts: {
  hooks?: Partial<ApprovalHooks>;
}): ApprovalPolicy {
  const hooks = resolveHooks(opts.hooks);
  return {
    async decide(calls, ctx) {
      const out: Record<string, ApprovalDecision> = {};
      for (const c of calls) {
        if (c.tool.readOnly) {
          out[c.call.id] = 'allow';
          continue;
        }
        const ask = c.tool.name === 'bash' ? hooks.confirmBash : hooks.confirmWrite;
        const d = await ask(c, ctx);
        out[c.call.id] = d;
        if (d === 'abort') return out;
      }
      return out;
    },
  };
}

/**
 * "Auto-all" — auto-allow reads and writes. **bash still prompts
 * per-call** (Constitution VII: no silent auto-execute). Users opt in
 * via `caramelo.agent.approval === "auto-all"` and accept that
 * recoverability relies on the git safety stash.
 */
export function autoAllAllPolicy(opts?: {
  hooks?: Partial<Pick<ApprovalHooks, 'confirmBash'>>;
}): ApprovalPolicy {
  const confirmBash = opts?.hooks?.confirmBash ?? defaultConfirmBash();
  return {
    async decide(calls, ctx) {
      const out: Record<string, ApprovalDecision> = {};
      for (const c of calls) {
        if (c.tool.name === 'bash') {
          const d = await confirmBash(c, ctx);
          out[c.call.id] = d;
          if (d === 'abort') return out;
          continue;
        }
        out[c.call.id] = 'allow';
      }
      return out;
    },
  };
}

// --- Hook resolution + defaults -----------------------------------------

function resolveHooks(
  hooks: Partial<ApprovalHooks> | undefined,
  writeBatchOpts?: { setSessionAutoApply(v: boolean): void },
): ApprovalHooks {
  return {
    confirmWrites:
      hooks?.confirmWrites ??
      defaultConfirmWrites(
        writeBatchOpts ?? { setSessionAutoApply: () => { /* noop */ } },
      ),
    confirmWrite: hooks?.confirmWrite ?? defaultConfirmSingleWrite(),
    confirmBash: hooks?.confirmBash ?? defaultConfirmBash(),
  };
}

function defaultConfirmWrites(opts: {
  setSessionAutoApply(v: boolean): void;
}): ApprovalHooks['confirmWrites'] {
  return async (writes) => {
    const paths = writes.map((w) => describeWrite(w)).join('\n');
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Apply all', description: `${writes.length} change(s)`, value: 'apply-all' as const },
        {
          label: "$(check-all) Apply all — don't ask again this session",
          description: 'Auto-apply subsequent write tools until reload',
          value: 'apply-all-session' as const,
        },
        { label: '$(x) Cancel run', description: 'Abort the agent run', value: 'cancel' as const },
      ],
      {
        placeHolder: `Caramelo agent: ${writes.length} write(s) proposed\n${paths}`,
      },
    );
    if (!pick || pick.value === 'cancel') {
      return Object.fromEntries(writes.map((w) => [w.call.id, 'abort'] as const));
    }
    if (pick.value === 'apply-all-session') opts.setSessionAutoApply(true);
    return Object.fromEntries(writes.map((w) => [w.call.id, 'allow'] as const));
  };
}

function defaultConfirmBash(): ApprovalHooks['confirmBash'] {
  return async (c) => {
    const cmd = String(c.call.arguments.command ?? '(missing)');
    const cwd = c.call.arguments.cwd ? `  cwd: ${String(c.call.arguments.cwd)}` : '';
    const choice = await vscode.window.showWarningMessage(
      `Caramelo agent wants to run:\n\n$ ${truncate(cmd, 300)}${cwd}`,
      { modal: true },
      'Run',
      'Skip',
      'Abort run',
    );
    if (choice === 'Run') return 'allow';
    if (choice === 'Skip') return 'deny';
    return 'abort';
  };
}

function defaultConfirmSingleWrite(): ApprovalHooks['confirmWrite'] {
  return async (c) => {
    const choice = await vscode.window.showWarningMessage(
      `Caramelo agent: ${describeWrite(c)}`,
      { modal: true },
      'Apply',
      'Skip',
      'Abort run',
    );
    if (choice === 'Apply') return 'allow';
    if (choice === 'Skip') return 'deny';
    return 'abort';
  };
}

function describeWrite(c: ToolCallApproval): string {
  const args = c.call.arguments;
  const relPath = (args.path as string) ?? '(unspecified)';
  if (c.tool.name === 'file_write') {
    const size = typeof args.content === 'string' ? args.content.length : 0;
    return `file_write ${relPath} (${size} B${args.overwrite ? ', overwrite' : ''})`;
  }
  if (c.tool.name === 'file_edit') {
    const s = typeof args.search === 'string' ? args.search.length : 0;
    const r = typeof args.replace === 'string' ? args.replace.length : 0;
    return `file_edit ${relPath} (${s} → ${r} B)`;
  }
  return `${c.tool.name} ${relPath}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
