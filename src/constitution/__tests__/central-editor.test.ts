import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  centralViewHtml,
  connectCentral,
  connectSectionHtml,
  describeStatus,
  disconnectCentralSource,
  BACKUP_REL,
  type ConnectUi,
  type SettingsWriter,
} from '../central-editor.js';
import { readMeta, CONSTITUTION_REL, type CentralConfig, type CentralStatus } from '../central.js';
import { GitSourceError } from '../git-source.js';

let root: string;
const file = (rel: string) => path.join(root, rel);
const read = (rel: string) => fs.readFileSync(file(rel), 'utf-8');
const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), body); };

function makeSettings(stillConfigured = false) {
  const writes: Array<CentralConfig | undefined> = [];
  const settings: SettingsWriter = { write: async (c) => { writes.push(c); }, stillConfigured: () => stillConfigured };
  return { settings, writes };
}
function makeUi(answer?: string) {
  const asked: string[] = [];
  const ui: ConnectUi = { ask: async (m) => { asked.push(m); return answer; }, withProgress: (_t, task) => task() };
  return { ui, asked };
}
const remote = (content: string, commit = 'abc1234def') => async () => ({ commit, content });
const input = { repository: 'https://git.acme.io/arch/standards.git', path: '', ref: 'v2' };

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-centraled-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('connectCentral', () => {
  it('fresh workspace: no question, settings recorded, exact copy written', async () => {
    const { settings, writes } = makeSettings();
    const { ui, asked } = makeUi();
    expect(await connectCentral(root, input, settings, ui, remote('# Acme\n## I. Security\n'))).toEqual({ ok: true });
    expect(asked).toEqual([]);
    expect(writes).toEqual([{ repository: input.repository, path: 'constitution.md', ref: 'v2' }]);
    expect(read(CONSTITUTION_REL)).toBe('# Acme\n## I. Security\n');
    expect(readMeta(root)).toMatchObject({ commit: 'abc1234def', ref: 'v2' });
  });

  it('an unfilled template is replaced without asking', async () => {
    write(CONSTITUTION_REL, '# [PROJECT_NAME]\n### [PRINCIPLE_1_NAME]\n');
    const { ui, asked } = makeUi();
    expect((await connectCentral(root, input, makeSettings().settings, ui, remote('# Acme\n'))).ok).toBe(true);
    expect(asked).toEqual([]);
  });

  it('an existing constitution: asks, and on Replace backs it up first', async () => {
    write(CONSTITUTION_REL, '# Our own\n');
    const { ui, asked } = makeUi('Replace');
    expect((await connectCentral(root, input, makeSettings().settings, ui, remote('# Acme\n'))).ok).toBe(true);
    expect(asked[0]).toMatch(/Replace the current constitution/);
    expect(read(BACKUP_REL)).toBe('# Our own\n');
    expect(read(CONSTITUTION_REL)).toBe('# Acme\n');
  });

  it('declining leaves the constitution, the settings and the source record untouched', async () => {
    write(CONSTITUTION_REL, '# Our own\n');
    const { settings, writes } = makeSettings();
    expect(await connectCentral(root, input, settings, makeUi(undefined).ui, remote('# Acme\n'))).toEqual({ ok: false });
    expect(writes).toEqual([]);
    expect(read(CONSTITUTION_REL)).toBe('# Our own\n');
    expect(readMeta(root)).toBeUndefined();
    expect(fs.existsSync(file(BACKUP_REL))).toBe(false);
  });

  it('identical content needs no question', async () => {
    write(CONSTITUTION_REL, '# Acme\n');
    const { ui, asked } = makeUi();
    expect((await connectCentral(root, input, makeSettings().settings, ui, remote('# Acme\n'))).ok).toBe(true);
    expect(asked).toEqual([]);
  });

  it.each([
    ['an empty repository field', { ...input, repository: '  ' }, remote('# Acme\n'), /Enter the repository URL/],
    ['an unsafe URL', { ...input, repository: 'ext::sh -c x' }, remote('# Acme\n'), /transport helpers/],
    ['an unreachable repository', input, async () => { throw new GitSourceError('auth', 'Access denied to repo.'); }, /Access denied/],
    ['the unfilled template upstream', input, remote('### [PRINCIPLE_1_NAME]\n'), /unfilled Spec Kit template/],
  ])('%s → error, nothing changed', async (_l, inp, fetch, msg) => {
    write(CONSTITUTION_REL, '# Our own\n');
    const { settings, writes } = makeSettings();
    const result = await connectCentral(root, inp, settings, makeUi('Replace').ui, fetch);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(msg);
    expect(writes).toEqual([]);
    expect(read(CONSTITUTION_REL)).toBe('# Our own\n');
  });
});

describe('disconnectCentralSource', () => {
  beforeEach(async () => {
    await connectCentral(root, input, makeSettings().settings, makeUi().ui, remote('# Acme\n'));
  });

  it('confirmed: clears settings and the record, keeps constitution.md', async () => {
    const { settings, writes } = makeSettings();
    expect(await disconnectCentralSource(root, settings, makeUi('Disconnect').ui)).toEqual({ ok: true });
    expect(writes).toEqual([undefined]);
    expect(readMeta(root)).toBeUndefined();
    expect(read(CONSTITUTION_REL)).toBe('# Acme\n');
  });

  it('cancelled: nothing changes', async () => {
    const { settings, writes } = makeSettings();
    expect(await disconnectCentralSource(root, settings, makeUi(undefined).ui)).toEqual({ ok: false });
    expect(writes).toEqual([]);
    expect(readMeta(root)).toBeDefined();
  });

  it('warns when user settings still configure a repository', async () => {
    const result = await disconnectCentralSource(root, makeSettings(true).settings, makeUi('Disconnect').ui);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/user settings/);
  });
});

describe('describeStatus', () => {
  const meta = { repository: 'r', path: 'p', commit: 'abcdef1234', sha256: 'h', syncedAt: '2026-10-23T10:00:00Z' };
  const now = Date.parse('2026-10-23T12:00:00Z');
  it.each<[CentralStatus, string, string | undefined]>([
    [{ kind: 'not-synced' }, 'not synced yet', 'sync'],
    [{ kind: 'synced', meta, localEdits: false }, 'Central · abcdef1 · synced 2 h ago', undefined],
    [{ kind: 'synced', meta, localEdits: true }, 'Edited locally', 'restore'],
    [{ kind: 'update-available', meta, localEdits: false, remoteCommit: '9876543210' }, 'abcdef1 → 9876543', 'sync'],
    [{ kind: 'error', meta, localEdits: false, error: new GitSourceError('network', 'Could not reach r.') }, 'Could not reach r.', 'retry'],
    [{ kind: 'error', localEdits: false, error: new GitSourceError('invalid-url', 'Invalid repository URL') }, 'Invalid repository URL', undefined],
  ])('%j', (status, text, action) => {
    const d = describeStatus(status, now);
    expect(d.text).toContain(text);
    expect(d.action).toBe(action);
  });
});

describe('HTML', () => {
  const config: CentralConfig = { repository: 'https://git.acme.io/<b>x</b>.git', path: 'constitution.md' };
  const status: CentralStatus = { kind: 'synced', meta: { repository: 'r', path: 'p', commit: 'abc', sha256: 'h', syncedAt: '2026-10-23T10:00:00Z' }, localEdits: false };

  it('central view escapes remote content and repository text, and sets a CSP', () => {
    const html = centralViewHtml('vscode-resource:', config, status, '# Rules\n<script>alert(1)</script><img src=x onerror=alert(2)>');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('connect section escapes the error message', () => {
    expect(connectSectionHtml('bad <img src=x onerror=1>')).not.toContain('<img src=x');
  });
});
