import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluateHookCondition, loadExtensionConfig } from '../hook-conditions.js';

let root: string;

function write(rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

const ctx = (extensionId?: string, env: Record<string, string> = {}) => ({ workspaceRoot: root, extensionId, env });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-cond-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadExtensionConfig — layering (defaults → project → local → env)', () => {
  it('merges layers recursively with later layers winning', () => {
    write('.specify/extensions/jira/extension.yml', 'config:\n  defaults:\n    connection:\n      url: https://default\n      timeout: 30\n');
    write('.specify/extensions/jira/jira-config.yml', 'connection:\n  url: https://project\n');
    write('.specify/extensions/jira/local-config.yml', 'project:\n  key: LOCAL\n');
    const cfg = loadExtensionConfig(root, 'jira', { SPECKIT_JIRA_PROJECT_KEY: 'ENV' });
    expect(cfg).toEqual({ connection: { url: 'https://project', timeout: 30 }, project: { key: 'ENV' } });
  });

  it('reads defaults from manifest config.defaults only (not top-level defaults)', () => {
    write('.specify/extensions/x/extension.yml', 'defaults:\n  a: 1\nconfig:\n  defaults:\n    b: 2\n');
    expect(loadExtensionConfig(root, 'x', {})).toEqual({ b: 2 });
  });

  it('tolerates missing, malformed and non-mapping files', () => {
    write('.specify/extensions/x/extension.yml', 'config: [1, 2]\n');
    write('.specify/extensions/x/x-config.yml', '- not\n- a mapping\n');
    write('.specify/extensions/x/local-config.yml', 'a: [');
    expect(loadExtensionConfig(root, 'x', {})).toEqual({});
    expect(loadExtensionConfig(root, 'missing', {})).toEqual({});
  });

  it('maps hyphenated extension ids to SPECKIT_<ID>_ with underscores', () => {
    expect(loadExtensionConfig(root, 'azure-devops', { SPECKIT_AZURE_DEVOPS_ORG_NAME: 'acme' })).toEqual({ org: { name: 'acme' } });
  });

  it('leaves env vars owned by a longer installed sibling id to that sibling', () => {
    write('.specify/extensions/.registry', JSON.stringify({ schema_version: '1', extensions: { git: {}, 'git-hooks': {} } }));
    const env = { SPECKIT_GIT_HOOKS_URL: 'sibling', SPECKIT_GIT_REMOTE: 'mine' };
    expect(loadExtensionConfig(root, 'git', env)).toEqual({ remote: 'mine' });
    expect(loadExtensionConfig(root, 'git-hooks', env)).toEqual({ url: 'sibling' });
  });

  it('nested env vars win over a colliding scalar regardless of order', () => {
    expect(loadExtensionConfig(root, 'x', { SPECKIT_X_CONNECTION: 'a', SPECKIT_X_CONNECTION_URL: 'b' }))
      .toEqual({ connection: { url: 'b' } });
    expect(loadExtensionConfig(root, 'x', { SPECKIT_X_CONNECTION_URL: 'b', SPECKIT_X_CONNECTION: 'a' }))
      .toEqual({ connection: { url: 'b' } });
  });
});

describe('evaluateHookCondition', () => {
  beforeEach(() => {
    write('.specify/extensions/jira/jira-config.yml', 'connection:\n  url: https://acme.atlassian.net\nsync:\n  enabled: true\n  empty: null\n');
  });

  it('absent or empty condition → runs; whitespace-only is evaluated and never runs (Spec Kit parity)', () => {
    expect(evaluateHookCondition(undefined, ctx('jira'))).toBe(true);
    expect(evaluateHookCondition('', ctx('jira'))).toBe(true);
    expect(evaluateHookCondition('   ', ctx('jira'))).toBe(false);
  });

  it('compares containers against Python str() output', () => {
    write('.specify/extensions/jira/jira-config.yml', 'list: [1, 2]\nmixed: [true, null, 2]\nnested: {k: 1}\n');
    expect(evaluateHookCondition("config.list == '[1, 2]'", ctx('jira'))).toBe(true);
    expect(evaluateHookCondition("config.mixed == '[True, None, 2]'", ctx('jira'))).toBe(true);
    expect(evaluateHookCondition("config.list == '[1,2]'", ctx('jira'))).toBe(false);
  });

  it('config.<path> is set — true even when the value is null', () => {
    expect(evaluateHookCondition('config.connection.url is set', ctx('jira'))).toBe(true);
    expect(evaluateHookCondition('config.sync.empty is set', ctx('jira'))).toBe(true);
    expect(evaluateHookCondition('config.connection.token is set', ctx('jira'))).toBe(false);
  });

  it('config comparisons normalise YAML booleans to lowercase', () => {
    expect(evaluateHookCondition("config.sync.enabled == 'true'", ctx('jira'))).toBe(true);
    expect(evaluateHookCondition('config.sync.enabled == "True"', ctx('jira'))).toBe(false);
    expect(evaluateHookCondition("config.connection.url != 'x'", ctx('jira'))).toBe(true);
  });

  it('config != on a missing key compares against Python None and is therefore true', () => {
    expect(evaluateHookCondition("config.nope != 'x'", ctx('jira'))).toBe(true);
    expect(evaluateHookCondition("config.nope == 'None'", ctx('jira'))).toBe(true);
  });

  it('config conditions without an extension id are false', () => {
    expect(evaluateHookCondition('config.connection.url is set', ctx(undefined))).toBe(false);
  });

  it('env conditions are case-insensitive on the name and read the given env', () => {
    expect(evaluateHookCondition('env.ci is set', ctx(undefined, { CI: '' }))).toBe(true);
    expect(evaluateHookCondition('env.CI is set', ctx(undefined, {}))).toBe(false);
    expect(evaluateHookCondition("env.STAGE == 'prod'", ctx(undefined, { STAGE: 'prod' }))).toBe(true);
    expect(evaluateHookCondition("env.STAGE != 'prod'", ctx(undefined, {}))).toBe(true);
  });

  it('matches at the start only, like Python re.match', () => {
    expect(evaluateHookCondition('env.CI is set and anything', ctx(undefined, { CI: '1' }))).toBe(true);
    expect(evaluateHookCondition('not env.CI is set', ctx(undefined, { CI: '1' }))).toBe(false);
  });

  it('unknown expressions evaluate to false', () => {
    expect(evaluateHookCondition('true', ctx('jira'))).toBe(false);
    expect(evaluateHookCondition('config.a > 3', ctx('jira'))).toBe(false);
  });
});
