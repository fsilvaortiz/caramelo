import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isObject, safeJsonParse } from '../utils/safe-json.js';
import {
  fetchFile,
  resolveRemoteCommit,
  validateFilePath,
  validateRef,
  validateRepositoryUrl,
  GitSourceError,
  type FetchedFile,
  type GitSource,
} from './git-source.js';

/**
 * Central constitution: `.specify/memory/constitution.md` is kept as an exact
 * copy of a file in a remote Git repository, so Spec Kit, other agents and
 * every Caramelo prompt keep reading the usual path. What was synced is
 * recorded next to it, which lets Caramelo tell a newer central version
 * apart from local edits to the copy.
 */

export const CONSTITUTION_REL = path.join('.specify', 'memory', 'constitution.md');
export const SOURCE_META_REL = path.join('.specify', 'memory', 'constitution-source.json');
export const DEFAULT_CONSTITUTION_PATH = 'constitution.md';

export interface CentralConfig {
  repository: string;
  path: string;
  ref?: string;
}

export interface CentralMeta {
  repository: string;
  path: string;
  ref?: string;
  commit: string;
  sha256: string;
  syncedAt: string;
}

export type CentralStatus =
  | { kind: 'not-configured' }
  /** Configured, but this workspace has never synced this source. */
  | { kind: 'not-synced' }
  | { kind: 'synced'; meta: CentralMeta; localEdits: boolean }
  | { kind: 'update-available'; meta: CentralMeta; localEdits: boolean; remoteCommit: string }
  | { kind: 'error'; meta?: CentralMeta; localEdits: boolean; error: GitSourceError };

export interface GitOps {
  resolveRemoteCommit(source: GitSource): Promise<string>;
  fetchFile(source: GitSource): Promise<FetchedFile>;
}

const realGit: GitOps = { resolveRemoteCommit, fetchFile };

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Normalise and validate a config; throws GitSourceError on invalid input. */
export function normalizeConfig(raw: { repository?: string; path?: string; ref?: string }): CentralConfig | undefined {
  if (!raw.repository || !raw.repository.trim()) return undefined;
  return {
    repository: validateRepositoryUrl(raw.repository),
    path: validateFilePath(raw.path?.trim() ? raw.path : DEFAULT_CONSTITUTION_PATH),
    ref: validateRef(raw.ref),
  };
}

function toSource(config: CentralConfig): GitSource {
  return { repository: config.repository, path: config.path, ref: config.ref };
}

export function readMeta(workspaceRoot: string): CentralMeta | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceRoot, SOURCE_META_REL), 'utf-8');
  } catch {
    return undefined;
  }
  const data = safeJsonParse(raw, isObject);
  if (!data) return undefined;
  const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : undefined);
  const repository = str('repository');
  const filePath = str('path');
  const commit = str('commit');
  const hash = str('sha256');
  const syncedAt = str('syncedAt');
  if (!repository || !filePath || !commit || !hash || !syncedAt) return undefined;
  return { repository, path: filePath, ref: str('ref') || undefined, commit, sha256: hash, syncedAt };
}

/** The recorded sync belongs to the configured source (a changed repo/path/ref needs a fresh sync). */
export function sameSource(config: CentralConfig, meta: CentralMeta): boolean {
  return config.repository === meta.repository && config.path === meta.path && (config.ref ?? '') === (meta.ref ?? '');
}

function readConstitution(workspaceRoot: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspaceRoot, CONSTITUTION_REL), 'utf-8');
  } catch {
    return undefined;
  }
}

/** Status from disk only — no network. */
export function localStatus(workspaceRoot: string, config: CentralConfig | undefined): CentralStatus {
  if (!config) return { kind: 'not-configured' };
  const meta = readMeta(workspaceRoot);
  if (!meta || !sameSource(config, meta)) return { kind: 'not-synced' };
  const current = readConstitution(workspaceRoot);
  return { kind: 'synced', meta, localEdits: current === undefined || sha256(current) !== meta.sha256 };
}

/**
 * Compare with the remote. A new commit whose file content is unchanged is
 * recorded silently, so unrelated commits in the central repository never
 * show up as an update.
 */
export async function checkRemote(
  workspaceRoot: string,
  config: CentralConfig | undefined,
  git: GitOps = realGit,
): Promise<CentralStatus> {
  const local = localStatus(workspaceRoot, config);
  if (local.kind !== 'synced' || !config) return local;
  const { meta, localEdits } = local;
  try {
    const remoteCommit = await git.resolveRemoteCommit(toSource(config));
    if (remoteCommit === meta.commit) return local;
    const fetched = await git.fetchFile(toSource(config));
    if (sha256(fetched.content) === meta.sha256) {
      const updated = { ...meta, commit: fetched.commit };
      writeMeta(workspaceRoot, updated);
      return { kind: 'synced', meta: updated, localEdits };
    }
    return { kind: 'update-available', meta, localEdits, remoteCommit: fetched.commit };
  } catch (err) {
    return { kind: 'error', meta, localEdits, error: asGitError(err) };
  }
}

function asGitError(err: unknown): GitSourceError {
  return err instanceof GitSourceError ? err : new GitSourceError('unknown', err instanceof Error ? err.message : String(err));
}

/** A central file must be a real constitution, not empty and not Spec Kit's unfilled template. */
export function validateContent(content: string, config: CentralConfig): void {
  if (!content.trim()) {
    throw new GitSourceError('invalid-content', `${config.path} in ${config.repository} is empty.`);
  }
  if (content.includes('[PRINCIPLE_1_NAME]')) {
    throw new GitSourceError('invalid-content', `${config.path} in ${config.repository} is still the unfilled Spec Kit template.`);
  }
}

function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function writeMeta(workspaceRoot: string, meta: CentralMeta): void {
  atomicWrite(path.join(workspaceRoot, SOURCE_META_REL), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Fetch the central file and make constitution.md an exact copy of it.
 * Nothing is written when the fetch or validation fails, so a broken source
 * never replaces a good constitution.
 */
export async function syncCentral(
  workspaceRoot: string,
  config: CentralConfig,
  git: GitOps = realGit,
  now: Date = new Date(),
): Promise<CentralMeta> {
  const fetched = await git.fetchFile(toSource(config));
  validateContent(fetched.content, config);
  atomicWrite(path.join(workspaceRoot, CONSTITUTION_REL), fetched.content);
  const meta: CentralMeta = {
    repository: config.repository,
    path: config.path,
    ...(config.ref ? { ref: config.ref } : {}),
    commit: fetched.commit,
    sha256: sha256(fetched.content),
    syncedAt: now.toISOString(),
  };
  writeMeta(workspaceRoot, meta);
  return meta;
}

/** Forget the source; constitution.md stays as it is and becomes a normal local file. */
export function disconnectCentral(workspaceRoot: string): void {
  fs.rmSync(path.join(workspaceRoot, SOURCE_META_REL), { force: true });
}
