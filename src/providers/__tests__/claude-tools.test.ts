import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeProvider } from '../claude.js';
import type { AgentEvent, Tool } from '../../agent/types.js';

// Minimal SecretStorage stub for the provider constructor.
const secrets = {
  get: vi.fn().mockResolvedValue('test-key'),
  store: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
} as unknown as import('vscode').SecretStorage;

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const readTool: Tool = {
  name: 'file_read',
  description: 'read a file',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  async execute() {
    return { summary: 'ok', content: 'ok' };
  },
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ClaudeProvider.chatWithTools', () => {
  it('yields text deltas and a tool_call assembled from streaming input_json_delta', async () => {
    const transcript = [
      // Text block
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading file.' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      // Tool-use block — deliberately split the JSON across two deltas to exercise reassembly.
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_123', name: 'file_read', input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"sr' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'c/a.ts"}' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(transcript),
    } as unknown as Response);

    const provider = new ClaudeProvider(
      {
        id: 'c',
        name: 'Claude',
        endpoint: 'https://api.anthropic.com',
        model: 'claude-opus-4-7',
        apiKeyId: 'k',
      },
      secrets,
    );
    await provider.authenticate();

    const events = await collect(
      provider.chatWithTools({
        messages: [{ role: 'user', content: 'Read it' }],
        tools: [readTool],
      }),
    );

    const textEvents = events.filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text');
    const toolCalls = events.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call');
    expect(textEvents.map((e) => e.delta).join('')).toBe('Reading file.');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].call).toEqual({
      id: 'toolu_123',
      name: 'file_read',
      arguments: { path: 'src/a.ts' },
    });
  });

  it('emits a done error event when the provider streams an error event', async () => {
    const transcript = [
      `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'too busy' } })}\n\n`,
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(transcript),
    } as unknown as Response);

    const provider = new ClaudeProvider(
      { id: 'c', name: 'Claude', endpoint: 'https://api.anthropic.com', model: 'x', apiKeyId: 'k' },
      secrets,
    );
    await provider.authenticate();

    const events = await collect(
      provider.chatWithTools({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    );
    const last = events.at(-1);
    expect(last?.kind).toBe('done');
    if (last?.kind === 'done') {
      expect(last.reason).toBe('error');
      expect(last.error).toMatch(/too busy/);
    }
  });

  it('passes tools, messages, and system into the request body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf([
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
      ]),
    } as unknown as Response);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new ClaudeProvider(
      { id: 'c', name: 'Claude', endpoint: 'https://api.anthropic.com', model: 'x', apiKeyId: 'k' },
      secrets,
    );
    await provider.authenticate();

    await collect(
      provider.chatWithTools({
        system: 'SYSTEM',
        messages: [
          { role: 'user', content: 'u1' },
          {
            role: 'assistant',
            content: 'thinking',
            toolCalls: [{ id: 'c1', name: 'file_read', arguments: { path: 'x' } }],
          },
          {
            role: 'tool',
            toolCallId: 'c1',
            toolName: 'file_read',
            content: 'file contents',
          },
        ],
        tools: [readTool],
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.system).toBe('SYSTEM');
    expect(body.tools).toEqual([
      {
        name: 'file_read',
        description: 'read a file',
        input_schema: readTool.inputSchema,
      },
    ]);
    // Messages: user, assistant (with tool_use), user (with tool_result)
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'u1' });
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 'c1', name: 'file_read', input: { path: 'x' } },
    ]);
    expect(body.messages[2].role).toBe('user');
    expect(body.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'file contents' },
    ]);
  });
});
