import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderRegistry } from '../providers/registry.js';
import type { TemplateManager } from '../speckit/templates.js';
import { setPhaseStatus, markDownstreamStale, type PhaseType, type Spec } from './spec.js';
import { showProgress, updateProgress, hideProgress } from '../progress.js';
import { AgentRuntime } from '../agent/runtime.js';
import { buildDefaultToolSet } from '../agent/tools/index.js';
import { formatPrologue, pipeToOutputChannel } from '../agent/events.js';
import { autoAllAllPolicy, readOnlyAutoBatchedWritesPolicy } from '../agent/approval.js';
import { isToolCallingProvider } from '../agent/types.js';
import type { LLMProvider } from '../providers/types.js';

let phaseOutputChannel: vscode.OutputChannel | undefined;

function getPhaseOutputChannel(): vscode.OutputChannel {
  if (!phaseOutputChannel) {
    phaseOutputChannel = vscode.window.createOutputChannel('Caramelo');
  }
  return phaseOutputChannel;
}

function isAgentLoopEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('caramelo.useAgentLoop', true);
}

function isBashToolEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('caramelo.enableBashTool', true);
}

function getAgentMaxIterations(): number {
  const raw = vscode.workspace.getConfiguration().get<number>('caramelo.agent.maxIterations');
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 15;
  return Math.max(3, Math.min(50, Math.floor(raw)));
}

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

    // Constitution VIII (FR-018): untrusted workspaces block LLM
    // execution — both phase generation and agent tasks.
    if (vscode.workspace.isTrusted === false) {
      vscode.window.showWarningMessage(
        'Caramelo: LLM execution is blocked in untrusted workspaces. Trust the workspace to generate phases.',
      );
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

    const fileName = spec.phases.find((p) => p.type === phaseType)?.fileName;
    if (!fileName) return;
    const filePath = path.join(spec.dirPath, fileName);

    // Per research.md R11: only design (plan.md) and tasks (tasks.md) go
    // through the agent path — the LLM benefits from inspecting the
    // codebase when proposing file paths / tasks. requirements is
    // text-only (no code exists yet to explore); research.md / data-model.md
    // / contracts/ stay text-only (narrow structured-output prompts).
    const canAgent =
      (phaseType === 'design' || phaseType === 'tasks') &&
      isAgentLoopEnabled() &&
      isToolCallingProvider(provider);

    let output: string | null;
    if (canAgent) {
      output = await this.generatePhaseViaAgent(
        spec,
        phaseType,
        template,
        context,
        provider,
        filePath,
      );
    } else {
      const systemPrompt =
        `You are a spec-driven development assistant. Generate the document following the template ` +
        `structure exactly. Replace all placeholders with concrete details. Output only the markdown ` +
        `document content, no explanations. If a Project Constitution is provided in the context, ensure ` +
        `the generated document aligns with its principles and constraints.`;
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        {
          role: 'user' as const,
          content: `Generate the ${phaseType} document for the feature using this template:\n\n${template}\n\n---\n\nContext:\n${context}`,
        },
      ];
      output = await this.streamToFile(filePath, messages, provider, phaseType);
    }

    if (!output) {
      setPhaseStatus(spec, phaseType, 'pending');
      return;
    }

    setPhaseStatus(spec, phaseType, 'pending-approval');

    // Intermediate artifacts for the Design phase — always text-only per R11.
    // These are narrow structured-output tasks whose quality doesn't improve
    // with filesystem exploration.
    if (phaseType === 'design') {
      await this.generateIntermediateArtifacts(spec, output, context, provider);
    }
  }

  /**
   * Agent-driven phase generation. The agent can grep / file_read / glob
   * the real codebase while producing the artifact. The terminal
   * assistant message (no tool calls) IS the file content — written once
   * at the end rather than streamed word-by-word into the editor. That's
   * an intentional UX trade: tool-call visibility in the Output Channel
   * replaces the streaming-text UX from the text-only path.
   */
  private async generatePhaseViaAgent(
    spec: Spec,
    phaseType: PhaseType,
    template: string,
    context: string,
    provider: LLMProvider,
    filePath: string,
  ): Promise<string | null> {
    // Placeholder file opened right away so the user can see where the
    // artifact will land.
    fs.writeFileSync(
      filePath,
      `<!-- Caramelo agent is generating ${phaseType}…\n` +
      `     Tool calls stream to the Caramelo output channel. -->\n`,
      'utf-8',
    );
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });

    const channel = getPhaseOutputChannel();
    channel.show(true);
    channel.appendLine(`\n${'─'.repeat(60)}`);
    channel.appendLine(`▶ Phase: ${phaseType} — ${spec.name}`);
    channel.appendLine(`  ${new Date().toLocaleTimeString()}`);
    channel.appendLine('─'.repeat(60));

    const abortController = new AbortController();
    showProgress(`Generating ${phaseType} (agent)…`, () => abortController.abort());

    const tools = buildDefaultToolSet({ enableBash: isBashToolEnabled() });
    // Phase generation is read-heavy; still use the default write-approval
    // policy so any file_edit/file_write the agent proposes mid-generation
    // gets user review.
    const approval = isReadOnlyPhaseMode()
      ? autoAllAllPolicy() // fast path: reads auto-run, bash still prompts
      : readOnlyAutoBatchedWritesPolicy({
          isAutoApplyEnabled: () => false,
          setSessionAutoApply: () => { /* phase gen is one-shot; ignore */ },
        });

    const systemPrompt = buildAgentSystemPrompt(phaseType, template);
    const userPrompt =
      `Generate the ${phaseType} document for feature "${spec.name}".\n\n` +
      `Use the tools (file_read, grep, glob, list_dir) to inspect the real codebase whenever the ` +
      `template asks for paths, module names, or existing patterns — do NOT hallucinate file paths.\n\n` +
      `--- Context ---\n${context}\n\n` +
      `--- Template ---\n${template}\n\n` +
      `When you are done, emit the COMPLETE markdown artifact as your final assistant message with ` +
      `NO tool calls. The extension will take that final message and write it verbatim to ${path.basename(filePath)}.`;

    const prov = provider as LLMProvider & { id: string; displayName: string };
    channel.appendLine(
      formatPrologue({
        providerId: prov.id,
        providerName: prov.displayName,
        model: undefined,
        capabilities: Array.from(prov.capabilities()),
        toolNames: tools.map((t) => t.name),
        approvalMode: isReadOnlyPhaseMode() ? 'auto-all (phase-gen)' : 'auto-reads-batched-writes',
        bashEnabled: isBashToolEnabled(),
        maxIterations: getAgentMaxIterations(),
      }),
    );

    const runtime = new AgentRuntime();
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        channel.appendLine('\n✗ No workspace folder open.');
        return null;
      }

      const result = await runtime.run(provider, {
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools,
        approval,
        workspaceRoot,
        signal: abortController.signal,
        onEvent: pipeToOutputChannel(channel),
        maxIterations: getAgentMaxIterations(),
      });

      if (result.stopReason === 'cancelled') {
        channel.appendLine('\n⚠ Phase generation cancelled.');
        return null;
      }
      if (result.stopReason === 'error') {
        channel.appendLine(`\n✗ Phase generation error: ${result.error ?? '(unknown)'}`);
        vscode.window.showErrorMessage(
          `Phase generation failed: ${result.error ?? 'unknown error'}`,
        );
        return null;
      }
      if (result.stopReason === 'max_iterations') {
        channel.appendLine('\n⚠ Agent hit max iterations while generating the phase.');
        vscode.window.showWarningMessage(
          `${phaseType} generation stopped — max agent iterations. Inspect the Caramelo output channel.`,
        );
        return null;
      }

      // The terminal assistant message (no tool calls) is the artifact.
      // We walk backward from the end — if the model intersperses tool
      // calls with content, only the final empty-toolCalls turn counts.
      let artifact = '';
      for (let i = result.messages.length - 1; i >= 0; i--) {
        const m = result.messages[i];
        if (m.role !== 'assistant') continue;
        if (m.toolCalls && m.toolCalls.length > 0) continue;
        artifact = m.content;
        break;
      }

      if (!artifact.trim()) {
        channel.appendLine('\n⚠ Agent finished without producing a final artifact message.');
        vscode.window.showWarningMessage(
          `${phaseType} generation produced no content. The agent may have stopped early — see the Caramelo output channel.`,
        );
        return null;
      }

      fs.writeFileSync(filePath, artifact, 'utf-8');
      channel.appendLine(
        `\n✓ Phase ${phaseType} written (${artifact.length} B, ${result.executedToolCalls} tool call(s)).`,
      );
      return artifact;
    } finally {
      hideProgress();
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
      // Include Jira context if available
      const jiraContextPath = path.join(spec.dirPath, 'jira-context.md');
      if (fs.existsSync(jiraContextPath)) {
        parts.push(`## Jira Issue Context\n\n${fs.readFileSync(jiraContextPath, 'utf-8')}`);
      }
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

function buildAgentSystemPrompt(phaseType: PhaseType, template: string): string {
  return (
    `You are Caramelo, a spec-driven development assistant generating a ${phaseType} document.\n\n` +
    `You have tools:\n` +
    `  - file_read(path, [start_line, end_line])  — read a workspace file\n` +
    `  - list_dir(path?)                          — list a directory\n` +
    `  - grep(pattern, [path], [case_sensitive])  — regex search\n` +
    `  - glob(pattern)                            — file-path glob\n` +
    `  - file_edit(path, search, replace)         — (rarely needed) replace an exact snippet\n` +
    `  - file_write(path, content, [overwrite])   — (rarely needed) create or overwrite a file\n` +
    `  - bash(command, [cwd], [timeout_ms])       — shell command (user approval required)\n\n` +
    `Rules:\n` +
    `- Use read-only tools (file_read, grep, glob, list_dir) to INSPECT the codebase when the ` +
    `template asks for file paths, module names, or references to existing code.\n` +
    `- Do NOT write or edit files — the extension writes the final artifact for you. Only use ` +
    `file_write / file_edit if the template EXPLICITLY requires side-artifacts like contracts/.\n` +
    `- Follow the template structure exactly. Replace every placeholder with concrete details.\n` +
    `- When done, reply with the COMPLETE markdown document as your final message and emit NO ` +
    `tool calls — that is the signal that the document is ready.\n\n` +
    `Template (for reference):\n${template.slice(0, 400)}${template.length > 400 ? '…' : ''}`
  );
}

function isReadOnlyPhaseMode(): boolean {
  // Design/tasks phase generation is read-heavy. We still route writes
  // through approval by default, but users can set this to speed up
  // phase generation in trusted workspaces. Exposed as a future setting
  // — today it's hard-coded off so the default behaviour matches user
  // expectations.
  return false;
}
