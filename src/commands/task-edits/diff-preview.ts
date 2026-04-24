import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Edit } from './parser.js';

/**
 * Virtual content provider used to render the "proposed" side of each
 * diff. We register once when the module is loaded and cache proposals
 * by synthetic URI — that lets `vscode.diff` open a read-only view over
 * the in-memory replacement without writing anything to disk first.
 */
const SCHEME = 'caramelo-proposed';
const proposals = new Map<string, string>();

let registered = false;
function ensureRegistered(context?: vscode.ExtensionContext): void {
  if (registered) return;
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri) {
      return proposals.get(uri.toString()) ?? '';
    },
  };
  const disposable = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  if (context) context.subscriptions.push(disposable);
  registered = true;
}

export type ConfirmChoice = 'apply-all' | 'apply-all-session' | 'file-by-file' | 'cancel';

export interface PreviewOptions {
  context?: vscode.ExtensionContext;
  workspaceRoot: string;
  /** Task description — shown in the QuickPick so parallel batches are disambiguable. */
  taskText?: string;
}

export async function confirmApplyChoice(count: number, taskText?: string): Promise<ConfirmChoice> {
  const label = taskText ? `Task: ${taskText.slice(0, 60)}` : 'Caramelo task';
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(check) Apply all',
        description: `Write ${count} change(s) now`,
        value: 'apply-all' as const,
      },
      {
        label: '$(check-all) Apply all — don\'t ask again this session',
        description: 'Auto-apply every subsequent task until you reload the window',
        value: 'apply-all-session' as const,
      },
      {
        label: '$(eye) Review file-by-file',
        description: 'Open a diff for each file before applying it',
        value: 'file-by-file' as const,
      },
      {
        label: '$(x) Cancel',
        description: 'Discard the proposed changes',
        value: 'cancel' as const,
      },
    ],
    {
      placeHolder: `${label} — ${count} edit(s). Tip: set caramelo.autoApplyEdits:true to skip permanently.`,
    },
  );
  return pick?.value ?? 'cancel';
}

export async function previewEdit(
  edit: Edit,
  options: PreviewOptions,
): Promise<'accept' | 'skip' | 'cancel-all'> {
  ensureRegistered(options.context);

  const rel = edit.filePath;
  const abs = path.resolve(options.workspaceRoot, rel);

  // Build a proposed-content URI.
  const proposedUri = vscode.Uri.parse(`${SCHEME}:/${encodeURIComponent(rel)}?${Date.now()}`);
  const proposedText = edit.kind === 'create'
    ? edit.content
    : computeProposedContent(abs, edit.search, edit.replace);

  proposals.set(proposedUri.toString(), proposedText);

  const originalUri = edit.kind === 'create'
    ? vscode.Uri.parse(`${SCHEME}:/(new file)?${Date.now()}-empty`)
    : vscode.Uri.file(abs);
  if (edit.kind === 'create') {
    proposals.set(originalUri.toString(), '');
  }

  const diffTitle = options.taskText
    ? `Caramelo: ${rel} — ${options.taskText.slice(0, 40)}`
    : `Caramelo: ${rel} (proposed)`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    proposedUri,
    diffTitle,
    { preview: true, preserveFocus: false },
  );

  const placeHolder = options.taskText
    ? `Apply ${rel}? (task: ${options.taskText.slice(0, 40)})`
    : `Apply change to ${rel}?`;
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(check) Apply this file', value: 'accept' as const },
      { label: '$(arrow-right) Skip this file', value: 'skip' as const },
      { label: '$(x) Cancel all remaining', value: 'cancel-all' as const },
    ],
    { placeHolder },
  );

  // Clean up proposals so memory doesn't grow across tasks.
  proposals.delete(proposedUri.toString());
  if (edit.kind === 'create') proposals.delete(originalUri.toString());

  return pick?.value ?? 'cancel-all';
}

function computeProposedContent(abs: string, search: string, replace: string): string {
  let current: string;
  try {
    current = fs.readFileSync(abs, 'utf-8');
  } catch {
    return `// Caramelo could not read "${abs}" — the edit will likely fail.\n${replace}`;
  }
  const currentLF = current.replace(/\r\n/g, '\n');
  const searchLF = search.replace(/\r\n/g, '\n');
  const idx = currentLF.indexOf(searchLF);
  if (idx === -1) {
    return (
      `// Caramelo preview: SEARCH block did not match this file. The applier will abort.\n` +
      `// --- Expected SEARCH ---\n${search}\n// --- End SEARCH ---\n${current}`
    );
  }
  return currentLF.slice(0, idx) + replace.replace(/\r\n/g, '\n') + currentLF.slice(idx + searchLF.length);
}
