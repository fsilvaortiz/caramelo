import * as vscode from 'vscode';
import type { LLMProvider } from './types.js';
import { SETTINGS_KEYS } from '../constants.js';

export type HealthStatus = 'unknown' | 'ok' | 'fail' | 'checking';

export interface HealthState {
  status: HealthStatus;
  error?: string;
  checkedAt?: number;
}

export class ProviderRegistry implements vscode.Disposable {
  private readonly providers = new Map<string, LLMProvider>();
  private readonly healthByProvider = new Map<string, HealthState>();
  private _activeProvider: LLMProvider | undefined;
  private readonly _onDidChangeActiveProvider = new vscode.EventEmitter<LLMProvider | undefined>();
  readonly onDidChangeActiveProvider = this._onDidChangeActiveProvider.event;

  private readonly _onDidChangeProviders = new vscode.EventEmitter<void>();
  readonly onDidChangeProviders = this._onDidChangeProviders.event;

  private readonly _onDidChangeHealth = new vscode.EventEmitter<{ id: string; state: HealthState }>();
  readonly onDidChangeHealth = this._onDidChangeHealth.event;

  get activeProvider(): LLMProvider | undefined {
    return this._activeProvider;
  }

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
    this._onDidChangeProviders.fire();
  }

  unregister(id: string): void {
    const provider = this.providers.get(id);
    if (provider) {
      provider.dispose();
      this.providers.delete(id);
      this.healthByProvider.delete(id);
      if (this._activeProvider?.id === id) {
        this._activeProvider = undefined;
        this._onDidChangeActiveProvider.fire(undefined);
      }
      this._onDidChangeProviders.fire();
    }
  }

  getHealth(id: string): HealthState {
    return this.healthByProvider.get(id) ?? { status: 'unknown' };
  }

  recordHealth(id: string, status: HealthStatus, error?: string): void {
    if (!this.providers.has(id)) return;
    const state: HealthState = {
      status,
      error: status === 'fail' ? error : undefined,
      checkedAt: status === 'checking' ? this.healthByProvider.get(id)?.checkedAt : Date.now(),
    };
    this.healthByProvider.set(id, state);
    this._onDidChangeHealth.fire({ id, state });
  }

  getAll(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  async setActive(id: string): Promise<void> {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Provider "${id}" not found`);
    }
    this._activeProvider = provider;
    this._onDidChangeActiveProvider.fire(provider);

    const config = vscode.workspace.getConfiguration();
    await config.update(SETTINGS_KEYS.activeProvider, id, vscode.ConfigurationTarget.Global);
  }

  restoreActiveFromSettings(): void {
    const config = vscode.workspace.getConfiguration();
    const activeId = config.get<string>(SETTINGS_KEYS.activeProvider);
    if (activeId && this.providers.has(activeId)) {
      this._activeProvider = this.providers.get(activeId);
      this._onDidChangeActiveProvider.fire(this._activeProvider);
    }
  }

  dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.providers.clear();
    this.healthByProvider.clear();
    this._onDidChangeActiveProvider.dispose();
    this._onDidChangeProviders.dispose();
    this._onDidChangeHealth.dispose();
  }
}
