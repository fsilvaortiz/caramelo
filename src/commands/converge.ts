import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { LLMProvider } from '../providers/types.js';
import { AgentRuntime } from '../agent/runtime.js';
import { buildReadOnlyToolSet } from '../agent/tools/index.js';
import { pipeToOutputChannel } from '../agent/events.js';
import { readOnlyAutoBatchedWritesPolicy } from '../agent/approval.js';
import { isToolCallingProvider } from '../agent/types.js';
import { pickTerminalArtifact } from '../specs/workflow.js';
import { log } from '../utils/log.js';
import { getCarameloChannel } from '../utils/output-channel.js';
import { beginActionHooks } from '../speckit/hook-runner-vscode.js';
import {
  CONVERGE_SYSTEM_PROMPT,
  appendConvergencePhase,
  buildConvergeUserPrompt,
  collectReferencedFiles,
  formatFindingsTable,
  parseConvergeFindings,
  type ConvergeFinding,
  type ConvergeInputs,
} from './converge-core.js';

interface Refreshable { refresh(): void }

function useAgent(provider: LLMProvider): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('caramelo.useAgentLoop', true) && isToolCallingProvider(provider);
}

function maxIterations(): number {
  const raw = vscode.workspace.getConfiguration().get<number>('caramelo.agent.maxIterations');
  // Assessing a codebase needs more reads than generating a phase.
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 25;
  return Math.max(3, Math.min(50, Math.floor(raw)));
}

async function assess(
  provider: LLMProvider,
  inputs: ConvergeInputs,
  workspaceRoot: string,
  signal: AbortSignal,
  channel: vscode.OutputChannel,
): Promise<string> {
  if (useAgent(provider)) {
    const result = await new AgentRuntime().run(provider, {
      system: CONVERGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildConvergeUserPrompt(inputs, true) }],
      tools: buildReadOnlyToolSet(),
      approval: readOnlyAutoBatchedWritesPolicy({ isAutoApplyEnabled: () => false, setSessionAutoApply: () => { /* read-only */ } }),
      workspaceRoot,
      signal,
      onEvent: pipeToOutputChannel(channel),
      maxIterations: maxIterations(),
    });
    if (result.stopReason === 'cancelled' || result.stopReason === 'aborted_by_user') throw new Error('cancelled');
    if (result.stopReason !== 'stop') throw new Error(result.error ?? `agent stopped: ${result.stopReason}`);
    return pickTerminalArtifact(result.messages);
  }

  channel.appendLine('(provider has no tool calling — assessing files referenced by plan.md / tasks.md)');
  const withCode: ConvergeInputs = {
    ...inputs,
    referencedFiles: collectReferencedFiles(workspaceRoot, [inputs.planMd, inputs.tasksMd]),
  };
  channel.appendLine(`  included ${withCode.referencedFiles!.length} file(s)`);
  let raw = '';
  for await (const chunk of provider.chat(
    [{ role: 'system', content: CONVERGE_SYSTEM_PROMPT }, { role: 'user', content: buildConvergeUserPrompt(withCode, false) }],
    { signal },
  )) {
    raw += chunk;
  }
  if (signal.aborted) throw new Error('cancelled');
  return raw;
}

export async function convergeTasks(
  specName: string,
  workspace: SpecWorkspace,
  registry: ProviderRegistry,
  specsTree: Refreshable,
): Promise<void> {
  const provider = registry.activeProvider;
  if (!provider) {
    vscode.window.showWarningMessage('No active LLM provider. Configure one first.');
    vscode.commands.executeCommand('caramelo.selectProvider');
    return;
  }
  if (vscode.workspace.isTrusted === false) {
    vscode.window.showWarningMessage('Caramelo: LLM execution is blocked in untrusted workspaces. Trust the workspace to run converge.');
    return;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const spec = workspace.listSpecs().find((s) => s.name === specName);
  if (!spec || !workspaceRoot) {
    vscode.window.showErrorMessage(`Spec "${specName}" not found.`);
    return;
  }

  const files = { spec: 'spec.md', plan: 'plan.md', tasks: 'tasks.md' } as const;
  const prerequisite = { spec: '/speckit.specify (Generate Requirements)', plan: '/speckit.plan (Generate Design)', tasks: '/speckit.tasks (Generate Tasks)' };
  for (const key of ['spec', 'plan', 'tasks'] as const) {
    if (!fs.existsSync(path.join(spec.dirPath, files[key]))) {
      vscode.window.showErrorMessage(`Caramelo: cannot converge — ${files[key]} is missing. Run ${prerequisite[key]} first.`);
      return;
    }
  }

  // Before-hooks may edit tasks.md; read everything only afterwards.
  const hooks = await beginActionHooks('converge', specName, registry);
  if (!hooks) return;

  const tasksPath = path.join(spec.dirPath, files.tasks);
  const read = (f: string) => fs.readFileSync(path.join(spec.dirPath, f), 'utf-8');
  const constitutionPath = path.join(workspaceRoot, '.specify', 'memory', 'constitution.md');
  const inputs: ConvergeInputs = {
    specMd: read(files.spec),
    planMd: read(files.plan),
    tasksMd: read(files.tasks),
    constitutionMd: fs.existsSync(constitutionPath) ? fs.readFileSync(constitutionPath, 'utf-8') : undefined,
  };

  const channel = getCarameloChannel();
  channel.show(true);
  channel.appendLine(`\n${'─'.repeat(60)}`);
  channel.appendLine(`▶ Converge — ${specName}`);
  channel.appendLine('─'.repeat(60));

  let findings: ConvergeFinding[] | null = null;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Converging ${specName}…`, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        const raw = await assess(provider, inputs, workspaceRoot, abort.signal, channel);
        findings = parseConvergeFindings(raw);
        if (findings === null) {
          log.warn('[converge] unparseable findings (first 400 B):', raw.slice(0, 400));
          channel.appendLine('\n✗ The model did not return a findings JSON object. tasks.md was not changed.');
          vscode.window.showErrorMessage('Converge: the model returned no usable findings. tasks.md was not changed — try again.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        channel.appendLine(`\n✗ Converge ${msg === 'cancelled' ? 'cancelled' : `failed: ${msg}`}. tasks.md was not changed.`);
        if (msg !== 'cancelled') vscode.window.showErrorMessage(`Converge failed: ${msg}. tasks.md was not changed.`);
      }
    },
  );
  if (findings === null) return;
  const found: ConvergeFinding[] = findings;

  if (found.length === 0) {
    channel.appendLine('\n✅ Converged — the implementation satisfies the spec, plan, and tasks.');
    vscode.window.showInformationMessage(`✅ ${specName} converged — the implementation satisfies the spec, plan, and tasks.`);
    await hooks.after();
    return;
  }

  // Re-read right before writing: the assessment can take minutes and the user may have edited tasks.md.
  const current = fs.readFileSync(tasksPath, 'utf-8');
  fs.writeFileSync(tasksPath, appendConvergencePhase(current, found), 'utf-8');
  specsTree.refresh();
  channel.appendLine(`\n## Convergence Findings\n\n${formatFindingsTable(found)}\n`);
  channel.appendLine(`Appended ${found.length} task(s) to ${specName}/tasks.md. Run Implement to complete them; a follow-up converge should find fewer items.`);
  void vscode.window.showInformationMessage(
    `Converge: ${found.length} remaining item(s) appended to ${specName}/tasks.md as a Convergence phase.`,
    'Open tasks.md',
  ).then(async (choice) => {
    if (choice === 'Open tasks.md') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(tasksPath));
  });
  await hooks.after();
}
