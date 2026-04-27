import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { WorkflowViewProvider } from '../views/sidebar/workflow-view.js';
import { isAbortError } from '../errors.js';
import { log } from '../utils/log.js';

export interface ClarificationQuestion {
  question: string;
  /** 2–5 entries, matches the prompt contract enforced in parseQuestions. */
  options: string[];
  /** Always `0 ≤ recommended < options.length` once parsed. */
  recommended: number;
}

export type WriteAnswersResult =
  | { ok: true; bytesWritten: number }
  | { ok: false; reason: 'no-answers' | 'read-failed' | 'write-failed'; error?: unknown };

/**
 * Entry point for the `caramelo.clarify` command. Asks the LLM to scan
 * the spec for ambiguities, then hands the questions to the Workflow
 * sidebar webview which collects answers inline.
 */
export async function clarifySpec(
  specName: string,
  workspace: SpecWorkspace,
  registry: ProviderRegistry,
  workflowView: WorkflowViewProvider,
): Promise<void> {
  const provider = registry.activeProvider;
  if (!provider) {
    vscode.window.showWarningMessage('No active LLM provider configured.');
    return;
  }

  const specsRoot = workspace.getSpecsRoot();
  const specPath = path.join(specsRoot, specName, 'spec.md');
  if (!fs.existsSync(specPath)) {
    vscode.window.showErrorMessage(`Spec "${specName}" not found.`);
    return;
  }

  let specContent: string;
  try {
    specContent = fs.readFileSync(specPath, 'utf-8');
  } catch (err) {
    vscode.window.showErrorMessage(
      `Caramelo: could not read "${specName}/spec.md" — ${formatErr(err)}`,
    );
    return;
  }

  const result = await generateClarificationQuestions(provider, specContent);
  if (result.kind === 'cancelled') return;
  if (result.kind === 'error') {
    vscode.window.showErrorMessage(`Clarify failed: ${result.message}`);
    return;
  }
  if (result.kind === 'unparseable') {
    vscode.window.showWarningMessage(
      'Caramelo: clarification analysis returned an unparseable response. Try again.',
    );
    log.warn('[clarify] unparseable LLM response (first 400 B):', result.raw.slice(0, 400));
    return;
  }
  if (result.questions.length === 0) {
    vscode.window.showInformationMessage('No critical ambiguities found. Proceed to Design.');
    return;
  }

  workflowView.startClarify(specName, specPath, result.questions);
}

type GenerateResult =
  | { kind: 'questions'; questions: ClarificationQuestion[] }
  | { kind: 'unparseable'; raw: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

async function generateClarificationQuestions(
  provider: { chat: (messages: { role: 'system' | 'user'; content: string }[], options?: { signal?: AbortSignal }) => AsyncIterable<string> },
  specContent: string,
): Promise<GenerateResult> {
  const systemPrompt =
    'Analyze this specification for ambiguities, missing details, and underspecified areas. ' +
    'Return a JSON array of up to 5 clarification questions. Each item must have: ' +
    '{ "question": string, "options": string[] (2-5 options), "recommended": number (0-based index) }. ' +
    'Output ONLY the JSON between ```json and ``` delimiters. ' +
    'If no ambiguities found, return an empty array [].';

  const controller = new AbortController();
  let response = '';
  let outcome: GenerateResult | null = null;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Caramelo: analyzing spec for ambiguities…',
        cancellable: true,
      },
      async (_progress, token) => {
        // The progress notification's Cancel button propagates here;
        // we hand it to the provider via the AbortSignal.
        token.onCancellationRequested(() => controller.abort());
        try {
          for await (const chunk of provider.chat(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: specContent },
            ],
            { signal: controller.signal },
          )) {
            response += chunk;
          }
        } catch (err) {
          if (isAbortError(err) || controller.signal.aborted) {
            outcome = { kind: 'cancelled' };
            return;
          }
          outcome = { kind: 'error', message: formatErr(err) };
        }
      },
    );
  } catch (err) {
    // withProgress itself failed (uncommon; usually only on shutdown).
    return { kind: 'error', message: formatErr(err) };
  }

  if (outcome) return outcome;

  const parsed = parseQuestions(response);
  if (parsed === null) return { kind: 'unparseable', raw: response };
  return { kind: 'questions', questions: parsed };
}

/**
 * Strict parser: rejects any item where the JSON shape, types, or
 * bounds don't match the prompt contract (`options.length` between 2
 * and 5, `recommended` is an integer in `[0, options.length)`,
 * `question` is non-empty after trim). Returns `null` on any failure
 * rather than smuggling malformed data downstream.
 */
function parseQuestions(response: string): ClarificationQuestion[] | null {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: ClarificationQuestion[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null;
    const { question, options, recommended } = item as Partial<ClarificationQuestion>;
    if (typeof question !== 'string' || question.trim().length === 0) return null;
    if (!Array.isArray(options) || options.length < 2 || options.length > 5) return null;
    if (options.some((o: unknown) => typeof o !== 'string' || o.length === 0)) return null;
    if (
      typeof recommended !== 'number' ||
      !Number.isInteger(recommended) ||
      recommended < 0 ||
      recommended >= options.length
    ) {
      return null;
    }
    out.push({ question, options: options as string[], recommended });
  }
  return out;
}

/**
 * Persist the user's clarification answers to the spec's
 * `## Clarifications` section. Heading matching is line-anchored so
 * stray "## Clarifications" inside body text (e.g. quoted prose) does
 * NOT get hijacked. New sessions are inserted right after the section
 * heading so the most recent session reads first; same-day re-runs
 * differentiate by `HH:MM` to avoid duplicate `### Session YYYY-MM-DD`
 * blocks.
 *
 * Returns a discriminated result so callers can toast accurately —
 * silent swallow + lying "success" toast was the prior bug.
 */
export function writeAnswersToSpec(
  specPath: string,
  answers: Array<{ question: string; answer: string }>,
): WriteAnswersResult {
  if (answers.length === 0) return { ok: false, reason: 'no-answers' };

  const now = new Date();
  const day = now.toISOString().split('T')[0];
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const sessionLabel = `### Session ${day} ${hhmm}`;
  const clarificationLines = answers.map((a) => `- Q: ${a.question} → A: ${a.answer}`).join('\n');

  let content: string;
  try {
    content = fs.readFileSync(specPath, 'utf-8');
  } catch (err) {
    return { ok: false, reason: 'read-failed', error: err };
  }

  const clarHeadingRe = /^## Clarifications\s*$/m;
  const assumptionsHeadingRe = /^## Assumptions\s*$/m;

  let updated: string;
  if (clarHeadingRe.test(content)) {
    updated = content.replace(
      clarHeadingRe,
      `## Clarifications\n\n${sessionLabel}\n\n${clarificationLines}`,
    );
  } else if (assumptionsHeadingRe.test(content)) {
    updated = content.replace(
      assumptionsHeadingRe,
      `## Clarifications\n\n${sessionLabel}\n\n${clarificationLines}\n\n## Assumptions`,
    );
  } else {
    // EOF append. trimEnd ensures we don't double-newline when the file
    // already ends with whitespace; the leading \n\n separates from the
    // last paragraph regardless of its trailing newlines.
    updated = `${content.trimEnd()}\n\n## Clarifications\n\n${sessionLabel}\n\n${clarificationLines}\n`;
  }

  try {
    fs.writeFileSync(specPath, updated, 'utf-8');
  } catch (err) {
    return { ok: false, reason: 'write-failed', error: err };
  }

  return { ok: true, bytesWritten: updated.length };
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Exported only for tests.
export { parseQuestions };
