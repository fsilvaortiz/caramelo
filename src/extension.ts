import * as vscode from 'vscode';
import * as path from 'path';
import { ProviderRegistry } from './providers/registry.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { ClaudeProvider } from './providers/claude.js';
import { CopilotProvider } from './providers/copilot.js';
import { ProvidersViewProvider } from './views/sidebar/providers-view.js';
import { TaskCodeLensProvider } from './views/codelens/tasks-codelens.js';
import { PhaseActionsCodeLensProvider } from './views/codelens/phase-actions-codelens.js';
import { EditorContextTracker } from './views/editor-context.js';
import { DagView } from './views/webview/dag-view.js';
import { WorkflowViewProvider } from './views/sidebar/workflow-view.js';
import { SpecWorkspace } from './specs/workspace.js';
import { TemplateManager } from './speckit/templates.js';
import { WorkflowEngine } from './specs/workflow.js';
import { selectProvider } from './commands/select-provider.js';
import { runPhase } from './commands/run-phase.js';
import { approvePhase } from './commands/approve-phase.js';
import { startTask } from './commands/start-task.js';
import { syncTemplates } from './commands/sync-templates.js';
import { editConstitution } from './commands/edit-constitution.js';
import { clarifySpec } from './commands/clarify.js';
import { analyzeConsistency, fixSingleIssue } from './commands/analyze.js';
import { AnalysisCodeLensProvider } from './views/codelens/analysis-codelens.js';
import { createSpecFromJira } from './commands/create-spec-from-jira.js';
import { generateChecklist } from './commands/generate-checklist.js';
import { TemplateSync } from './speckit/sync.js';
import { COMMAND_IDS, VIEW_IDS, SETTINGS_KEYS } from './constants.js';
import { initProgressBar } from './progress.js';
import { log } from './utils/log.js';
import { migrateProviderSettingsToGlobal } from './utils/migrate-providers.js';
import type { ProviderConfig } from './constants.js';

export function activate(context: vscode.ExtensionContext): void {
  const registry = new ProviderRegistry();
  const secrets = context.secrets;

  // One-shot: lift legacy Workspace-scoped provider settings to Global so they
  // survive opening a different folder. Safe no-op if Global is already set.
  migrateProviderSettingsToGlobal().catch((err) => log.warn('provider settings migration failed:', err));

  // Register providers from settings
  const providerConfigs = vscode.workspace.getConfiguration().get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
  for (const config of providerConfigs) {
    if (config.type === 'jira') continue; // Jira is not an LLM provider
    let provider;
    if (config.type === 'copilot') {
      provider = new CopilotProvider(config.id, config.name, config.model);
    } else if (config.type === 'anthropic') {
      const apiKeyId = `caramelo.provider.${config.id}.apiKey`;
      provider = new ClaudeProvider({ ...config, apiKeyId }, secrets);
    } else {
      const apiKeyId = `caramelo.provider.${config.id}.apiKey`;
      provider = new OpenAICompatibleProvider({ ...config, apiKeyId }, secrets);
    }
    provider.authenticate().catch((err) => {
      log.debug(`authenticate failed for ${provider.id}:`, err);
    });
    registry.register(provider);
  }
  registry.restoreActiveFromSettings();

  // Progress bar in status bar
  initProgressBar(context);

  // Providers WebviewView
  const providersView = new ProvidersViewProvider(registry, secrets);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ProvidersViewProvider.viewType, providersView)
  );

  // Spec Workspace
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const specWorkspace = workspaceFolder ? new SpecWorkspace(workspaceFolder.uri) : undefined;
  const templateManager = new TemplateManager();
  const workflowEngine = new WorkflowEngine();

  // Workflow WebviewView (unified: constitution + specs + progress + tasks)
  const workflowView = new WorkflowViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WorkflowViewProvider.viewType, workflowView)
  );

  // CodeLens — tasks
  const codeLensProvider = new TaskCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: '**/*tasks*.md' }, codeLensProvider)
  );

  // CodeLens — analysis findings
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'markdown', pattern: '**/*analysis*' }, new AnalysisCodeLensProvider())
  );

  // CodeLens — phase actions (approve, regenerate, progress bar)
  const phaseActionsProvider = new PhaseActionsCodeLensProvider(workspaceFolder?.uri);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: '**/specs/**/*.md' }, phaseActionsProvider)
  );

  // Editor context tracker (sets when-clause contexts for editor/title buttons)
  const editorContext = new EditorContextTracker(workspaceFolder?.uri);
  context.subscriptions.push(editorContext);

  // Template Sync (background, fire-and-forget). On a successful
  // refresh we invalidate `templateManager.cache` so the next phase
  // generation reads the new disk content instead of stale in-memory
  // copies left over from a prior session. On a first-install failure
  // (no prior cache AND network/all-files failed) we surface a one-shot
  // toast — the alternative is silent breakage where the user has no
  // templates at all and gets opaque downstream errors.
  const templateSync = new TemplateSync();
  templateSync
    .checkForUpdates()
    .then((result) => {
      if (result.updated) {
        templateManager.clearCache();
      } else if (result.reason !== 'up-to-date' && result.version === undefined) {
        vscode.window.showWarningMessage(
          'Caramelo: could not download Spec Kit templates. Using bundled fallback. ' +
          'Try "Caramelo: Sync Spec Kit Templates" once you\'re online.',
        );
      }
    })
    .catch((err) => log.warn('template sync failed:', err));

  // Status bar. Click focuses the Providers sidebar webview — never
  // opens a top-bar QuickPick. Provider selection / editing lives
  // inline in the sidebar.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'caramelo.providers.focus';
  const updateStatusBar = () => {
    const active = registry.activeProvider;
    if (active) {
      statusBar.text = `$(hubot) ${active.displayName}`;
      statusBar.tooltip = `Caramelo: ${active.displayName} — click to manage providers`;
    } else {
      statusBar.text = '$(hubot) No Provider';
      statusBar.tooltip = 'Caramelo: click to open the Providers panel';
    }
    statusBar.show();
  };
  registry.onDidChangeActiveProvider(updateStatusBar);
  updateStatusBar();

  // Commands
  context.subscriptions.push(
    // Programmatic-only: accepts a providerId from the sidebar webview's
    // postMessage. Never invoked without an argument, so never falls
    // through to the legacy QuickPick.
    vscode.commands.registerCommand(COMMAND_IDS.selectProvider, (providerId?: string) => {
      if (!providerId) {
        // Human-initiated (command palette) → focus the sidebar instead
        // of the legacy top-bar picker.
        vscode.commands.executeCommand('caramelo.providers.focus');
        return;
      }
      return selectProvider(registry, secrets, providerId);
    }),
    vscode.commands.registerCommand('caramelo.addProvider', () =>
      // Routed to the sidebar's inline Add form — kept as a registered
      // command so keybindings / the command palette still work.
      vscode.commands.executeCommand('caramelo.providers.focus'),
    ),
    vscode.commands.registerCommand(COMMAND_IDS.editConstitution, () => {
      editConstitution(context, { refresh: () => workflowView.refresh() }, registry);
    }),
    vscode.commands.registerCommand(COMMAND_IDS.newSpec, () => {
      if (!specWorkspace) { vscode.window.showWarningMessage('No workspace folder open'); return; }
      // Trigger via workflow webview — the form is there now
      vscode.commands.executeCommand('caramelo.workflow.focus');
    }),
    vscode.commands.registerCommand(COMMAND_IDS.runPhase, (specNameOrItem: string | { spec: { name: string }; phase: { type: string } }, phaseType?: string) => {
      const [sn, pt] = extractSpecArgs(specNameOrItem, phaseType);
      if (!specWorkspace || !sn || !pt) return;
      runPhase(sn, pt, specWorkspace, registry, templateManager, workflowEngine, { refresh: () => workflowView.refresh() });
    }),
    vscode.commands.registerCommand(COMMAND_IDS.approvePhase, (specNameOrItem: string | { spec: { name: string }; phase: { type: string } }, phaseType?: string) => {
      const [sn, pt] = extractSpecArgs(specNameOrItem, phaseType);
      if (!specWorkspace || !sn || !pt) return;
      approvePhase(sn, pt, specWorkspace, { refresh: () => workflowView.refresh() }, phaseActionsProvider);
    }),
    vscode.commands.registerCommand(COMMAND_IDS.regeneratePhase, (specNameOrItem: string | { spec: { name: string }; phase: { type: string } }, phaseType?: string) => {
      const [sn, pt] = extractSpecArgs(specNameOrItem, phaseType);
      if (!specWorkspace || !sn || !pt) return;
      runPhase(sn, pt, specWorkspace, registry, templateManager, workflowEngine, { refresh: () => workflowView.refresh() });
    }),
    vscode.commands.registerCommand(COMMAND_IDS.startTask, async (lineNumber: number, taskText: string, docUri: vscode.Uri) => {
      await startTask(lineNumber, taskText, docUri, registry);
      workflowView.refresh();
    }),
    vscode.commands.registerCommand('caramelo.runNextTask', async (docUri: vscode.Uri) => {
      const doc = await vscode.workspace.openTextDocument(docUri);
      for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text.trimStart();
        if (/^- \[ \] /.test(text)) {
          const taskText = text.replace(/^- \[ \] /, '').trim();
          await startTask(i, taskText, docUri, registry);
          workflowView.refresh();
          return;
        }
      }
      vscode.window.showInformationMessage('All tasks are complete!');
    }),
    vscode.commands.registerCommand('caramelo.createSpecFromJira', () =>
      createSpecFromJira(workspaceFolder?.uri)
    ),
    vscode.commands.registerCommand('caramelo._getJiraToken', async (providerId: string) => {
      return secrets.get(`caramelo.jira.${providerId}.token`);
    }),
    vscode.commands.registerCommand('caramelo.openDag', () => {
      const dagView = new DagView(workspaceFolder?.uri);
      dagView.show();
    }),
    vscode.commands.registerCommand(COMMAND_IDS.syncTemplates, () => syncTemplates(templateSync)),
    vscode.commands.registerCommand('caramelo.clarify', () => {
      if (editorContext.currentSpecName && specWorkspace) {
        clarifySpec(editorContext.currentSpecName, specWorkspace, registry, workflowView);
      }
    }),
    vscode.commands.registerCommand('caramelo.analyze', () => {
      if (editorContext.currentSpecName && specWorkspace) {
        analyzeConsistency(editorContext.currentSpecName, specWorkspace, registry);
      }
    }),
    vscode.commands.registerCommand('caramelo.fixAllIssues', () => {
      if (editorContext.currentSpecName && specWorkspace) {
        // Re-run analyze which now offers "Fix All Issues" in the notification
        analyzeConsistency(editorContext.currentSpecName, specWorkspace, registry);
      }
    }),
    vscode.commands.registerCommand('caramelo.fixSingleIssue', (findingText: string, docs: string[]) => {
      if (editorContext.currentSpecName && specWorkspace) {
        const specDir = path.join(specWorkspace.getSpecsRoot(), editorContext.currentSpecName);
        fixSingleIssue(specDir, { severity: 'high', finding: findingText, documents: docs, section: '' }, registry);
      }
    }),
    vscode.commands.registerCommand('caramelo.generateChecklist', () => {
      if (editorContext.currentSpecName && editorContext.currentPhaseType && specWorkspace) {
        generateChecklist(editorContext.currentSpecName, editorContext.currentPhaseType, specWorkspace, registry);
      }
    }),
    vscode.commands.registerCommand('caramelo.approvePhaseFromEditor', () => {
      if (editorContext.currentSpecName && editorContext.currentPhaseType && specWorkspace) {
        approvePhase(editorContext.currentSpecName, editorContext.currentPhaseType, specWorkspace, { refresh: () => workflowView.refresh() }, phaseActionsProvider);
        setTimeout(() => editorContext.update(), 200);
      }
    }),
    vscode.commands.registerCommand('caramelo.regeneratePhaseFromEditor', () => {
      if (editorContext.currentSpecName && editorContext.currentPhaseType && specWorkspace) {
        runPhase(editorContext.currentSpecName, editorContext.currentPhaseType, specWorkspace, registry, templateManager, workflowEngine, { refresh: () => workflowView.refresh() });
      }
    }),
    vscode.commands.registerCommand('caramelo.nextPhaseFromEditor', () => {
      if (editorContext.currentSpecName && editorContext.currentNextPhase && specWorkspace) {
        runPhase(editorContext.currentSpecName, editorContext.currentNextPhase, specWorkspace, registry, templateManager, workflowEngine, { refresh: () => workflowView.refresh() });
      }
    }),
    vscode.commands.registerCommand('caramelo.runNextTaskFromEditor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text.trimStart();
        if (/^- \[ \] /.test(text)) {
          const taskText = text.replace(/^- \[ \] /, '').trim();
          await startTask(i, taskText, doc.uri, registry);
          workflowView.refresh();
          return;
        }
      }
      vscode.window.showInformationMessage('All tasks are complete!');
    }),
    vscode.commands.registerCommand('caramelo.runAllTasks', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;

      // Collect all pending tasks with parallel info
      interface PendingTask { line: number; text: string; isParallel: boolean }
      const pendingTasks: PendingTask[] = [];
      for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text.trimStart();
        if (/^- \[ \] /.test(text)) {
          const taskText = text.replace(/^- \[ \] /, '').trim();
          const isParallel = /\[P\]/.test(taskText);
          pendingTasks.push({ line: i, text: taskText, isParallel });
        }
      }

      if (pendingTasks.length === 0) {
        vscode.window.showInformationMessage('All tasks are already complete!');
        return;
      }

      // Count parallel groups
      const parallelCount = pendingTasks.filter(t => t.isParallel).length;
      const seqCount = pendingTasks.length - parallelCount;
      const msg = parallelCount > 0
        ? `Run ${pendingTasks.length} tasks? (${parallelCount} parallel, ${seqCount} sequential)`
        : `Run all ${pendingTasks.length} tasks sequentially?`;

      const confirm = await vscode.window.showInformationMessage(msg, 'Run All', 'Cancel');
      if (confirm !== 'Run All') return;

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
          vscode.window.showInformationMessage(
            `Running ${batch.length} tasks in parallel (${completed + 1}-${completed + batch.length}/${pendingTasks.length})`
          );

          const results = await Promise.allSettled(batch.map(async (task) => {
            const freshDoc = await vscode.workspace.openTextDocument(doc.uri);
            const currentLine = findTaskLine(freshDoc, task.text);
            if (currentLine >= 0) {
              await startTask(currentLine, task.text, doc.uri, registry);
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
            vscode.window.showWarningMessage(
              `${failed.length}/${batch.length} parallel task(s) failed. See Caramelo output for details. Continuing with the remaining batches.`
            );
          }
        } else {
          // Run sequential tasks one by one
          for (const task of batch) {
            completed++;
            vscode.window.showInformationMessage(
              `Running task ${completed}/${pendingTasks.length}: ${task.text.slice(0, 50)}...`
            );
            const freshDoc = await vscode.workspace.openTextDocument(doc.uri);
            const currentLine = findTaskLine(freshDoc, task.text);
            if (currentLine >= 0) {
              await startTask(currentLine, task.text, doc.uri, registry);
            }
          }
        }
      }

      vscode.window.showInformationMessage(`All ${pendingTasks.length} tasks executed!`);
      editorContext.update();
      workflowView.refresh();
    }),
    vscode.commands.registerCommand('caramelo.showLockedMessage', (reason: string) =>
      vscode.window.showInformationMessage(reason ?? 'Previous phase must be approved first')
    ),
    vscode.commands.registerCommand(COMMAND_IDS.viewChanges, () =>
      vscode.window.showInformationMessage('View Changes: Coming soon')
    ),
    registry,
    statusBar
  );
}

export function deactivate(): void {
  // Cleanup handled by disposables
}

function findTaskLine(doc: vscode.TextDocument, taskText: string): number {
  const searchStr = taskText.slice(0, 30);
  for (let j = 0; j < doc.lineCount; j++) {
    const lineText = doc.lineAt(j).text.trimStart();
    if (/^- \[ \] /.test(lineText) && lineText.includes(searchStr)) {
      return j;
    }
  }
  return -1;
}

function extractSpecArgs(
  specNameOrItem: string | { spec: { name: string }; phase: { type: string } },
  phaseType?: string
): [string | undefined, string | undefined] {
  if (typeof specNameOrItem === 'string') {
    return [specNameOrItem, phaseType];
  }
  if (specNameOrItem?.spec && specNameOrItem?.phase) {
    return [specNameOrItem.spec.name, specNameOrItem.phase.type];
  }
  return [undefined, undefined];
}
