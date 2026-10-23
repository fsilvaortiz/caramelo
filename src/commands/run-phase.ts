import * as vscode from 'vscode';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { TemplateManager } from '../speckit/templates.js';
import type { WorkflowEngine } from '../specs/workflow.js';
import { getPhaseStatus, type PhaseType } from '../specs/spec.js';
import { beginActionHooks } from '../speckit/hook-runner-vscode.js';
import { ensureCentralConstitutionCurrent } from '../constitution/central-vscode.js';
import type { HookAction } from '../speckit/hook-runner.js';

interface Refreshable { refresh(): void }

const PHASE_ORDER: PhaseType[] = ['requirements', 'design', 'tasks'];
/** Spec Kit command each phase corresponds to, for `before_` / `after_` hooks. */
const PHASE_HOOK_ACTION: Record<PhaseType, HookAction> = {
  requirements: 'specify',
  design: 'plan',
  tasks: 'tasks',
};

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
  specsTree: Refreshable
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

  if (!(await ensureCentralConstitutionCurrent())) return;

  const hooks = await beginActionHooks(PHASE_HOOK_ACTION[phase], spec.name, registry);
  if (!hooks) return;

  await workflowEngine.runPhase(spec, phase, registry, templateManager);
  specsTree.refresh();
  if (getPhaseStatus(spec, phase) === 'pending-approval') await hooks.after();
}
