import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';

interface ClarificationQuestion {
  question: string;
  options: string[];
  recommended: number;
}

export async function clarifySpec(
  specName: string,
  workspace: SpecWorkspace,
  registry: ProviderRegistry
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

  // Ask LLM to identify ambiguities
  const systemPrompt = `Analyze this specification for ambiguities, missing details, and underspecified areas. Return a JSON array of up to 5 clarification questions. Each item must have: { "question": string, "options": string[] (2-5 options), "recommended": number (0-based index) }. Output ONLY the JSON between \`\`\`json and \`\`\` delimiters. If no ambiguities found, return an empty array [].`;

  let response = '';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Analyzing spec for ambiguities...' },
    async () => {
      for await (const chunk of provider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: specContent },
        ]
      )) {
        response += chunk;
      }
    }
  );

  // Parse JSON from response
  const questions = parseQuestions(response);
  if (!questions || questions.length === 0) {
    vscode.window.showInformationMessage('No critical ambiguities found. Proceed to Design.');
    return;
  }

  // Present questions as sequential QuickPicks
  const answers: Array<{ question: string; answer: string }> = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const items: vscode.QuickPickItem[] = q.options.map((opt, idx) => ({
      label: idx === q.recommended ? `$(star-full) ${opt}` : opt,
      description: idx === q.recommended ? 'Recommended' : undefined,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Q${i + 1}/${questions.length}: ${q.question}`,
      title: q.question,
    });

    if (!selected) break; // User cancelled

    const answer = selected.label.replace('$(star-full) ', '');
    answers.push({ question: q.question, answer });
  }

  if (answers.length === 0) return;

  // Write clarifications to spec
  const today = new Date().toISOString().split('T')[0];
  const clarifications = answers
    .map((a) => `- Q: ${a.question} → A: ${a.answer}`)
    .join('\n');

  let updatedSpec = specContent;
  if (updatedSpec.includes('## Clarifications')) {
    // Append to existing section
    updatedSpec = updatedSpec.replace(
      '## Clarifications',
      `## Clarifications\n\n### Session ${today}\n\n${clarifications}`
    );
  } else {
    // Add before Assumptions
    updatedSpec = updatedSpec.replace(
      '## Assumptions',
      `## Clarifications\n\n### Session ${today}\n\n${clarifications}\n\n## Assumptions`
    );
  }

  fs.writeFileSync(specPath, updatedSpec, 'utf-8');

  // Open the updated spec
  const doc = await vscode.workspace.openTextDocument(specPath);
  await vscode.window.showTextDocument(doc);

  vscode.window.showInformationMessage(`${answers.length} clarification(s) recorded in spec.`);
}

function parseQuestions(response: string): ClarificationQuestion[] | null {
  // Try to extract JSON between ```json and ``` markers
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
