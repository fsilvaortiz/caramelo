import { exec } from 'node:child_process';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { AuthError } from '../errors.js';

/**
 * `apiKeyHelper` support — the same idea as Claude Code's `apiKeyHelper`
 * setting: instead of storing a static API key, the provider runs a shell
 * command whose stdout is the key. Useful for short-lived tokens issued by
 * a corporate gateway, a vault CLI, `gcloud auth print-access-token`, etc.
 *
 * The value is cached for `ttlMs` (default 5 minutes, like Claude Code) and
 * refreshed earlier when the endpoint answers 401/403 (see `invalidate()`).
 */

export const DEFAULT_API_KEY_HELPER_TTL_MS = 5 * 60_000;
export const API_KEY_HELPER_TIMEOUT_MS = 60_000;

export type CommandRunner = (
  command: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<string>;

export interface ApiKeyHelperOptions {
  ttlMs?: number;
  /** Injected for tests; defaults to running the command through the user's shell. */
  run?: CommandRunner;
  /** Injected for tests; defaults to `vscode.workspace.isTrusted`. */
  isTrusted?: () => boolean;
  /** Injected for tests; defaults to the first workspace folder (or $HOME). */
  cwd?: () => string;
  now?: () => number;
}

export const runShellCommand: CommandRunner = (command, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || '').trim().slice(0, 500);
          reject(new Error(`${err.message.split('\n')[0]}${detail ? ` — ${detail}` : ''}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });

function defaultCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

export function normaliseTtl(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_API_KEY_HELPER_TTL_MS;
}

export class ApiKeyHelper {
  private cached: { key: string; at: number } | null = null;
  private inFlight: Promise<string> | null = null;
  private readonly ttlMs: number;
  private readonly run: CommandRunner;
  private readonly isTrusted: () => boolean;
  private readonly cwd: () => string;
  private readonly now: () => number;

  constructor(
    readonly command: string,
    private readonly label: string,
    opts: ApiKeyHelperOptions = {},
  ) {
    this.ttlMs = normaliseTtl(opts.ttlMs);
    this.run = opts.run ?? runShellCommand;
    this.isTrusted = opts.isTrusted ?? (() => vscode.workspace.isTrusted !== false);
    this.cwd = opts.cwd ?? defaultCwd;
    this.now = opts.now ?? Date.now;
  }

  /** Returns a key, running the helper only when the cache is empty or expired. */
  async getKey(): Promise<string> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) {
      return this.cached.key;
    }
    // Deduplicate concurrent callers (parallel [P] tasks) onto one run.
    if (!this.inFlight) {
      this.inFlight = this.execute().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Drop the cached key so the next `getKey()` runs the helper again. */
  invalidate(): void {
    this.cached = null;
  }

  private async execute(): Promise<string> {
    if (!this.isTrusted()) {
      throw new AuthError(
        `${this.label}: apiKeyHelper is disabled in untrusted workspaces. Trust the workspace to run it.`,
      );
    }
    let stdout: string;
    try {
      stdout = await this.run(this.command, { cwd: this.cwd(), timeoutMs: API_KEY_HELPER_TIMEOUT_MS });
    } catch (err) {
      throw new AuthError(`${this.label}: apiKeyHelper failed: ${(err as Error).message}`, err);
    }
    const key = stdout.trim();
    if (!key) {
      throw new AuthError(`${this.label}: apiKeyHelper printed an empty key`);
    }
    if (/[\r\n]/.test(key)) {
      throw new AuthError(`${this.label}: apiKeyHelper must print the key on a single line`);
    }
    this.cached = { key, at: this.now() };
    return key;
  }
}

/** Build a helper from a provider config, or null when none is configured. */
export function createApiKeyHelper(
  config: { name: string; apiKeyHelper?: string; apiKeyHelperTtlMs?: number },
  opts: Omit<ApiKeyHelperOptions, 'ttlMs'> = {},
): ApiKeyHelper | null {
  const command = typeof config.apiKeyHelper === 'string' ? config.apiKeyHelper.trim() : '';
  if (!command) return null;
  return new ApiKeyHelper(command, config.name, { ...opts, ttlMs: config.apiKeyHelperTtlMs });
}
