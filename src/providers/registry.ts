import * as vscode from 'vscode';
import type { LLMProvider } from './types.js';
import { SETTINGS_KEYS } from '../constants.js';

export class ProviderRegistry implements vscode.Disposable {
  private readonly providers = new Map<string, LLMProvider>();
  private _activeProvider: LLMProvider | undefined;
  private readonly _onDidChangeActiveProvider = new vscode.EventEmitter<LLMProvider | undefined>();
  readonly onDidChangeActiveProvider = this._onDidChangeActiveProvider.event;

  private readonly _onDidChangeProviders = new vscode.EventEmitter<void>();
  readonly onDidChangeProviders = this._onDidChangeProviders.event;

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
      if (this._activeProvider?.id === id) {
        this._activeProvider = undefined;
        this._onDidChangeActiveProvider.fire(undefined);
      }
      this._onDidChangeProviders.fire();
    }
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
    await config.update(SETTINGS_KEYS.activeProvider, id, vscode.ConfigurationTarget.Workspace);
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
    this._onDidChangeActiveProvider.dispose();
    this._onDidChangeProviders.dispose();
  }
}
