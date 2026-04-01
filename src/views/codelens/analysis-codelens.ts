import * as vscode from 'vscode';

export class AnalysisCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!document.fileName.endsWith('analysis.md')) return [];

    const lenses: vscode.CodeLens[] = [];
    const titleRange = new vscode.Range(0, 0, 0, 0);

    // "Fix All" button at the top
    let hasFindings = false;
    for (let i = 0; i < document.lineCount; i++) {
      if (document.lineAt(i).text.startsWith('- **')) {
        hasFindings = true;
        break;
      }
    }

    if (hasFindings) {
      lenses.push(new vscode.CodeLens(titleRange, {
        title: '$(wrench) Fix All Issues',
        command: 'caramelo.fixAllIssues',
      }));
      lenses.push(new vscode.CodeLens(titleRange, {
        title: '$(refresh) Re-analyze',
        command: 'caramelo.analyze',
      }));
    }

    // Per-finding "Fix" and "Open" buttons
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      if (line.text.startsWith('- **')) {
        const findingText = line.text.replace(/^- \*\*/, '').replace(/\*\*$/, '');
        const range = new vscode.Range(i, 0, i, line.text.length);

        // Look for documents on the next lines
        let docLine = i + 1;
        const docs: string[] = [];
        while (docLine < document.lineCount) {
          const nextText = document.lineAt(docLine).text.trim();
          if (nextText.startsWith('- Documents:')) {
            const docNames = nextText.replace('- Documents:', '').trim().split(',').map((d) => d.trim());
            docs.push(...docNames);
          }
          if (nextText.startsWith('- [Open ')) {
            const pathMatch = nextText.match(/\]\((.+)\)/);
            if (pathMatch) {
              lenses.push(new vscode.CodeLens(range, {
                title: '$(file) Open',
                command: 'vscode.open',
                arguments: [vscode.Uri.file(pathMatch[1])],
              }));
            }
          }
          if (!nextText.startsWith('-') && nextText.length > 0) break;
          if (nextText.startsWith('- **')) break;
          docLine++;
        }

        lenses.push(new vscode.CodeLens(range, {
          title: '$(wrench) Fix This',
          command: 'caramelo.fixSingleIssue',
          arguments: [findingText, docs],
        }));
      }
    }

    return lenses;
  }
}
