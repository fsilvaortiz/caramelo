import * as vscode from 'vscode';
import type {
  ApprovalContext,
  ApprovalDecision,
  ApprovalPolicy,
  Tool,
  ToolCallApproval,
} from './types.js';

/**
 * Lets every tool run without prompting. Intended for unit tests. Never
 * install this in production.
 */
export const autoAllowPolicy: ApprovalPolicy = {
  async decide(calls): Promise<Record<string, ApprovalDecision>> {
    return Object.fromEntries(calls.map((c) => [c.call.id, 'allow'] as const));
  },
};

export interface WriteApprovalHooks {
  /**
   * Default batched-write prompt: one QuickPick covers every write in the
   * turn. Returns a map from each call.id to a decision.
   */
  confirmWrites(
    writes: ToolCallApproval[],
    ctx: ApprovalContext,
  ): Promise<Record<string, ApprovalDecision>>;
  /**
   * Default per-call prompt for bash (shows the literal command) — bash is
   * ALWAYS prompted, regardless of the surrounding policy, because it is
   * the only tool that can run arbitrary code.
   */
  confirmBash(
    call: ToolCallApproval,
    ctx: ApprovalContext,
  ): Promise<ApprovalDecision>;
}

/**
 * Default production policy:
 *  - reads (readOnly=true) auto-allowed
 *  - bash ALWAYS per-call, showing the literal command
 *  - other writes batched into a single per-turn approval
 *
 * Honours `caramelo.autoApplyEdits` (treated as "allow all writes this run"
 * without a prompt) and a session-scoped override set by the "don't ask
 * again this session" QuickPick option.
 */
export function readOnlyAutoBatchedWritesPolicy(opts: {
  isAutoApplyEnabled(): boolean;
  /** Set when the user picks "apply all — don't ask again this session". */
  setSessionAutoApply(v: boolean): void;
  hooks?: Partial<WriteApprovalHooks>;
  /** Override to include non-bash tools in the always-prompt set. */
  alwaysPromptTools?: Set<string>;
}): ApprovalPolicy {
  const hooks: WriteApprovalHooks = {
    confirmWrites: opts.hooks?.confirmWrites ?? defaultConfirmWrites(opts),
    confirmBash: opts.hooks?.confirmBash ?? defaultConfirmBash(),
  };
  const alwaysPrompt = opts.alwaysPromptTools ?? new Set(['bash']);

  return {
    async decide(calls, ctx) {
      const out: Record<string, ApprovalDecision> = {};

      // 1. Reads auto-allow.
      const writes: ToolCallApproval[] = [];
      const bashLike: ToolCallApproval[] = [];
      for (const c of calls) {
        if (c.tool.readOnly) {
          out[c.call.id] = 'allow';
        } else if (alwaysPrompt.has(c.tool.name)) {
          bashLike.push(c);
        } else {
          writes.push(c);
        }
      }

      // 2. Bash-like: per-call prompt. `abort` from any one stops the run.
      for (const c of bashLike) {
        const d = await hooks.confirmBash(c, ctx);
        out[c.call.id] = d;
        if (d === 'abort') return out;
      }

      // 3. Writes: batched approval (skipped when auto-apply is on).
      if (writes.length > 0) {
        if (opts.isAutoApplyEnabled()) {
          for (const w of writes) out[w.call.id] = 'allow';
        } else {
          const decisions = await hooks.confirmWrites(writes, ctx);
          for (const w of writes) out[w.call.id] = decisions[w.call.id] ?? 'deny';
        }
      }
      return out;
    },
  };
}

/**
 * Per-call policy (alternative): every non-read call gets its own prompt.
 * Used when `caramelo.agent.approval` is set to "per-call".
 */
export function perCallPolicy(opts: {
  hooks?: Partial<WriteApprovalHooks>;
}): ApprovalPolicy {
  const hooks: WriteApprovalHooks = {
    confirmBash: opts.hooks?.confirmBash ?? defaultConfirmBash(),
    confirmWrites:
      opts.hooks?.confirmWrites ??
      (async (writes) => {
        const out: Record<string, ApprovalDecision> = {};
        for (const w of writes) {
          const d = await defaultConfirmBash()(w, {
            workspaceRoot: '',
            turnIndex: 0,
          });
          out[w.call.id] = d;
          if (d === 'abort') return out;
        }
        return out;
      }),
  };
  return {
    async decide(calls, ctx) {
      const out: Record<string, ApprovalDecision> = {};
      for (const c of calls) {
        if (c.tool.readOnly) {
          out[c.call.id] = 'allow';
          continue;
        }
        if (c.tool.name === 'bash') {
          const d = await hooks.confirmBash(c, ctx);
          out[c.call.id] = d;
          if (d === 'abort') return out;
        } else {
          const d = await defaultConfirmSingleWrite()(c, ctx);
          out[c.call.id] = d;
          if (d === 'abort') return out;
        }
      }
      return out;
    },
  };
}

/** Auto-allow everything (reads + writes + bash). Rely on the git stash. */
export function autoAllAllPolicy(): ApprovalPolicy {
  return {
    async decide(calls) {
      return Object.fromEntries(calls.map((c) => [c.call.id, 'allow'] as const));
    },
  };
}

// --- Default vscode-backed prompts ---

function defaultConfirmWrites(opts: {
  setSessionAutoApply(v: boolean): void;
}): WriteApprovalHooks['confirmWrites'] {
  return async (writes) => {
    const paths = writes
      .map((w) => describeWrite(w))
      .join('\n');
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
    if (pick.value === 'apply-all-session') {
      opts.setSessionAutoApply(true);
    }
    return Object.fromEntries(writes.map((w) => [w.call.id, 'allow'] as const));
  };
}

function defaultConfirmBash(): WriteApprovalHooks['confirmBash'] {
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

function defaultConfirmSingleWrite(): (
  c: ToolCallApproval,
  ctx: ApprovalContext,
) => Promise<ApprovalDecision> {
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

// Re-export Tool so downstream importers don't need two imports for typing.
export type { Tool };
