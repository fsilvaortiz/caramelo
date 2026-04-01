import * as vscode from 'vscode';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { TemplateManager } from '../speckit/templates.js';
import type { WorkflowEngine } from '../specs/workflow.js';
import type { SpecsTreeDataProvider } from '../views/sidebar/specs-tree.js';
import { getPhaseStatus, type PhaseType } from '../specs/spec.js';

const PHASE_ORDER: PhaseType[] = ['requirements', 'design', 'tasks'];
const PHASE_LABELS: Record<PhaseType, string> = {
  requirements: 'Requirements',
  design: 'Design',
  tasks: 'Tasks',
};

export async function runPhase(
  specName: string,
  phaseType: string,
  workspace: SpecWorkspace,
  registry: ProviderRegistry,
  templateManager: TemplateManager,
  workflowEngine: WorkflowEngine,
  specsTree: SpecsTreeDataProvider
): Promise<void> {
  if (!registry.activeProvider) {
    vscode.window.showWarningMessage('No active LLM provider. Configure one first.');
    vscode.commands.executeCommand('caramelo.selectProvider');
    return;
  }

  const specs = workspace.listSpecs();
  const spec = specs.find((s) => s.name === specName);
  if (!spec) {
    vscode.window.showErrorMessage(`Spec "${specName}" not found`);
    return;
  }

  const phase = phaseType as PhaseType;
  const phaseIndex = PHASE_ORDER.indexOf(phase);

  // Strict gate: previous phase MUST be approved
  for (let i = 0; i < phaseIndex; i++) {
    const prereq = PHASE_ORDER[i];
    const status = getPhaseStatus(spec, prereq);
    if (status !== 'approved') {
      vscode.window.showWarningMessage(
        `Cannot generate "${PHASE_LABELS[phase]}" yet. Approve "${PHASE_LABELS[prereq]}" first.`
      );
      return;
    }
  }

  await workflowEngine.runPhase(spec, phase, registry, templateManager);
  specsTree.refresh();
}
