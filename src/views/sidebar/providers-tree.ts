import * as vscode from 'vscode';
import * as path from 'path';
import type { ProviderRegistry } from '../../providers/registry.js';
import { COMMAND_IDS } from '../../constants.js';

export class ProviderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly providerId: string,
    label: string,
    description: string,
    isActive: boolean,
    isConnected: boolean,
    extensionPath: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'provider';
    this.tooltip = `${label} (${description})${isActive ? ' — Active' : ''}`;

    const iconName = isConnected ? 'provider-connected' : 'provider-disconnected';
    this.iconPath = {
      light: vscode.Uri.file(path.join(extensionPath, 'resources', 'icons', `${iconName}.svg`)),
      dark: vscode.Uri.file(path.join(extensionPath, 'resources', 'icons', `${iconName}.svg`)),
    };

    if (isActive) {
      this.label = `● ${label}`;
    }

    this.command = {
      command: COMMAND_IDS.selectProvider,
      title: 'Select Provider',
      arguments: [providerId],
    };
  }
}

export class ProvidersTreeDataProvider implements vscode.TreeDataProvider<ProviderTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ProviderTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connectedStatus = new Map<string, boolean>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly extensionPath: string
  ) {
    registry.onDidChangeActiveProvider(() => this._onDidChangeTreeData.fire(null));
    registry.onDidChangeProviders(() => {
      // When providers change (add/remove), check connections for new ones
      this.checkAllConnections().catch(() => {});
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: ProviderTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ProviderTreeItem[] {
    const items: ProviderTreeItem[] = [];

    // LLM providers from registry
    const providers = this.registry.getAll();
    const activeId = this.registry.activeProvider?.id;
    for (const p of providers) {
      const isConnected = this.connectedStatus.get(p.id) ?? false;
      items.push(new ProviderTreeItem(
        p.id, p.displayName,
        isConnected ? 'Connected' : 'Disconnected',
        p.id === activeId, isConnected, this.extensionPath
      ));
    }

    // Jira providers from settings
    const configs = vscode.workspace.getConfiguration().get<Array<{ id: string; name: string; type: string; boardName?: string }>>('caramelo.providers') ?? [];
    for (const c of configs) {
      if (c.type === 'jira') {
        const isConnected = this.connectedStatus.get(c.id) ?? false;
        const item = new ProviderTreeItem(
          c.id, c.name,
          c.boardName ?? 'Jira',
          false, isConnected, this.extensionPath
        );
        item.iconPath = new vscode.ThemeIcon('project');
        items.push(item);
      }
    }

    return items;
  }

  async checkAllConnections(): Promise<void> {
    const providers = this.registry.getAll();
    await Promise.all(
      providers.map(async (p) => {
        await p.authenticate().catch(() => {});
        const available = await p.isAvailable();
        this.connectedStatus.set(p.id, available);
      })
    );
    this._onDidChangeTreeData.fire(null);
  }

  async checkConnection(providerId: string): Promise<void> {
    const provider = this.registry.get(providerId);
    if (!provider) return;
    await provider.authenticate().catch(() => {});
    const available = await provider.isAvailable();
    this.connectedStatus.set(providerId, available);
    this._onDidChangeTreeData.fire(null);
  }
}
