import * as vscode from 'vscode';
import * as path from 'path';

export class AnalysisCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor() {
    vscode.workspace.onDidSaveTextDocument(() => this._onDidChangeCodeLenses.fire());
    vscode.workspace.onDidOpenTextDocument(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const fileName = path.basename(document.fileName);
    if (fileName !== 'analysis.md') return [];

    const lenses: vscode.CodeLens[] = [];
    const titleRange = new vscode.Range(0, 0, 0, 0);

    // Scan for findings
    const findings: Array<{ line: number; text: string; docs: string[] }> = [];
    for (let i = 0; i < document.lineCount; i++) {
      const lineText = document.lineAt(i).text;
      if (lineText.startsWith('- **')) {
        const findingText = lineText.replace(/^- \*\*/, '').replace(/\*\*.*$/, '');
        const docs: string[] = [];

        // Scan following lines for document references
        for (let j = i + 1; j < document.lineCount && j < i + 10; j++) {
          const nextText = document.lineAt(j).text.trim();
          if (nextText.startsWith('- Documents:')) {
            docs.push(...nextText.replace('- Documents:', '').trim().split(',').map((d) => d.trim()));
          }
          if (nextText === '' || nextText.startsWith('- **') || nextText.startsWith('###')) break;
        }

        findings.push({ line: i, text: findingText, docs });
      }
    }

    if (findings.length === 0) return [];

    // Top-level buttons
    lenses.push(new vscode.CodeLens(titleRange, {
      title: `$(wrench) Fix All ${findings.length} Issues`,
      command: 'caramelo.fixAllIssues',
    }));
    lenses.push(new vscode.CodeLens(titleRange, {
      title: '$(refresh) Re-analyze',
      command: 'caramelo.analyze',
    }));

    // Per-finding buttons
    for (const finding of findings) {
      const range = new vscode.Range(finding.line, 0, finding.line, 0);

      lenses.push(new vscode.CodeLens(range, {
        title: '$(wrench) Fix This',
        command: 'caramelo.fixSingleIssue',
        arguments: [finding.text, finding.docs],
      }));

      // Open buttons for each referenced document
      for (const doc of finding.docs) {
        // Find the spec directory from the analysis.md path
        const specDir = path.dirname(document.fileName);
        const docPath = path.join(specDir, doc);
        lenses.push(new vscode.CodeLens(range, {
          title: `$(file) ${doc}`,
          command: 'vscode.open',
          arguments: [vscode.Uri.file(docPath)],
        }));
      }
    }

    return lenses;
  }
}
