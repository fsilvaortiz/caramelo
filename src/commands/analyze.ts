import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SpecWorkspace } from '../specs/workspace.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { SPECS_DIR_NAME, PHASE_FILES } from '../constants.js';

interface AnalysisFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  finding: string;
  documents: string[];
  section: string;
}

const SEVERITY_BADGES: Record<string, string> = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
  low: '🔵 LOW',
};

export async function analyzeConsistency(
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
  const specDir = path.join(specsRoot, specName);

  const artifacts = collectArtifacts(specDir);
  if (artifacts.length < 2) {
    vscode.window.showWarningMessage('At least 2 phase documents are needed for consistency analysis.');
    return;
  }

  const combinedContent = artifacts
    .map((a) => `=== ${a.name} ===\n\n${a.content}`)
    .join('\n\n---\n\n');

  const systemPrompt = `Analyze these spec artifacts for consistency. Check for:
- Requirements without corresponding tasks
- Tasks that don't trace back to requirements
- Contradictions between spec and plan
- Terminology inconsistencies across documents
- Missing edge cases mentioned in one document but not addressed in others
- Scope mismatches between documents

Return a JSON array of findings. Each item: { "severity": "critical"|"high"|"medium"|"low", "finding": string, "documents": string[], "section": string }.
Output ONLY the JSON between \`\`\`json and \`\`\` delimiters. If no issues found, return an empty array [].`;

  let response = '';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Analyzing consistency...' },
    async () => {
      for await (const chunk of provider.chat(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: combinedContent }]
      )) {
        response += chunk;
      }
    }
  );

  const findings = parseFindings(response);
  const analysisPath = path.join(specDir, 'analysis.md');
  const analysisContent = formatAnalysisReport(specName, specDir, artifacts.map((a) => a.name), findings, response);
  fs.writeFileSync(analysisPath, analysisContent, 'utf-8');

  const doc = await vscode.workspace.openTextDocument(analysisPath);
  await vscode.window.showTextDocument(doc);

  if (findings && findings.length > 0) {
    const criticalCount = findings.filter((f) => f.severity === 'critical').length;
    const highCount = findings.filter((f) => f.severity === 'high').length;
    vscode.window.showWarningMessage(
      `Found ${findings.length} issue(s): ${criticalCount} critical, ${highCount} high.`,
      'Fix All Issues'
    ).then((action) => {
      if (action === 'Fix All Issues') {
        fixAllIssues(specName, specDir, findings, registry);
      }
    });
  } else {
    vscode.window.showInformationMessage('All artifacts are consistent!');
  }
}

export async function fixSingleIssue(
  specDir: string,
  finding: AnalysisFinding,
  registry: ProviderRegistry
): Promise<void> {
  const provider = registry.activeProvider;
  if (!provider) return;

  // Load the affected documents
  const docsContent: string[] = [];
  for (const docName of finding.documents) {
    const filePath = path.join(specDir, docName);
    if (fs.existsSync(filePath)) {
      docsContent.push(`=== ${docName} ===\n\n${fs.readFileSync(filePath, 'utf-8')}`);
    }
  }

  const systemPrompt = `You are fixing a consistency issue in spec documents. The issue is:

"${finding.finding}"
Severity: ${finding.severity}
Affected documents: ${finding.documents.join(', ')}
Section: ${finding.section}

Review the documents below and output the corrected version of EACH affected document. Use this format for each file:

=== FILE: filename.md ===
<complete corrected file content>
=== END FILE ===

Only fix the specific issue. Do not change anything else.`;

  let output = '';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fixing: ${finding.finding.slice(0, 50)}...` },
    async () => {
      for await (const chunk of provider.chat(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: docsContent.join('\n\n---\n\n') }]
      )) {
        output += chunk;
      }
    }
  );

  // Parse and apply file blocks
  const fileRegex = /=== FILE: (.+?) ===\n([\s\S]*?)\n=== END FILE ===/g;
  let match;
  let applied = 0;
  while ((match = fileRegex.exec(output)) !== null) {
    const fileName = match[1].trim();
    const content = match[2];
    const filePath = path.join(specDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    applied++;
  }

  if (applied > 0) {
    vscode.window.showInformationMessage(`Fixed: ${finding.finding.slice(0, 60)}. ${applied} file(s) updated.`);
  } else {
    vscode.window.showWarningMessage('LLM did not produce file corrections. Review manually.');
  }
}

async function fixAllIssues(
  specName: string,
  specDir: string,
  findings: AnalysisFinding[],
  registry: ProviderRegistry
): Promise<void> {
  const provider = registry.activeProvider;
  if (!provider) return;

  // Load all artifacts
  const artifacts = collectArtifacts(specDir);
  const combinedContent = artifacts
    .map((a) => `=== ${a.name} ===\n\n${a.content}`)
    .join('\n\n---\n\n');

  const findingsText = findings
    .map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.finding} (in: ${f.documents.join(', ')}, section: ${f.section})`)
    .join('\n');

  const systemPrompt = `You are fixing consistency issues in spec documents. Here are ALL the issues found:

${findingsText}

Review ALL the documents below and output the corrected version of EACH document that needs changes. Use this format:

=== FILE: filename.md ===
<complete corrected file content>
=== END FILE ===

Fix all issues. Ensure cross-document consistency. Do not change anything unrelated to the findings.`;

  const channel = vscode.window.createOutputChannel('Caramelo');
  channel.show(true);
  channel.appendLine(`\n${'─'.repeat(60)}`);
  channel.appendLine(`▶ Fixing ${findings.length} consistency issues for ${specName}`);
  channel.appendLine('─'.repeat(60));

  let output = '';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fixing ${findings.length} issues...`, cancellable: true },
    async (_progress, token) => {
      const abortController = new AbortController();
      token.onCancellationRequested(() => abortController.abort());

      try {
        for await (const chunk of provider.chat(
          [{ role: 'system', content: systemPrompt }, { role: 'user', content: combinedContent }],
          { signal: abortController.signal }
        )) {
          output += chunk;
          channel.append(chunk);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          channel.appendLine(`\n\n✗ Error: ${msg}`);
          vscode.window.showErrorMessage(`Fix failed: ${msg}`);
        }
        return;
      }
    }
  );

  // Apply corrections
  const fileRegex = /=== FILE: (.+?) ===\n([\s\S]*?)\n=== END FILE ===/g;
  let match;
  let applied = 0;
  while ((match = fileRegex.exec(output)) !== null) {
    const fileName = match[1].trim();
    const content = match[2];
    const filePath = path.join(specDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    applied++;
    channel.appendLine(`  → Updated ${fileName}`);
  }

  channel.appendLine(`\n✓ ${applied} file(s) corrected.`);

  if (applied > 0) {
    vscode.window.showInformationMessage(
      `${applied} file(s) corrected. Re-run Analyze to verify.`,
      'Re-analyze'
    ).then((action) => {
      if (action === 'Re-analyze') {
        vscode.commands.executeCommand('caramelo.analyze');
      }
    });
  }
}

function collectArtifacts(specDir: string): Array<{ name: string; content: string }> {
  const artifacts: Array<{ name: string; content: string }> = [];
  for (const file of ['spec.md', 'plan.md', 'tasks.md', 'research.md', 'data-model.md']) {
    const filePath = path.join(specDir, file);
    if (fs.existsSync(filePath)) {
      artifacts.push({ name: file, content: fs.readFileSync(filePath, 'utf-8') });
    }
  }
  return artifacts;
}

function parseFindings(response: string): AnalysisFinding[] | null {
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

function formatAnalysisReport(
  specName: string,
  specDir: string,
  documentNames: string[],
  findings: AnalysisFinding[] | null,
  rawResponse: string
): string {
  const lines: string[] = [
    `# Consistency Analysis: ${specName}`,
    '',
    `**Date**: ${new Date().toISOString().split('T')[0]}`,
    `**Documents analyzed**: ${documentNames.join(', ')}`,
    '',
  ];

  if (!findings) {
    lines.push('## Raw Analysis Output', '', 'Could not parse structured findings. Raw LLM response:', '', rawResponse);
    return lines.join('\n');
  }

  if (findings.length === 0) {
    lines.push('## Result', '', 'All artifacts are consistent. No issues found.');
    return lines.join('\n');
  }

  lines.push(`## Findings (${findings.length})`, '');

  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;

    lines.push(`### ${SEVERITY_BADGES[severity]} (${group.length})`, '');
    for (const finding of group) {
      lines.push(`- **${finding.finding}**`);
      lines.push(`  - Documents: ${finding.documents.join(', ')}`);
      lines.push(`  - Section: ${finding.section}`);
      // Add clickable file links
      for (const doc of finding.documents) {
        const docPath = path.join(specDir, doc);
        if (fs.existsSync(docPath)) {
          lines.push(`  - [Open ${doc}](${docPath})`);
        }
      }
      lines.push('');
    }
  }

  lines.push('---', '', '> Use the **Caramelo** menu in the editor toolbar → **Fix All Issues** to auto-correct, or fix manually and re-analyze.');

  return lines.join('\n');
}
