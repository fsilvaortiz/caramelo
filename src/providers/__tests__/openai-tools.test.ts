import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from '../openai-compatible.js';
import type { AgentEvent, Tool } from '../../agent/types.js';

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
  description: 'read',
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

/** Build one SSE "data: ..." chunk from a deltas-choices payload. */
function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function provider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    { id: 'gpt', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', apiKeyId: 'k' },
    secrets,
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OpenAICompatibleProvider.chatWithTools', () => {
  it('emits text deltas verbatim', async () => {
    const transcript = [
      sseChunk({ choices: [{ delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] }),
      sseChunk({ choices: [{ delta: { content: 'world' }, finish_reason: null }] }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(transcript),
    } as unknown as Response);

    const p = provider();
    await p.authenticate();
    const events = await collect(
      p.chatWithTools({ messages: [{ role: 'user', content: 'hi' }], tools: [readTool] }),
    );
    const text = events
      .filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Hello world');
    expect(events.some((e) => e.kind === 'tool_call')).toBe(false);
  });

  it('reassembles tool_call deltas split across multiple chunks (arguments JSON fragmented)', async () => {
    // The canonical OpenAI streaming pattern: first chunk has id+name, later
    // chunks are keyed by index and only contain the arguments suffix.
    const transcript = [
      sseChunk({
        choices: [
          {
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'file_read', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseChunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }, finish_reason: null },
        ],
      }),
      sseChunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"src/a.ts"}' } }] }, finish_reason: null },
        ],
      }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(transcript),
    } as unknown as Response);

    const p = provider();
    await p.authenticate();
    const events = await collect(
      p.chatWithTools({ messages: [{ role: 'user', content: 'read it' }], tools: [readTool] }),
    );
    const calls = events.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].call).toEqual({
      id: 'call_abc',
      name: 'file_read',
      arguments: { path: 'src/a.ts' },
    });
  });

  it('handles two tool calls interleaved by index in a single turn', async () => {
    const transcript = [
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_0', type: 'function', function: { name: 'file_read', arguments: '' } },
                { index: 1, id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"path":"a"}' } },
                { index: 1, function: { arguments: '{"path":"b"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(transcript),
    } as unknown as Response);

    const p = provider();
    await p.authenticate();
    const events = await collect(
      p.chatWithTools({ messages: [{ role: 'user', content: 'dual' }], tools: [readTool] }),
    );
    const calls = events.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(calls[0].call.arguments).toEqual({ path: 'a' });
    expect(calls[1].call.arguments).toEqual({ path: 'b' });
  });

  it('emits done:error on malformed tool arguments JSON (no silent fallback to {})', async () => {
    const transcript = [
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_x', type: 'function', function: { name: 'file_read', arguments: '{"path":"src' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(transcript),
    } as unknown as Response);

    const p = provider();
    await p.authenticate();
    const events = await collect(
      p.chatWithTools({ messages: [{ role: 'user', content: 'x' }], tools: [readTool] }),
    );
    const done = events.find((e) => e.kind === 'done');
    expect(done?.kind).toBe('done');
    if (done?.kind === 'done') {
      expect(done.reason).toBe('error');
      expect(done.error).toMatch(/malformed/i);
    }
    expect(events.some((e) => e.kind === 'tool_call')).toBe(false);
  });

  it('treats empty arguments string as {} for tools without required fields', async () => {
    const listDirTool: Tool = {
      name: 'list_dir',
      description: 'list dir',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { summary: '', content: '' };
      },
    };
    const transcript = [
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_e', type: 'function', function: { name: 'list_dir', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(transcript),
    } as unknown as Response);

    const p = provider();
    await p.authenticate();
    const events = await collect(
      p.chatWithTools({ messages: [{ role: 'user', content: 'ls' }], tools: [listDirTool] }),
    );
    const calls = events.filter((e): e is Extract<AgentEvent, { kind: 'tool_call' }> => e.kind === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].call.arguments).toEqual({});
  });

  it('translates role:tool messages to the OpenAI tool message shape', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(['data: [DONE]\n\n']),
    } as unknown as Response);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const p = provider();
    await p.authenticate();
    await collect(
      p.chatWithTools({
        system: 'S',
        messages: [
          { role: 'user', content: 'u1' },
          {
            role: 'assistant',
            content: 'thinking',
            toolCalls: [{ id: 'call_1', name: 'file_read', arguments: { path: 'x' } }],
          },
          {
            role: 'tool',
            toolCallId: 'call_1',
            toolName: 'file_read',
            content: 'file contents',
          },
        ],
        tools: [readTool],
      }),
    );

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'file_read',
          description: 'read',
          parameters: readTool.inputSchema,
        },
      },
    ]);
    // system → first message; assistant with tool_calls has arguments as a JSON string;
    // role:tool becomes { role:'tool', tool_call_id, content }.
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: 'thinking',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'file_read', arguments: JSON.stringify({ path: 'x' }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
    ]);
  });

  it('sends assistant.content as empty string when only tool_calls present', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(['data: [DONE]\n\n']),
    } as unknown as Response);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const p = provider();
    await p.authenticate();
    await collect(
      p.chatWithTools({
        messages: [
          { role: 'user', content: 'u' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c', name: 'file_read', arguments: { path: 'x' } }],
          },
          { role: 'tool', toolCallId: 'c', toolName: 'file_read', content: 'x' },
        ],
        tools: [readTool],
      }),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const assistantMsg = body.messages.find((m: { role: string }) => m.role === 'assistant');
    // OpenAI accepts null OR empty string; we send empty string to match
    // the AgentMessage contract and match what most compatible servers
    // (Ollama, LM Studio) expect.
    expect(assistantMsg.content).toBe('');
    expect(assistantMsg.tool_calls).toHaveLength(1);
  });

  it('dispatches 401 as an error that bubbles out', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid key',
    } as unknown as Response);

    const p = provider();
    await p.authenticate();
    await expect(
      collect(p.chatWithTools({ messages: [{ role: 'user', content: 'hi' }], tools: [readTool] })),
    ).rejects.toThrow(/401/);
  });
});

describe('OpenAICompatibleProvider.capabilities', () => {
  it('advertises tool-calling once a key is present', async () => {
    const p = provider();
    expect(p.capabilities().has('tool-calling')).toBe(false);
    await p.authenticate();
    expect(p.capabilities().has('tool-calling')).toBe(true);
    expect(p.capabilities().has('streaming')).toBe(true);
  });

  it('advertises tool-calling when no auth is required (apiKeyId null — e.g. Ollama)', () => {
    const noAuth = new OpenAICompatibleProvider(
      { id: 'ollama', name: 'Ollama', endpoint: 'http://localhost:11434/v1', model: 'llama3' },
      secrets,
    );
    // No authenticate() call needed because apiKeyId is undefined.
    expect(noAuth.capabilities().has('tool-calling')).toBe(true);
  });
});
