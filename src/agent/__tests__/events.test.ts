import { describe, it, expect } from 'vitest';
import { formatEvent, formatPrologue } from '../events.js';
import type { AgentEvent } from '../types.js';

describe('formatEvent — redaction (Constitution III)', () => {
  it('redacts Bearer tokens in text deltas', () => {
    const out = formatEvent({
      kind: 'text',
      delta: 'Here is a leaked secret: Bearer sk-abc123xyz',
    });
    expect(out).toMatch(/Bearer \[REDACTED\]/);
    expect(out).not.toMatch(/sk-abc123xyz/);
  });

  it('redacts authorization-like headers in tool_call args', () => {
    const ev: AgentEvent = {
      kind: 'tool_call',
      call: {
        id: 'c1',
        name: 'file_write',
        arguments: { path: 'a.env', content: 'AUTHORIZATION: Bearer super-secret-789' },
      },
    };
    const out = formatEvent(ev) ?? '';
    expect(out).toMatch(/\[REDACTED\]/);
    expect(out).not.toMatch(/super-secret-789/);
  });

  it('redacts URL-embedded credentials in tool_result summaries', () => {
    const ev: AgentEvent = {
      kind: 'tool_result',
      callId: 'c1',
      toolName: 'bash',
      result: {
        summary: 'cloned from https://user:pw-789@github.com/x/y.git',
        content: '',
      },
    };
    const out = formatEvent(ev) ?? '';
    expect(out).toMatch(/\[REDACTED\]@github\.com/);
    expect(out).not.toMatch(/pw-789/);
  });

  it('redacts leaked tokens in tool_denied reasons', () => {
    const ev: AgentEvent = {
      kind: 'tool_denied',
      callId: 'c1',
      toolName: 'bash',
      reason: 'user typed Authorization: Bearer leaked-42 in the comment',
    };
    const out = formatEvent(ev) ?? '';
    expect(out).toMatch(/\[REDACTED\]/);
    expect(out).not.toMatch(/leaked-42/);
  });

  it('redacts error strings in done events', () => {
    const out = formatEvent({
      kind: 'done',
      reason: 'error',
      error: 'provider returned 401 for Bearer sk-private',
    });
    expect(out).toMatch(/Bearer \[REDACTED\]/);
    expect(out).not.toMatch(/sk-private/);
  });

  it('passes through benign text unchanged aside from whitespace', () => {
    const out = formatEvent({ kind: 'text', delta: 'Reading file src/foo.ts' });
    expect(out).toBe('Reading file src/foo.ts');
  });
});

describe('formatPrologue', () => {
  it('includes provider, capabilities, tool count, approval mode, bash flag', () => {
    const line = formatPrologue({
      providerId: 'claude-main',
      providerName: 'Claude',
      model: 'claude-opus-4-7',
      capabilities: ['streaming', 'tool-calling'],
      toolNames: ['file_read', 'file_edit', 'bash'],
      approvalMode: 'auto-reads-batched-writes',
      bashEnabled: true,
      maxIterations: 15,
    });
    expect(line).toMatch(/provider=Claude \(claude-main\)/);
    expect(line).toMatch(/model=claude-opus-4-7/);
    expect(line).toMatch(/capabilities=\[streaming,tool-calling\]/);
    expect(line).toMatch(/tools=3/);
    expect(line).toMatch(/approval=auto-reads-batched-writes/);
    expect(line).toMatch(/bash=on/);
    expect(line).toMatch(/maxIter=15/);
  });

  it('redacts sensitive substrings in provider name or model id', () => {
    const line = formatPrologue({
      providerId: 'proxy-route-sk-dangerous',
      providerName: 'CorporateProxy Bearer abc123',
      model: undefined,
      capabilities: ['streaming'],
      toolNames: [],
      approvalMode: 'per-call',
      bashEnabled: false,
      maxIterations: 3,
    });
    expect(line).toMatch(/Bearer \[REDACTED\]/);
    expect(line).not.toMatch(/abc123/);
    expect(line).toMatch(/model=\(default\)/);
    expect(line).toMatch(/bash=off/);
  });
});
