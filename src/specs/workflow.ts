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
import type { AgentMessage } from '../agent/types.js';
import type { LLMProvider } from '../providers/types.js';
import { log } from '../utils/log.js';

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

// ---------------------------------------------------------------------------
// Pure helpers extracted so the behaviour is unit-testable without booting
// the whole VS Code stack. See `__tests__/workflow.test.ts`.
// ---------------------------------------------------------------------------

/**
 * Decide whether the given phase generation should go through the agent
 * loop or the legacy text-only path. Only `design` and `tasks` benefit
 * from filesystem exploration (the LLM needs to see real paths / patterns);
 * `requirements` has no existing code to inspect.
 */
export function shouldUsePhaseAgent(
  phaseType: PhaseType,
  agentLoopEnabled: boolean,
  toolCallingProvider: boolean,
): boolean {
  if (phaseType !== 'design' && phaseType !== 'tasks') return false;
  return agentLoopEnabled && toolCallingProvider;
}

/**
 * The terminal assistant message (no tool calls) IS the artifact.
 *
 * The agent may interleave text and tool_calls across turns — e.g., emit
 * an interim narration message that contains both text and a tool_call.
 * Only a turn with `toolCalls` empty or absent qualifies as the final
 * artifact. Walking backwards is necessary because the runtime sometimes
 * persists a placeholder assistant turn between the last tool result and
 * the final message.
 *
 * Returns an empty string when no suitable terminal message exists —
 * callers must treat that as "nothing to write" (don't clobber the
 * placeholder with empty content).
 */
export function pickTerminalArtifact(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (m.toolCalls && m.toolCalls.length > 0) continue;
    return m.content;
  }
  return '';
}

// ---------------------------------------------------------------------------

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

    // Untrusted workspaces block LLM execution — both the agent path and
    // the legacy text-only path. The check lives here (before any file
    // IO or progress indicator) so the refusal message is the first
    // thing the user sees.
    if (vscode.workspace.isTrusted === false) {
      vscode.window.showWarningMessage(
        'Caramelo: LLM execution is blocked in untrusted workspaces. Trust the workspace to generate phases.',
      );
      return;
    }

    // Regenerating an already-completed phase marks downstream as stale
    // so the sidebar nudges the user to regenerate them too.
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

    const useAgent = shouldUsePhaseAgent(
      phaseType,
      isAgentLoopEnabled(),
      isToolCallingProvider(provider),
    );

    let output: string | null;
    if (useAgent) {
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

    // Intermediate artifacts for the Design phase — always text-only.
    // Narrow structured-output prompts don't benefit from filesystem
    // exploration; keeping them on chat() saves tokens and matches the
    // 3-separate-calls UX of streaming into the editor.
    if (phaseType === 'design') {
      await this.generateIntermediateArtifacts(spec, output, context, provider);
    }
  }

  /**
   * Agent-driven phase generation. The agent can grep / file_read / glob
   * the real codebase while producing the artifact. The terminal
   * assistant message (no tool calls) IS the file content — written once
   * at the end rather than streamed word-by-word into the editor. Tool
   * calls stream to the Output Channel instead, so the user still sees
   * the generation happening — just in a different surface.
   */
  private async generatePhaseViaAgent(
    spec: Spec,
    phaseType: PhaseType,
    template: string,
    context: string,
    provider: LLMProvider,
    filePath: string,
  ): Promise<string | null> {
    // Placeholder file opened right away so the user sees where the
    // artifact will land. We delete it on cancel/error so the user
    // doesn't end up with a half-empty `plan.md` containing only our
    // HTML comment.
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
    const approval = readOnlyAutoBatchedWritesPolicy({
      isAutoApplyEnabled: () => false,
      setSessionAutoApply: () => { /* phase gen is one-shot; don't persist */ },
    });
    // Silence unused-import warning: autoAllAllPolicy is retained as an
    // escape hatch for when we expose a "fast phase gen" setting.
    void autoAllAllPolicy;

    const systemPrompt = buildAgentSystemPrompt(phaseType, template);
    const userPrompt =
      `Generate the ${phaseType} document for feature "${spec.name}".\n\n` +
      `Use the tools (file_read, grep, glob, list_dir) to inspect the real codebase whenever the ` +
      `template asks for paths, module names, or existing patterns — do NOT hallucinate file paths.\n\n` +
      `--- Context ---\n${context}\n\n` +
      `--- Template ---\n${template}\n\n` +
      `When you are done, emit the COMPLETE markdown artifact as your final assistant message with ` +
      `NO tool calls. The extension will take that final message and write it verbatim to ${path.basename(filePath)}.`;

    channel.appendLine(
      formatPrologue({
        providerId: provider.id,
        providerName: provider.displayName,
        model: undefined,
        capabilities: Array.from(provider.capabilities()),
        toolNames: tools.map((t) => t.name),
        approvalMode: 'auto-reads-batched-writes',
        bashEnabled: isBashToolEnabled(),
        maxIterations: getAgentMaxIterations(),
      }),
    );

    const runtime = new AgentRuntime();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      channel.appendLine('\n✗ No workspace folder open.');
      hideProgress();
      cleanupPlaceholder(filePath);
      return null;
    }

    try {
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
        cleanupPlaceholder(filePath);
        return null;
      }
      if (result.stopReason === 'error') {
        channel.appendLine(`\n✗ Phase generation error: ${result.error ?? '(unknown)'}`);
        vscode.window.showErrorMessage(
          `Phase generation failed: ${result.error ?? 'unknown error'}`,
        );
        cleanupPlaceholder(filePath);
        return null;
      }
      if (result.stopReason === 'max_iterations') {
        channel.appendLine('\n⚠ Agent hit max iterations while generating the phase.');
        vscode.window.showWarningMessage(
          `${phaseType} generation stopped — max agent iterations. Inspect the Caramelo output channel.`,
        );
        cleanupPlaceholder(filePath);
        return null;
      }

      const artifact = pickTerminalArtifact(result.messages);
      if (!artifact.trim()) {
        channel.appendLine('\n⚠ Agent finished without producing a final artifact message.');
        vscode.window.showWarningMessage(
          `${phaseType} generation produced no content. The agent may have stopped early — see the Caramelo output channel.`,
        );
        cleanupPlaceholder(filePath);
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
            try {
              await editor.edit((eb) => eb.insert(doc.positionAt(doc.getText().length), chunk));
              const lastLine = doc.lineCount - 1;
              editor.revealRange(new vscode.Range(lastLine, 0, lastLine, 0), vscode.TextEditorRevealType.Default);
            } catch (err) {
              // Editor may have been closed or the document disposed —
              // swallow so we keep collecting output into the file. Log
              // at debug so a recurring failure (e.g. broken extension
              // host editor state) isn't invisible.
              log.debug('[workflow] editor.edit failed — continuing:', err);
            }
            updateProgress(`Generating ${label}... ${charCount} chars`);
          }
        } catch (err) {
          if (abortController.signal.aborted) return null;
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
    const researchPath = path.join(spec.dirPath, 'research.md');
    await this.generateArtifact(
      researchPath,
      'research decisions',
      `Based on the requirements and plan below, document key technical decisions. For each decision include: what was chosen, rationale, and alternatives considered. Output a markdown document.\n\n## Plan\n${planContent}\n\n${specContext}`,
      provider
    );

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
    } catch (err) {
      // Intermediate artifacts are optional — we don't abort the whole
      // phase if research.md fails — but the failure MUST surface. A
      // silent catch has left downstream `tasks` phase reading stale
      // files in the past.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[workflow] ${label} generation failed:`, msg);
      vscode.window.showWarningMessage(
        `Caramelo: ${label} artifact could not be generated (${msg}). ` +
        `The main phase document was saved. You can regenerate ${path.basename(filePath)} ` +
        `manually or retry the phase.`,
      );
      // If we produced partial output before the error, save it so the
      // user can inspect it.
      if (output.length > 0) {
        try {
          fs.writeFileSync(filePath, output, 'utf-8');
        } catch (writeErr) {
          log.warn(`[workflow] could not save partial ${label}:`, writeErr);
        }
      }
    }
  }

  private gatherContext(spec: Spec, phaseType: PhaseType): string {
    const parts: string[] = [];

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
      for (const file of ['plan.md', 'research.md', 'data-model.md']) {
        const filePath = path.join(spec.dirPath, file);
        if (fs.existsSync(filePath)) {
          parts.push(`## ${file}\n\n${fs.readFileSync(filePath, 'utf-8')}`);
        }
      }
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

/** Remove the placeholder file we opened up-front. Silent on ENOENT. */
function cleanupPlaceholder(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      log.debug('[workflow] could not remove placeholder:', err);
    }
  }
}
