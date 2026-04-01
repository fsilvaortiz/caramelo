import * as vscode from 'vscode';
import type { TemplateSync } from '../speckit/sync.js';

export async function syncTemplates(templateSync: TemplateSync): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Syncing Spec Kit templates...',
      cancellable: false,
    },
    async () => {
      try {
        const result = await templateSync.checkForUpdates(true);
        if (result.updated) {
          vscode.window.showInformationMessage(`Templates updated to ${result.version}`);
        } else {
          vscode.window.showInformationMessage(`Templates already up to date (${result.version ?? 'bundled'})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Template sync failed: ${msg}`);
      }
    }
  );
}
