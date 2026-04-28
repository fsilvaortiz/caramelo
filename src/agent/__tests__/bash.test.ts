import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('truncates stdout at exactly 10 KB', async () => {
    if (!hasShell) return;
    // Produce ~20 KB of output via a POSIX-portable command (brace
    // expansion is a bash-ism, not available under /bin/sh).
    const result = await bashTool.execute(
      { command: 'yes a | tr -d "\\n" | head -c 20000' },
      ctxFor(),
    );
    expect(result.isError).toBeFalsy();
    const out = String(result.content);
    // Extract the stdout section and verify its byte count is the exact
    // cap — a regression removing the cap would produce a much larger
    // section. The header advertises the byte count; we verify both the
    // header and the actual payload length.
    const match = out.match(/--- stdout \((\d+) B, truncated\) ---\n([\s\S]*?)\n--- stderr/);
    expect(match).toBeTruthy();
    if (match) {
      const byteCount = parseInt(match[1], 10);
      const payload = match[2];
      expect(byteCount).toBe(10 * 1024);
      expect(payload.length).toBe(10 * 1024);
    }
  });

  it('clamps huge timeout_ms values to the 120 s hard max', async () => {
    if (!hasShell) return;
    // Spy on setTimeout and assert the delay the tool passes in is
    // clamped to MAX_TIMEOUT_MS (120_000), even when we request ~16
    // minutes. Without the clamp, a compromised/buggy agent could pin
    // the worker for hours before SIGKILL fires.
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    const spy = ((fn: (...args: unknown[]) => void, delay: number, ...rest: unknown[]) => {
      delays.push(delay);
      return originalSetTimeout(fn, delay, ...rest);
    }) as unknown as typeof setTimeout;
    globalThis.setTimeout = spy;
    try {
      const result = await bashTool.execute(
        { command: 'echo fast', timeout_ms: 999_999_999 },
        ctxFor(),
      );
      expect(result.isError).toBeFalsy();
      // The tool's own setTimeout call for the watchdog is the largest
      // one we expect (dominating any libuv internal timers that might
      // also route through setTimeout). Assert 120_000 appears.
      expect(delays).toContain(120_000);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('clamps tiny timeout_ms values up to the 100 ms floor', async () => {
    if (!hasShell) return;
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    const spy = ((fn: (...args: unknown[]) => void, delay: number, ...rest: unknown[]) => {
      delays.push(delay);
      return originalSetTimeout(fn, delay, ...rest);
    }) as unknown as typeof setTimeout;
    globalThis.setTimeout = spy;
    try {
      await bashTool.execute(
        { command: 'echo ok', timeout_ms: 1 },
        ctxFor(),
      );
      expect(delays).toContain(100);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

// Hook `vi` so TS doesn't complain about the import being unused in the
// no-shell path on platforms where `hasShell` is false.
void vi;
