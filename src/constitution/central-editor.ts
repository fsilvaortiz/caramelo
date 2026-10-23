import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  disconnectCentral,
  normalizeConfig,
  sha256,
  syncCentral,
  validateContent,
  CONSTITUTION_REL,
  DEFAULT_CONSTITUTION_PATH,
  type CentralConfig,
  type CentralStatus,
} from './central.js';
import { fetchFile } from './git-source.js';

export const BACKUP_REL = path.join('.specify', 'memory', 'constitution.local-backup.md');

export interface ConnectInput {
  repository: string;
  path: string;
  ref: string;
}

export interface ConnectUi {
  ask(message: string, detail: string, buttons: string[]): Promise<string | undefined>;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
}

export interface SettingsWriter {
  write(config: CentralConfig | undefined): Promise<void>;
  /** Whether a repository is still configured after clearing (e.g. in user settings). */
  stillConfigured(): boolean;
}

export type ConnectResult = { ok: true } | { ok: false; error?: string };

const vscodeConnectUi: ConnectUi = {
  ask: (message, detail, buttons) => Promise.resolve(vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons)),
  withProgress: (title, task) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task)),
};

/** Workspace-level settings, so the choice is shared through .vscode/settings.json. */
export const workspaceSettingsWriter: SettingsWriter = {
  async write(config) {
    const cfg = vscode.workspace.getConfiguration('caramelo.constitution');
    const targets = [vscode.ConfigurationTarget.Workspace];
    if (!config && vscode.workspace.workspaceFolders?.length) targets.push(vscode.ConfigurationTarget.WorkspaceFolder);
    for (const target of targets) {
      await cfg.update('repository', config?.repository, target);
      await cfg.update('path', config && config.path !== DEFAULT_CONSTITUTION_PATH ? config.path : undefined, target);
      await cfg.update('ref', config?.ref, target);
    }
  },
  stillConfigured() {
    return !!vscode.workspace.getConfiguration('caramelo.constitution').get<string>('repository')?.trim();
  },
};

function readConstitution(root: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, CONSTITUTION_REL), 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Validate the source, fetch the file, back up an existing constitution that
 * would be replaced (after asking), then record the settings and write the
 * copy. Nothing is changed when any step before the confirmation fails.
 */
export async function connectCentral(
  root: string,
  input: ConnectInput,
  settings: SettingsWriter = workspaceSettingsWriter,
  ui: ConnectUi = vscodeConnectUi,
  fetch = fetchFile,
): Promise<ConnectResult> {
  let config: CentralConfig;
  try {
    const normalized = normalizeConfig(input);
    if (!normalized) return { ok: false, error: 'Enter the repository URL.' };
    config = normalized;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let fetched: { commit: string; content: string };
  try {
    fetched = await ui.withProgress(`Fetching ${config.path} from ${config.repository}…`, () => fetch(config));
    validateContent(fetched.content, config);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const existing = readConstitution(root);
  const meaningful = existing !== undefined && existing.trim() !== '' && !existing.includes('[PRINCIPLE_1_NAME]');
  if (meaningful && sha256(existing) !== sha256(fetched.content)) {
    const choice = await ui.ask(
      'Replace the current constitution with the central one?',
      `From now on .specify/memory/constitution.md follows ${config.repository}${config.ref ? ` @ ${config.ref}` : ''} and can only change through that repository.\n\nThe current file is saved as ${BACKUP_REL.split(path.sep).join('/')}.`,
      ['Replace'],
    );
    if (choice !== 'Replace') return { ok: false };
    fs.writeFileSync(path.join(root, BACKUP_REL), existing, 'utf-8');
  }

  await settings.write(config);
  await syncCentral(root, config, {
    resolveRemoteCommit: async () => fetched.commit,
    fetchFile: async () => fetched,
  });
  return { ok: true };
}

/** Stop following the repository; constitution.md keeps its content and becomes editable again. */
export async function disconnectCentralSource(
  root: string,
  settings: SettingsWriter = workspaceSettingsWriter,
  ui: ConnectUi = vscodeConnectUi,
): Promise<ConnectResult> {
  const choice = await ui.ask(
    'Stop following the central constitution?',
    '.specify/memory/constitution.md keeps its current content and becomes a normal, editable file. The repository settings are removed from this workspace.',
    ['Disconnect'],
  );
  if (choice !== 'Disconnect') return { ok: false };
  await settings.write(undefined);
  disconnectCentral(root);
  if (settings.stillConfigured()) {
    return { ok: false, error: 'caramelo.constitution.repository is also set in your user settings — remove it there to fully disconnect.' };
  }
  return { ok: true };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relativeTime(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** One-line status used by the sidebar and the editor. */
export function describeStatus(status: CentralStatus, now = Date.now()): { tone: 'ok' | 'warn' | 'error'; text: string; action?: 'sync' | 'restore' | 'retry' } {
  switch (status.kind) {
    case 'not-configured':
      return { tone: 'ok', text: 'Local constitution' };
    case 'not-synced':
      return { tone: 'warn', text: 'Central constitution not synced yet', action: 'sync' };
    case 'synced':
      return status.localEdits
        ? { tone: 'warn', text: 'Edited locally — differs from the central version', action: 'restore' }
        : { tone: 'ok', text: `Central · ${status.meta.commit.slice(0, 7)} · synced ${relativeTime(status.meta.syncedAt, now)}` };
    case 'update-available':
      return { tone: 'warn', text: `Update available (${status.meta.commit.slice(0, 7)} → ${status.remoteCommit.slice(0, 7)})`, action: 'sync' };
    case 'error':
      return { tone: 'error', text: status.error.message, action: status.error.kind === 'invalid-url' || status.error.kind === 'invalid-path' || status.error.kind === 'invalid-ref' ? undefined : 'retry' };
  }
}

/** Read-only view of the central constitution. */
export function centralViewHtml(cspSource: string, config: CentralConfig, status: CentralStatus, content: string | undefined): string {
  const s = describeStatus(status);
  const actionLabel = s.action === 'restore' ? 'Restore central version' : s.action === 'retry' ? 'Retry sync' : 'Sync now';
  const meta = status.kind === 'synced' || status.kind === 'update-available' || (status.kind === 'error' && status.meta)
    ? (status as { meta: { commit: string; syncedAt: string } }).meta
    : undefined;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px; max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.5em; margin: 0 0 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 20px; font-size: 0.9em; }
  .card { border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3)); border-radius: 8px; padding: 14px 16px; margin-bottom: 18px; }
  .row { display: flex; gap: 8px; margin: 4px 0; font-size: 0.9em; }
  .k { color: var(--vscode-descriptionForeground); min-width: 90px; }
  .v { font-family: var(--vscode-editor-font-family); word-break: break-all; }
  .status { margin-top: 10px; padding: 6px 10px; border-radius: 4px; font-size: 0.9em; }
  .status.ok { background: rgba(76,175,80,0.12); }
  .status.warn { background: rgba(255,193,7,0.15); }
  .status.error { background: rgba(244,67,54,0.15); }
  .actions { display: flex; gap: 10px; margin-top: 12px; }
  button { padding: 7px 14px; border-radius: 4px; cursor: pointer; font-size: 0.9em; border: 1px solid transparent; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .secondary { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-widget-border, rgba(127,127,127,0.4)); }
  pre { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 0.88em; line-height: 1.5;
        background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.08)); padding: 14px; border-radius: 6px; }
</style></head>
<body>
  <h1>🔒 Project Constitution</h1>
  <p class="subtitle">This workspace follows a central constitution. Change it in its repository; Caramelo keeps <code>.specify/memory/constitution.md</code> as an exact copy.</p>
  <div class="card">
    <div class="row"><span class="k">Repository</span><span class="v">${escapeHtml(config.repository)}</span></div>
    <div class="row"><span class="k">File</span><span class="v">${escapeHtml(config.path)}</span></div>
    <div class="row"><span class="k">Follows</span><span class="v">${config.ref ? escapeHtml(config.ref) : 'default branch'}</span></div>
    ${meta ? `<div class="row"><span class="k">Commit</span><span class="v">${escapeHtml(meta.commit)}</span></div>
    <div class="row"><span class="k">Synced</span><span class="v">${escapeHtml(new Date(meta.syncedAt).toLocaleString())}</span></div>` : ''}
    <div class="status ${s.tone}">${escapeHtml(s.text)}</div>
    <div class="actions">
      <button class="primary" onclick="post('syncCentral')">${actionLabel}</button>
      <button class="secondary" onclick="post('disconnectCentral')">Disconnect…</button>
    </div>
  </div>
  ${content !== undefined ? `<pre>${escapeHtml(content)}</pre>` : '<p class="subtitle">Not synced yet.</p>'}
  <script>
    const vscode = acquireVsCodeApi();
    function post(command) { vscode.postMessage({ command }); }
  </script>
</body></html>`;
}

/** Collapsible "connect" section embedded in the local constitution editor. */
export function connectSectionHtml(error?: string): string {
  return `
  <div class="ai-section" id="central-section">
    <div class="ai-header" onclick="toggleCentral()">
      <span>🔗 Use a central constitution from a Git repository</span>
      <span id="central-toggle">${error ? '▾' : '▸'}</span>
    </div>
    <div id="central-body" style="display:${error ? 'block' : 'none'}">
      <p class="hint">For organisations that share one constitution across many projects. Caramelo keeps .specify/memory/constitution.md as an exact copy of the file in the repository, using your existing Git credentials, and tells you when it changes.</p>
      <label>Repository</label>
      <input type="text" id="centralRepo" placeholder="https://github.com/acme/engineering-standards.git or git@github.com:acme/standards.git" />
      <label>File in the repository</label>
      <input type="text" id="centralPath" placeholder="${DEFAULT_CONSTITUTION_PATH}" />
      <label>Branch or tag (optional)</label>
      <input type="text" id="centralRef" placeholder="default branch — or a tag such as v2 to pin a reviewed version" />
      ${error ? `<p class="hint" style="color: var(--vscode-errorForeground)">${escapeHtml(error)}</p>` : ''}
      <button class="btn-generate" style="margin-top:10px" onclick="connectCentral()">Connect</button>
    </div>
  </div>
  <script>
    function toggleCentral() {
      const b = document.getElementById('central-body');
      const open = b.style.display === 'none';
      b.style.display = open ? 'block' : 'none';
      document.getElementById('central-toggle').textContent = open ? '▾' : '▸';
    }
    // \`vscode\` is the API handle created by the editor's main script.
    function connectCentral() {
      vscode.postMessage({
        command: 'connectCentral',
        repository: document.getElementById('centralRepo').value,
        path: document.getElementById('centralPath').value,
        ref: document.getElementById('centralRef').value,
      });
    }
  </script>`;
}

export function currentConstitution(root: string): string | undefined {
  return readConstitution(root);
}
