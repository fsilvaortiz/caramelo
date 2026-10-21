import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { LLMProvider } from '../providers/types.js';
import { log } from '../utils/log.js';

interface Refreshable { refresh(): void }

/**
 * Backup file written next to `tasks.md` before `/speckit.converge`
 * appends new tasks. The user can diff against it if the LLM output is
 * unsatisfactory. Stored as plain `.md` (not dotfile) so it is
 * discoverable in the Explorer; `.gitignore` templates for this repo
 * do not include this suffix, so it will land in git by default — the
 * user can `.gitignore` it per their preference.
 */
export const CONVERGE_BACKUP_SUFFIX = '.pre-converge.md';

const SYSTEM_PROMPT =
  'You are Caramelo, a spec-driven development assistant executing the Spec Kit `/speckit.converge` ' +
  'action. Your job: compare the current `tasks.md` against `spec.md` and `plan.md`, identify tasks ' +
  'the feature still needs that are NOT already in `tasks.md`, and list only those new tasks. You MUST ' +
  'NOT edit, reorder, or restate existing tasks. You MUST NOT invent tasks unrelated to the spec/plan. ' +
  'If there are no new tasks to add, respond with the single line `NONE`.';

const USER_PROMPT_HEADER =
  'Produce a Markdown unordered list of ONLY the net-new tasks that need to be added to tasks.md. ' +
  'Use `- [ ] ` for every item. Keep each task atomic (one concrete deliverable per item) and phrased ' +
  'the same way the existing tasks are phrased. No preamble, no closing commentary — just the list, ' +
  'or the single word `NONE`.\n\n' +
  'If a required `data-model.md`, `research.md`, or contract file is implied by the plan but missing ' +
  'from `tasks.md` coverage, add a task for it.\n';

/**
 * Parse the LLM response into a list of new task lines.
 *
 * The LLM is instructed to produce `- [ ]` Markdown checkboxes. We tolerate
 * common deviations: numbered lists, missing checkboxes, bullet symbols
 * other than `-`. We also honor the explicit `NONE` sentinel. Anything we
 * can't recognise as a task line is dropped (we do NOT return it as-is —
 * the whole point of this parser is to keep garbage out of tasks.md).
 *
 * Pure function; exported for tests.
 */
export function parseConvergeOutput(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.toUpperCase() === 'NONE') return [];

  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const stripped = line.trimEnd();
    if (!stripped.trim()) continue;
    // Already properly formatted `- [ ] text`
    const checkboxMatch = stripped.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/);
    if (checkboxMatch) {
      out.push(`- [ ] ${checkboxMatch[1].trim()}`);
      continue;
    }
    // Numbered list: `1. text` or `1) text`
    const numberedMatch = stripped.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      out.push(`- [ ] ${numberedMatch[1].trim()}`);
      continue;
    }
    // Plain bullet: `- text` or `* text` or `+ text`
    const bulletMatch = stripped.match(/^\s*[-*+]\s+(.+)$/);
    if (bulletMatch) {
      out.push(`- [ ] ${bulletMatch[1].trim()}`);
      continue;
    }
    // Everything else is discarded — probably commentary from a chatty model.
  }
  return out;
}

/**
 * Append a converged-tasks section to `tasks.md`. The function returns
 * the full new file content; writing to disk is the caller's job so
 * tests don't need temp-dir choreography.
 *
 * The appended block is clearly delimited with a dated heading so a
 * reader can see at a glance which tasks were added by `/speckit.converge`
 * versus authored during the initial `/speckit.tasks` run. Multiple
 * converge runs produce multiple dated sections — intentional, so the
 * audit trail stays legible.
 *
 * Invariant: the function NEVER modifies lines that were already in the
 * input (test coverage asserts this on arbitrary inputs). The returned
 * string always starts with the original string unchanged.
 */
export function appendConvergedTasks(
  current: string,
  newTasks: readonly string[],
  isoDate: string,
): string {
  if (newTasks.length === 0) return current;
  const trimmedBase = current.endsWith('\n') ? current : `${current}\n`;
  const header = `## Converged Tasks — ${isoDate}`;
  const body = newTasks.map((t) => (t.startsWith('- [ ]') ? t : `- [ ] ${t}`)).join('\n');
  return `${trimmedBase}\n${header}\n\n${body}\n`;
}

/** Build the user-visible prompt body with the three artifacts inlined. */
export function buildConvergeMessages(
  specMd: string,
  planMd: string,
  tasksMd: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `${USER_PROMPT_HEADER}\n` +
        `--- SPEC: spec.md ---\n${specMd}\n\n` +
        `--- PLAN: plan.md ---\n${planMd}\n\n` +
        `--- TASKS: tasks.md (current) ---\n${tasksMd}\n`,
    },
  ];
}

async function collectStream(stream: AsyncIterable<string>): Promise<string> {
  let acc = '';
  for await (const chunk of stream) acc += chunk;
  return acc;
}

export async function convergeTasks(
  specName: string,
  workspace: SpecWorkspace,
  registry: ProviderRegistry,
  specsTree: Refreshable,
): Promise<void> {
  if (!registry.activeProvider) {
    vscode.window.showWarningMessage('No active LLM provider. Configure one first.');
    vscode.commands.executeCommand('caramelo.selectProvider');
    return;
  }

  if (vscode.workspace.isTrusted === false) {
    vscode.window.showWarningMessage(
      'Caramelo: LLM execution is blocked in untrusted workspaces. Trust the workspace to run converge.',
    );
    return;
  }

  const spec = workspace.listSpecs().find((s) => s.name === specName);
  if (!spec) {
    vscode.window.showErrorMessage(`Spec "${specName}" not found.`);
    return;
  }

  const specMdPath = path.join(spec.dirPath, 'spec.md');
  const planMdPath = path.join(spec.dirPath, 'plan.md');
  const tasksMdPath = path.join(spec.dirPath, 'tasks.md');

  for (const [label, p] of [['spec.md', specMdPath], ['plan.md', planMdPath], ['tasks.md', tasksMdPath]] as const) {
    if (!fs.existsSync(p)) {
      vscode.window.showErrorMessage(`Caramelo: cannot converge — ${label} missing. Approve the earlier phases first.`);
      return;
    }
  }

  const specMd = fs.readFileSync(specMdPath, 'utf-8');
  const planMd = fs.readFileSync(planMdPath, 'utf-8');
  const tasksMd = fs.readFileSync(tasksMdPath, 'utf-8');

  const backupPath = path.join(spec.dirPath, `tasks${CONVERGE_BACKUP_SUFFIX}`);
  fs.writeFileSync(backupPath, tasksMd, 'utf-8');

  const messages = buildConvergeMessages(specMd, planMd, tasksMd);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Converging ${specName}…`, cancellable: false },
    async () => {
      try {
        const provider = registry.activeProvider as LLMProvider;
        const raw = await collectStream(provider.chat(messages));
        const newTasks = parseConvergeOutput(raw);
        if (newTasks.length === 0) {
          vscode.window.showInformationMessage(`Converge: no new tasks found for "${specName}". Nothing added.`);
          return;
        }
        const isoDate = new Date().toISOString().slice(0, 10);
        const merged = appendConvergedTasks(tasksMd, newTasks, isoDate);
        fs.writeFileSync(tasksMdPath, merged, 'utf-8');
        specsTree.refresh();
        vscode.window.showInformationMessage(
          `Converge: appended ${newTasks.length} new task${newTasks.length === 1 ? '' : 's'} to ${specName}/tasks.md. Backup at ${path.basename(backupPath)}.`,
        );
      } catch (err) {
        log.warn('[converge] failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Converge failed: ${msg}. Your tasks.md is unchanged (backup kept).`);
      }
    },
  );
}
