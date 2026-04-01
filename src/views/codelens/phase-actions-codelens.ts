import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_IDS, SPECS_DIR_NAME } from '../../constants.js';
import {
  buildSpec,
  findSpecForFile,
  getNextPhase,
  getPhaseLabel,
  isPhaseUnlocked,
  type PhaseType,
  type Spec,
} from '../../specs/spec.js';

export class PhaseActionsCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private readonly watcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly workspaceUri: vscode.Uri | undefined) {
    if (workspaceUri) {
      const pattern = new vscode.RelativePattern(workspaceUri, `${SPECS_DIR_NAME}/**/.caramelo-meta.json`);
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.watcher.onDidChange(() => this._onDidChangeCodeLenses.fire());
      this.watcher.onDidCreate(() => this._onDidChangeCodeLenses.fire());
      this.watcher.onDidDelete(() => this._onDidChangeCodeLenses.fire());
    }

    // Also refresh when documents are saved
    vscode.workspace.onDidSaveTextDocument(() => this._onDidChangeCodeLenses.fire());
  }

  fireRefresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.workspaceUri) return [];

    const specsRoot = path.join(this.workspaceUri.fsPath, SPECS_DIR_NAME);
    const match = findSpecForFile(document.uri.fsPath, specsRoot);
    if (!match) return [];

    const specDir = path.join(specsRoot, match.specName);
    const spec = buildSpec(match.specName, specDir);
    const phase = spec.phases.find((p) => p.type === match.phaseType);
    if (!phase) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [];

    // === Row 1: Progress indicator ===
    lenses.push(...this.buildProgressIndicator(spec, range));

    // === Row 2: Action buttons ===
    lenses.push(...this.buildActionButtons(spec, match.phaseType, phase.status, range));

    return lenses;
  }

  private buildProgressIndicator(spec: Spec, range: vscode.Range): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const phases: PhaseType[] = ['requirements', 'design', 'tasks'];

    for (let i = 0; i < phases.length; i++) {
      const type = phases[i];
      const phase = spec.phases.find((p) => p.type === type)!;
      const label = getPhaseLabel(type);
      const unlocked = isPhaseUnlocked(spec, type);

      let symbol: string;
      let command: vscode.Command | undefined;

      switch (phase.status) {
        case 'approved':
          symbol = `$(pass-filled) ${label}`;
          command = {
            title: symbol,
            command: 'vscode.open',
            arguments: [vscode.Uri.file(path.join(spec.dirPath, phase.fileName))],
          };
          break;
        case 'pending-approval':
          symbol = `$(circle-filled) ${label}`;
          command = {
            title: symbol,
            command: 'vscode.open',
            arguments: [vscode.Uri.file(path.join(spec.dirPath, phase.fileName))],
          };
          break;
        case 'generating':
          symbol = `$(loading~spin) ${label}`;
          command = { title: symbol, command: '' };
          break;
        case 'stale':
          symbol = `$(warning) ${label}`;
          command = {
            title: symbol,
            command: COMMAND_IDS.regeneratePhase,
            arguments: [spec.name, type],
          };
          break;
        case 'pending':
          if (unlocked) {
            symbol = `$(circle-outline) ${label}`;
            command = {
              title: symbol,
              command: COMMAND_IDS.runPhase,
              arguments: [spec.name, type],
            };
          } else {
            symbol = `$(lock) ${label}`;
            command = {
              title: symbol,
              command: 'caramelo.showLockedMessage',
              arguments: [`Approve previous phase first`],
            };
          }
          break;
      }

      lenses.push(new vscode.CodeLens(range, command));

      // Arrow separator (except after last)
      if (i < phases.length - 1) {
        lenses.push(new vscode.CodeLens(range, { title: '→', command: '' }));
      }
    }

    return lenses;
  }

  private buildActionButtons(
    spec: Spec,
    phaseType: PhaseType,
    status: string,
    range: vscode.Range
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    // Spacer
    lenses.push(new vscode.CodeLens(range, { title: '   ', command: '' }));

    switch (status) {
      case 'pending-approval':
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(check) Approve',
            command: COMMAND_IDS.approvePhase,
            arguments: [spec.name, phaseType],
          })
        );
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(sync) Regenerate',
            command: COMMAND_IDS.regeneratePhase,
            arguments: [spec.name, phaseType],
          })
        );
        // Show "Next Phase" if there is one
        const next = getNextPhase(spec);
        if (next && next !== phaseType) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `$(arrow-right) Next: ${getPhaseLabel(next)}`,
              command: COMMAND_IDS.runPhase,
              arguments: [spec.name, next],
            })
          );
        }
        break;

      case 'approved':
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(pass-filled) Approved',
            command: '',
          })
        );
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(sync) Regenerate',
            command: COMMAND_IDS.regeneratePhase,
            arguments: [spec.name, phaseType],
          })
        );
        // Show next phase button
        const nextAfterApproved = getNextPhase(spec);
        if (nextAfterApproved) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `$(arrow-right) Next: ${getPhaseLabel(nextAfterApproved)}`,
              command: COMMAND_IDS.runPhase,
              arguments: [spec.name, nextAfterApproved],
            })
          );
        }
        break;

      case 'pending': {
        const unlocked = isPhaseUnlocked(spec, phaseType);
        if (unlocked) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `$(play) Generate ${getPhaseLabel(phaseType)}`,
              command: COMMAND_IDS.runPhase,
              arguments: [spec.name, phaseType],
            })
          );
        } else {
          lenses.push(
            new vscode.CodeLens(range, {
              title: '$(lock) Approve previous phase first',
              command: '',
            })
          );
        }
        break;
      }

      case 'generating':
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(loading~spin) Generating...',
            command: '',
          })
        );
        break;

      case 'stale':
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(warning) Outdated — a previous phase was regenerated',
            command: '',
          })
        );
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(sync) Regenerate',
            command: COMMAND_IDS.regeneratePhase,
            arguments: [spec.name, phaseType],
          })
        );
        break;
    }

    return lenses;
  }
}
