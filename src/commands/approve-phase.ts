import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { SpecsTreeDataProvider } from '../views/sidebar/specs-tree.js';
import type { PhaseActionsCodeLensProvider } from '../views/codelens/phase-actions-codelens.js';
import { setPhaseStatus, getPhaseLabel, getNextPhase, type PhaseType } from '../specs/spec.js';
import { COMMAND_IDS } from '../constants.js';

export async function approvePhase(
  specName: string,
  phaseType: string,
  workspace: SpecWorkspace,
  specsTree: SpecsTreeDataProvider,
  phaseActionsProvider?: PhaseActionsCodeLensProvider
): Promise<void> {
  const specs = workspace.listSpecs();
  const spec = specs.find((s) => s.name === specName);
  if (!spec) {
    vscode.window.showErrorMessage(`Spec "${specName}" not found`);
    return;
  }

  setPhaseStatus(spec, phaseType as PhaseType, 'approved');
  specsTree.refresh();
  phaseActionsProvider?.fireRefresh();

  // Rebuild spec to get updated statuses
  const updatedSpecs = workspace.listSpecs();
  const updatedSpec = updatedSpecs.find((s) => s.name === specName);
  const next = updatedSpec ? getNextPhase(updatedSpec) : null;

  if (next) {
    const action = await vscode.window.showInformationMessage(
      `${getPhaseLabel(phaseType as PhaseType)} approved! Next: ${getPhaseLabel(next)}`,
      `Generate ${getPhaseLabel(next)}`,
      'Later'
    );
    if (action?.startsWith('Generate')) {
      vscode.commands.executeCommand(COMMAND_IDS.runPhase, specName, next);
    }
  } else {
    // All phases approved — offer to open tasks for implementation
    const action = await vscode.window.showInformationMessage(
      `All phases approved for "${specName}"! Ready to implement.`,
      'Open Tasks',
      'Later'
    );
    if (action === 'Open Tasks') {
      const tasksPath = path.join(updatedSpec!.dirPath, 'tasks.md');
      if (fs.existsSync(tasksPath)) {
        const doc = await vscode.workspace.openTextDocument(tasksPath);
        await vscode.window.showTextDocument(doc);
      }
    }
  }
}
