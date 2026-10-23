import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/log.js';
import {
  checkRemote,
  localStatus,
  normalizeConfig,
  sha256,
  syncCentral,
  CONSTITUTION_REL,
  type CentralConfig,
  type CentralStatus,
  type GitOps,
} from './central.js';
import { GitSourceError } from './git-source.js';

/** Re-check the remote at most this often before generations. */
const REMOTE_CHECK_TTL_MS = 5 * 60_000;

export interface CentralUi {
  /** Modal question; resolves to the chosen button or undefined when dismissed. */
  ask(message: string, detail: string, buttons: string[]): Promise<string | undefined>;
  /** Non-blocking notification with optional buttons. */
  notify(message: string, buttons: string[]): Promise<string | undefined>;
  error(message: string): void;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
}

const vscodeUi: CentralUi = {
  ask: (message, detail, buttons) => Promise.resolve(vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons)),
  notify: (message, buttons) => Promise.resolve(vscode.window.showInformationMessage(message, ...buttons)),
  error: (message) => { void vscode.window.showErrorMessage(message); },
  withProgress: (title, task) =>
    Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task)),
};

export function readCentralSettings(scope?: vscode.Uri): { repository?: string; path?: string; ref?: string } {
  const cfg = vscode.workspace.getConfiguration('caramelo.constitution', scope);
  return { repository: cfg.get<string>('repository'), path: cfg.get<string>('path'), ref: cfg.get<string>('ref') };
}

function describeSource(c: CentralConfig): string {
  return `${c.repository}${c.ref ? ` @ ${c.ref}` : ''} (${c.path})`;
}

export class CentralConstitution implements vscode.Disposable {
  private status: CentralStatus = { kind: 'not-configured' };
  private lastRemoteCheck: number | undefined;
  private readonly declined = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<CentralStatus>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly workspaceRoot: string | undefined,
    private readonly ui: CentralUi = vscodeUi,
    private readonly git?: GitOps,
    private readonly readSettings: () => ReturnType<typeof readCentralSettings> = () => readCentralSettings(),
    private readonly isTrusted: () => boolean = () => vscode.workspace.isTrusted !== false,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.refreshLocal();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /** Validated settings; an invalid value surfaces as an error status instead of throwing. */
  config(): { config?: CentralConfig; error?: GitSourceError } {
    try {
      return { config: normalizeConfig(this.readSettings()) };
    } catch (err) {
      return { error: err instanceof GitSourceError ? err : new GitSourceError('unknown', String(err)) };
    }
  }

  getStatus(): CentralStatus {
    return this.status;
  }

  isConfigured(): boolean {
    const { config, error } = this.config();
    return !!config || !!error;
  }

  private set(status: CentralStatus): CentralStatus {
    this.status = status;
    this.emitter.fire(status);
    return status;
  }

  /** Re-read disk state (settings changed, constitution.md edited). */
  refreshLocal(): CentralStatus {
    if (!this.workspaceRoot) return this.set({ kind: 'not-configured' });
    const { config, error } = this.config();
    if (error) return this.set({ kind: 'error', localEdits: false, error });
    const local = localStatus(this.workspaceRoot, config);
    // Keep a known remote state (update/error) unless the disk state changed what it means.
    const prev = this.status;
    if (local.kind === 'synced' && (prev.kind === 'update-available' || prev.kind === 'error') && prev.meta?.commit === local.meta.commit) {
      return this.set({ ...prev, localEdits: local.localEdits });
    }
    return this.set(local);
  }

  async checkRemote(force = false): Promise<CentralStatus> {
    const { config, error } = this.config();
    if (!this.workspaceRoot || error || !config) return this.refreshLocal();
    if (!this.isTrusted()) return this.refreshLocal();
    if (!force && this.lastRemoteCheck !== undefined && this.now() - this.lastRemoteCheck < REMOTE_CHECK_TTL_MS) {
      return this.refreshLocal();
    }
    this.lastRemoteCheck = this.now();
    const status = await checkRemote(this.workspaceRoot, config, this.git);
    if (status.kind === 'error') log.warn(`[constitution] remote check failed: ${status.error.message}`, status.error.detail ?? '');
    return this.set(status);
  }

  /** Make constitution.md match the central file. Returns false (after telling the user) on failure. */
  async sync(): Promise<boolean> {
    const { config, error } = this.config();
    if (!this.workspaceRoot || !config) {
      if (error) this.ui.error(`Caramelo: central constitution settings are invalid — ${error.message}`);
      return false;
    }
    if (!this.isTrusted()) {
      this.ui.error('Caramelo: trust this workspace to sync the central constitution.');
      return false;
    }
    try {
      await this.ui.withProgress(`Syncing constitution from ${config.repository}…`, () =>
        syncCentral(this.workspaceRoot!, config, this.git));
      this.lastRemoteCheck = this.now();
      this.refreshLocal();
      return true;
    } catch (err) {
      const e = err instanceof GitSourceError ? err : new GitSourceError('unknown', String(err));
      log.warn(`[constitution] sync failed: ${e.message}`, e.detail ?? '');
      this.ui.error(`Caramelo: could not sync the central constitution — ${e.message}`);
      const local = localStatus(this.workspaceRoot, config);
      this.set(local.kind === 'synced'
        ? { kind: 'error', meta: local.meta, localEdits: local.localEdits, error: e }
        : { kind: 'error', localEdits: false, error: e });
      return false;
    }
  }

  /** On startup: check in the background and offer a one-click sync when needed. */
  async onActivation(): Promise<void> {
    const { config } = this.config();
    if (!config || !this.isTrusted()) return;
    const status = await this.checkRemote(true);
    let message: string | undefined;
    if (status.kind === 'not-synced') {
      message = `This workspace uses a central constitution from ${describeSource(config)}. Sync it now?`;
    } else if (status.kind === 'update-available') {
      message = `The central constitution was updated (${describeSource(config)}).`;
    }
    if (!message) return;
    if ((await this.ui.notify(message, ['Sync'])) === 'Sync') await this.sync();
  }

  /**
   * Called before generating. Offers a sync when the central constitution is
   * missing or newer, and a restore when constitution.md was edited by hand.
   * Returns false when the user cancelled (or a requested sync failed).
   * Declining is remembered for the session so the same question isn't repeated.
   */
  async beforeGeneration(): Promise<boolean> {
    const { config } = this.config();
    if (!this.workspaceRoot || !config || !this.isTrusted()) return true;
    const status = await this.checkRemote();
    const source = describeSource(config);

    if (status.kind === 'not-synced') {
      if (this.declined.has('not-synced')) return true;
      return this.offerSync('not-synced', 'The central constitution has not been synced in this workspace.',
        `Source: ${source}\n\nGenerating now would use the local .specify/memory/constitution.md instead.`,
        'Sync and continue', 'Continue without it');
    }
    if (status.kind === 'update-available' && !this.declined.has(`update:${status.remoteCommit}`)) {
      const ok = await this.offerSync(`update:${status.remoteCommit}`, 'The central constitution was updated.',
        `Source: ${source}\nSynced: ${status.meta.commit.slice(0, 7)} → available: ${status.remoteCommit.slice(0, 7)}`,
        'Sync and continue', 'Continue with current');
      if (!ok) return false;
      if (this.status.kind !== 'synced' || !this.status.localEdits) return true;
    }
    const current = this.status;
    if ((current.kind === 'synced' || current.kind === 'update-available' || current.kind === 'error') && current.localEdits) {
      const key = `edits:${this.currentHash()}`;
      if (!this.declined.has(key)) {
        return this.offerSync(key, '.specify/memory/constitution.md was edited and no longer matches the central constitution.',
          `Source: ${source}\n\nRestoring replaces the local edits with the central version.`,
          'Restore central and continue', 'Keep my edits');
      }
    }
    return true;
  }

  private async offerSync(key: string, message: string, detail: string, syncLabel: string, keepLabel: string): Promise<boolean> {
    const choice = await this.ui.ask(message, detail, [syncLabel, keepLabel]);
    if (choice === undefined) return false;
    if (choice === keepLabel) {
      this.declined.add(key);
      return true;
    }
    return this.sync();
  }

  private currentHash(): string {
    try {
      return sha256(fs.readFileSync(path.join(this.workspaceRoot!, CONSTITUTION_REL), 'utf-8'));
    } catch {
      return 'missing';
    }
  }
}

let instance: CentralConstitution | undefined;

export function setCentralConstitution(c: CentralConstitution | undefined): void {
  instance = c;
}

export function getCentralConstitution(): CentralConstitution | undefined {
  return instance;
}

/** Gate for generation commands; true when there is nothing to do or the user chose to continue. */
export async function ensureCentralConstitutionCurrent(): Promise<boolean> {
  return instance ? instance.beforeGeneration() : true;
}
