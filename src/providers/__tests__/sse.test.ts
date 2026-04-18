import { describe, it, expect } from 'vitest';
import { parseSSEStream } from '../sse.js';
import { TimeoutError } from '../../errors.js';

function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return stream.getReader();
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const extract = (json: unknown): string | null => {
  const obj = json as { content?: unknown };
  return typeof obj?.content === 'string' ? obj.content : null;
};

describe('parseSSEStream', () => {
  it('yields content from well-formed events split on double newline', async () => {
    const reader = makeReader([
      'data: {"content":"hello"}\n\n',
      'data: {"content":" world"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const result = await collect(parseSSEStream(reader, extract));
    expect(result.join('')).toBe('hello world');
  });

  it('skips malformed JSON lines without throwing', async () => {
    const reader = makeReader([
      'data: {not json\n\n',
      'data: {"content":"ok"}\n\n',
    ]);
    const result = await collect(parseSSEStream(reader, extract));
    expect(result).toEqual(['ok']);
  });

  it('stops on [DONE] marker', async () => {
    const reader = makeReader([
      'data: {"content":"first"}\n\n',
      'data: [DONE]\n\n',
      'data: {"content":"should-not-appear"}\n\n',
    ]);
    const result = await collect(parseSSEStream(reader, extract));
    expect(result).toEqual(['first']);
  });

  it('handles chunks that split an event mid-stream', async () => {
    const reader = makeReader([
      'data: {"cont',
      'ent":"joined"}\n\n',
    ]);
    const result = await collect(parseSSEStream(reader, extract));
    expect(result).toEqual(['joined']);
  });

  it('ignores events without a data: prefix', async () => {
    const reader = makeReader([
      'event: ping\n\n',
      'data: {"content":"ok"}\n\n',
    ]);
    const result = await collect(parseSSEStream(reader, extract));
    expect(result).toEqual(['ok']);
  });

  it('returns nothing when extractContent yields null', async () => {
    const reader = makeReader(['data: {"other":"x"}\n\n']);
    const result = await collect(parseSSEStream(reader, extract));
    expect(result).toEqual([]);
  });

  it('processes a trailing event that lacks a closing double newline', async () => {
    const reader = makeReader(['data: {"content":"tail"}\n']);
    const result = await collect(parseSSEStream(reader, extract));
    expect(result).toEqual(['tail']);
  });

  it('throws a TimeoutError when no data arrives before the configured timeout', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue or close — simulate a hung upstream.
      },
    });
    const reader = stream.getReader();

    await expect(collect(parseSSEStream(reader, extract, { timeoutMs: 20 }))).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});
