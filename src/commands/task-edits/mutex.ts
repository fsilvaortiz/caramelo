/**
 * A tiny async mutex — every caller of `run()` is serialized in FIFO order
 * and a throwing holder does not poison the chain for the next caller.
 *
 * Used by `startTask` to serialize stash + review UI + applyEdits across
 * concurrent [P]-marked parallel task invocations, while leaving the LLM
 * streaming call unlocked so parallel throughput is preserved.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
    } catch {
      // Previous holder threw — the chain continues uninterrupted for us.
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
