import * as vscode from 'vscode';
import * as fs from 'fs';
import type { ProviderRegistry } from '../providers/registry.js';
import { startTask } from './start-task.js';
import { beginActionHooks } from '../speckit/hook-runner-vscode.js';
import { findSpecForFile } from '../specs/spec.js';
import { getCarameloChannel } from '../utils/output-channel.js';
import { log } from '../utils/log.js';

export interface RunAllTasksOptions {
  /** Specs root, used to name the feature for Spec Kit hooks. */
  specsRoot?: string;
  /** Called after the tasks ran, before the after_implement hooks. */
  onFinished?: () => void;
}

export interface RunAllSummary {
  total: number;
  done: number;
}

/**
 * Run every pending task of a tasks.md: consecutive `[P]` tasks run
 * concurrently, the rest one by one. Tasks run in quiet mode — no toast
 * per task and no editor jumps — and the user gets ONE summary at the
 * end. Returns undefined when a before_implement hook cancelled the run.
 */
export async function runAllTasks(
  docUri: vscode.Uri,
  registry: ProviderRegistry,
  opts: RunAllTasksOptions = {},
): Promise<RunAllSummary | undefined> {
  // Collect all pending tasks with parallel info
  interface PendingTask { line: number; text: string; isParallel: boolean }
  // tasks.md is always read from disk: markTaskComplete writes it with fs,
  // and VS Code reloads an open document from disk only asynchronously —
  // reading the document model here would see stale checkboxes.
  const collectPending = (): PendingTask[] => {
    const out: PendingTask[] = [];
    const lines = readLines(docUri);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trimStart();
      if (/^- \[ \] /.test(text)) {
        const taskText = text.replace(/^- \[ \] /, '').trim();
        out.push({ line: i, text: taskText, isParallel: /\[P\]/.test(taskText) });
      }
    }
    return out;
  };
  let pendingTasks = collectPending();

  if (pendingTasks.length === 0) {
    vscode.window.showInformationMessage('All tasks are already complete!');
    return { total: 0, done: 0 };
  }

  const channel = getCarameloChannel();
  // No "Run N tasks?" confirmation: the user already clicked Run All /
  // Implement, every task is covered by the git safety stash, and the
  // status bar shows progress (cancellable).
  const specName = opts.specsRoot ? findSpecForFile(docUri.fsPath, opts.specsRoot)?.specName : undefined;
  const hooks = await beginActionHooks('implement', specName, registry);
  if (!hooks) return undefined;
  // before_implement hooks may have edited tasks.md.
  pendingTasks = collectPending();
  if (pendingTasks.length === 0) {
    vscode.window.showInformationMessage('All tasks are already complete!');
    await hooks.after();
    return { total: 0, done: 0 };
  }

  // Group consecutive [P] tasks into batches
  const batches: PendingTask[][] = [];
  let currentBatch: PendingTask[] = [];
  let lastWasParallel = false;

  for (const task of pendingTasks) {
    if (task.isParallel) {
      if (!lastWasParallel && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      currentBatch.push(task);
      lastWasParallel = true;
    } else {
      if (lastWasParallel && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      currentBatch.push(task);
      lastWasParallel = false;
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  // Execute batches
  let completed = 0;
  for (const batch of batches) {
    const isParallelBatch = batch[0].isParallel;

    if (isParallelBatch && batch.length > 1) {
      // Run parallel tasks concurrently. Use allSettled so one failing
      // task does not abort the whole batch and discard the work of
      // siblings that have already written to disk.
      channel.appendLine(`\n▶ Running ${batch.length} tasks in parallel (${completed + 1}-${completed + batch.length}/${pendingTasks.length})`);

      const results = await Promise.allSettled(batch.map(async (task) => {
        const currentLine = findTaskLine(readLines(docUri), task.text);
        if (currentLine >= 0) {
          await startTask(currentLine, task.text, docUri, registry, { quiet: true });
        }
      }));
      completed += batch.length;

      const failed: Array<{ task: PendingTask; reason: string }> = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          failed.push({ task: batch[i], reason });
          log.warn(`[runAllTasks] parallel task failed: "${batch[i].text.slice(0, 60)}" — ${reason}`);
        }
      }
      if (failed.length > 0) {
        channel.appendLine(`✗ ${failed.length}/${batch.length} parallel task(s) failed; continuing with the remaining batches.`);
      }
    } else {
      // Run sequential tasks one by one
      for (const task of batch) {
        completed++;
        channel.appendLine(`\n▶ Running task ${completed}/${pendingTasks.length}: ${task.text.slice(0, 50)}`);
        const currentLine = findTaskLine(readLines(docUri), task.text);
        if (currentLine >= 0) {
          await startTask(currentLine, task.text, docUri, registry, { quiet: true });
        }
      }
    }
  }

  // One summary instead of a toast per task: count what actually got ticked.
  const stillPending = new Set(collectPending().map((t) => t.text));
  const done = pendingTasks.filter((t) => !stillPending.has(t.text)).length;
  const notDone = pendingTasks.length - done;
  if (notDone === 0) {
    vscode.window.showInformationMessage(`Caramelo: all ${pendingTasks.length} tasks completed.`);
  } else {
    vscode.window.showWarningMessage(
      `Caramelo: ${done}/${pendingTasks.length} tasks completed, ${notDone} not completed. See the Caramelo output for details.`,
    );
  }
  opts.onFinished?.();
  await hooks.after();
  return { total: pendingTasks.length, done };
}

function readLines(uri: vscode.Uri): string[] {
  return fs.readFileSync(uri.fsPath, 'utf-8').split('\n');
}

function findTaskLine(lines: string[], taskText: string): number {
  const searchStr = taskText.slice(0, 30);
  for (let j = 0; j < lines.length; j++) {
    const lineText = lines[j].trimStart();
    if (/^- \[ \] /.test(lineText) && lineText.includes(searchStr)) {
      return j;
    }
  }
  return -1;
}
