import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../runtime.js';
import { autoAllowPolicy } from '../approval.js';
import { fileReadTool } from '../tools/file-read.js';
import { fileWriteTool } from '../tools/file-write.js';
import type {
  AgentEvent,
  ApprovalPolicy,
  ProviderToolCallRequest,
  Tool,
} from '../types.js';
import type { Capability } from '../../providers/types.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-runtime-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Scripted provider: each "turn" is a function that returns the async
 * iterable the runtime expects. Lets us simulate an agent that issues a
 * tool call, reads the result, and then terminates.
 */
function makeScriptedProvider(
  turns: Array<(req: ProviderToolCallRequest) => AsyncIterable<AgentEvent>>,
): unknown {
  let turnIndex = 0;
  return {
    capabilities: () => new Set<Capability>(['streaming', 'tool-calling']),
    async *chatWithTools(req: ProviderToolCallRequest) {
      if (turnIndex >= turns.length) {
        throw new Error(`scripted provider ran out of turns (turn ${turnIndex})`);
      }
      const fn = turns[turnIndex++];
      yield* fn(req);
    },
  };
}

async function* events(...ev: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of ev) yield e;
}

describe('AgentRuntime', () => {
  it('terminates immediately when the first turn has no tool calls', async () => {
    const runtime = new AgentRuntime();
    const provider = makeScriptedProvider([
      () => events({ kind: 'text', delta: 'All done.' }),
    ]);
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      approval: autoAllowPolicy,
      workspaceRoot: tmp,
    });
    expect(result.stopReason).toBe('stop');
    expect(result.executedToolCalls).toBe(0);
    expect(result.messages.at(-1)?.role).toBe('assistant');
    expect(result.messages.at(-1)?.content).toBe('All done.');
  });

  it('executes a tool call and continues to a second turn', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    const runtime = new AgentRuntime();
    const provider = makeScriptedProvider([
      // Turn 1 — model asks for file_read.
      () =>
        events(
          { kind: 'text', delta: 'Let me read it.' },
          {
            kind: 'tool_call',
            call: { id: 'call-1', name: 'file_read', arguments: { path: 'a.txt' } },
          },
        ),
      // Turn 2 — model finishes.
      () => events({ kind: 'text', delta: 'Read complete.' }),
    ]);
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'read a.txt' }],
      tools: [fileReadTool],
      approval: autoAllowPolicy,
      workspaceRoot: tmp,
    });
    expect(result.stopReason).toBe('stop');
    expect(result.executedToolCalls).toBe(1);
    expect(result.toolErrors).toBe(0);
    // History includes: user, assistant(turn1), tool_result, assistant(turn2)
    const roles = result.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolResult = result.messages[2];
    expect(toolResult.toolCallId).toBe('call-1');
    expect(String(toolResult.content)).toContain('hello');
  });

  it('counts tool errors but keeps running', async () => {
    const runtime = new AgentRuntime();
    const provider = makeScriptedProvider([
      () =>
        events({
          kind: 'tool_call',
          call: { id: 'c1', name: 'file_read', arguments: { path: 'nope.txt' } },
        }),
      () => events({ kind: 'text', delta: 'Gave up.' }),
    ]);
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'task' }],
      tools: [fileReadTool],
      approval: autoAllowPolicy,
      workspaceRoot: tmp,
    });
    expect(result.stopReason).toBe('stop');
    expect(result.toolErrors).toBe(1);
    expect(result.executedToolCalls).toBe(1);
  });

  it('hits max_iterations when the model keeps calling tools', async () => {
    const runtime = new AgentRuntime();
    const loopTurn = (callId: string) => () =>
      events({
        kind: 'tool_call',
        call: { id: callId, name: 'file_read', arguments: { path: 'a.txt' } },
      });
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    const provider = makeScriptedProvider([
      loopTurn('c1'),
      loopTurn('c2'),
      loopTurn('c3'),
    ]);
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'loop' }],
      tools: [fileReadTool],
      approval: autoAllowPolicy,
      workspaceRoot: tmp,
      maxIterations: 3,
    });
    expect(result.stopReason).toBe('max_iterations');
    expect(result.executedToolCalls).toBe(3);
  });

  it('returns is_error for unknown tools and still completes', async () => {
    const runtime = new AgentRuntime();
    const provider = makeScriptedProvider([
      () =>
        events({
          kind: 'tool_call',
          call: { id: 'c1', name: 'ghost_tool', arguments: {} },
        }),
      () => events({ kind: 'text', delta: 'Done.' }),
    ]);
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'task' }],
      tools: [fileReadTool],
      approval: autoAllowPolicy,
      workspaceRoot: tmp,
    });
    expect(result.toolErrors).toBe(1);
    expect(result.stopReason).toBe('stop');
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.isError).toBe(true);
    expect(String(toolMsg?.content)).toMatch(/not available|unknown/i);
  });

  it('aborts when the signal is already aborted', async () => {
    const runtime = new AgentRuntime();
    const provider = makeScriptedProvider([
      () => events({ kind: 'text', delta: 'hi' }),
    ]);
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'task' }],
      tools: [],
      approval: autoAllowPolicy,
      workspaceRoot: tmp,
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('cancelled');
    expect(result.executedToolCalls).toBe(0);
  });

  it('stops the run when approval.decide returns abort', async () => {
    const runtime = new AgentRuntime();
    const provider = makeScriptedProvider([
      () =>
        events({
          kind: 'tool_call',
          call: { id: 'c1', name: 'file_write', arguments: { path: 'a.txt', content: 'x' } },
        }),
    ]);
    const abortPolicy: ApprovalPolicy = {
      async decide(calls) {
        return Object.fromEntries(calls.map((c) => [c.call.id, 'abort'] as const));
      },
    };
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'write' }],
      tools: [fileWriteTool],
      approval: abortPolicy,
      workspaceRoot: tmp,
    });
    expect(result.stopReason).toBe('aborted_by_user');
    expect(result.executedToolCalls).toBe(0);
    // Must still produce a tool_result so the message history stays balanced.
    expect(result.messages.find((m) => m.role === 'tool')).toBeTruthy();
  });

  it('records a tool_denied event for deny decisions and skips execution', async () => {
    const runtime = new AgentRuntime();
    const seen: AgentEvent[] = [];
    const provider = makeScriptedProvider([
      () =>
        events({
          kind: 'tool_call',
          call: { id: 'c1', name: 'file_write', arguments: { path: 'a.txt', content: 'x' } },
        }),
      () => events({ kind: 'text', delta: 'acknowledged denial' }),
    ]);
    const denyPolicy: ApprovalPolicy = {
      async decide(calls) {
        return Object.fromEntries(calls.map((c) => [c.call.id, 'deny'] as const));
      },
    };
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'write' }],
      tools: [fileWriteTool],
      approval: denyPolicy,
      workspaceRoot: tmp,
      onEvent: (ev) => seen.push(ev),
    });
    expect(result.stopReason).toBe('stop');
    expect(result.executedToolCalls).toBe(0);
    expect(seen.some((e) => e.kind === 'tool_denied')).toBe(true);
    // File must NOT have been written.
    expect(fs.existsSync(path.join(tmp, 'a.txt'))).toBe(false);
  });

  it('throws when the provider does not advertise tool-calling capability', async () => {
    const runtime = new AgentRuntime();
    // Streaming-only provider: has chatWithTools shape but NOT the capability flag.
    const brokenProvider = {
      capabilities: () => new Set<Capability>(['streaming']),
      chatWithTools: async function* () { /* unreachable */ },
    } as unknown;
    await expect(
      runtime.run(brokenProvider, {
        system: 'test',
        messages: [],
        tools: [],
        approval: autoAllowPolicy,
        workspaceRoot: tmp,
      }),
    ).rejects.toThrow(/tool-calling/);
  });

  it('throws when the provider has no capabilities() at all', async () => {
    const runtime = new AgentRuntime();
    const brokenProvider = { chatWithTools: async function* () { /* noop */ } } as unknown;
    await expect(
      runtime.run(brokenProvider, {
        system: 'test',
        messages: [],
        tools: [],
        approval: autoAllowPolicy,
        workspaceRoot: tmp,
      }),
    ).rejects.toThrow(/tool-calling/);
  });

  it('bubbles up a provider error event as stopReason=error', async () => {
    const runtime = new AgentRuntime();
    const provider = makeScriptedProvider([
      () => events({ kind: 'done', reason: 'error', error: 'upstream 500' }),
    ]);
    const result = await runtime.run(provider, {
      system: 'test',
      messages: [{ role: 'user', content: 'task' }],
      tools: [],
      approval: autoAllowPolicy,
      workspaceRoot: tmp,
    });
    expect(result.stopReason).toBe('error');
    expect(result.error).toMatch(/upstream 500/);
  });
});

/**
 * Dummy tool to make a couple of edge-case checks easier to read.
 */
export const dummyTool: Tool = {
  name: 'dummy',
  description: 'dummy',
  readOnly: true,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return { summary: 'ok', content: 'ok' };
  },
};
