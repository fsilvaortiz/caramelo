import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../../specs/workspace.js';
import type { Spec, SpecPhase, PhaseStatus, PhaseType } from '../../specs/spec.js';
import { COMMAND_IDS } from '../../constants.js';

type TreeItemType = SpecItem | PhaseItem | ArtifactItem;

const DESIGN_ARTIFACTS = ['research.md', 'data-model.md'];

const PHASE_ORDER: PhaseType[] = ['requirements', 'design', 'tasks'];

class SpecItem extends vscode.TreeItem {
  constructor(public readonly spec: Spec) {
    super(spec.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'spec';
    this.tooltip = `Spec: ${spec.name}`;
  }
}

class PhaseItem extends vscode.TreeItem {
  constructor(
    public readonly spec: Spec,
    public readonly phase: SpecPhase,
    isLocked: boolean,
    lockedReason: string | null,
    extensionPath: string
  ) {
    // Design phase is collapsible if it has intermediate artifacts
    const hasArtifacts = phase.type === 'design' && DESIGN_ARTIFACTS.some(
      (f) => fs.existsSync(path.join(spec.dirPath, f))
    );
    super(
      formatPhaseLabel(phase.type),
      hasArtifacts ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    if (isLocked) {
      this.description = '🔒 Locked';
      this.tooltip = lockedReason ?? 'Previous phase must be approved first';
      this.contextValue = 'specPhase.locked';
      this.iconPath = {
        light: vscode.Uri.file(path.join(extensionPath, 'resources', 'icons', 'phase-pending.svg')),
        dark: vscode.Uri.file(path.join(extensionPath, 'resources', 'icons', 'phase-pending.svg')),
      };
      this.command = {
        command: 'caramelo.showLockedMessage',
        title: 'Locked',
        arguments: [lockedReason],
      };
      return;
    }

    this.description = formatStatus(phase.status);
    this.contextValue = `specPhase.${phase.status}`;
    this.tooltip = `${formatPhaseLabel(phase.type)}: ${phase.status}`;

    const iconName = statusToIcon(phase.status);
    this.iconPath = {
      light: vscode.Uri.file(path.join(extensionPath, 'resources', 'icons', `${iconName}.svg`)),
      dark: vscode.Uri.file(path.join(extensionPath, 'resources', 'icons', `${iconName}.svg`)),
    };

    if (phase.status === 'pending') {
      this.command = {
        command: COMMAND_IDS.runPhase,
        title: 'Generate',
        arguments: [spec.name, phase.type],
      };
    } else if (phase.status === 'pending-approval') {
      this.description = '⏳ Review & Approve';
      const filePath = path.join(spec.dirPath, phase.fileName);
      this.command = {
        command: 'vscode.open',
        title: 'Open for Review',
        arguments: [vscode.Uri.file(filePath)],
      };
    } else if (phase.status === 'approved') {
      this.description = '✓ Approved';
      const filePath = path.join(spec.dirPath, phase.fileName);
      this.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(filePath)],
      };
    }
  }
}

export class SpecsTreeDataProvider implements vscode.TreeDataProvider<TreeItemType> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeItemType | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private constitutionChecker?: () => boolean;

  constructor(
    private readonly workspace: SpecWorkspace | undefined,
    private readonly extensionPath: string
  ) {
    workspace?.onDidChangeSpecs(() => this.refresh());
  }

  setConstitutionChecker(checker: () => boolean): void {
    this.constitutionChecker = checker;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: TreeItemType): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItemType): TreeItemType[] {
    if (!this.workspace) return [];

    if (!element) {
      // Show message if constitution not configured
      if (this.constitutionChecker && !this.constitutionChecker()) {
        const item = new vscode.TreeItem('Set up Constitution to begin', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
        item.command = { command: COMMAND_IDS.editConstitution, title: 'Set Up Constitution' };
        item.tooltip = 'A project constitution is required before creating specs';
        return [item] as TreeItemType[];
      }
      return this.workspace.listSpecs().map((spec) => new SpecItem(spec));
    }

    if (element instanceof SpecItem) {
      const spec = element.spec;
      return spec.phases.map((phase) => {
        const phaseIndex = PHASE_ORDER.indexOf(phase.type);
        let isLocked = false;
        let lockedReason: string | null = null;

        // Check if previous phase is approved
        if (phaseIndex > 0) {
          const prevPhase = spec.phases[phaseIndex - 1];
          if (prevPhase.status !== 'approved') {
            isLocked = true;
            lockedReason = `Approve "${formatPhaseLabel(prevPhase.type)}" first`;
          }
        }

        return new PhaseItem(spec, phase, isLocked, lockedReason, this.extensionPath);
      });
    }

    if (element instanceof PhaseItem && element.phase.type === 'design') {
      // Show intermediate artifacts under Design
      const artifacts: ArtifactItem[] = [];
      for (const fileName of DESIGN_ARTIFACTS) {
        const filePath = path.join(element.spec.dirPath, fileName);
        if (fs.existsSync(filePath)) {
          artifacts.push(new ArtifactItem(fileName, filePath));
        }
      }
      // Check contracts directory
      const contractsDir = path.join(element.spec.dirPath, 'contracts');
      if (fs.existsSync(contractsDir)) {
        const files = fs.readdirSync(contractsDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
          artifacts.push(new ArtifactItem(`contracts/${file}`, path.join(contractsDir, file)));
        }
      }
      return artifacts;
    }

    return [];
  }
}

class ArtifactItem extends vscode.TreeItem {
  constructor(label: string, filePath: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'artifact';
    this.tooltip = filePath;
    this.iconPath = new vscode.ThemeIcon('file');
    this.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

function formatPhaseLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatStatus(status: PhaseStatus): string {
  switch (status) {
    case 'pending': return 'Ready';
    case 'generating': return 'Generating...';
    case 'pending-approval': return 'Review';
    case 'approved': return 'Approved';
    case 'stale': return '⚠ Outdated';
  }
}

function statusToIcon(status: PhaseStatus): string {
  switch (status) {
    case 'pending': return 'phase-pending';
    case 'generating': return 'phase-generating';
    case 'pending-approval': return 'phase-review';
    case 'approved': return 'phase-approved';
    case 'stale': return 'phase-review'; // Use review icon with warning description
  }
}
