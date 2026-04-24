import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderRegistry, type HealthState } from '../registry.js';
import type { LLMProvider } from '../types.js';

function fakeProvider(id: string, name = id): LLMProvider {
  return {
    id,
    displayName: name,
    authenticate: vi.fn().mockResolvedValue(true),
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: async function* () { yield 'noop'; },
    dispose: vi.fn(),
  };
}

let registry: ProviderRegistry;

beforeEach(() => {
  registry = new ProviderRegistry();
});

describe('health state', () => {
  it('reports unknown for an unregistered provider', () => {
    expect(registry.getHealth('missing').status).toBe('unknown');
  });

  it('records and exposes ok / fail / checking', () => {
    registry.register(fakeProvider('a'));

    registry.recordHealth('a', 'checking');
    expect(registry.getHealth('a').status).toBe('checking');

    registry.recordHealth('a', 'ok');
    expect(registry.getHealth('a').status).toBe('ok');
    expect(registry.getHealth('a').error).toBeUndefined();
    expect(registry.getHealth('a').checkedAt).toBeTypeOf('number');

    registry.recordHealth('a', 'fail', 'boom');
    expect(registry.getHealth('a').status).toBe('fail');
    expect(registry.getHealth('a').error).toBe('boom');
  });

  it('ignores recordHealth for an unregistered id', () => {
    registry.recordHealth('ghost', 'ok');
    expect(registry.getHealth('ghost').status).toBe('unknown');
  });

  it('emits onDidChangeHealth when state changes', () => {
    registry.register(fakeProvider('a'));
    const events: Array<{ id: string; state: HealthState }> = [];
    registry.onDidChangeHealth((evt) => events.push(evt));
    registry.recordHealth('a', 'checking');
    registry.recordHealth('a', 'ok');
    expect(events).toHaveLength(2);
    expect(events[0].state.status).toBe('checking');
    expect(events[1].state.status).toBe('ok');
  });

  it('clears health when a provider is unregistered', () => {
    registry.register(fakeProvider('a'));
    registry.recordHealth('a', 'ok');
    registry.unregister('a');
    expect(registry.getHealth('a').status).toBe('unknown');
  });
});
