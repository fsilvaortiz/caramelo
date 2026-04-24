import { describe, it, expect, vi } from 'vitest';
import { migrateProviderSettingsToGlobal } from '../migrate-providers.js';
import { SETTINGS_KEYS } from '../../constants.js';

interface InspectShape {
  workspaceValue?: unknown;
  globalValue?: unknown;
}

function makeConfig(initial: Record<string, InspectShape>) {
  const state: Record<string, InspectShape> = JSON.parse(JSON.stringify(initial));
  const update = vi.fn(async (key: string, value: unknown, target: number) => {
    state[key] = state[key] ?? {};
    if (target === 1 /* Global */) state[key].globalValue = value;
    else if (target === 2 /* Workspace */) state[key].workspaceValue = value;
  });
  const inspect = vi.fn((key: string) => state[key] ?? undefined);
  return {
    state,
    cfg: { update, inspect, get: () => undefined } as never,
    update,
  };
}

describe('migrateProviderSettingsToGlobal', () => {
  it('moves providers from Workspace to Global when Global is empty', async () => {
    const providers = [{ id: 'p1', name: 'Ollama', type: 'openai-compatible', endpoint: 'x', model: 'y' }];
    const { cfg, state, update } = makeConfig({
      [SETTINGS_KEYS.providers]: { workspaceValue: providers },
      [SETTINGS_KEYS.activeProvider]: { workspaceValue: 'p1' },
    });

    const migrated = await migrateProviderSettingsToGlobal(cfg);

    expect(migrated).toEqual([SETTINGS_KEYS.providers, SETTINGS_KEYS.activeProvider]);
    expect(state[SETTINGS_KEYS.providers].globalValue).toEqual(providers);
    expect(state[SETTINGS_KEYS.providers].workspaceValue).toBeUndefined();
    expect(state[SETTINGS_KEYS.activeProvider].globalValue).toBe('p1');
    expect(update).toHaveBeenCalledTimes(4);
  });

  it('does nothing when Global already has a value', async () => {
    const { cfg, state, update } = makeConfig({
      [SETTINGS_KEYS.providers]: {
        workspaceValue: [{ id: 'old' }],
        globalValue: [{ id: 'kept' }],
      },
    });

    const migrated = await migrateProviderSettingsToGlobal(cfg);

    expect(migrated).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(state[SETTINGS_KEYS.providers].globalValue).toEqual([{ id: 'kept' }]);
    expect(state[SETTINGS_KEYS.providers].workspaceValue).toEqual([{ id: 'old' }]);
  });

  it('treats empty arrays as no value', async () => {
    const { cfg, update } = makeConfig({
      [SETTINGS_KEYS.providers]: { workspaceValue: [] },
    });
    const migrated = await migrateProviderSettingsToGlobal(cfg);
    expect(migrated).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('migrates only the keys that have a workspace value', async () => {
    const { cfg, update } = makeConfig({
      [SETTINGS_KEYS.providers]: { workspaceValue: [{ id: 'p' }] },
      // activeProvider deliberately absent
    });
    const migrated = await migrateProviderSettingsToGlobal(cfg);
    expect(migrated).toEqual([SETTINGS_KEYS.providers]);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
