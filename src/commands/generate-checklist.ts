import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';

export async function generateChecklist(
  specName: string,
  phaseType: string,
  workspace: SpecWorkspace,
  registry: ProviderRegistry
): Promise<void> {
  const provider = registry.activeProvider;
  if (!provider) {
    vscode.window.showWarningMessage('No active LLM provider configured.');
    return;
  }

  const specsRoot = workspace.getSpecsRoot();
  const specDir = path.join(specsRoot, specName);

  // Map phase type to file name
  const fileMap: Record<string, string> = {
    requirements: 'spec.md',
    design: 'plan.md',
    tasks: 'tasks.md',
  };
  const fileName = fileMap[phaseType];
  if (!fileName) return;

  const filePath = path.join(specDir, fileName);
  if (!fs.existsSync(filePath)) {
    vscode.window.showErrorMessage(`Document ${fileName} not found.`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  const systemPrompt = `Read this specification document and generate a quality checklist with concrete, verifiable items SPECIFIC to this document's content. Each item should be a statement that can be checked against the spec. Group items by category. Output a markdown document with:
- A title and metadata
- Checkbox items (- [ ] Item description)
- Categories as ## headings

IMPORTANT: Do NOT include generic items. Every item must reference specific content from the document. For example, instead of "Requirements are testable", use "The user authentication requirement (FR-003) includes specific acceptance criteria".`;

  let response = '';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Generating checklist for ${phaseType}...` },
    async () => {
      for await (const chunk of provider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate a quality checklist for this ${phaseType} document:\n\n${content}` },
        ]
      )) {
        response += chunk;
      }
    }
  );

  // Write checklist
  const checklistsDir = path.join(specDir, 'checklists');
  if (!fs.existsSync(checklistsDir)) fs.mkdirSync(checklistsDir, { recursive: true });

  const checklistPath = path.join(checklistsDir, `${phaseType}.md`);
  fs.writeFileSync(checklistPath, response, 'utf-8');

  const doc = await vscode.workspace.openTextDocument(checklistPath);
  await vscode.window.showTextDocument(doc);

  vscode.window.showInformationMessage(`Checklist generated for ${phaseType}.`);
}
