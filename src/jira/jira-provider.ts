import * as vscode from 'vscode';
import { JiraClient } from './jira-client.js';
import type { ProviderConfig } from '../constants.js';

export class JiraProvider {
  readonly id: string;
  readonly displayName: string;
  readonly instanceUrl: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly email: string;

  private client: JiraClient | undefined;
  private connected = false;

  constructor(
    private readonly config: ProviderConfig,
    private readonly secrets: vscode.SecretStorage
  ) {
    this.id = config.id;
    this.displayName = config.name;
    this.instanceUrl = config.instanceUrl ?? '';
    this.boardId = config.boardId ?? '';
    this.boardName = config.boardName ?? '';
    this.email = config.email ?? '';
  }

  async authenticate(): Promise<boolean> {
    const tokenKey = `caramelo.jira.${this.id}.token`;
    const token = await this.secrets.get(tokenKey);
    if (!token) return false;
    this.client = new JiraClient(this.instanceUrl, this.email, token, this.boardId);
    return true;
  }

  async testConnection(): Promise<boolean> {
    if (!this.client) {
      const ok = await this.authenticate();
      if (!ok) return false;
    }
    this.connected = await this.client!.testConnection();
    return this.connected;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  getClient(): JiraClient {
    if (!this.client) throw new Error('Jira provider not authenticated. Call authenticate() first.');
    return this.client;
  }

  dispose(): void {
    this.client = undefined;
  }
}
