import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { WorkflowViewProvider } from '../views/sidebar/workflow-view.js';

export interface ClarificationQuestion {
  question: string;
  options: string[];
  recommended: number;
}

/**
 * Entry point for the `caramelo.clarify` command. Asks the LLM to scan
 * the spec for ambiguities, then hands the questions to the Workflow
 * sidebar webview which collects answers inline. The legacy sequential-
 * QuickPick UI was removed (see feedback_no_quickpick).
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

  const specContent = fs.readFileSync(specPath, 'utf-8');
  const questions = await generateClarificationQuestions(provider, specContent);

  if (!questions) {
    // The LLM returned non-JSON or unparseable output. Surface so the
    // user can re-run; clarify is non-destructive.
    vscode.window.showWarningMessage(
      'Caramelo: clarification analysis returned an unparseable response. Try again.',
    );
    return;
  }

  if (questions.length === 0) {
    vscode.window.showInformationMessage('No critical ambiguities found. Proceed to Design.');
    return;
  }

  workflowView.startClarify(specName, specPath, questions);
}

async function generateClarificationQuestions(
  provider: { chat: (messages: { role: 'system' | 'user'; content: string }[]) => AsyncIterable<string> },
  specContent: string,
): Promise<ClarificationQuestion[] | null> {
  const systemPrompt =
    'Analyze this specification for ambiguities, missing details, and underspecified areas. ' +
    'Return a JSON array of up to 5 clarification questions. Each item must have: ' +
    '{ "question": string, "options": string[] (2-5 options), "recommended": number (0-based index) }. ' +
    'Output ONLY the JSON between ```json and ``` delimiters. ' +
    'If no ambiguities found, return an empty array [].';

  let response = '';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Analyzing spec for ambiguities...' },
    async () => {
      for await (const chunk of provider.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: specContent },
      ])) {
        response += chunk;
      }
    },
  );

  return parseQuestions(response);
}

function parseQuestions(response: string): ClarificationQuestion[] | null {
  // Try to extract JSON between ```json and ``` markers
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return null;
    // Light shape check: each item must look like a ClarificationQuestion.
    for (const item of parsed) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof item.question !== 'string' ||
        !Array.isArray(item.options) ||
        item.options.some((o: unknown) => typeof o !== 'string') ||
        typeof item.recommended !== 'number'
      ) {
        return null;
      }
    }
    return parsed as ClarificationQuestion[];
  } catch {
    return null;
  }
}

/**
 * Persist the user's clarification answers to the spec's
 * `## Clarifications` section. Idempotent on the file: if the section
 * already exists we append a new dated subsection; otherwise we insert
 * before `## Assumptions` (or at end of file if neither marker is
 * present). Exported so the workflow webview can call it once the
 * inline Q&A flow finishes.
 */
export function writeAnswersToSpec(
  specPath: string,
  answers: Array<{ question: string; answer: string }>,
): void {
  if (answers.length === 0) return;

  const today = new Date().toISOString().split('T')[0];
  const clarificationLines = answers.map((a) => `- Q: ${a.question} → A: ${a.answer}`).join('\n');

  let content: string;
  try {
    content = fs.readFileSync(specPath, 'utf-8');
  } catch {
    return;
  }

  let updated: string;
  if (content.includes('## Clarifications')) {
    updated = content.replace(
      '## Clarifications',
      `## Clarifications\n\n### Session ${today}\n\n${clarificationLines}`,
    );
  } else if (content.includes('## Assumptions')) {
    updated = content.replace(
      '## Assumptions',
      `## Clarifications\n\n### Session ${today}\n\n${clarificationLines}\n\n## Assumptions`,
    );
  } else {
    updated = `${content.trimEnd()}\n\n## Clarifications\n\n### Session ${today}\n\n${clarificationLines}\n`;
  }

  fs.writeFileSync(specPath, updated, 'utf-8');
}

// Exported only for tests.
export { parseQuestions };
