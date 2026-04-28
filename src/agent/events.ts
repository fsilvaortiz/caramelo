import type * as vscode from 'vscode';
import { redactString } from '../utils/log.js';
import type { AgentEvent } from './types.js';

/**
 * One-line prologue written to the Output Channel at the start of an
 * agent run. Answers "what did the LLM see?" from the channel alone —
 * the user never has to attach a debugger to know which provider/model
 * ran, which capabilities were declared, or which tools were exposed.
 * Every field passes through `redactString` so leaked credentials in
 * a model id or provider name don't land in the log.
 */
export interface AgentRunPrologue {
  providerId: string;
  providerName: string;
  model: string | undefined;
  capabilities: string[];
  toolNames: string[];
  approvalMode: string;
  bashEnabled: boolean;
  maxIterations: number;
}

export function formatPrologue(p: AgentRunPrologue): string {
  return (
    `▶ agent start  provider=${redactString(p.providerName)} (${redactString(p.providerId)})` +
    `  model=${redactString(p.model ?? '(default)')}` +
    `  capabilities=[${p.capabilities.join(',')}]` +
    `  tools=${p.toolNames.length}` +
    `  approval=${p.approvalMode}` +
    `  bash=${p.bashEnabled ? 'on' : 'off'}` +
    `  maxIter=${p.maxIterations}`
  );
}

/**
 * Format an AgentEvent as a line for the Caramelo output channel. One place
 * so every command that drives the agent (/start-task today, /plan and
 * /tasks later) shows identical, scannable output. Every string that could
 * carry user/model-supplied content passes through `redactString` first so
 * raw `Bearer` / `Authorization` / URL credentials can never land in the
 * Output Channel — even if a tool result or file read returns them.
 */
export function formatEvent(event: AgentEvent): string | null {
  switch (event.kind) {
    case 'iteration':
      return event.index === 1
        ? `\n${'─'.repeat(40)}\n▶ agent turn ${event.index}`
        : `\n▶ agent turn ${event.index}`;
    case 'text':
      // Text deltas stream as-is; the LLM's own output never carries auth
      // headers by accident, but we still redact to be safe against a
      // prompt-injection attack that tries to echo a header shape.
      return redactString(event.delta);
    case 'tool_call':
      return `\n→ ${event.call.name} ${redactString(renderArgs(event.call.arguments))}`;
    case 'tool_result':
      return `  ${event.result.isError ? '✗' : '✓'} ${redactString(event.result.summary)}`;
    case 'tool_denied':
      return `  ⚠ denied: ${event.toolName} — ${redactString(event.reason)}`;
    case 'done':
      if (event.reason === 'stop') return `\n✓ agent done (stopped).`;
      if (event.reason === 'max_iterations')
        return `\n⚠ agent hit max iterations — forced stop.`;
      if (event.reason === 'cancelled') return `\n⚠ agent cancelled.`;
      if (event.reason === 'aborted_by_user') return `\n⚠ agent aborted by user during approval.`;
      return `\n✗ agent error: ${redactString(event.error ?? '(unknown)')}`;
  }
}

export function pipeToOutputChannel(channel: vscode.OutputChannel): (e: AgentEvent) => void {
  return (event) => {
    const formatted = formatEvent(event);
    if (!formatted) return;
    if (event.kind === 'text') channel.append(formatted);
    else channel.appendLine(formatted);
  };
}

function renderArgs(args: Record<string, unknown>): string {
  const short: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      short.push(`${k}=${JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v)}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      short.push(`${k}=${v}`);
    } else {
      short.push(`${k}=<${typeof v}>`);
    }
  }
  return short.join(' ');
}
