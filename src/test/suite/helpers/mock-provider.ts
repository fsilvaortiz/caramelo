import type {
  Capability,
  LLMMessage,
  LLMOptions,
  LLMProvider,
} from '../../../providers/types.js';

/**
 * Recorded chat invocation. Tests use this to assert how many times the
 * provider was called and with what content, without having to wire a
 * spy framework into the extension host.
 */
export interface RecordedCall {
  messages: LLMMessage[];
  options?: LLMOptions;
  /** Set if the provider yielded its scripted response. */
  yielded?: string;
  /** Set if a programmed error was thrown for this call. */
  error?: Error;
}

/**
 * Programmed behaviour for a single chat invocation. A queue lets one
 * test drive a flow that hits the provider multiple times (e.g. analyze
 * + auto-fix passes) with different canned outputs.
 */
type Step =
  | { kind: 'reply'; text: string; chunkSize?: number }
  | { kind: 'throw'; error: Error };

/**
 * Hand-rolled mock LLMProvider. Configurable per test via `queue*` and
 * `setDefaultReply`. Recording is on by default so tests can assert what
 * was sent without an external spy library. The mock supports streaming
 * by default but emits the canned text as one chunk; callers that want
 * to exercise chunk-handling code paths can pass `chunkSize` to slice.
 */
export class MockLLMProvider implements LLMProvider {
  public readonly id: string;
  public readonly displayName: string;
  public readonly calls: RecordedCall[] = [];
  private readonly steps: Step[] = [];
  private defaultReply: string = '';
  private _disposed = false;

  constructor(opts: { id?: string; displayName?: string } = {}) {
    this.id = opts.id ?? 'mock';
    this.displayName = opts.displayName ?? 'Mock';
  }

  /** Queue a single reply. Order: first queued = first served. */
  queueReply(text: string, chunkSize?: number): this {
    this.steps.push({ kind: 'reply', text, chunkSize });
    return this;
  }

  /** Queue a JSON reply, serialised. Convenience for clarify/analyze flows. */
  queueJsonReply(payload: unknown, opts: { fence?: boolean } = {}): this {
    const body = JSON.stringify(payload);
    const text = opts.fence ? `\`\`\`json\n${body}\n\`\`\`` : body;
    this.steps.push({ kind: 'reply', text });
    return this;
  }

  /** Queue an error to throw on the next chat call. */
  queueError(error: Error | string): this {
    const err = typeof error === 'string' ? new Error(error) : error;
    this.steps.push({ kind: 'throw', error: err });
    return this;
  }

  /** Reply when the queue is exhausted (falls through to empty string). */
  setDefaultReply(text: string): this {
    this.defaultReply = text;
    return this;
  }

  /**
   * Replace the FIFO queue with a content-based dispatcher. Required for
   * tests that fire multiple `chat()` calls concurrently — the queue
   * order is decided by which generator's `.next()` runs first, which
   * is non-deterministic in practice. The dispatcher inspects the
   * outgoing messages and picks the reply, so order does not matter.
   *
   * Returning `null` from the dispatcher means "fall through to
   * defaultReply".
   */
  setDispatcher(
    fn: (messages: LLMMessage[], options?: LLMOptions) =>
      { reply: string; chunkSize?: number } |
      { error: Error } |
      null,
  ): this {
    this.dispatcher = fn;
    return this;
  }

  private dispatcher: ((messages: LLMMessage[], options?: LLMOptions) =>
    { reply: string; chunkSize?: number } |
    { error: Error } |
    null) | undefined;

  /** Reset queued steps and recorded calls between tests. */
  reset(): void {
    this.steps.length = 0;
    this.calls.length = 0;
    this.defaultReply = '';
    this.dispatcher = undefined;
  }

  // --- LLMProvider interface ---

  async authenticate(): Promise<boolean> {
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return !this._disposed;
  }

  capabilities(): Set<Capability> {
    return new Set<Capability>(['streaming']);
  }

  dispose(): void {
    this._disposed = true;
  }

  async *chat(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<string> {
    const record: RecordedCall = { messages, options };
    this.calls.push(record);

    // Dispatcher wins over the queue — tests that opt into content-based
    // routing get deterministic behaviour even under concurrent chats.
    let text: string;
    let chunkSize: number | undefined;
    if (this.dispatcher) {
      const out = this.dispatcher(messages, options);
      if (out && 'error' in out) {
        record.error = out.error;
        throw out.error;
      }
      if (out && 'reply' in out) {
        text = out.reply;
        chunkSize = out.chunkSize;
      } else {
        text = this.defaultReply;
      }
    } else {
      const step = this.steps.shift();
      if (step?.kind === 'throw') {
        record.error = step.error;
        throw step.error;
      }
      text = step?.kind === 'reply' ? step.text : this.defaultReply;
      chunkSize = step?.kind === 'reply' ? step.chunkSize : undefined;
    }
    record.yielded = text;

    if (text.length === 0) {
      return;
    }
    if (!chunkSize || chunkSize >= text.length) {
      yield text;
      return;
    }
    for (let i = 0; i < text.length; i += chunkSize) {
      // Respect an abort signal mid-stream so tests can exercise cancellation.
      if (options?.signal?.aborted) {
        throw makeAbortError();
      }
      yield text.slice(i, i + chunkSize);
    }
  }
}

function makeAbortError(): Error {
  const err: Error & { name: string } = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}
