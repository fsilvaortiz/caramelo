import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

export interface GitSafetyResult {
  kind: 'no-git' | 'clean' | 'stashed';
  /** Human-readable hint shown to the user so they can revert if needed. */
  message: string;
  /** Stash name, present only when kind === 'stashed'. */
  stashName?: string;
}

/**
 * Take a best-effort pre-task backup of the working tree.
 *
 * - If the workspace is not a git repo: report 'no-git' so the caller can
 *   ask the user to confirm running without a safety net.
 * - If the working tree is clean: nothing to do, report 'clean'.
 * - Otherwise: `git stash push -u -m <label>` and return the label so the
 *   user can restore it.
 */
export async function createSafetyStash(
  workspaceRoot: string,
  now: Date = new Date(),
): Promise<GitSafetyResult> {
  if (!(await isGitRepo(workspaceRoot))) {
    return {
      kind: 'no-git',
      message: 'Workspace is not a git repository — no automatic backup will be taken.',
    };
  }

  const dirty = await workingTreeDirty(workspaceRoot);
  if (!dirty) {
    return { kind: 'clean', message: 'Working tree is clean; no stash needed.' };
  }

  const stashName = `caramelo-pre-task-${toStashSuffix(now)}`;
  try {
    await run('git', ['stash', 'push', '--include-untracked', '-m', stashName], {
      cwd: workspaceRoot,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      kind: 'no-git',
      message: `git stash failed (${detail}) — proceeding without a backup is NOT recommended.`,
    };
  }

  return {
    kind: 'stashed',
    stashName,
    message:
      `Caramelo created a safety stash "${stashName}". ` +
      `Revert with: git stash list | grep ${stashName} && git stash pop --index <stash@{N}>`,
  };
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function workingTreeDirty(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function toStashSuffix(d: Date): string {
  // ISO without colons so it's shell-friendly.
  return d.toISOString().replace(/[:.]/g, '-');
}
