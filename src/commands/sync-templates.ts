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
          const optional = result.missingOptional.length > 0
            ? ` (${result.missingOptional.length} optional file${result.missingOptional.length === 1 ? '' : 's'} missing — non-blocking)`
            : '';
          vscode.window.showInformationMessage(`Templates updated to ${result.version}${optional}.`);
          return;
        }
        // The toast can no longer lie about the cause: each non-success
        // reason gets its own message instead of collapsing to a single
        // "already up to date" claim.
        if (result.reason === 'up-to-date') {
          vscode.window.showInformationMessage(`Templates already up to date (${result.version}).`);
          return;
        }
        if (result.reason === 'network-error') {
          const cached = result.version ? ` Using cached ${result.version}.` : ' No cache available — bundled fallback in use.';
          vscode.window.showWarningMessage(
            `Caramelo: could not reach Spec Kit upstream.${cached}`,
          );
          return;
        }
        // 'all-failed' — release lookup succeeded but every required template fetch failed.
        const cached = result.version ? ` Keeping cached ${result.version}.` : ' No cache available — bundled fallback in use.';
        vscode.window.showErrorMessage(
          `Caramelo: Spec Kit released a new version but its templates could not be downloaded.${cached}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Template sync failed: ${msg}`);
      }
    }
  );
}
