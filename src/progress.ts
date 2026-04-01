import * as vscode from 'vscode';

let statusBarItem: vscode.StatusBarItem | undefined;
let cancelCallback: (() => void) | undefined;

export function initProgressBar(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'caramelo.cancelProgress';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('caramelo.cancelProgress', () => {
      if (cancelCallback) {
        cancelCallback();
        hideProgress();
      }
    })
  );
}

export function showProgress(message: string, onCancel?: () => void): void {
  if (!statusBarItem) return;
  cancelCallback = onCancel;
  statusBarItem.text = `$(loading~spin) ${message}`;
  statusBarItem.tooltip = onCancel ? 'Click to cancel' : message;
  statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusBarItem.show();
}

export function updateProgress(message: string): void {
  if (!statusBarItem) return;
  statusBarItem.text = `$(loading~spin) ${message}`;
}

export function hideProgress(): void {
  if (!statusBarItem) return;
  cancelCallback = undefined;
  statusBarItem.hide();
}

/**
 * Run a long operation with status bar progress instead of notification.
 * Shows a spinner in the status bar with the message.
 * Returns the result of the operation.
 */
export async function withStatusBarProgress<T>(
  message: string,
  operation: (cancel: AbortController) => Promise<T>
): Promise<T | null> {
  const abortController = new AbortController();
  showProgress(message, () => abortController.abort());

  try {
    const result = await operation(abortController);
    return result;
  } catch (err) {
    if (abortController.signal.aborted) return null;
    throw err;
  } finally {
    hideProgress();
  }
}
