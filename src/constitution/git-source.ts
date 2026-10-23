import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read one file from a remote Git repository with the user's existing Git
 * credentials. The repository URL comes from workspace settings, i.e. from a
 * file anyone can commit, so every input is validated and git runs with a
 * protocol allowlist and no interactive prompts.
 */

export type GitSourceErrorKind =
  | 'invalid-url'
  | 'invalid-path'
  | 'invalid-ref'
  | 'not-found'
  | 'auth'
  | 'network'
  | 'ref-not-found'
  | 'file-not-found'
  | 'too-large'
  | 'timeout'
  | 'git-missing'
  | 'invalid-content'
  | 'unknown';

export class GitSourceError extends Error {
  constructor(readonly kind: GitSourceErrorKind, message: string, readonly detail?: string) {
    super(message);
  }
}

export interface GitSource {
  repository: string;
  /** Path of the file inside the repository, POSIX separators. */
  path: string;
  /** Branch or tag; empty for the remote's default branch. */
  ref?: string;
}

const ALLOWED_PROTOCOLS = 'https:ssh:git:file';
const LS_REMOTE_TIMEOUT_MS = 20_000;
const CLONE_TIMEOUT_MS = 60_000;
export const MAX_FILE_BYTES = 1024 * 1024;

/** https://, ssh://, git://, file:// URLs, or scp-like `user@host:path`. */
export function validateRepositoryUrl(raw: string): string {
  const url = raw.trim();
  const bad = (why: string) => new GitSourceError('invalid-url', `Invalid repository URL: ${why}`);
  if (!url) throw bad('it is empty');
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) throw bad('Git transport helpers ("<name>::") are not allowed');
  if (/[\s\x00-\x1f\x7f]/.test(url)) throw bad('it contains whitespace or control characters');
  if (url.startsWith('-')) throw bad('it starts with "-"');

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (!['https', 'ssh', 'git', 'file'].includes(scheme)) {
      throw bad(`the "${scheme}" protocol is not allowed (use https, ssh, git or file)`);
    }
    if (scheme !== 'file' && !/^[a-z]+:\/\/[^/]+\/./i.test(url)) throw bad('it has no host or repository path');
    return url;
  }
  // scp-like syntax: [user@]host:path — a one-letter "host" would be a Windows drive.
  const scp = /^(?:[A-Za-z0-9._~-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(url);
  if (scp && scp[1].length > 1 && !scp[2].startsWith('-')) return url;
  throw bad('use https://…, ssh://…, git@host:org/repo.git, git://… or file://…');
}

/** Relative POSIX path inside the repository. */
export function validateFilePath(raw: string): string {
  const p = raw.trim();
  const bad = (why: string) => new GitSourceError('invalid-path', `Invalid file path "${raw}": ${why}`);
  if (!p) throw bad('it is empty');
  if (/[\x00-\x1f\x7f\\]/.test(p)) throw bad('use forward slashes and no control characters');
  if (p.startsWith('/') || p.startsWith('-') || /^[A-Za-z]:/.test(p)) throw bad('it must be relative to the repository root');
  if (p.split('/').some((seg) => seg === '..' || seg === '')) throw bad('it must not contain ".." or empty segments');
  return p;
}

/** Branch or tag name; empty means the default branch. */
export function validateRef(raw: string | undefined): string | undefined {
  const r = (raw ?? '').trim();
  if (!r) return undefined;
  const ok = /^[A-Za-z0-9._/-]+$/.test(r) && !r.startsWith('-') && !r.startsWith('/') && !r.endsWith('/')
    && !r.endsWith('.lock') && !r.includes('..') && !r.includes('//');
  if (!ok) throw new GitSourceError('invalid-ref', `Invalid branch or tag "${raw}".`);
  return r;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
  };
}

interface RunResult { stdout: string; stderr: string }

function runGit(args: string[], opts: { cwd?: string; timeoutMs: number; maxBuffer?: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: opts.cwd,
      env: gitEnv(),
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** Map a failed git invocation to a user-facing error. Exported for tests. */
export function classifyGitError(err: unknown, source: GitSource): GitSourceError {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
  const stderr = (e.stderr ?? '').trim();
  const where = source.repository;
  if (e.code === 'ENOENT') return new GitSourceError('git-missing', 'Git is not installed or not on PATH.');
  // Checked before `killed`: Node also kills the child when stdout exceeds maxBuffer.
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new GitSourceError('too-large', `${source.path} is larger than ${MAX_FILE_BYTES / 1024} KB.`);
  }
  if (e.killed || e.signal === 'SIGTERM') return new GitSourceError('timeout', `Timed out contacting ${where}.`, stderr);
  const s = stderr.toLowerCase();
  if (/remote branch .* not found|couldn't find remote ref/.test(s)) {
    return new GitSourceError('ref-not-found', `Branch or tag "${source.ref}" not found in ${where}.`, stderr);
  }
  if (/(path|file) .* does not exist|exists on disk, but not in|invalid object name|not a valid object name/.test(s)) {
    return new GitSourceError('file-not-found', `${source.path} was not found in ${where}${source.ref ? ` at ${source.ref}` : ''}.`, stderr);
  }
  if (/authentication failed|permission denied|could not read username|terminal prompts disabled|access denied|http basic: access denied|returned error: 40[13]/.test(s)) {
    return new GitSourceError('auth', `Access denied to ${where} — or it does not exist (hosts answer both the same way). Check the URL and your Git credentials (SSH key or credential helper).`, stderr);
  }
  if (/repository .*not found|not found|does not appear to be a git repository|returned error: 404/.test(s)) {
    return new GitSourceError('not-found', `Repository not found: ${where}.`, stderr);
  }
  if (/could not resolve host|connection (timed out|refused)|network is unreachable|unable to access|failed to connect|ssl/.test(s)) {
    return new GitSourceError('network', `Could not reach ${where}.`, stderr);
  }
  if (/transport .* not allowed/.test(s)) {
    return new GitSourceError('invalid-url', `The protocol of ${where} is not allowed.`, stderr);
  }
  return new GitSourceError('unknown', `Git failed for ${where}.`, stderr || e.message);
}

/** Commit the branch/tag (or the default branch) currently points to. */
export async function resolveRemoteCommit(source: GitSource): Promise<string> {
  const repository = validateRepositoryUrl(source.repository);
  const ref = validateRef(source.ref);
  let stdout: string;
  try {
    // An annotated tag's own line carries the tag object id; only the peeled
    // `^{}` line has the commit, and a bare "<ref>" pattern does not match it.
    const patterns = ref ? [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`] : ['HEAD'];
    ({ stdout } = await runGit(['ls-remote', '--', repository, ...patterns], { timeoutMs: LS_REMOTE_TIMEOUT_MS }));
  } catch (err) {
    throw classifyGitError(err, source);
  }
  const refs = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name) refs.set(name, sha);
  }
  const candidates = ref
    ? [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]
    : ['HEAD'];
  for (const c of candidates) {
    const sha = refs.get(c);
    if (sha) return sha;
  }
  throw new GitSourceError('ref-not-found', ref ? `Branch or tag "${ref}" not found in ${repository}.` : `${repository} has no default branch.`);
}

export interface FetchedFile {
  commit: string;
  content: string;
}

/** Shallow, blob-less clone into a temp dir, read one file at HEAD, delete the clone. */
export async function fetchFile(source: GitSource): Promise<FetchedFile> {
  const repository = validateRepositoryUrl(source.repository);
  const filePath = validateFilePath(source.path);
  const ref = validateRef(source.ref);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-constitution-'));
  try {
    const clone = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout'];
    if (ref) clone.push('--branch', ref);
    clone.push('--', repository, dir);
    try {
      await runGit(clone, { timeoutMs: CLONE_TIMEOUT_MS });
      const { stdout: commit } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 10_000 });
      const { stdout: content } = await runGit(['show', `HEAD:${filePath}`], {
        cwd: dir,
        timeoutMs: CLONE_TIMEOUT_MS,
        maxBuffer: MAX_FILE_BYTES,
      });
      return { commit: commit.trim(), content };
    } catch (err) {
      throw err instanceof GitSourceError ? err : classifyGitError(err, source);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
