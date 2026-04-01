import * as vscode from 'vscode';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { SpecsTreeDataProvider } from '../views/sidebar/specs-tree.js';
import type { ConstitutionTreeDataProvider } from '../views/sidebar/constitution-tree.js';
import { COMMAND_IDS } from '../constants.js';

export async function newSpec(
  workspace: SpecWorkspace,
  specsTree: SpecsTreeDataProvider,
  constitutionTree: ConstitutionTreeDataProvider
): Promise<void> {
  // Constitution is mandatory before creating specs
  if (!constitutionTree.hasConstitution()) {
    const action = await vscode.window.showErrorMessage(
      'A project constitution is required before creating specs. It defines the principles that guide all spec generation.',
      'Set Up Constitution'
    );
    if (action === 'Set Up Constitution') {
      vscode.commands.executeCommand(COMMAND_IDS.editConstitution);
    }
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Feature name (e.g., "user-authentication")',
    placeHolder: 'feature-name',
    validateInput: (value) => {
      if (!value.trim()) return 'Name is required';
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value) && value.length > 1) {
        return 'Use lowercase letters, numbers, and hyphens only';
      }
      return null;
    },
  });
  if (!name) return;

  const description = await vscode.window.showInputBox({
    prompt: 'Brief feature description',
    placeHolder: 'Describe what this feature does...',
  });
  if (description === undefined) return;

  workspace.createSpec(name, description || name);
  specsTree.refresh();

  const generate = await vscode.window.showInformationMessage(
    `Spec "${name}" created. Generate Requirements now?`,
    'Generate',
    'Later'
  );

  if (generate === 'Generate') {
    vscode.commands.executeCommand(COMMAND_IDS.runPhase, name, 'requirements');
  }
}
