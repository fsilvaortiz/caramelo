import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderRegistry } from '../providers/registry.js';
import { SPECS_DIR_NAME } from '../constants.js';
import { showProgress, hideProgress } from '../progress.js';
import { LegacyFormatError, ParseError, parseEdits, type Edit } from './task-edits/parser.js';
import { applyEdits, type ApplyOutcome } from './task-edits/apply.js';
import { buildTaskContext } from './task-edits/context.js';
import { createSafetyStash } from './task-edits/git-safety.js';
import { confirmApplyChoice, previewEdit } from './task-edits/diff-preview.js';
import { TASK_SYSTEM_PROMPT } from './task-edits/prompt.js';
import { AsyncMutex } from './task-edits/mutex.js';
import { log } from '../utils/log.js';
import { AgentRuntime } from '../agent/runtime.js';
import { buildDefaultToolSet } from '../agent/tools/index.js';
import { formatPrologue, pipeToOutputChannel } from '../agent/events.js';
import {
  autoAllAllPolicy,
  perCallPolicy,
  readOnlyAutoBatchedWritesPolicy,
} from '../agent/approval.js';
import { isToolCallingProvider } from '../agent/types.js';
import type { ApprovalPolicy } from '../agent/types.js';

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

function isAgentLoopEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('caramelo.useAgentLoop', true);
}

function isBashToolEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('caramelo.enableBashTool', true);
}

function getAgentMaxIterations(): number {
  const raw = vscode.workspace.getConfiguration().get<number>('caramelo.agent.maxIterations');
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 15;
  return Math.max(3, Math.min(50, Math.floor(raw)));
}

function getApprovalMode(): 'auto-reads-batched-writes' | 'per-call' | 'auto-all' {
  const raw = vscode.workspace
    .getConfiguration()
    .get<string>('caramelo.agent.approval', 'auto-reads-batched-writes');
  if (raw === 'per-call' || raw === 'auto-all') return raw;
  return 'auto-reads-batched-writes';
}

function buildApprovalPolicy(): ApprovalPolicy {
  const mode = getApprovalMode();
  if (mode === 'auto-all') return autoAllAllPolicy();
  if (mode === 'per-call') return perCallPolicy({});
  return readOnlyAutoBatchedWritesPolicy({
    isAutoApplyEnabled,
    setSessionAutoApply: (v) => {
      sessionAutoApply = v;
    },
  });
}

const AGENT_SYSTEM_PROMPT =
  `You are Caramelo, a code-editing agent embedded in a VS Code extension. ` +
  `You are executing ONE task from a spec-driven-development tasks.md list.\n\n` +
  `You have tools:\n` +
  `  - file_read(path, [start_line, end_line])  — read a workspace file\n` +
  `  - list_dir(path?)                          — list a directory\n` +
  `  - grep(pattern, [path], [case_sensitive])  — regex search\n` +
  `  - glob(pattern)                            — file-path glob\n` +
  `  - file_edit(path, search, replace)         — replace an exact, unique snippet\n` +
  `  - file_write(path, content, [overwrite])   — create or overwrite a file\n` +
  `  - bash(command, [cwd], [timeout_ms])       — run a shell command (user approval required)\n\n` +
  `Rules:\n` +
  `- Paths are workspace-relative; anything outside the workspace is refused.\n` +
  `- Use grep/glob/list_dir/file_read to explore before editing — the context ` +
  `you were given is a seed, not the whole picture.\n` +
  `- Prefer file_edit with a precise, unique SEARCH over file_write. file_write ` +
  `refuses to overwrite by default; use it for new files.\n` +
  `- When you are done, reply with a one- or two-sentence summary of what changed ` +
  `and emit NO tool calls — that is the signal that the task is complete.\n` +
  `- If a tool returns an error, read the error message and recover; do NOT repeat ` +
  `the same failing call verbatim.`;

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

  // Constitution VIII (FR-018): untrusted workspaces block ALL LLM execution.
  // Checked before the safety-stash + no-git modal so we don't ask the user
  // to confirm "proceed without backup" and then refuse the task anyway.
  if (vscode.workspace.isTrusted === false) {
    channel.appendLine(
      '\n✗ Task refused: workspace is not trusted. ' +
      'Trust the workspace (Command Palette → "Manage Workspace Trust") and retry.',
    );
    vscode.window.showWarningMessage(
      'Caramelo: LLM execution is blocked in untrusted workspaces. Trust the workspace to run tasks.',
    );
    return;
  }

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

  // Phase A: prefer agent loop when the active provider advertises the
  // `tool-calling` capability and the user hasn't flipped the kill switch.
  // Falls back to the legacy SEARCH/REPLACE text protocol otherwise.
  const agentLoopRequested = isAgentLoopEnabled();
  const canDoAgent = isToolCallingProvider(provider);
  if (agentLoopRequested && canDoAgent) {
    try {
      await runTaskWithAgent({
        provider,
        workspaceRoot,
        userPrompt,
        taskText,
        channel,
        abortController,
        docUri,
        lineNumber,
        safety,
      });
    } finally {
      hideProgress();
    }
    return;
  }

  // Constitution VII: providers without native tool-calling MUST inform the
  // user which execution mode is active — no silent drift between agent and
  // legacy paths.
  if (agentLoopRequested && !canDoAgent) {
    channel.appendLine(
      `↪ provider "${provider.displayName}" does not advertise the 'tool-calling' capability ` +
      `(capabilities: [${Array.from(provider.capabilities()).join(',')}]). ` +
      `Falling back to the legacy SEARCH/REPLACE protocol. To silence this message, ` +
      `set caramelo.useAgentLoop=false, or switch to a tool-calling provider.`,
    );
  }

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

      // Recovery: if CREATE blocks collided with existing files, do a single
      // second round asking the LLM to emit SEARCH/REPLACE against the real
      // content instead. The user already consented to applying these edits,
      // so the retry applies automatically as well.
      const conflicts = outcomes.filter((o) => o.status === 'aborted-exists');
      if (conflicts.length > 0) {
        channel.appendLine(
          `↻ ${conflicts.length} CREATE block(s) hit existing file(s); retrying as SEARCH/REPLACE…`,
        );
        const retryCtx = conflicts
          .map((c) => {
            const abs = path.isAbsolute(c.filePath)
              ? c.filePath
              : path.join(workspaceRoot, c.filePath);
            let current = '';
            try { current = fs.readFileSync(abs, 'utf-8'); } catch { /* ignore */ }
            return `--- EXISTING FILE: ${c.filePath} ---\n${current}\n--- END FILE ---`;
          })
          .join('\n\n');
        const retryPrompt =
          'Your previous response emitted CREATE blocks for paths that already exist on disk. ' +
          'For each file below, emit a FILE block with SEARCH/REPLACE pairs that transform the current content into your intended content. ' +
          'If the current content already matches your intent, emit no block for that file.\n\n' +
          retryCtx;
        let retryOutput = '';
        try {
          channel.appendLine('\n--- retry round ---');
          for await (const chunk of provider.chat(
            [
              { role: 'system', content: TASK_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: output },
              { role: 'user', content: retryPrompt },
            ],
            { signal: abortController.signal },
          )) {
            retryOutput += chunk;
            channel.append(chunk);
          }
          channel.appendLine('\n--- end retry ---');
        } catch (err) {
          channel.appendLine(`⚠ Retry LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (retryOutput) {
          let retryEdits: Edit[] = [];
          try {
            retryEdits = parseEdits(retryOutput);
          } catch (err) {
            channel.appendLine(`⚠ Retry output could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
          }
          // Only accept retry edits that touch one of the conflicted files.
          const conflictPaths = new Set(conflicts.map((c) => c.filePath));
          const filteredRetry = retryEdits.filter(
            (e) => e.kind === 'edit' && conflictPaths.has(e.filePath),
          );
          if (filteredRetry.length > 0) {
            const retryOutcomes = applyEdits(filteredRetry, { workspaceRoot });
            for (const ro of retryOutcomes) {
              const idx = outcomes.findIndex(
                (o) => o.filePath === ro.filePath && o.status === 'aborted-exists',
              );
              if (idx >= 0) outcomes[idx] = ro;
            }
          } else {
            // LLM produced no applicable edits — either the current content
            // already matches its intent (no-op) or it couldn't recover.
            for (const c of conflicts) {
              const idx = outcomes.findIndex(
                (o) => o.filePath === c.filePath && o.status === 'aborted-exists',
              );
              if (idx >= 0) {
                outcomes[idx] = {
                  filePath: c.filePath,
                  status: 'applied',
                  detail: `Retry produced no edits for "${c.filePath}" — treating the existing file as already up to date.`,
                  wrote: false,
                };
              }
            }
          }
        }
      }

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

interface AgentRunArgs {
  provider: unknown;
  workspaceRoot: string;
  userPrompt: string;
  taskText: string;
  channel: vscode.OutputChannel;
  abortController: AbortController;
  docUri: vscode.Uri;
  lineNumber: number;
  safety: { kind: 'no-git' | 'clean' | 'stashed'; message: string; stashName?: string };
}

async function runTaskWithAgent(args: AgentRunArgs): Promise<void> {
  const {
    provider,
    workspaceRoot,
    userPrompt,
    taskText,
    channel,
    abortController,
    docUri,
    lineNumber,
    safety,
  } = args;

  const tools = buildDefaultToolSet({ enableBash: isBashToolEnabled() });
  const approval = buildApprovalPolicy();
  const runtime = new AgentRuntime();

  // Constitution IX — every LLM run logs provider, model, capability set,
  // tool inventory, and approval mode. Redacted via events.ts.
  const providerForPrologue = provider as {
    id: string;
    displayName: string;
    capabilities(): Set<string>;
  };
  channel.appendLine(
    formatPrologue({
      providerId: providerForPrologue.id,
      providerName: providerForPrologue.displayName,
      model: undefined,
      capabilities: Array.from(providerForPrologue.capabilities()),
      toolNames: tools.map((t) => t.name),
      approvalMode: getApprovalMode(),
      bashEnabled: isBashToolEnabled(),
      maxIterations: getAgentMaxIterations(),
    }),
  );

  let result;
  try {
    result = await runtime.run(provider, {
      system: AGENT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      tools,
      approval,
      workspaceRoot,
      signal: abortController.signal,
      onEvent: pipeToOutputChannel(channel),
      maxIterations: getAgentMaxIterations(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channel.appendLine(`\n✗ agent runtime error: ${msg}`);
    vscode.window.showErrorMessage(`Task failed: ${msg}`);
    return;
  }

  if (result.stopReason === 'stop' && result.toolErrors === 0 && result.executedToolCalls > 0) {
    await interactiveLock.run(async () => {
      await markTaskComplete(docUri, lineNumber, taskText);
    });
    channel.appendLine(
      `✓ Task complete via agent loop. ` +
      `${result.executedToolCalls} tool call(s), ${result.toolErrors} error(s).`,
    );
    vscode.window.showInformationMessage(`Task complete. ${result.executedToolCalls} tool call(s).`);
    return;
  }

  // Non-success terminal states. Surface the reason and (if a stash exists)
  // remind the user how to roll back.
  if (result.stopReason === 'cancelled') {
    channel.appendLine('\n⚠ Task cancelled.');
    return;
  }
  if (result.stopReason === 'aborted_by_user') {
    channel.appendLine('\n⚠ Task aborted during tool approval.');
    return;
  }
  if (result.stopReason === 'max_iterations') {
    channel.appendLine('\n⚠ Agent reached max iterations without finishing.');
    vscode.window.showWarningMessage(
      `Task stopped — max agent iterations reached. Inspect the Caramelo output channel. ` +
      (safety.kind === 'stashed' ? `Revert with: git stash pop "${safety.stashName}".` : ''),
    );
    return;
  }
  if (result.stopReason === 'error') {
    channel.appendLine(`\n✗ agent error: ${result.error ?? '(unknown)'}`);
    vscode.window.showErrorMessage(`Task failed: ${result.error ?? 'unknown error'}`);
    return;
  }
  if (result.executedToolCalls === 0) {
    channel.appendLine('\n⚠ Agent finished without taking any action.');
    vscode.window.showWarningMessage('Task ended with no changes. See the Caramelo output channel.');
  } else if (result.toolErrors > 0) {
    channel.appendLine(
      `\n⚠ Agent finished with ${result.toolErrors} tool error(s). Task NOT marked complete.`,
    );
    vscode.window.showWarningMessage(
      `Task finished with errors. ${result.toolErrors} tool call(s) failed. See the Caramelo output channel.`,
    );
  }
}
