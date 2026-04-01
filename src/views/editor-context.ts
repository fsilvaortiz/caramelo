import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SPECS_DIR_NAME } from '../constants.js';
import { buildSpec, findSpecForFile, getNextPhase, type PhaseType } from '../specs/spec.js';

/**
 * Tracks the active editor and sets VS Code context keys
 * so editor/title buttons appear conditionally.
 */
export class EditorContextTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  // Current editor state
  currentSpecName: string | undefined;
  currentPhaseType: PhaseType | undefined;
  currentNextPhase: PhaseType | undefined;

  constructor(private readonly workspaceUri: vscode.Uri | undefined) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidSaveTextDocument(() => this.update())
    );
    // Initial update
    this.update();
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.workspaceUri) {
      this.clear();
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const specsRoot = path.join(this.workspaceUri.fsPath, SPECS_DIR_NAME);

    // Check if it's a spec document
    const match = findSpecForFile(filePath, specsRoot);
    if (!match) {
      // Check if it's a tasks file (might have pending tasks)
      if (filePath.includes('tasks') && filePath.endsWith('.md')) {
        this.checkTasksFile(editor.document);
      } else {
        this.clear();
      }
      return;
    }

    const specDir = path.join(specsRoot, match.specName);
    const spec = buildSpec(match.specName, specDir);
    const phase = spec.phases.find((p) => p.type === match.phaseType);

    this.currentSpecName = match.specName;
    this.currentPhaseType = match.phaseType;

    // Set phase status context
    vscode.commands.executeCommand('setContext', 'caramelo.editorPhaseStatus', phase?.status ?? '');

    // Set requirements context (for Clarify button)
    vscode.commands.executeCommand('setContext', 'caramelo.editorIsRequirements', match.phaseType === 'requirements');

    // Set multiple phases context (for Analyze button)
    const phaseFileCount = spec.phases.filter((p) => {
      const pPath = path.join(specDir, p.fileName);
      return fs.existsSync(pPath);
    }).length;
    vscode.commands.executeCommand('setContext', 'caramelo.editorHasMultiplePhases', phaseFileCount >= 2);

    // Set next phase context
    const next = getNextPhase(spec);
    this.currentNextPhase = next ?? undefined;
    vscode.commands.executeCommand('setContext', 'caramelo.editorHasNextPhase',
      next !== null && next !== match.phaseType
    );

    // Check for pending tasks if this is a tasks file
    if (match.phaseType === 'tasks') {
      this.checkTasksFile(editor.document);
    } else {
      vscode.commands.executeCommand('setContext', 'caramelo.editorHasPendingTasks', false);
    }
  }

  private checkTasksFile(document: vscode.TextDocument): void {
    let hasPending = false;
    for (let i = 0; i < document.lineCount; i++) {
      if (/^\s*- \[ \] /.test(document.lineAt(i).text)) {
        hasPending = true;
        break;
      }
    }
    vscode.commands.executeCommand('setContext', 'caramelo.editorHasPendingTasks', hasPending);
  }

  private clear(): void {
    this.currentSpecName = undefined;
    this.currentPhaseType = undefined;
    this.currentNextPhase = undefined;
    vscode.commands.executeCommand('setContext', 'caramelo.editorPhaseStatus', '');
    vscode.commands.executeCommand('setContext', 'caramelo.editorHasNextPhase', false);
    vscode.commands.executeCommand('setContext', 'caramelo.editorHasPendingTasks', false);
    vscode.commands.executeCommand('setContext', 'caramelo.editorIsRequirements', false);
    vscode.commands.executeCommand('setContext', 'caramelo.editorHasMultiplePhases', false);
  }

  dispose(): void {
    this.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}
