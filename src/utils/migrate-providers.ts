import * as vscode from 'vscode';
import { SETTINGS_KEYS } from '../constants.js';
import type { ProviderConfig } from '../constants.js';
import { log } from './log.js';

/**
 * One-shot migration: copy `caramelo.providers` and `caramelo.activeProvider`
 * from Workspace scope to Global scope, then clear the Workspace value so the
 * Global value wins on every workspace.
 *
 * Runs only when Workspace has a value AND Global is empty / missing — never
 * overwrites an already-populated Global config.
 *
 * Returns the list of settings that were migrated, for logging.
 */
export async function migrateProviderSettingsToGlobal(
  cfg: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(),
): Promise<string[]> {
  const migrated: string[] = [];
  await migrateOne<ProviderConfig[]>(cfg, SETTINGS_KEYS.providers, (v) => Array.isArray(v) && v.length > 0, migrated);
  await migrateOne<string>(cfg, SETTINGS_KEYS.activeProvider, (v) => typeof v === 'string' && v.length > 0, migrated);
  if (migrated.length > 0) {
    log.info('migrated provider settings from Workspace to Global:', migrated);
  }
  return migrated;
}

async function migrateOne<T>(
  cfg: vscode.WorkspaceConfiguration,
  key: string,
  hasValue: (v: unknown) => boolean,
  migrated: string[],
): Promise<void> {
  const inspected = cfg.inspect<T>(key);
  if (!inspected) return;
  const workspaceValue = inspected.workspaceValue;
  const globalValue = inspected.globalValue;
  if (hasValue(workspaceValue) && !hasValue(globalValue)) {
    await cfg.update(key, workspaceValue, vscode.ConfigurationTarget.Global);
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    migrated.push(key);
  }
}
