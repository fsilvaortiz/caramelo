import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  classifyGitError,
  fetchFile,
  resolveRemoteCommit,
  validateFilePath,
  validateRef,
  validateRepositoryUrl,
  GitSourceError,
  MAX_FILE_BYTES,
  removeTempDir,
} from '../git-source.js';

describe('validateRepositoryUrl', () => {
  it.each([
    'https://github.com/acme/standards.git',
    'ssh://git@gitlab.acme.io:2222/arch/constitution.git',
    'git@github.com:acme/standards.git',
    'github.com:acme/standards',
    'git://git.acme.io/standards.git',
    'file:///srv/git/standards.git',
  ])('accepts %s', (url) => {
    expect(validateRepositoryUrl(`  ${url} `)).toBe(url);
  });

  it.each([
    ['', /empty/],
    ['ext::sh -c touch% /tmp/pwned', /transport helpers/],
    ['fd::17', /transport helpers/],
    ['-oProxyCommand=evil', /starts with "-"/],
    ['http://github.com/acme/x.git', /"http" protocol is not allowed/],
    ['ftp://host/repo', /"ftp" protocol/],
    ['https://github.com/acme x.git', /whitespace/],
    ['https://github.com', /no host or repository path/],
    ['C:\\repos\\standards', /use https/],
    ['C:/repos/standards', /use https/],
    ['host:-oProxyCommand=x', /use https/],
    ['just-a-name', /use https/],
  ])('rejects %j', (url, msg) => {
    expect(() => validateRepositoryUrl(url)).toThrow(msg);
  });
});

describe('validateFilePath / validateRef', () => {
  it('accepts relative POSIX paths and trims', () => {
    expect(validateFilePath(' constitution.md ')).toBe('constitution.md');
    expect(validateFilePath('docs/standards/constitution.md')).toBe('docs/standards/constitution.md');
  });

  it.each(['', '/etc/passwd', '../x.md', 'a/../../x', 'a//b', 'C:/x', 'a\\b', '-x', 'a\nb'])('rejects path %j', (p) => {
    expect(() => validateFilePath(p)).toThrow(GitSourceError);
  });

  it('treats blank refs as the default branch and validates names', () => {
    expect(validateRef(undefined)).toBeUndefined();
    expect(validateRef('  ')).toBeUndefined();
    expect(validateRef('v2.1.0')).toBe('v2.1.0');
    expect(validateRef('release/2026')).toBe('release/2026');
    for (const bad of ['-b', 'a..b', 'x.lock', '/x', 'x/', 'a b', 'a//b', 'a~1']) {
      expect(() => validateRef(bad), bad).toThrow(GitSourceError);
    }
  });
});

describe('classifyGitError', () => {
  const src = { repository: 'https://example.com/r.git', path: 'constitution.md', ref: 'v2' };
  const err = (stderr: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('x'), { stderr, ...extra });

  it.each([
    ['fatal: Authentication failed for \'https://example.com/r.git/\'', 'auth'],
    ['git@github.com: Permission denied (publickey).', 'auth'],
    ['fatal: could not read Username for \'https://example.com\': terminal prompts disabled', 'auth'],
    ['remote: Repository not found.\nfatal: repository \'https://example.com/r.git/\' not found', 'not-found'],
    ['fatal: Remote branch v2 not found in upstream origin', 'ref-not-found'],
    ['fatal: path \'constitution.md\' does not exist in \'HEAD\'', 'file-not-found'],
    ['fatal: unable to access \'https://example.com/r.git/\': Could not resolve host: example.com', 'network'],
    ['fatal: transport \'ext\' not allowed', 'invalid-url'],
  ])('%s → %s', (stderr, kind) => {
    expect(classifyGitError(err(stderr), src).kind).toBe(kind);
  });

  it('distinguishes missing git, timeouts and oversized output', () => {
    expect(classifyGitError(Object.assign(new Error('x'), { code: 'ENOENT' }), src).kind).toBe('git-missing');
    expect(classifyGitError(err('', { killed: true, signal: 'SIGTERM' }), src).kind).toBe('timeout');
    expect(classifyGitError(err('', { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), src).kind).toBe('too-large');
  });
});

/** Real git against throwaway repositories reached through file:// URLs. */
describe('resolveRemoteCommit / fetchFile (real git)', () => {
  let root: string;
  let url: string;
  let mainV1: string;
  let tagV1: string;
  let mainV2: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-gitsrc-'));
    const work = path.join(root, 'work');
    const bare = path.join(root, 'standards.git');
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.email', 't@example.com');
    git(work, 'config', 'user.name', 'T');
    fs.mkdirSync(path.join(work, 'docs'));
    fs.writeFileSync(path.join(work, 'constitution.md'), '# Org Constitution v1\n');
    fs.writeFileSync(path.join(work, 'docs', 'nested.md'), '# Nested\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'v1');
    mainV1 = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', '-a', 'v1', '-m', 'release v1');
    git(work, 'tag', 'v1-light');
    tagV1 = mainV1;
    fs.writeFileSync(path.join(work, 'constitution.md'), '# Org Constitution v2\n');
    fs.writeFileSync(path.join(work, 'big.md'), 'x'.repeat(MAX_FILE_BYTES + 10));
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'v2');
    mainV2 = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', '-b', 'draft');
    fs.writeFileSync(path.join(work, 'constitution.md'), '# Draft\n');
    git(work, 'commit', '-q', '-am', 'draft');
    git(work, 'checkout', '-q', 'main');
    git(root, 'clone', '-q', '--bare', work, bare);
    url = pathToFileURL(bare).href;
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves the default branch, a branch, and an annotated tag (peeled)', async () => {
    expect(await resolveRemoteCommit({ repository: url, path: 'constitution.md' })).toBe(mainV2);
    expect(await resolveRemoteCommit({ repository: url, path: 'constitution.md', ref: 'main' })).toBe(mainV2);
    expect(await resolveRemoteCommit({ repository: url, path: 'constitution.md', ref: 'v1' })).toBe(tagV1);
    expect(await resolveRemoteCommit({ repository: url, path: 'constitution.md', ref: 'v1-light' })).toBe(mainV1);
  });

  it('the commit resolved for a tag matches the commit fetched for it (no endless "update available")', async () => {
    for (const ref of ['v1', 'v1-light', 'main', undefined]) {
      const src = { repository: url, path: 'constitution.md', ref };
      expect(await resolveRemoteCommit(src), String(ref)).toBe((await fetchFile(src)).commit);
    }
  });

  it('reports an unknown branch or tag', async () => {
    await expect(resolveRemoteCommit({ repository: url, path: 'x', ref: 'nope' })).rejects.toMatchObject({ kind: 'ref-not-found' });
  });

  it('fetches the file at the default branch, a branch, a tag, and a nested path', async () => {
    expect(await fetchFile({ repository: url, path: 'constitution.md' })).toEqual({ commit: mainV2, content: '# Org Constitution v2\n' });
    expect((await fetchFile({ repository: url, path: 'constitution.md', ref: 'draft' })).content).toBe('# Draft\n');
    expect(await fetchFile({ repository: url, path: 'constitution.md', ref: 'v1' })).toEqual({ commit: mainV1, content: '# Org Constitution v1\n' });
    expect((await fetchFile({ repository: url, path: 'docs/nested.md' })).content).toBe('# Nested\n');
  });

  it('classifies a missing file, missing ref, missing repo, and an oversized file', async () => {
    await expect(fetchFile({ repository: url, path: 'nope.md' })).rejects.toMatchObject({ kind: 'file-not-found' });
    await expect(fetchFile({ repository: url, path: 'constitution.md', ref: 'nope' })).rejects.toMatchObject({ kind: 'ref-not-found' });
    const missing = pathToFileURL(path.join(root, 'missing.git')).href;
    await expect(fetchFile({ repository: missing, path: 'constitution.md' })).rejects.toMatchObject({ kind: 'not-found' });
    await expect(fetchFile({ repository: url, path: 'big.md' })).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('leaves no temporary clone behind', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('caramelo-constitution-')).length;
    await fetchFile({ repository: url, path: 'constitution.md' });
    await fetchFile({ repository: url, path: 'nope.md' }).catch(() => undefined);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('caramelo-constitution-')).length;
    expect(after).toBe(before);
  });

  it('removeTempDir deletes read-only files (git objects) and never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-rm-'));
    fs.mkdirSync(path.join(dir, 'objects', 'ab'), { recursive: true });
    const obj = path.join(dir, 'objects', 'ab', 'cdef');
    fs.writeFileSync(obj, 'x');
    fs.chmodSync(obj, 0o444);
    removeTempDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => removeTempDir(dir)).not.toThrow();
  });

  it('never runs git for an invalid URL (ext:: transport)', async () => {
    const marker = path.join(root, 'pwned');
    await expect(fetchFile({ repository: `ext::sh -c touch% ${marker}`, path: 'constitution.md' }))
      .rejects.toMatchObject({ kind: 'invalid-url' });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
