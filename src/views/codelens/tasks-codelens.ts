import * as vscode from 'vscode';
import { COMMAND_IDS } from '../../constants.js';

const progressBarDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  after: {
    margin: '0 0 0 1em',
    fontWeight: 'bold',
  },
});

const progressFillDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: 'rgba(75, 175, 80, 0.08)',
  overviewRulerColor: '#4CAF50',
  overviewRulerLane: vscode.OverviewRulerLane.Full,
});

export class TaskCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor() {
    vscode.workspace.onDidChangeTextDocument((e) => {
      this._onDidChangeCodeLenses.fire();
      this.updateDecorations(e.document);
    });

    // Apply decorations when editor changes
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) this.updateDecorations(editor.document);
    });
  }

  private updateDecorations(document: vscode.TextDocument): void {
    if (!document.fileName.includes('tasks') || !document.fileName.endsWith('.md')) return;

    const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
    if (!editor) return;

    const { totalTasks, completedTasks } = this.countTasks(document);
    if (totalTasks === 0) {
      editor.setDecorations(progressBarDecorationType, []);
      editor.setDecorations(progressFillDecorationType, []);
      return;
    }

    const percent = Math.round((completedTasks / totalTasks) * 100);
    const bar = this.buildProgressBar(completedTasks, totalTasks);
    const pendingTasks = totalTasks - completedTasks;

    const statusText = pendingTasks === 0
      ? `  ✅ All ${totalTasks} tasks complete!`
      : `  ${bar}  ${completedTasks}/${totalTasks} tasks (${percent}%)  •  ${pendingTasks} remaining`;

    // Apply decoration on line 0
    const range = new vscode.Range(0, 0, 0, document.lineAt(0).text.length);
    editor.setDecorations(progressBarDecorationType, [
      {
        range,
        renderOptions: {
          after: {
            contentText: statusText,
            color: pendingTasks === 0
              ? new vscode.ThemeColor('testing.iconPassed')
              : new vscode.ThemeColor('editorInfo.foreground'),
          },
        },
      },
    ]);

    // Highlight the title line with a subtle background
    editor.setDecorations(progressFillDecorationType, [{ range }]);
  }

  private buildProgressBar(completed: number, total: number): string {
    const width = 20;
    const filled = Math.round((completed / total) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  private countTasks(document: vscode.TextDocument): { totalTasks: number; completedTasks: number } {
    let totalTasks = 0;
    let completedTasks = 0;
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text.trimStart();
      if (/^- \[ \] /.test(text)) totalTasks++;
      else if (/^- \[x\] /i.test(text)) { totalTasks++; completedTasks++; }
    }
    return { totalTasks, completedTasks };
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const { totalTasks, completedTasks } = this.countTasks(document);

    // Summary CodeLens at top — Run Next Task button
    if (totalTasks > 0) {
      const range = new vscode.Range(0, 0, 0, 0);
      const pendingTasks = totalTasks - completedTasks;

      if (pendingTasks > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '▶  Run Next Pending Task',
            command: 'caramelo.runNextTask',
            arguments: [document.uri],
          })
        );
      }
    }

    // Per-task CodeLens
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const text = line.text.trimStart();

      if (/^- \[ \] /.test(text)) {
        const taskText = text.replace(/^- \[ \] /, '').trim();
        const range = new vscode.Range(i, 0, i, line.text.length);
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(play) Run Task',
            command: COMMAND_IDS.startTask,
            arguments: [i, taskText, document.uri],
          })
        );
      } else if (/^- \[x\] /i.test(text)) {
        const range = new vscode.Range(i, 0, i, line.text.length);
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(check) Done',
            command: '',
          })
        );
      }
    }

    // Trigger decoration update
    this.updateDecorations(document);

    return lenses;
  }
}
