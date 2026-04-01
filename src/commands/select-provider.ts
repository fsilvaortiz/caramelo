import * as vscode from 'vscode';
import type { ProviderRegistry } from '../providers/registry.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { ClaudeProvider } from '../providers/claude.js';
import { SETTINGS_KEYS } from '../constants.js';
import type { ProviderConfig } from '../constants.js';

export async function selectProvider(
  registry: ProviderRegistry,
  _secrets: vscode.SecretStorage,
  providerId?: string
): Promise<void> {
  if (providerId) {
    await registry.setActive(providerId);
    vscode.window.showInformationMessage(`Active provider: ${registry.activeProvider?.displayName}`);
    return;
  }

  // Fallback for status bar click: show list only if no providerId
  const providers = registry.getAll();
  if (providers.length === 0) {
    vscode.window.showInformationMessage('No providers configured. Use the "+" button in the Providers section to add one.');
    return;
  }

  const activeId = registry.activeProvider?.id;
  const items = providers.map((p) => ({
    label: p.id === activeId ? `$(check) ${p.displayName}` : p.displayName,
    description: p.id,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select active provider',
  });
  if (!selected) return;

  await registry.setActive(selected.description!);
  vscode.window.showInformationMessage(`Active provider: ${selected.label.replace('$(check) ', '')}`);
}

export async function addProviderWizard(
  registry: ProviderRegistry,
  secrets: vscode.SecretStorage
): Promise<void> {
  await addProvider(registry, secrets);
}

async function addProvider(
  registry: ProviderRegistry,
  secrets: vscode.SecretStorage
): Promise<void> {
  const type = await vscode.window.showQuickPick(
    [
      { label: '$(server) Ollama', description: 'openai-compatible', detail: 'Local — http://localhost:11434' },
      { label: '$(cloud) Claude (Anthropic)', description: 'anthropic', detail: 'Cloud — requires API key' },
      { label: '$(cloud) OpenAI', description: 'openai-compatible', detail: 'Cloud — requires API key' },
      { label: '$(cloud) Groq', description: 'openai-compatible', detail: 'Cloud — requires API key' },
      { label: '$(server) LM Studio', description: 'openai-compatible', detail: 'Local — http://localhost:1234' },
      { label: '$(ellipsis) Other (OpenAI-compatible)', description: 'openai-compatible', detail: 'Custom endpoint' },
      { label: '', kind: vscode.QuickPickItemKind.Separator, description: '' },
      { label: '$(project) Jira', description: 'jira', detail: 'Import issues as specs' },
    ],
    { placeHolder: 'Select provider' }
  );
  if (!type) return;

  const presets: Record<string, { name: string; endpoint: string; model: string; needsKey: boolean }> = {
    '$(server) Ollama': { name: 'Ollama', endpoint: 'http://localhost:11434/v1', model: 'llama3', needsKey: false },
    '$(cloud) Claude (Anthropic)': { name: 'Claude', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', needsKey: true },
    '$(cloud) OpenAI': { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', needsKey: true },
    '$(cloud) Groq': { name: 'Groq', endpoint: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
    '$(server) LM Studio': { name: 'LM Studio', endpoint: 'http://localhost:1234/v1', model: 'default', needsKey: false },
  };

  // Handle Jira separately
  if (type.description === 'jira') {
    await addJiraProvider(registry, secrets);
    return;
  }

  const preset = presets[type.label];
  let name: string;
  let endpoint: string;
  let model: string;
  let needsKey: boolean;

  if (preset) {
    name = preset.name;
    endpoint = preset.endpoint;
    model = preset.model;
    needsKey = preset.needsKey;

    // For cloud providers, ask for model override
    if (needsKey) {
      const customModel = await vscode.window.showInputBox({
        prompt: `Model for ${name}`,
        value: preset.model,
      });
      if (!customModel) return;
      model = customModel;
    }
  } else {
    // Custom provider
    name = await vscode.window.showInputBox({ prompt: 'Provider name' }) ?? '';
    if (!name) return;

    endpoint = await vscode.window.showInputBox({ prompt: 'Endpoint URL', value: 'http://localhost:8080/v1' }) ?? '';
    if (!endpoint) return;

    model = await vscode.window.showInputBox({ prompt: 'Model name' }) ?? '';
    if (!model) return;

    needsKey = (await vscode.window.showQuickPick(['No', 'Yes'], { placeHolder: 'Requires API key?' })) === 'Yes';
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const apiKeyId = `caramelo.provider.${id}.apiKey`;

  if (needsKey) {
    const key = await vscode.window.showInputBox({ prompt: `API key for ${name}`, password: true });
    if (!key) return;
    await secrets.store(apiKeyId, key);
  }

  const config: ProviderConfig = {
    id,
    name,
    type: type.description as ProviderConfig['type'],
    endpoint,
    model,
  };

  // Create and register the provider
  const provider = type.description === 'anthropic'
    ? new ClaudeProvider({ ...config, apiKeyId }, secrets)
    : new OpenAICompatibleProvider({ ...config, apiKeyId: needsKey ? apiKeyId : undefined }, secrets);

  if (needsKey) await provider.authenticate();
  registry.register(provider);

  // Persist to settings
  const vsConfig = vscode.workspace.getConfiguration();
  const existing = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
  existing.push(config);
  await vsConfig.update(SETTINGS_KEYS.providers, existing, vscode.ConfigurationTarget.Workspace);

  await registry.setActive(id);
  vscode.window.showInformationMessage(`Provider "${name}" added and set as active.`);
}

export async function editProvider(
  providerId: string,
  registry: ProviderRegistry,
  secrets: vscode.SecretStorage
): Promise<void> {
  const provider = registry.get(providerId);
  if (!provider) return;

  const vsConfig = vscode.workspace.getConfiguration();
  const configs = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
  const config = configs.find((c) => c.id === providerId);
  if (!config) return;

  const field = await vscode.window.showQuickPick(
    [
      { label: 'Name', description: config.name },
      { label: 'Endpoint', description: config.endpoint },
      { label: 'Model', description: config.model },
      { label: 'API Key', description: '••••••' },
    ],
    { placeHolder: `Edit ${config.name} — select field to change` }
  );
  if (!field) return;

  if (field.label === 'API Key') {
    const key = await vscode.window.showInputBox({ prompt: 'New API key', password: true });
    if (key) {
      await secrets.store(`caramelo.provider.${providerId}.apiKey`, key);
      vscode.window.showInformationMessage('API key updated.');
    }
    return;
  }

  const newValue = await vscode.window.showInputBox({
    prompt: `New ${field.label.toLowerCase()}`,
    value: field.description,
  });
  if (!newValue) return;

  const key = field.label.toLowerCase() as 'name' | 'endpoint' | 'model';
  config[key] = newValue;
  await vsConfig.update(SETTINGS_KEYS.providers, configs, vscode.ConfigurationTarget.Workspace);

  // Re-register provider with new config
  registry.unregister(providerId);
  const apiKeyId = `caramelo.provider.${config.id}.apiKey`;
  const newProvider = config.type === 'anthropic'
    ? new ClaudeProvider({ ...config, apiKeyId }, secrets)
    : new OpenAICompatibleProvider({ ...config, apiKeyId }, secrets);
  await newProvider.authenticate().catch(() => {});
  registry.register(newProvider);

  vscode.window.showInformationMessage(`Provider "${config.name}" updated.`);
}

export async function deleteProvider(
  providerId: string,
  registry: ProviderRegistry
): Promise<void> {
  const provider = registry.get(providerId);
  if (!provider) return;

  const confirm = await vscode.window.showWarningMessage(
    `Delete provider "${provider.displayName}"?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;

  registry.unregister(providerId);

  const vsConfig = vscode.workspace.getConfiguration();
  const configs = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
  const updated = configs.filter((c) => c.id !== providerId);
  await vsConfig.update(SETTINGS_KEYS.providers, updated, vscode.ConfigurationTarget.Workspace);

  vscode.window.showInformationMessage(`Provider deleted.`);
}

export async function testProvider(
  providerId: string,
  registry: ProviderRegistry
): Promise<void> {
  const provider = registry.get(providerId);
  if (!provider) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Testing ${provider.displayName}...` },
    async () => {
      await provider.authenticate().catch(() => {});
      const available = await provider.isAvailable();
      if (available) {
        vscode.window.showInformationMessage(`✓ ${provider.displayName} is connected and ready.`);
      } else {
        vscode.window.showErrorMessage(`✗ ${provider.displayName} is not reachable. Check endpoint and API key.`);
      }
    }
  );
}

async function addJiraProvider(
  registry: ProviderRegistry,
  secrets: vscode.SecretStorage
): Promise<void> {
  const instanceUrl = await vscode.window.showInputBox({
    prompt: 'Jira Cloud URL',
    value: 'https://mycompany.atlassian.net',
    placeHolder: 'https://your-org.atlassian.net',
  });
  if (!instanceUrl) return;

  const email = await vscode.window.showInputBox({
    prompt: 'Jira account email',
    placeHolder: 'you@company.com',
  });
  if (!email) return;

  const apiToken = await vscode.window.showInputBox({
    prompt: 'Jira API token (from id.atlassian.com/manage-profile/security/api-tokens)',
    password: true,
  });
  if (!apiToken) return;

  // Test connection
  const { JiraClient } = await import('../jira/jira-client.js');
  const testClient = new JiraClient(instanceUrl, email, apiToken);

  const connected = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing Jira connection...' },
    () => testClient.testConnection()
  );

  if (!connected) {
    vscode.window.showErrorMessage('Could not connect to Jira. Check URL, email, and API token.');
    return;
  }

  // Fetch boards
  const boards = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Fetching boards...' },
    () => testClient.getBoards()
  );

  if (boards.length === 0) {
    vscode.window.showErrorMessage('No boards found. Check your Jira permissions.');
    return;
  }

  const boardPick = await vscode.window.showQuickPick(
    boards.map((b) => ({ label: b.name, description: b.type, detail: `Board ID: ${b.id}`, boardId: b.id })),
    { placeHolder: 'Select a board' }
  );
  if (!boardPick) return;

  const id = `jira-${instanceUrl.replace(/https?:\/\//, '').replace(/\.atlassian\.net.*/, '').replace(/[^a-z0-9]+/g, '-')}`;
  const name = `Jira (${boardPick.label})`;

  // Store token
  await secrets.store(`caramelo.jira.${id}.token`, apiToken);

  const config: ProviderConfig = {
    id,
    name,
    type: 'jira',
    endpoint: instanceUrl,
    model: '',
    instanceUrl,
    boardId: boardPick.boardId,
    boardName: boardPick.label,
    email,
  };

  // Persist to settings
  const vsConfig = vscode.workspace.getConfiguration();
  const existing = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
  existing.push(config);
  await vsConfig.update(SETTINGS_KEYS.providers, existing, vscode.ConfigurationTarget.Workspace);

  // Note: Jira providers are not LLM providers — they don't go in the ProviderRegistry
  // They're handled separately by the Jira spec creation flow

  vscode.window.showInformationMessage(`Jira provider "${name}" added. You can now create specs from Jira issues.`);
}
