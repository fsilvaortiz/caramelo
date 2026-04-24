import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderRegistry } from '../providers/registry.js';
import { SPECS_DIR_NAME } from '../constants.js';
import { showProgress, hideProgress } from '../progress.js';
import { LegacyFormatError, ParseError, parseEdits } from './task-edits/parser.js';
import { applyEdits, type ApplyOutcome } from './task-edits/apply.js';
import { buildTaskContext } from './task-edits/context.js';
import { createSafetyStash } from './task-edits/git-safety.js';
import { confirmApplyChoice, previewEdit } from './task-edits/diff-preview.js';
import { TASK_SYSTEM_PROMPT } from './task-edits/prompt.js';
import { AsyncMutex } from './task-edits/mutex.js';
import { log } from '../utils/log.js';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Caramelo');
  }
  return outputChannel;
}

/**
 * Serializes the pieces of a task that are NOT safe to run concurrently:
 *   1. `git stash push -u` (races on .git/index.lock)
 *   2. modal warnings / confirm QuickPicks (VS Code shows one at a time)
 *   3. `previewEdit` diff tabs
 *   4. `applyEdits` — two edits hitting the same file from different
 *      task runs would shift each other's SEARCH context.
 *
 * The LLM streaming call happens OUTSIDE this lock so that the throughput
 * benefit of `[P]`-marked parallel tasks is preserved.
 */
const interactiveLock = new AsyncMutex();

/**
 * Per-session dismissal of the "no git repo" safety prompt. Resets on window
 * reload. Users who always work in non-git dirs can also flip
 * `caramelo.tasks.allowWithoutGit` once and never see the prompt again.
 */
let sessionAllowNoGit = false;

/**
 * Per-session dismissal of the Apply/Review QuickPick. Set when the user
 * clicks "Apply all — don't ask again this session". Resets on reload.
 * The permanent switch is `caramelo.autoApplyEdits`.
 */
let sessionAutoApply = false;

function isAllowWithoutGitEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('caramelo.tasks.allowWithoutGit', false);
}

function isAutoApplyEnabled(): boolean {
  return (
    sessionAutoApply ||
    vscode.workspace.getConfiguration().get<boolean>('caramelo.autoApplyEdits', false)
  );
}

export async function startTask(
  lineNumber: number,
  taskText: string,
  docUri: vscode.Uri,
  registry: ProviderRegistry,
): Promise<void> {
  const provider = registry.activeProvider;
  if (!provider) {
    vscode.window.showWarningMessage('No active LLM provider configured.');
    vscode.commands.executeCommand('caramelo.selectProvider');
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('No workspace folder open — task execution requires a workspace.');
    return;
  }

  const channel = getOutputChannel();
  channel.show(true);
  channel.appendLine(`\n${'─'.repeat(60)}`);
  channel.appendLine(`▶ Task: ${taskText}`);
  channel.appendLine(`  ${new Date().toLocaleTimeString()}`);
  channel.appendLine('─'.repeat(60));

  // Phase A — safety stash + no-git confirmation. Must be serialized across
  // concurrent startTask invocations so two parallel [P] tasks don't race
  // on .git/index.lock or stack modal dialogs on top of each other. When a
  // prior task already took a stash the worktree is clean here, so this
  // returns kind:'clean' and takes no second stash — one batch-wide stash
  // is enough to revert everything.
  const phaseA = await interactiveLock.run(async () => {
    const safety = await createSafetyStash(workspaceRoot);
    channel.appendLine(`↪ [${taskText.slice(0, 40)}] ${safety.message}`);
    if (safety.kind === 'no-git' && !sessionAllowNoGit && !isAllowWithoutGitEnabled()) {
      const proceedOnce = 'Proceed without backup';
      const proceedSession = 'Proceed — don\'t ask again this session';
      const choice = await vscode.window.showWarningMessage(
        `Task "${taskText.slice(0, 60)}": ${safety.message} Proceed anyway?`,
        { modal: true },
        proceedOnce,
        proceedSession,
      );
      if (choice === proceedSession) {
        sessionAllowNoGit = true;
      } else if (choice !== proceedOnce) {
        return { abort: true as const, safety };
      }
    }
    return { abort: false as const, safety };
  });
  if (phaseA.abort) {
    channel.appendLine('✗ Task cancelled by user — no backup available.');
    return;
  }
  const safety = phaseA.safety;

  // Build context — pure reads, safe to run in parallel with other tasks.
  const specDir = findSpecDir(docUri.fsPath);
  const ctx = specDir
    ? buildTaskContext({ specDir, workspaceRoot, taskText })
    : { text: '', includedFiles: [], skippedFiles: [] };
  if (ctx.includedFiles.length > 0) {
    channel.appendLine(`↪ Included in context: ${ctx.includedFiles.join(', ')}`);
  }
  if (ctx.skippedFiles.length > 0) {
    channel.appendLine(`↪ Skipped (context budget): ${ctx.skippedFiles.join(', ')}`);
  }

  const userPrompt = `Task: ${taskText}\n\n${ctx.text ? `Context:\n${ctx.text}` : ''}`;

  const abortController = new AbortController();
  showProgress(`Task: ${taskText.slice(0, 40)}...`, () => abortController.abort());

  try {
    let output = '';
    try {
      for await (const chunk of provider.chat(
        [
          { role: 'system', content: TASK_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        { signal: abortController.signal },
      )) {
        output += chunk;
        channel.append(chunk);
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        channel.appendLine('\n\n⚠ Task cancelled.');
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      channel.appendLine(`\n\n✗ Error: ${msg}`);
      vscode.window.showErrorMessage(`Task failed: ${msg}`);
      return;
    }

    // Parse edits. Hard fail on legacy-format output so we never fall
    // back to raw overwrites.
    let edits;
    try {
      edits = parseEdits(output);
    } catch (err) {
      if (err instanceof LegacyFormatError) {
        channel.appendLine(`\n\n✗ ${err.message}`);
        vscode.window.showErrorMessage(
          'Caramelo rejected an out-of-protocol response (legacy whole-file format). Nothing was written. See the Caramelo output channel for details.',
        );
        return;
      }
      if (err instanceof ParseError) {
        channel.appendLine(`\n\n✗ Malformed edit protocol: ${err.message}`);
        vscode.window.showErrorMessage(
          'Caramelo could not parse the proposed edits. Nothing was written. See the Caramelo output channel for details.',
        );
        return;
      }
      log.error('unexpected parseEdits error', err);
      throw err;
    }

    if (edits.length === 0) {
      channel.appendLine('\n\n⚠ No edits detected in LLM output. Nothing to apply.');
      vscode.window.showInformationMessage('No edits proposed by the LLM.');
      return;
    }

    channel.appendLine(`\n\n${'─'.repeat(40)}`);
    channel.appendLine(`✓ ${edits.length} edit block(s) parsed.`);

    // Phase C — review + apply + markTaskComplete + openDoc. Serialized so
    // two parallel tasks don't stack QuickPicks or race on applyEdits
    // against the same file. The LLM stream above ran outside the lock so
    // we still get parallel throughput on `chat()`.
    await interactiveLock.run(async () => {
      let toApply = edits;
      if (!isAutoApplyEnabled()) {
        const choice = await confirmApplyChoice(edits.length, taskText);
        if (choice === 'cancel') {
          channel.appendLine('✗ Task cancelled by user at review step.');
          return;
        }
        if (choice === 'apply-all-session') {
          sessionAutoApply = true;
          channel.appendLine('↪ Auto-apply enabled for this session.');
        }
        if (choice === 'file-by-file') {
          const accepted = [];
          for (const edit of edits) {
            const result = await previewEdit(edit, { workspaceRoot, taskText });
            if (result === 'cancel-all') {
              channel.appendLine('✗ Review cancelled; remaining edits discarded.');
              break;
            }
            if (result === 'accept') accepted.push(edit);
            else channel.appendLine(`  skipped: ${edit.filePath}`);
          }
          toApply = accepted;
        }
      }

      if (toApply.length === 0) {
        channel.appendLine('⚠ Nothing selected for application.');
        return;
      }

      const outcomes = applyEdits(toApply, { workspaceRoot });
      const applied = logOutcomes(channel, outcomes);

      if (applied > 0) {
        await markTaskComplete(docUri, lineNumber, taskText);
        channel.appendLine(`✓ Task complete. ${applied} file(s) changed.`);
        vscode.window.showInformationMessage(`Task complete. ${applied} file(s) changed.`);
        const first = outcomes.find((o) => o.wrote);
        if (first) {
          const abs = path.isAbsolute(first.filePath)
            ? first.filePath
            : path.join(workspaceRoot, first.filePath);
          const doc = await vscode.workspace.openTextDocument(abs);
          await vscode.window.showTextDocument(doc, { preview: false });
        }
      } else {
        const hint = safety.kind === 'stashed'
          ? ` Your work is safe in stash "${safety.stashName}".`
          : '';
        vscode.window.showWarningMessage(
          `Task "${taskText.slice(0, 50)}" produced no applicable edits.${hint} See the Caramelo output channel for details.`,
        );
      }
    });
  } finally {
    hideProgress();
  }
}

function logOutcomes(channel: vscode.OutputChannel, outcomes: ApplyOutcome[]): number {
  let applied = 0;
  for (const outcome of outcomes) {
    const icon = outcome.status === 'applied' ? '✓' : '✗';
    channel.appendLine(`${icon} [${outcome.status}] ${outcome.filePath}`);
    if (outcome.status !== 'applied') {
      for (const line of outcome.detail.split('\n')) channel.appendLine(`    ${line}`);
    }
    if (outcome.wrote) applied++;
  }
  return applied;
}

// Mutex to prevent concurrent writes to the same tasks file.
let writeLock: Promise<void> = Promise.resolve();

async function markTaskComplete(docUri: vscode.Uri, lineNumber: number, taskText?: string): Promise<void> {
  writeLock = writeLock.then(async () => {
    const filePath = docUri.fsPath;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    if (lineNumber < lines.length && lines[lineNumber].includes('- [ ]')) {
      lines[lineNumber] = lines[lineNumber].replace('- [ ]', '- [x]');
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      return;
    }

    if (taskText) {
      const searchStr = taskText.slice(0, 30);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('- [ ]') && lines[i].includes(searchStr)) {
          lines[i] = lines[i].replace('- [ ]', '- [x]');
          fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
          return;
        }
      }
    }

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('- [ ]')) {
        lines[i] = lines[i].replace('- [ ]', '- [x]');
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return;
      }
    }
  });
  await writeLock;
}

function findSpecDir(filePath: string): string | null {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (dir.includes(SPECS_DIR_NAME)) return dir;
    dir = path.dirname(dir);
  }
  return null;
}
