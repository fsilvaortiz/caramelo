import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * The single workspace folder the smoke harness opens. All transient
 * fixtures live under here so the standard `workspaceFolders[0]` lookup
 * the extension performs at activate-time keeps working.
 */
export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder open — smoke harness must set one in .vscode-test.mjs');
  }
  return folder.uri.fsPath;
}

/** Default constitution body used by seedConstitution(); skips the
 * placeholder check the extension uses to detect un-set constitutions. */
const DEFAULT_CONSTITUTION = [
  '# Project Constitution',
  '',
  '## I. Always Ship',
  '',
  'Prefer working software to comprehensive documentation.',
  '',
  '## II. Test First',
  '',
  'New behaviour must arrive with a failing test.',
  '',
].join('\n');

/** Write a non-placeholder constitution if missing. */
export function seedConstitution(body: string = DEFAULT_CONSTITUTION): string {
  const dest = path.join(workspaceRoot(), '.specify', 'memory', 'constitution.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body, 'utf-8');
  return dest;
}

/** Remove the seeded constitution so the next test can re-seed cleanly. */
export function clearConstitution(): void {
  const target = path.join(workspaceRoot(), '.specify', 'memory', 'constitution.md');
  try {
    fs.unlinkSync(target);
  } catch { /* ignore */ }
}

export interface SeedSpecOptions {
  /** Optional explicit name — defaults to `feat-<uniq>`. */
  name?: string;
  /** Phase statuses to persist into `.caramelo-meta.json`. */
  statuses?: Partial<Record<'requirements' | 'design' | 'tasks', string>>;
  /** Optional contents for spec.md / plan.md / tasks.md. */
  files?: Partial<Record<'spec' | 'plan' | 'tasks', string>>;
}

export interface SeededSpec {
  name: string;
  dir: string;
  metaPath: string;
}

/** Create a fresh spec directory under specs/. Unique by default so
 * tests can run in parallel without colliding. */
export function seedSpec(opts: SeedSpecOptions = {}): SeededSpec {
  const name = opts.name ?? `feat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(workspaceRoot(), 'specs', name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    phases: {
      requirements: opts.statuses?.requirements ?? 'pending',
      design: opts.statuses?.design ?? 'pending',
      tasks: opts.statuses?.tasks ?? 'pending',
    },
  };
  const metaPath = path.join(dir, '.caramelo-meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

  if (opts.files?.spec !== undefined) {
    fs.writeFileSync(path.join(dir, 'spec.md'), opts.files.spec, 'utf-8');
  }
  if (opts.files?.plan !== undefined) {
    fs.writeFileSync(path.join(dir, 'plan.md'), opts.files.plan, 'utf-8');
  }
  if (opts.files?.tasks !== undefined) {
    fs.writeFileSync(path.join(dir, 'tasks.md'), opts.files.tasks, 'utf-8');
  }
  return { name, dir, metaPath };
}

/** Best-effort cleanup. Safe to call even if the spec dir is gone. */
export function removeSpec(spec: SeededSpec): void {
  try {
    fs.rmSync(spec.dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Read the JSON-encoded meta file from a seeded spec. */
export function readMeta(spec: SeededSpec): { phases: Record<string, string> } {
  return JSON.parse(fs.readFileSync(spec.metaPath, 'utf-8'));
}

export function readSpecFile(spec: SeededSpec, file: 'spec.md' | 'plan.md' | 'tasks.md' | 'analysis.md'): string | null {
  try {
    return fs.readFileSync(path.join(spec.dir, file), 'utf-8');
  } catch {
    return null;
  }
}

export function specFileExists(spec: SeededSpec, file: string): boolean {
  return fs.existsSync(path.join(spec.dir, file));
}
