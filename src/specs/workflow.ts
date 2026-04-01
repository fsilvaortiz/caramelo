import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderRegistry } from '../providers/registry.js';
import type { TemplateManager } from '../speckit/templates.js';
import { setPhaseStatus, markDownstreamStale, type PhaseType, type Spec } from './spec.js';
import { showProgress, updateProgress, hideProgress } from '../progress.js';

export class WorkflowEngine {
  async runPhase(
    spec: Spec,
    phaseType: PhaseType,
    registry: ProviderRegistry,
    templateManager: TemplateManager
  ): Promise<void> {
    const provider = registry.activeProvider;
    if (!provider) {
      vscode.window.showWarningMessage('No active LLM provider. Please configure one first.');
      vscode.commands.executeCommand('caramelo.selectProvider');
      return;
    }

    // If regenerating an already-completed phase, mark downstream phases as stale
    const currentStatus = spec.phases.find((p) => p.type === phaseType)?.status;
    if (currentStatus === 'approved' || currentStatus === 'pending-approval' || currentStatus === 'stale') {
      markDownstreamStale(spec, phaseType);
    }

    setPhaseStatus(spec, phaseType, 'generating');

    const templateKey = phaseType === 'requirements' ? 'spec' : phaseType === 'design' ? 'plan' : 'tasks';
    const template = templateManager.getTemplate(templateKey);
    const context = this.gatherContext(spec, phaseType);

    const systemPrompt = `You are a spec-driven development assistant. Generate the document following the template structure exactly. Replace all placeholders with concrete details. Output only the markdown document content, no explanations. If a Project Constitution is provided in the context, ensure the generated document aligns with its principles and constraints.`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      {
        role: 'user' as const,
        content: `Generate the ${phaseType} document for the feature using this template:\n\n${template}\n\n---\n\nContext:\n${context}`,
      },
    ];

    // Create the file and open it immediately so the user sees streaming
    const fileName = spec.phases.find((p) => p.type === phaseType)?.fileName;
    if (!fileName) return;
    const filePath = path.join(spec.dirPath, fileName);

    // Stream the main phase document
    const output = await this.streamToFile(filePath, messages, provider, phaseType);
    if (!output) {
      // Failed or cancelled — reset to pending so user can retry
      setPhaseStatus(spec, phaseType, 'pending');
      return;
    }

    setPhaseStatus(spec, phaseType, 'pending-approval');

    // Generate intermediate artifacts for the Design phase
    if (phaseType === 'design') {
      await this.generateIntermediateArtifacts(spec, output, context, provider);
    }
  }

  private async streamToFile(
    filePath: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    provider: Pick<import('../providers/types.js').LLMProvider, 'chat'>,
    label: string
  ): Promise<string | null> {
    fs.writeFileSync(filePath, `<!-- Generating ${label}... -->\n`, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const abortController = new AbortController();
    showProgress(`Generating ${label}...`, () => abortController.abort());

    try {
      return await (async () => {

        let output = '';
        let charCount = 0;

        try {
          const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
          await editor.edit((eb) => eb.replace(fullRange, ''));

          for await (const chunk of provider.chat(messages, { signal: abortController.signal })) {
            output += chunk;
            charCount += chunk.length;
            // Editor may have been closed — write to file directly if edit fails
            try {
              await editor.edit((eb) => eb.insert(doc.positionAt(doc.getText().length), chunk));
              const lastLine = doc.lineCount - 1;
              editor.revealRange(new vscode.Range(lastLine, 0, lastLine, 0), vscode.TextEditorRevealType.Default);
            } catch {
              // Editor closed — continue collecting output silently
            }
            updateProgress(`Generating ${label}... ${charCount} chars`);
          }
        } catch (err) {
          if (abortController.signal.aborted) return null;
          // If we have partial output, save it
          if (output.length > 0) {
            fs.writeFileSync(filePath, output, 'utf-8');
            vscode.window.showWarningMessage(
              `Generation interrupted with partial output saved. You can regenerate.`
            );
            return output;
          }
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Generation failed: ${msg}`);
          return null;
        }

        fs.writeFileSync(filePath, output, 'utf-8');
        return output;
      })();
    } finally {
      hideProgress();
    }
  }

  private async generateIntermediateArtifacts(
    spec: Spec,
    planContent: string,
    specContext: string,
    provider: Pick<import('../providers/types.js').LLMProvider, 'chat'>
  ): Promise<void> {
    // Generate research.md
    const researchPath = path.join(spec.dirPath, 'research.md');
    await this.generateArtifact(
      researchPath,
      'research decisions',
      `Based on the requirements and plan below, document key technical decisions. For each decision include: what was chosen, rationale, and alternatives considered. Output a markdown document.\n\n## Plan\n${planContent}\n\n${specContext}`,
      provider
    );

    // Generate data-model.md
    const dataModelPath = path.join(spec.dirPath, 'data-model.md');
    await this.generateArtifact(
      dataModelPath,
      'data model',
      `Based on the requirements below, extract all data entities with their attributes, relationships, validation rules, and state transitions. Output a structured markdown document with tables.\n\n${specContext}`,
      provider
    );
  }

  private async generateArtifact(
    filePath: string,
    label: string,
    prompt: string,
    provider: Pick<import('../providers/types.js').LLMProvider, 'chat'>
  ): Promise<void> {
    const messages = [
      { role: 'system' as const, content: `You are a spec-driven development assistant. Generate a ${label} document. Output only markdown content.` },
      { role: 'user' as const, content: prompt },
    ];

    let output = '';
    try {
      for await (const chunk of provider.chat(messages)) {
        output += chunk;
      }
      fs.writeFileSync(filePath, output, 'utf-8');
    } catch {
      // Non-critical — intermediate artifacts are optional
    }
  }

  private gatherContext(spec: Spec, phaseType: PhaseType): string {
    const parts: string[] = [];

    // Always include constitution if available
    const constitutionPath = path.join(spec.dirPath, '..', '..', '.specify', 'memory', 'constitution.md');
    const altConstitutionPath = path.join(spec.dirPath, '..', '..', '..', '.specify', 'memory', 'constitution.md');
    for (const cPath of [constitutionPath, altConstitutionPath]) {
      if (fs.existsSync(cPath)) {
        const content = fs.readFileSync(cPath, 'utf-8');
        if (!content.includes('[PRINCIPLE_1_NAME]')) {
          parts.push(`## Project Constitution\n\n${content}`);
        }
        break;
      }
    }

    if (phaseType === 'requirements') {
      parts.push(`Feature: ${spec.name}`);
    }

    if (phaseType === 'design' || phaseType === 'tasks') {
      const reqPath = path.join(spec.dirPath, 'spec.md');
      if (fs.existsSync(reqPath)) {
        parts.push(`## Requirements Document\n\n${fs.readFileSync(reqPath, 'utf-8')}`);
      }
    }

    if (phaseType === 'tasks') {
      // Include plan + intermediate artifacts
      for (const file of ['plan.md', 'research.md', 'data-model.md']) {
        const filePath = path.join(spec.dirPath, file);
        if (fs.existsSync(filePath)) {
          parts.push(`## ${file}\n\n${fs.readFileSync(filePath, 'utf-8')}`);
        }
      }
      // Include contracts
      const contractsDir = path.join(spec.dirPath, 'contracts');
      if (fs.existsSync(contractsDir)) {
        const files = fs.readdirSync(contractsDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
          parts.push(`## Contract: ${file}\n\n${fs.readFileSync(path.join(contractsDir, file), 'utf-8')}`);
        }
      }
    }

    return parts.join('\n\n---\n\n');
  }
}
