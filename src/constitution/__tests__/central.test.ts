import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkRemote,
  disconnectCentral,
  localStatus,
  normalizeConfig,
  readMeta,
  sha256,
  syncCentral,
  CONSTITUTION_REL,
  SOURCE_META_REL,
  type CentralConfig,
  type GitOps,
} from '../central.js';
import { GitSourceError } from '../git-source.js';

let root: string;
const config: CentralConfig = { repository: 'https://git.acme.io/arch/standards.git', path: 'constitution.md', ref: 'v2' };
const constitution = () => fs.readFileSync(path.join(root, CONSTITUTION_REL), 'utf-8');

/** Fake remote: the test sets what the remote currently holds. */
function fakeGit(remote: { commit: string; content: string } | Error) {
  const calls = { resolve: 0, fetch: 0 };
  const git: GitOps = {
    async resolveRemoteCommit() {
      calls.resolve++;
      if (remote instanceof Error) throw remote;
      return remote.commit;
    },
    async fetchFile() {
      calls.fetch++;
      if (remote instanceof Error) throw remote;
      return { ...remote };
    },
  };
  return { git, calls };
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-central-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('normalizeConfig', () => {
  it('returns undefined when no repository is configured', () => {
    expect(normalizeConfig({})).toBeUndefined();
    expect(normalizeConfig({ repository: '  ', path: 'x.md' })).toBeUndefined();
  });

  it('defaults the path, trims, and drops an empty ref', () => {
    expect(normalizeConfig({ repository: ' git@github.com:acme/std.git ', path: '', ref: ' ' }))
      .toEqual({ repository: 'git@github.com:acme/std.git', path: 'constitution.md', ref: undefined });
  });

  it('rejects unsafe values', () => {
    expect(() => normalizeConfig({ repository: 'ext::sh -c x' })).toThrow(GitSourceError);
    expect(() => normalizeConfig({ repository: 'https://h/r.git', path: '../x' })).toThrow(GitSourceError);
  });
});

describe('syncCentral', () => {
  it('writes constitution.md as an exact copy and records the source', async () => {
    const { git } = fakeGit({ commit: 'c1', content: '# Org\n\n## I. Security first\n' });
    const meta = await syncCentral(root, config, git, new Date('2026-10-23T10:00:00Z'));
    expect(constitution()).toBe('# Org\n\n## I. Security first\n');
    expect(meta).toEqual({
      repository: config.repository, path: 'constitution.md', ref: 'v2', commit: 'c1',
      sha256: sha256('# Org\n\n## I. Security first\n'), syncedAt: '2026-10-23T10:00:00.000Z',
    });
    expect(readMeta(root)).toEqual(meta);
  });

  it('omits ref from the record when following the default branch', async () => {
    const { git } = fakeGit({ commit: 'c1', content: '# Org\n' });
    const meta = await syncCentral(root, { ...config, ref: undefined }, git);
    expect('ref' in meta).toBe(false);
  });

  it.each([
    ['empty', '  \n', /is empty/],
    ['the unfilled template', '# [PROJECT_NAME]\n### [PRINCIPLE_1_NAME]\n', /unfilled Spec Kit template/],
  ])('refuses %s content and leaves the existing constitution untouched', async (_label, content, msg) => {
    fs.mkdirSync(path.dirname(path.join(root, CONSTITUTION_REL)), { recursive: true });
    fs.writeFileSync(path.join(root, CONSTITUTION_REL), '# Previous\n');
    const { git } = fakeGit({ commit: 'c9', content });
    await expect(syncCentral(root, config, git)).rejects.toThrow(msg);
    expect(constitution()).toBe('# Previous\n');
    expect(readMeta(root)).toBeUndefined();
  });

  it('a failed fetch writes nothing', async () => {
    const { git } = fakeGit(new GitSourceError('auth', 'denied'));
    await expect(syncCentral(root, config, git)).rejects.toMatchObject({ kind: 'auth' });
    expect(fs.existsSync(path.join(root, CONSTITUTION_REL))).toBe(false);
  });
});

describe('localStatus', () => {
  it('not-configured / not-synced / synced', async () => {
    expect(localStatus(root, undefined)).toEqual({ kind: 'not-configured' });
    expect(localStatus(root, config)).toEqual({ kind: 'not-synced' });
    await syncCentral(root, config, fakeGit({ commit: 'c1', content: '# Org\n' }).git);
    expect(localStatus(root, config)).toMatchObject({ kind: 'synced', localEdits: false });
  });

  it('a changed repository, path or ref means the workspace needs a fresh sync', async () => {
    await syncCentral(root, config, fakeGit({ commit: 'c1', content: '# Org\n' }).git);
    expect(localStatus(root, { ...config, ref: 'v3' }).kind).toBe('not-synced');
    expect(localStatus(root, { ...config, path: 'other.md' }).kind).toBe('not-synced');
    expect(localStatus(root, { ...config, repository: 'https://git.acme.io/other.git' }).kind).toBe('not-synced');
  });

  it('flags local edits to constitution.md, and a deleted file', async () => {
    await syncCentral(root, config, fakeGit({ commit: 'c1', content: '# Org\n' }).git);
    fs.appendFileSync(path.join(root, CONSTITUTION_REL), '\n## Our own rule\n');
    expect(localStatus(root, config)).toMatchObject({ kind: 'synced', localEdits: true });
    fs.rmSync(path.join(root, CONSTITUTION_REL));
    expect(localStatus(root, config)).toMatchObject({ kind: 'synced', localEdits: true });
  });

  it('ignores a corrupt or incomplete source record', () => {
    fs.mkdirSync(path.dirname(path.join(root, SOURCE_META_REL)), { recursive: true });
    fs.writeFileSync(path.join(root, SOURCE_META_REL), '{bad');
    expect(localStatus(root, config).kind).toBe('not-synced');
    fs.writeFileSync(path.join(root, SOURCE_META_REL), JSON.stringify({ repository: config.repository }));
    expect(localStatus(root, config).kind).toBe('not-synced');
  });
});

describe('checkRemote', () => {
  beforeEach(async () => {
    await syncCentral(root, config, fakeGit({ commit: 'c1', content: '# Org v1\n' }).git);
  });

  it('same commit → synced, without downloading anything', async () => {
    const { git, calls } = fakeGit({ commit: 'c1', content: 'unused' });
    expect(await checkRemote(root, config, git)).toMatchObject({ kind: 'synced' });
    expect(calls).toEqual({ resolve: 1, fetch: 0 });
  });

  it('new commit, same file content → stays synced and records the new commit silently', async () => {
    const { git } = fakeGit({ commit: 'c2', content: '# Org v1\n' });
    expect(await checkRemote(root, config, git)).toMatchObject({ kind: 'synced', meta: { commit: 'c2' } });
    expect(readMeta(root)!.commit).toBe('c2');
    expect(constitution()).toBe('# Org v1\n');
  });

  it('new content → update-available, and nothing is written until sync', async () => {
    const { git } = fakeGit({ commit: 'c3', content: '# Org v2\n' });
    expect(await checkRemote(root, config, git)).toMatchObject({ kind: 'update-available', remoteCommit: 'c3', meta: { commit: 'c1' } });
    expect(constitution()).toBe('# Org v1\n');
    expect(readMeta(root)!.commit).toBe('c1');
  });

  it('reports local edits alongside the remote state', async () => {
    fs.writeFileSync(path.join(root, CONSTITUTION_REL), '# Edited\n');
    expect(await checkRemote(root, config, fakeGit({ commit: 'c1', content: '' }).git)).toMatchObject({ kind: 'synced', localEdits: true });
    expect(await checkRemote(root, config, fakeGit({ commit: 'c4', content: '# Org v3\n' }).git))
      .toMatchObject({ kind: 'update-available', localEdits: true });
  });

  it('network/auth problems → error with the last synced record kept', async () => {
    const status = await checkRemote(root, config, fakeGit(new GitSourceError('network', 'offline')).git);
    expect(status).toMatchObject({ kind: 'error', meta: { commit: 'c1' }, error: { kind: 'network' } });
    expect(constitution()).toBe('# Org v1\n');
  });

  it('does not contact the remote when nothing has been synced yet', async () => {
    const { git, calls } = fakeGit({ commit: 'c1', content: '' });
    expect(await checkRemote(root, { ...config, ref: 'other' }, git)).toEqual({ kind: 'not-synced' });
    expect(calls).toEqual({ resolve: 0, fetch: 0 });
  });
});

describe('disconnectCentral', () => {
  it('forgets the source but keeps constitution.md', async () => {
    await syncCentral(root, config, fakeGit({ commit: 'c1', content: '# Org\n' }).git);
    disconnectCentral(root);
    expect(readMeta(root)).toBeUndefined();
    expect(constitution()).toBe('# Org\n');
  });
});
