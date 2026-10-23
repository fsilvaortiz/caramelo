import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CentralConstitution, type CentralUi } from '../central-vscode.js';
import { syncCentral, CONSTITUTION_REL, type GitOps } from '../central.js';
import { GitSourceError } from '../git-source.js';

let root: string;
const settings = { repository: 'https://git.acme.io/arch/standards.git', path: 'constitution.md', ref: '' };
const constitution = () => fs.readFileSync(path.join(root, CONSTITUTION_REL), 'utf-8');

let remote: { commit: string; content: string } | Error;
const calls = { resolve: 0, fetch: 0 };
const git: GitOps = {
  async resolveRemoteCommit() { calls.resolve++; if (remote instanceof Error) throw remote; return remote.commit; },
  async fetchFile() { calls.fetch++; if (remote instanceof Error) throw remote; return { ...remote }; },
};

/** Scripted UI: answers questions from a queue and records everything shown. */
function makeUi(answers: Array<string | undefined> = []) {
  const shown: string[] = [];
  const ui: CentralUi = {
    ask: async (message, _detail, buttons) => { shown.push(`ask:${message}|${buttons.join('/')}`); return answers.shift(); },
    notify: async (message, buttons) => { shown.push(`notify:${message}`); return answers.shift() ?? (buttons.length ? undefined : undefined); },
    error: (message) => { shown.push(`error:${message}`); },
    withProgress: (_t, task) => task(),
  };
  return { ui, shown };
}

function make(ui: CentralUi, opts: { trusted?: boolean; s?: typeof settings; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: 0 };
  return new CentralConstitution(root, ui, git, () => opts.s ?? settings, () => opts.trusted ?? true, () => clock.t);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-centralvs-'));
  remote = { commit: 'c1', content: '# Org v1\n' };
  calls.resolve = 0;
  calls.fetch = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const syncedAtC1 = () => syncCentral(root, { repository: settings.repository, path: 'constitution.md' }, git);

describe('beforeGeneration', () => {
  it('does nothing when no repository is configured', async () => {
    const { ui, shown } = makeUi();
    expect(await make(ui, { s: { repository: '', path: '', ref: '' } }).beforeGeneration()).toBe(true);
    expect(shown).toEqual([]);
    expect(calls.resolve).toBe(0);
  });

  it('never runs git in an untrusted workspace', async () => {
    const { ui, shown } = makeUi();
    expect(await make(ui, { trusted: false }).beforeGeneration()).toBe(true);
    expect(calls).toEqual({ resolve: 0, fetch: 0 });
    expect(shown).toEqual([]);
  });

  it('not synced → "Sync and continue" writes constitution.md and proceeds', async () => {
    const { ui, shown } = makeUi(['Sync and continue']);
    expect(await make(ui).beforeGeneration()).toBe(true);
    expect(shown[0]).toMatch(/has not been synced/);
    expect(constitution()).toBe('# Org v1\n');
  });

  it('not synced → "Continue without it" proceeds and is not asked again this session', async () => {
    const { ui, shown } = makeUi(['Continue without it']);
    const c = make(ui);
    expect(await c.beforeGeneration()).toBe(true);
    expect(await c.beforeGeneration()).toBe(true);
    expect(shown.filter((s) => s.startsWith('ask:'))).toHaveLength(1);
  });

  it('dismissing the question cancels the generation', async () => {
    const { ui } = makeUi([undefined]);
    expect(await make(ui).beforeGeneration()).toBe(false);
  });

  it('up to date → no question; the remote is not re-checked within 5 minutes', async () => {
    await syncedAtC1();
    const clock = { t: 0 };
    const { ui, shown } = makeUi();
    const c = make(ui, { clock });
    expect(await c.beforeGeneration()).toBe(true);
    clock.t = 4 * 60_000;
    expect(await c.beforeGeneration()).toBe(true);
    expect(calls.resolve).toBe(1);
    clock.t = 6 * 60_000;
    await c.beforeGeneration();
    expect(calls.resolve).toBe(2);
    expect(shown).toEqual([]);
  });

  it('update available → sync on request, or keep current and not be asked again for that version', async () => {
    await syncedAtC1();
    remote = { commit: 'c2', content: '# Org v2\n' };
    const syncing = makeUi(['Sync and continue']);
    expect(await make(syncing.ui).beforeGeneration()).toBe(true);
    expect(constitution()).toBe('# Org v2\n');

    remote = { commit: 'c3', content: '# Org v3\n' };
    const keeping = makeUi(['Continue with current']);
    const clock = { t: 0 };
    const c = make(keeping.ui, { clock });
    expect(await c.beforeGeneration()).toBe(true);
    clock.t = 10 * 60_000;
    expect(await c.beforeGeneration()).toBe(true);
    expect(keeping.shown.filter((s) => s.startsWith('ask:'))).toHaveLength(1);
    expect(constitution()).toBe('# Org v2\n');

    remote = { commit: 'c4', content: '# Org v4\n' };
    clock.t = 20 * 60_000;
    await c.beforeGeneration();
    expect(keeping.shown.filter((s) => s.startsWith('ask:'))).toHaveLength(2);
  });

  it('local edits → offer to restore; restoring rewrites the central version', async () => {
    await syncedAtC1();
    fs.writeFileSync(path.join(root, CONSTITUTION_REL), '# My own rules\n');
    const { ui, shown } = makeUi(['Restore central and continue']);
    expect(await make(ui).beforeGeneration()).toBe(true);
    expect(shown[0]).toMatch(/was edited/);
    expect(constitution()).toBe('# Org v1\n');
  });

  it('local edits kept → not asked again until the file changes again', async () => {
    await syncedAtC1();
    fs.writeFileSync(path.join(root, CONSTITUTION_REL), '# My own rules\n');
    const { ui, shown } = makeUi(['Keep my edits']);
    const c = make(ui);
    expect(await c.beforeGeneration()).toBe(true);
    expect(await c.beforeGeneration()).toBe(true);
    fs.writeFileSync(path.join(root, CONSTITUTION_REL), '# More edits\n');
    c.refreshLocal();
    await c.beforeGeneration();
    expect(shown.filter((s) => s.includes('was edited'))).toHaveLength(2);
    expect(constitution()).toBe('# More edits\n');
  });

  it('remote unreachable → generation proceeds with the cached constitution, no question', async () => {
    await syncedAtC1();
    remote = new GitSourceError('network', 'offline');
    const { ui, shown } = makeUi();
    expect(await make(ui).beforeGeneration()).toBe(true);
    expect(shown).toEqual([]);
  });

  it('a requested sync that fails cancels the generation and tells the user', async () => {
    remote = new GitSourceError('auth', 'Access denied to the repo.');
    const { ui, shown } = makeUi(['Sync and continue']);
    const c = make(ui);
    expect(await c.beforeGeneration()).toBe(false);
    expect(shown.some((s) => s.startsWith('error:') && s.includes('Access denied'))).toBe(true);
    expect(c.getStatus()).toMatchObject({ kind: 'error', error: { kind: 'auth' } });
  });
});

describe('onActivation', () => {
  it('offers a one-click sync when the workspace was never synced', async () => {
    const { ui, shown } = makeUi(['Sync']);
    await make(ui).onActivation();
    expect(shown[0]).toMatch(/^notify:This workspace uses a central constitution/);
    expect(constitution()).toBe('# Org v1\n');
  });

  it('announces an update without syncing until the user clicks', async () => {
    await syncedAtC1();
    remote = { commit: 'c2', content: '# Org v2\n' };
    const { ui, shown } = makeUi([undefined]);
    const c = make(ui);
    await c.onActivation();
    expect(shown[0]).toMatch(/^notify:The central constitution was updated/);
    expect(constitution()).toBe('# Org v1\n');
    expect(c.getStatus().kind).toBe('update-available');
  });

  it('is silent when up to date', async () => {
    await syncedAtC1();
    const { ui, shown } = makeUi();
    await make(ui).onActivation();
    expect(shown).toEqual([]);
  });
});

describe('status', () => {
  it('invalid settings surface as an error status instead of throwing', () => {
    const { ui } = makeUi();
    const c = make(ui, { s: { repository: 'ext::sh -c x', path: '', ref: '' } });
    expect(c.getStatus()).toMatchObject({ kind: 'error', error: { kind: 'invalid-url' } });
  });

  it('a known update survives a local refresh (e.g. the file watcher firing)', async () => {
    await syncedAtC1();
    remote = { commit: 'c2', content: '# Org v2\n' };
    const { ui } = makeUi();
    const c = make(ui);
    await c.checkRemote(true);
    fs.writeFileSync(path.join(root, CONSTITUTION_REL), '# Edited\n');
    expect(c.refreshLocal()).toMatchObject({ kind: 'update-available', localEdits: true });
  });
});
