import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { COMMAND_IDS } from '../../constants.js';

class ConstitutionItem extends vscode.TreeItem {
  constructor(label: string, description: string, hasConstitution: boolean, extensionPath: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;

    if (hasConstitution) {
      this.iconPath = {
        light: vscode.Uri.file(path.join(extensionPath, 'resources', 'icons', 'phase-approved.svg')),
        dark: vscode.Uri.file(path.join(extensionPath, 'resources', 'icons', 'phase-approved.svg')),
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    }

    this.command = {
      command: COMMAND_IDS.editConstitution,
      title: 'Edit Constitution',
    };
  }
}

export class ConstitutionTreeDataProvider implements vscode.TreeDataProvider<ConstitutionItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ConstitutionItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly workspaceUri: vscode.Uri | undefined,
    private readonly extensionPath: string
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: ConstitutionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ConstitutionItem[] {
    if (!this.workspaceUri) {
      return [new ConstitutionItem('No workspace open', '', false, this.extensionPath)];
    }

    const constitutionPath = path.join(this.workspaceUri.fsPath, '.specify', 'memory', 'constitution.md');
    const exists = fs.existsSync(constitutionPath);

    if (exists) {
      const content = fs.readFileSync(constitutionPath, 'utf-8');
      const isTemplate = content.includes('[PRINCIPLE_1_NAME]') || content.includes('[PRINCIPLE_1_DESCRIPTION]');

      if (isTemplate) {
        return [new ConstitutionItem('Not configured', 'Click to set up', false, this.extensionPath)];
      }

      // Count principles
      const principles = (content.match(/^### /gm) || []).length;
      return [new ConstitutionItem('Configured', `${principles} principles`, true, this.extensionPath)];
    }

    return [new ConstitutionItem('Not configured', 'Click to set up', false, this.extensionPath)];
  }

  hasConstitution(): boolean {
    if (!this.workspaceUri) return false;
    const constitutionPath = path.join(this.workspaceUri.fsPath, '.specify', 'memory', 'constitution.md');
    if (!fs.existsSync(constitutionPath)) return false;
    const content = fs.readFileSync(constitutionPath, 'utf-8');
    return !content.includes('[PRINCIPLE_1_NAME]');
  }
}
