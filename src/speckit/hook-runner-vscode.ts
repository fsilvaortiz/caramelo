import * as vscode from 'vscode';
import * as fs from 'fs';
import type { ProviderRegistry } from '../providers/registry.js';
import { AgentRuntime } from '../agent/runtime.js';
import { buildDefaultToolSet } from '../agent/tools/index.js';
import { pipeToOutputChannel } from '../agent/events.js';
import { readOnlyAutoBatchedWritesPolicy } from '../agent/approval.js';
import { isToolCallingProvider } from '../agent/types.js';
import { getCarameloChannel } from '../utils/output-channel.js';
import { loadHooks, type HookEntry } from './extensions.js';
import { evaluateHookCondition } from './hook-conditions.js';
import { resolveHookCommand, renderExtensionCommand } from './hook-commands.js';
import {
  runHooks,
  hookArguments,
  type HookAction,
  type HookRunContext,
  type HookRunnerDeps,
  type HookTiming,
} from './hook-runner.js';

const SYSTEM_PROMPT =
  'You are Caramelo, executing a Spec Kit extension hook inside the user\'s workspace. ' +
  'Follow the command instructions below exactly as a coding agent would. Use the available tools ' +
  'to read files, run the scripts the instructions name, and make the edits they ask for. ' +
  'When finished, reply with a short summary of what you did and anything the user must act on.';

export function hooksEnabled(): boolean {
  if (vscode.workspace.isTrusted === false) return false;
  return vscode.workspace.getConfiguration().get<boolean>('caramelo.hooks.run', true);
}

function label(hook: HookEntry): string {
  return `/${hook.command}${hook.extension ? ` (${hook.extension})` : ''}`;
}

function getAgentMaxIterations(): number {
  const raw = vscode.workspace.getConfiguration().get<number>('caramelo.agent.maxIterations');
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 15;
  return Math.max(3, Math.min(50, Math.floor(raw)));
}

export function createVsCodeHookDeps(registry: ProviderRegistry): HookRunnerDeps {
  return {
    isEnabled: hooksEnabled,
    loadHooks,
    conditionMet: (hook, ctx) =>
      evaluateHookCondition(hook.condition, { workspaceRoot: ctx.workspaceRoot, extensionId: hook.extension }),

    preparePrompt(hook, ctx, event) {
      const resolved = resolveHookCommand(ctx.workspaceRoot, hook.command, hook.extension);
      const body = renderExtensionCommand(fs.readFileSync(resolved.filePath, 'utf-8'), {
        workspaceRoot: ctx.workspaceRoot,
        extensionId: resolved.extensionId,
        extensionDir: resolved.extensionDir,
      });
      return body.split('$ARGUMENTS').join(hookArguments(event, ctx));
    },

    async confirmOptional(hook, event) {
      const detail = [hook.prompt, hook.description].filter(Boolean).join('\n\n');
      const choice = await vscode.window.showInformationMessage(
        `Run optional Spec Kit hook ${label(hook)}? (${event})`,
        { modal: true, detail: detail || undefined },
        'Run',
      );
      return choice === 'Run';
    },

    async execute(hook, prompt, ctx, event) {
      const provider = registry.activeProvider;
      if (!provider) throw new Error('no active LLM provider');

      const channel = getCarameloChannel();
      channel.show(true);
      channel.appendLine(`\n${'─'.repeat(60)}`);
      channel.appendLine(`▶ Hook ${event}: ${label(hook)}${ctx.specName ? ` — ${ctx.specName}` : ''}`);
      channel.appendLine('─'.repeat(60));

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Spec Kit hook ${label(hook)}…`, cancellable: true },
        async (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());

          if (!isToolCallingProvider(provider)) {
            channel.appendLine('(provider has no tool calling — running the hook as a text-only prompt)\n');
            for await (const chunk of provider.chat(
              [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
              { signal: abort.signal },
            )) {
              channel.append(chunk);
            }
            if (abort.signal.aborted) throw new Error('cancelled by user');
            channel.appendLine(`\n✓ Hook ${label(hook)} finished.`);
            return;
          }

          const enableBash = vscode.workspace.getConfiguration().get<boolean>('caramelo.enableBashTool', true);
          const result = await new AgentRuntime().run(provider, {
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
            tools: buildDefaultToolSet({ enableBash }),
            approval: readOnlyAutoBatchedWritesPolicy({
              isAutoApplyEnabled: () => false,
              setSessionAutoApply: () => { /* per-hook approvals are not persisted */ },
            }),
            workspaceRoot: ctx.workspaceRoot,
            signal: abort.signal,
            onEvent: pipeToOutputChannel(channel),
            maxIterations: getAgentMaxIterations(),
          });
          if (result.stopReason === 'cancelled' || result.stopReason === 'aborted_by_user') {
            throw new Error('cancelled by user');
          }
          if (result.stopReason !== 'stop') {
            throw new Error(result.error ?? `agent stopped: ${result.stopReason}`);
          }
          channel.appendLine(`\n✓ Hook ${label(hook)} finished (${result.executedToolCalls} tool call(s)).`);
        },
      );
    },

    async confirmContinueAfterFailure(hook, event, error) {
      const choice = await vscode.window.showWarningMessage(
        `Mandatory Spec Kit hook ${label(hook)} failed (${event}).`,
        { modal: true, detail: `${error}\n\nContinue anyway? Cancel stops the action.` },
        'Continue',
      );
      return choice === 'Continue';
    },
  };
}

/** Report failures once, so a hook problem is never silent. */
function reportOutcomes(event: string, outcomes: Awaited<ReturnType<typeof runHooks>>['outcomes']): void {
  const failed = outcomes.filter((o) => o.status === 'failed');
  if (failed.length === 0) return;
  for (const o of failed) {
    if (o.status === 'failed') getCarameloChannel().appendLine(`✗ Hook ${label(o.hook)} (${event}) failed: ${o.error}`);
  }
  if (failed.some((o) => o.hook.optional || event.startsWith('after_'))) {
    vscode.window.showWarningMessage(
      `Caramelo: ${failed.length} Spec Kit hook(s) failed on ${event}. See the Caramelo output channel.`,
    );
  }
}

/** Run `<timing>_<action>` hooks. Returns false when the action must not proceed. */
export async function runActionHooks(
  timing: HookTiming,
  action: HookAction,
  ctx: HookRunContext,
  registry: ProviderRegistry,
): Promise<boolean> {
  const result = await runHooks(timing, action, ctx, createVsCodeHookDeps(registry));
  reportOutcomes(`${timing}_${action}`, result.outcomes);
  return result.proceed;
}
