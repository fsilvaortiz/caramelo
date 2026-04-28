import { describe, it, expect } from 'vitest';
import { pickTerminalArtifact, shouldUsePhaseAgent } from '../workflow.js';
import type { AgentMessage } from '../../agent/types.js';

describe('shouldUsePhaseAgent', () => {
  it('uses agent for design when capability + kill-switch align', () => {
    expect(shouldUsePhaseAgent('design', true, true)).toBe(true);
  });

  it('uses agent for tasks when capability + kill-switch align', () => {
    expect(shouldUsePhaseAgent('tasks', true, true)).toBe(true);
  });

  it('NEVER uses agent for requirements', () => {
    // requirements has no existing code to explore; text-only always.
    expect(shouldUsePhaseAgent('requirements', true, true)).toBe(false);
  });

  it('falls back when provider lacks tool-calling capability', () => {
    expect(shouldUsePhaseAgent('design', true, false)).toBe(false);
    expect(shouldUsePhaseAgent('tasks', true, false)).toBe(false);
  });

  it('falls back when the kill switch is off', () => {
    expect(shouldUsePhaseAgent('design', false, true)).toBe(false);
    expect(shouldUsePhaseAgent('tasks', false, true)).toBe(false);
  });
});

describe('pickTerminalArtifact', () => {
  it('returns content of the last assistant message with no tool calls', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'file_read', arguments: {} }] },
      { role: 'tool', toolCallId: '1', toolName: 'file_read', content: 'body' },
      { role: 'assistant', content: '# Final Plan\n\nContent here.' },
    ];
    expect(pickTerminalArtifact(messages)).toBe('# Final Plan\n\nContent here.');
  });

  it('walks backwards past intermediate assistant turns that still had tool calls', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'Reading…', toolCalls: [{ id: '1', name: 'file_read', arguments: {} }] },
      { role: 'tool', toolCallId: '1', toolName: 'file_read', content: 'body' },
      // Multiple candidates — pick the last WITHOUT toolCalls.
      { role: 'assistant', content: 'intermediate' },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'grep', arguments: {} }] },
      { role: 'tool', toolCallId: '2', toolName: 'grep', content: 'results' },
      { role: 'assistant', content: '# Plan\n\nFinal output.' },
    ];
    expect(pickTerminalArtifact(messages)).toBe('# Plan\n\nFinal output.');
  });

  it('returns empty string when no qualifying assistant message exists', () => {
    // Only assistant turns with tool_calls — no terminal artifact yet.
    const messages: AgentMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'file_read', arguments: {} }] },
      { role: 'tool', toolCallId: '1', toolName: 'file_read', content: 'body' },
    ];
    expect(pickTerminalArtifact(messages)).toBe('');
  });

  it('returns empty string when message list is empty', () => {
    expect(pickTerminalArtifact([])).toBe('');
  });

  it('treats an assistant turn with empty toolCalls array as terminal', () => {
    // JSON round-trip can leave an empty array where undefined was
    // expected — the check is `length > 0`, so empty array is fine.
    const messages: AgentMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'Done.', toolCalls: [] },
    ];
    expect(pickTerminalArtifact(messages)).toBe('Done.');
  });
});
