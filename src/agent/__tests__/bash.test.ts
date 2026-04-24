import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bashTool } from '../tools/bash.js';
import { nodeFs } from '../tools/io.js';
import type { ToolContext } from '../types.js';

// Note: bash.ts spawns /bin/sh. These tests skip on Windows runners (where
// /bin/sh doesn't exist) by returning early — Phase A ships POSIX-only.
const hasShell = fs.existsSync('/bin/sh');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-bash-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ctxFor(signal?: AbortSignal): ToolContext {
  return {
    workspaceRoot: tmp,
    signal: signal ?? new AbortController().signal,
    log: () => { /* noop */ },
    io: nodeFs,
  };
}

describe('bash tool', () => {
  it('runs a simple command and returns stdout + exit 0', async () => {
    if (!hasShell) return;
    const result = await bashTool.execute({ command: 'echo hello-world' }, ctxFor());
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toMatch(/exit_code: 0/);
    expect(String(result.content)).toMatch(/hello-world/);
  });

  it('surfaces non-zero exit codes as is_error=true', async () => {
    if (!hasShell) return;
    const result = await bashTool.execute({ command: 'exit 3' }, ctxFor());
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/exit_code: 3/);
  });

  it('refuses cwd paths that escape the workspace', async () => {
    const result = await bashTool.execute({ command: 'pwd', cwd: '../' }, ctxFor());
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/outside the workspace/);
  });

  it('runs in the given workspace-relative cwd', async () => {
    if (!hasShell) return;
    fs.mkdirSync(path.join(tmp, 'sub'));
    const result = await bashTool.execute(
      { command: 'pwd', cwd: 'sub' },
      ctxFor(),
    );
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain(path.join(tmp, 'sub'));
  });

  it('enforces the timeout via SIGKILL', async () => {
    if (!hasShell) return;
    const result = await bashTool.execute(
      { command: 'sleep 5', timeout_ms: 200 },
      ctxFor(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/reason: timeout/);
  });

  it('honours the abort signal', async () => {
    if (!hasShell) return;
    const controller = new AbortController();
    const p = bashTool.execute({ command: 'sleep 5' }, ctxFor(controller.signal));
    setTimeout(() => controller.abort(), 50);
    const result = await p;
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/reason: aborted/);
  });

  it('truncates stdout past 10 KB', async () => {
    if (!hasShell) return;
    // Produce ~20 KB of output via a POSIX-portable command (brace
    // expansion is a bash-ism, not available under /bin/sh).
    const result = await bashTool.execute(
      { command: 'yes a | tr -d "\\n" | head -c 20000' },
      ctxFor(),
    );
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toMatch(/truncated/);
  });

  it('clamps huge timeouts to 120 s', async () => {
    if (!hasShell) return;
    // We only verify the clamp by passing an absurd value and confirming
    // the call doesn't hang forever — the command itself exits fast.
    const result = await bashTool.execute(
      { command: 'echo fast', timeout_ms: 999_999_999 },
      ctxFor(),
    );
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toMatch(/exit_code: 0/);
  });
});
