import { describe, it, expect, vi } from 'vitest';
import {
  autoAllAllPolicy,
  autoAllowPolicy,
  perCallPolicy,
  readOnlyAutoBatchedWritesPolicy,
} from '../approval.js';
import type { Tool, ToolCallApproval } from '../types.js';

const readTool: Tool = {
  name: 'file_read',
  description: 'read',
  readOnly: true,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return { summary: '', content: '' };
  },
};

const editTool: Tool = {
  name: 'file_edit',
  description: 'edit',
  readOnly: false,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return { summary: '', content: '' };
  },
};

const bashTool: Tool = {
  name: 'bash',
  description: 'bash',
  readOnly: false,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return { summary: '', content: '' };
  },
};

function call(id: string, tool: Tool, args: Record<string, unknown> = {}): ToolCallApproval {
  return { call: { id, name: tool.name, arguments: args }, tool };
}

const ctx = { workspaceRoot: '/tmp', turnIndex: 1 };

describe('autoAllowPolicy', () => {
  it('allows everything including bash — tests only', async () => {
    const out = await autoAllowPolicy.decide(
      [call('r', readTool), call('e', editTool), call('b', bashTool, { command: 'rm -rf /' })],
      ctx,
    );
    expect(out).toEqual({ r: 'allow', e: 'allow', b: 'allow' });
  });
});

describe('readOnlyAutoBatchedWritesPolicy', () => {
  it('auto-allows reads, batches writes, always prompts bash', async () => {
    const confirmBash = vi.fn().mockResolvedValue('allow' as const);
    const confirmWrites = vi.fn().mockResolvedValue({ e: 'allow' });

    const policy = readOnlyAutoBatchedWritesPolicy({
      isAutoApplyEnabled: () => false,
      setSessionAutoApply: vi.fn(),
      hooks: { confirmBash, confirmWrites },
    });

    const out = await policy.decide(
      [
        call('r', readTool),
        call('e', editTool, { path: 'a.ts', search: 'x', replace: 'y' }),
        call('b', bashTool, { command: 'echo hi' }),
      ],
      ctx,
    );
    expect(out.r).toBe('allow');
    expect(out.e).toBe('allow');
    expect(out.b).toBe('allow');
    expect(confirmBash).toHaveBeenCalledTimes(1);
    expect(confirmWrites).toHaveBeenCalledTimes(1);
    expect(confirmWrites.mock.calls[0][0]).toHaveLength(1); // only the edit
  });

  it('auto-apply skips the write prompt but NOT the bash prompt', async () => {
    const confirmBash = vi.fn().mockResolvedValue('allow' as const);
    const confirmWrites = vi.fn();

    const policy = readOnlyAutoBatchedWritesPolicy({
      isAutoApplyEnabled: () => true,
      setSessionAutoApply: vi.fn(),
      hooks: { confirmBash, confirmWrites },
    });

    const out = await policy.decide(
      [
        call('e', editTool, { path: 'a.ts', search: 'x', replace: 'y' }),
        call('b', bashTool, { command: 'npm test' }),
      ],
      ctx,
    );
    expect(out.e).toBe('allow');
    expect(out.b).toBe('allow');
    expect(confirmWrites).not.toHaveBeenCalled();
    expect(confirmBash).toHaveBeenCalledTimes(1);
  });

  it('propagates bash abort and does NOT run the writes prompt', async () => {
    const confirmBash = vi.fn().mockResolvedValue('abort' as const);
    const confirmWrites = vi.fn();

    const policy = readOnlyAutoBatchedWritesPolicy({
      isAutoApplyEnabled: () => false,
      setSessionAutoApply: vi.fn(),
      hooks: { confirmBash, confirmWrites },
    });

    const out = await policy.decide(
      [
        call('b', bashTool, { command: 'rm -rf /' }),
        call('e', editTool, { path: 'a', search: 'x', replace: 'y' }),
      ],
      ctx,
    );
    expect(out.b).toBe('abort');
    expect(confirmWrites).not.toHaveBeenCalled();
  });

  it('defaults to deny when the write-hook omits a call id', async () => {
    const confirmWrites = vi.fn().mockResolvedValue({}); // empty map
    const policy = readOnlyAutoBatchedWritesPolicy({
      isAutoApplyEnabled: () => false,
      setSessionAutoApply: vi.fn(),
      hooks: { confirmWrites, confirmBash: vi.fn() },
    });
    const out = await policy.decide([call('e', editTool, { path: 'a', search: 'x', replace: 'y' })], ctx);
    expect(out.e).toBe('deny');
  });

  it('calls setSessionAutoApply when batched prompt is fed by the default', async () => {
    // We exercise the default confirmWrites via the vscode mock; vscode
    // stub returns undefined from showQuickPick → 'abort' mapping.
    const setSessionAutoApply = vi.fn();
    const policy = readOnlyAutoBatchedWritesPolicy({
      isAutoApplyEnabled: () => false,
      setSessionAutoApply,
    });
    const out = await policy.decide([call('e', editTool, { path: 'a', search: 'x', replace: 'y' })], ctx);
    // Default QuickPick mock returns undefined → aborts.
    expect(out.e).toBe('abort');
    expect(setSessionAutoApply).not.toHaveBeenCalled();
  });
});

describe('perCallPolicy', () => {
  it('uses the write hook (not bash) for file_edit / file_write', async () => {
    const confirmBash = vi.fn();
    const confirmWrite = vi.fn().mockResolvedValue('allow' as const);

    const policy = perCallPolicy({ hooks: { confirmBash, confirmWrite } });
    const out = await policy.decide(
      [call('e', editTool, { path: 'a', search: 'x', replace: 'y' })],
      ctx,
    );
    expect(out.e).toBe('allow');
    expect(confirmWrite).toHaveBeenCalledTimes(1);
    expect(confirmBash).not.toHaveBeenCalled();
  });

  it('routes bash through confirmBash even in per-call mode', async () => {
    const confirmBash = vi.fn().mockResolvedValue('allow' as const);
    const confirmWrite = vi.fn();

    const policy = perCallPolicy({ hooks: { confirmBash, confirmWrite } });
    await policy.decide([call('b', bashTool, { command: 'ls' })], ctx);
    expect(confirmBash).toHaveBeenCalledTimes(1);
    expect(confirmWrite).not.toHaveBeenCalled();
  });

  it('stops at first abort and returns accumulated decisions', async () => {
    const confirmWrite = vi
      .fn()
      .mockResolvedValueOnce('allow' as const)
      .mockResolvedValueOnce('abort' as const);
    const policy = perCallPolicy({ hooks: { confirmBash: vi.fn(), confirmWrite } });
    const out = await policy.decide(
      [
        call('e1', editTool, { path: 'a', search: 'x', replace: 'y' }),
        call('e2', editTool, { path: 'b', search: 'x', replace: 'y' }),
        call('e3', editTool, { path: 'c', search: 'x', replace: 'y' }),
      ],
      ctx,
    );
    expect(out.e1).toBe('allow');
    expect(out.e2).toBe('abort');
    expect(out.e3).toBeUndefined();
  });
});

describe('autoAllAllPolicy', () => {
  it('auto-allows reads and writes but still prompts bash', async () => {
    const confirmBash = vi.fn().mockResolvedValue('allow' as const);
    const policy = autoAllAllPolicy({ hooks: { confirmBash } });

    const out = await policy.decide(
      [
        call('r', readTool),
        call('e', editTool, { path: 'a', search: 'x', replace: 'y' }),
        call('b', bashTool, { command: 'ls' }),
      ],
      ctx,
    );
    expect(out).toEqual({ r: 'allow', e: 'allow', b: 'allow' });
    expect(confirmBash).toHaveBeenCalledTimes(1);
  });

  it('bash denial denies only bash; reads/writes still allowed in the same turn', async () => {
    const confirmBash = vi.fn().mockResolvedValue('deny' as const);
    const policy = autoAllAllPolicy({ hooks: { confirmBash } });
    const out = await policy.decide(
      [call('r', readTool), call('b', bashTool, { command: 'ls' })],
      ctx,
    );
    expect(out.r).toBe('allow');
    expect(out.b).toBe('deny');
  });

  it('bash abort aborts the whole run', async () => {
    const confirmBash = vi.fn().mockResolvedValue('abort' as const);
    const policy = autoAllAllPolicy({ hooks: { confirmBash } });
    const out = await policy.decide(
      [
        call('b', bashTool, { command: 'ls' }),
        call('e', editTool, { path: 'a', search: 'x', replace: 'y' }),
      ],
      ctx,
    );
    expect(out.b).toBe('abort');
    expect(out.e).toBeUndefined();
  });
});
