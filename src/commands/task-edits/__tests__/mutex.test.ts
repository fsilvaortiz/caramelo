import { describe, it, expect } from 'vitest';
import { AsyncMutex } from '../mutex.js';

function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AsyncMutex', () => {
  it('serializes concurrent callers in FIFO order', async () => {
    const m = new AsyncMutex();
    const order: string[] = [];

    const gateA = defer<void>();
    const gateB = defer<void>();

    const a = m.run(async () => {
      order.push('a-enter');
      await gateA.promise;
      order.push('a-exit');
    });
    const b = m.run(async () => {
      order.push('b-enter');
      await gateB.promise;
      order.push('b-exit');
    });

    // Let both calls settle into the microtask queue.
    await Promise.resolve();

    expect(order).toEqual(['a-enter']);

    gateA.resolve();
    await a;
    // B should only start after A released.
    expect(order).toEqual(['a-enter', 'a-exit', 'b-enter']);

    gateB.resolve();
    await b;
    expect(order).toEqual(['a-enter', 'a-exit', 'b-enter', 'b-exit']);
  });

  it('prevents the second caller from starting before the first resolves', async () => {
    const m = new AsyncMutex();
    let bStarted = false;

    const gate = defer<void>();
    const a = m.run(async () => {
      await gate.promise;
    });
    const b = m.run(async () => {
      bStarted = true;
    });

    // Give the scheduler a tick — b must still not have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(bStarted).toBe(false);

    gate.resolve();
    await a;
    await b;
    expect(bStarted).toBe(true);
  });

  it('does not poison the chain when a holder throws', async () => {
    const m = new AsyncMutex();
    const thrown = m.run(async () => {
      throw new Error('boom');
    });
    await expect(thrown).rejects.toThrow('boom');

    const next = await m.run(async () => 42);
    expect(next).toBe(42);
  });

  it('returns the value produced by the wrapped function', async () => {
    const m = new AsyncMutex();
    const result = await m.run(async () => 'hello');
    expect(result).toBe('hello');
  });

  it('holds sequential resources across many interleaved callers', async () => {
    const m = new AsyncMutex();
    let inside = 0;
    let maxInside = 0;

    const tasks = Array.from({ length: 20 }, (_, i) =>
      m.run(async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        // Yield to the microtask queue a couple of times so any race has a chance.
        await Promise.resolve();
        await Promise.resolve();
        inside--;
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(maxInside).toBe(1);
  });
});
