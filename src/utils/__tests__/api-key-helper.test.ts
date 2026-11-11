import { describe, it, expect, vi } from 'vitest';
import { ApiKeyHelper, createApiKeyHelper, runShellCommand, DEFAULT_API_KEY_HELPER_TTL_MS } from '../api-key-helper.js';
import { AuthError } from '../../errors.js';

function helperWith(run: ReturnType<typeof vi.fn>, opts: { ttlMs?: number; now?: () => number; isTrusted?: () => boolean } = {}) {
  return new ApiKeyHelper('get-key', 'Test', { run, cwd: () => '/tmp', isTrusted: () => true, ...opts });
}

describe('ApiKeyHelper', () => {
  it('returns trimmed stdout as the key', async () => {
    const run = vi.fn().mockResolvedValue('  sk-abc\n');
    await expect(helperWith(run).getKey()).resolves.toBe('sk-abc');
    expect(run).toHaveBeenCalledWith('get-key', expect.objectContaining({ cwd: '/tmp' }));
  });

  it('caches the key until the TTL expires', async () => {
    let t = 0;
    const run = vi.fn().mockResolvedValueOnce('k1').mockResolvedValueOnce('k2');
    const helper = helperWith(run, { ttlMs: 1000, now: () => t });
    expect(await helper.getKey()).toBe('k1');
    t = 999;
    expect(await helper.getKey()).toBe('k1');
    t = 1000;
    expect(await helper.getKey()).toBe('k2');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces a refresh', async () => {
    const run = vi.fn().mockResolvedValueOnce('k1').mockResolvedValueOnce('k2');
    const helper = helperWith(run);
    expect(await helper.getKey()).toBe('k1');
    helper.invalidate();
    expect(await helper.getKey()).toBe('k2');
  });

  it('deduplicates concurrent calls', async () => {
    let resolve!: (v: string) => void;
    const run = vi.fn().mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const helper = helperWith(run);
    const a = helper.getKey();
    const b = helper.getKey();
    resolve('k');
    expect(await Promise.all([a, b])).toEqual(['k', 'k']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects empty or multi-line output', async () => {
    await expect(helperWith(vi.fn().mockResolvedValue('\n')).getKey()).rejects.toThrow(/empty key/);
    await expect(helperWith(vi.fn().mockResolvedValue('a\nb\n')).getKey()).rejects.toThrow(/single line/);
  });

  it('wraps command failures in AuthError and does not cache them', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('exit 1')).mockResolvedValueOnce('k');
    const helper = helperWith(run);
    await expect(helper.getKey()).rejects.toBeInstanceOf(AuthError);
    expect(await helper.getKey()).toBe('k');
  });

  it('refuses to run in untrusted workspaces', async () => {
    const run = vi.fn();
    await expect(helperWith(run, { isTrusted: () => false }).getKey()).rejects.toThrow(/untrusted/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('createApiKeyHelper', () => {
  it('returns null when no command is configured', () => {
    expect(createApiKeyHelper({ name: 'x' })).toBeNull();
    expect(createApiKeyHelper({ name: 'x', apiKeyHelper: '   ' })).toBeNull();
  });

  it('builds a helper with the default TTL when none is given', async () => {
    let t = 0;
    const run = vi.fn().mockResolvedValue('k');
    const helper = createApiKeyHelper({ name: 'x', apiKeyHelper: 'cmd' }, { run, now: () => t, isTrusted: () => true, cwd: () => '/' })!;
    await helper.getKey();
    t = DEFAULT_API_KEY_HELPER_TTL_MS - 1;
    await helper.getKey();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('runShellCommand', () => {
  // Commands must work in both /bin/sh and cmd.exe (Windows CI): `&&` chaining
  // proves the string goes through a shell, and node stands in for anything
  // that needs stderr + an exit code.
  const node = `"${process.execPath}"`;

  it('runs through the shell and returns stdout', async () => {
    const out = await runShellCommand('echo hello&& echo world', { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual(['hello', 'world']);
  });

  it('rejects with stderr detail on non-zero exit', async () => {
    const cmd = `${node} -e "process.stderr.write('boom');process.exit(3)"`;
    await expect(runShellCommand(cmd, { cwd: process.cwd(), timeoutMs: 10_000 })).rejects.toThrow(/boom/);
  });
});
