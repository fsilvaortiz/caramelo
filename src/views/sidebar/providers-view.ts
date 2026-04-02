import * as vscode from 'vscode';
import type { ProviderRegistry } from '../../providers/registry.js';
import { OpenAICompatibleProvider } from '../../providers/openai-compatible.js';
import { ClaudeProvider } from '../../providers/claude.js';
import { CopilotProvider, getCopilotModels } from '../../providers/copilot.js';
import { JiraClient } from '../../jira/jira-client.js';
import { SETTINGS_KEYS } from '../../constants.js';
import type { ProviderConfig } from '../../constants.js';

interface ModelInfo { id: string; name: string }

const PROVIDER_PRESETS = [
  { label: 'Ollama', type: 'openai-compatible', endpoint: 'http://localhost:11434/v1', needsKey: false, icon: '🖥️' },
  { label: 'Claude', type: 'anthropic', endpoint: 'https://api.anthropic.com', needsKey: true, icon: '🤖' },
  { label: 'OpenAI', type: 'openai-compatible', endpoint: 'https://api.openai.com/v1', needsKey: true, icon: '🧠' },
  { label: 'Groq', type: 'openai-compatible', endpoint: 'https://api.groq.com/openai/v1', needsKey: true, icon: '⚡' },
  { label: 'LM Studio', type: 'openai-compatible', endpoint: 'http://localhost:1234/v1', needsKey: false, icon: '🖥️' },
  { label: 'Copilot', type: 'copilot', endpoint: '', needsKey: false, icon: '🐙' },
  { label: 'Jira', type: 'jira', endpoint: '', needsKey: true, icon: '📋' },
];

export class ProvidersViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'caramelo.providers';
  private view?: vscode.WebviewView;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly secrets: vscode.SecretStorage
  ) {
    registry.onDidChangeActiveProvider(() => this.refresh());
    registry.onDidChangeProviders(() => this.refresh());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'selectActive':
          await this.registry.setActive(msg.id);
          this.refresh();
          break;
        case 'deleteProvider':
          await this.handleDelete(msg.id);
          break;
        case 'startAdd':
          // Show the form for this preset
          this.refresh(msg.presetIndex);
          break;
        case 'addProvider':
          await this.handleAdd(msg);
          break;
        case 'fetchModels':
          await this.handleFetchModels(msg);
          break;
        case 'changeModel':
          console.log('[Caramelo] changeModel:', msg.id);
          this.handleChangeModelInline(msg.id).catch((e) => console.error('[Caramelo] changeModel error:', e));
          break;
        case 'setModel':
          await this.handleSetModel(msg.id, msg.model);
          break;
        case 'renameProvider':
          await this.handleRename(msg.id);
          break;
        case 'cancelAdd':
          this.refresh();
          break;
        case 'testJiraConnection':
          console.log('[Caramelo] Testing Jira connection:', msg.url);
          this.handleTestJira(msg).catch((err) => {
            console.error('[Caramelo] Jira test error:', err);
            this.view?.webview.postMessage({ command: 'jiraTestResult', success: false, error: String(err) });
          });
          break;
        case 'searchJiraBoards':
          this.handleSearchBoards(msg).catch(() => {});
          break;
        case 'addJiraProvider':
          await this.handleAddJira(msg);
          break;
      }
    });

    this.refresh();
  }

  refresh(addingPresetIndex?: number): void {
    if (!this.view) return;
    this.view.webview.html = this.getHtml(addingPresetIndex);
  }

  private async handleAdd(msg: { name: string; type: string; endpoint: string; model: string; apiKey?: string; authHeader?: string; authPrefix?: string }): Promise<void> {
    const baseId = msg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const existingIds = new Set((vscode.workspace.getConfiguration().get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? []).map((c) => c.id));
    let id = baseId;
    let counter = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${counter++}`;
    }
    const apiKeyId = `caramelo.provider.${id}.apiKey`;

    if (msg.apiKey) {
      await this.secrets.store(apiKeyId, msg.apiKey);
    }

    const config: ProviderConfig = {
      id, name: msg.name, type: msg.type as ProviderConfig['type'],
      endpoint: msg.endpoint, model: msg.model,
      ...(msg.authHeader ? { authHeader: msg.authHeader } : {}),
      ...(msg.authPrefix !== undefined && msg.authPrefix !== '' ? { authPrefix: msg.authPrefix } : {}),
    };

    let provider: import('../../providers/types.js').LLMProvider;
    if (msg.type === 'copilot') {
      provider = new CopilotProvider(id, msg.name, msg.model);
    } else if (msg.type === 'anthropic') {
      provider = new ClaudeProvider({ ...config, apiKeyId }, this.secrets);
    } else {
      provider = new OpenAICompatibleProvider({ ...config, apiKeyId: msg.apiKey ? apiKeyId : undefined }, this.secrets);
    }

    if (msg.apiKey) await provider.authenticate().catch(() => {});
    this.registry.register(provider);

    const vsConfig = vscode.workspace.getConfiguration();
    const existing = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
    existing.push(config);
    await vsConfig.update(SETTINGS_KEYS.providers, existing, vscode.ConfigurationTarget.Workspace);

    await this.registry.setActive(id);
    this.refresh();
  }

  private async handleDelete(id: string): Promise<void> {
    const provider = this.registry.get(id);
    const name = provider?.displayName ?? id;

    const confirm = await vscode.window.showWarningMessage(`Delete provider "${name}"?`, { modal: true }, 'Delete');
    if (confirm !== 'Delete') return;

    this.registry.unregister(id);
    const vsConfig = vscode.workspace.getConfiguration();
    const configs = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
    await vsConfig.update(SETTINGS_KEYS.providers, configs.filter((c) => c.id !== id), vscode.ConfigurationTarget.Workspace);
    this.refresh();
  }

  private async handleFetchModels(msg: { type: string; endpoint: string; apiKey?: string; authHeader?: string; authPrefix?: string }): Promise<void> {
    let models: ModelInfo[];
    if (msg.type === 'copilot') {
      const copilotModels = await getCopilotModels();
      models = copilotModels.map((m) => ({ id: m.family, name: m.name }));
    } else {
      models = await this.fetchModelsFromAPI(msg.type, msg.endpoint, msg.apiKey, msg.authHeader, msg.authPrefix);
    }
    this.view?.webview.postMessage({ command: 'modelsLoaded', models });
  }

  private async handleTestJira(msg: { url: string; email: string; token: string }): Promise<void> {
    const sendResult = (success: boolean, data?: { boards?: unknown[]; error?: string }) => {
      console.log('[Caramelo] Jira test result:', success, data?.error ?? 'OK');
      this.view?.webview.postMessage({ command: 'jiraTestResult', success, ...data });
    };

    const url = msg.url.replace(/\/+$/, '');
    const auth = `Basic ${Buffer.from(`${msg.email}:${msg.token}`).toString('base64')}`;
    const headers = { 'Authorization': auth, 'Accept': 'application/json' };

    // Step 1: Test connection
    try {
      console.log('[Caramelo] Jira: testing connection to', url);
      const res = await fetch(`${url}/rest/api/3/myself`, { headers, signal: AbortSignal.timeout(15000) });
      console.log('[Caramelo] Jira: response status', res.status);
      if (!res.ok) {
        sendResult(false, { error: `Auth failed (HTTP ${res.status}). Check email and API token.` });
        return;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Caramelo] Jira connection error:', error);
      sendResult(false, { error: `Connection error: ${error}` });
      return;
    }

    sendResult(true, {});
  }

  private async handleSearchBoards(msg: { url: string; email: string; token: string; query: string }): Promise<void> {
    const url = msg.url.replace(/\/+$/, '');
    const auth = `Basic ${Buffer.from(`${msg.email}:${msg.token}`).toString('base64')}`;
    const headers = { 'Authorization': auth, 'Accept': 'application/json' };

    try {
      const nameParam = msg.query ? `&name=${encodeURIComponent(msg.query)}` : '';
      const res = await fetch(
        `${url}/rest/agile/1.0/board?maxResults=20${nameParam}`,
        { headers, signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) {
        this.view?.webview.postMessage({ command: 'jiraBoardResults', boards: [], error: `HTTP ${res.status}` });
        return;
      }
      const data = await res.json() as { values: Array<{ id: number; name: string; type: string }> };
      const boards = (data.values || []).map((b) => ({ id: String(b.id), name: b.name, type: b.type }));
      this.view?.webview.postMessage({ command: 'jiraBoardResults', boards });
    } catch (err) {
      this.view?.webview.postMessage({ command: 'jiraBoardResults', boards: [], error: String(err) });
    }
  }

  private async handleAddJira(msg: { url: string; email: string; token: string; boardId: string; boardName: string }): Promise<void> {
    const id = `jira-${msg.url.replace(/https?:\/\//, '').replace(/\.atlassian\.net.*/, '').replace(/[^a-z0-9]+/g, '-')}`;
    const name = `Jira (${msg.boardName})`;

    await this.secrets.store(`caramelo.jira.${id}.token`, msg.token);

    const config: ProviderConfig = {
      id, name, type: 'jira', endpoint: msg.url, model: '',
      instanceUrl: msg.url, boardId: msg.boardId, boardName: msg.boardName, email: msg.email,
    };

    const vsConfig = vscode.workspace.getConfiguration();
    const existing = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
    existing.push(config);
    await vsConfig.update(SETTINGS_KEYS.providers, existing, vscode.ConfigurationTarget.Workspace);

    this.refresh();
    vscode.window.showInformationMessage(`Jira provider "${name}" added.`);
  }

  private async handleChangeModelInline(id: string): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration();
    const configs = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
    const config = configs.find((c) => c.id === id);
    if (!config) {
      console.log('[Caramelo] changeModel: config not found for', id);
      return;
    }

    // Send picker immediately with empty models (shows manual input)
    // Then fetch models in background and update
    console.log('[Caramelo] changeModel: sending picker for', id, 'current model:', config.model);
    this.view?.webview.postMessage({ command: 'showModelPicker', id, models: [], currentModel: config.model });

    // Fetch available models asynchronously
    try {
      let models: ModelInfo[];
      if (config.type === 'copilot') {
        const copilotModels = await getCopilotModels();
        models = copilotModels.map((m) => ({ id: m.family, name: m.name }));
      } else {
        const apiKey = await this.secrets.get(`caramelo.provider.${id}.apiKey`);
        models = await this.fetchModelsFromAPI(config.type, config.endpoint, apiKey ?? undefined, config.authHeader, config.authPrefix);
      }
      console.log('[Caramelo] changeModel: fetched', models.length, 'models');
      if (models.length > 0) {
        // Update picker with actual models
        this.view?.webview.postMessage({ command: 'showModelPicker', id, models, currentModel: config.model });
      }
    } catch (err) {
      console.log('[Caramelo] changeModel: fetch error', err);
    }
  }

  private async handleSetModel(id: string, model: string): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration();
    const configs = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
    const config = configs.find((c) => c.id === id);
    if (!config) return;

    // Notify webview: validating
    this.view?.webview.postMessage({ command: 'modelValidation', id, status: 'validating' });

    config.model = model;
    await vsConfig.update(SETTINGS_KEYS.providers, configs, vscode.ConfigurationTarget.Workspace);

    // Re-register with new model
    this.registry.unregister(id);
    let provider: import('../../providers/types.js').LLMProvider;
    if (config.type === 'copilot') {
      provider = new CopilotProvider(id, config.name, model);
    } else if (config.type === 'anthropic') {
      provider = new ClaudeProvider({ ...config, apiKeyId: `caramelo.provider.${id}.apiKey` }, this.secrets);
    } else {
      provider = new OpenAICompatibleProvider({ ...config, apiKeyId: `caramelo.provider.${id}.apiKey` }, this.secrets);
    }
    await provider.authenticate().catch(() => {});

    // Validate by sending a small test request
    let valid = false;
    try {
      let testOutput = '';
      for await (const chunk of provider.chat(
        [{ role: 'user', content: 'Reply with OK' }],
        { maxTokens: 5 }
      )) {
        testOutput += chunk;
        if (testOutput.length > 0) { valid = true; break; }
      }
    } catch {
      valid = false;
    }

    this.view?.webview.postMessage({ command: 'modelValidation', id, status: valid ? 'valid' : 'invalid', model });
    this.registry.register(provider);
    await this.registry.setActive(id);
    this.refresh();
  }

  private async handleRename(id: string): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration();
    const configs = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
    const config = configs.find((c) => c.id === id);
    if (!config) return;

    const newName = await vscode.window.showInputBox({
      prompt: 'Provider name',
      value: config.name,
    });
    if (!newName || newName === config.name) return;

    config.name = newName;
    await vsConfig.update(SETTINGS_KEYS.providers, configs, vscode.ConfigurationTarget.Workspace);

    // Re-register with new name
    this.registry.unregister(id);
    let provider: import('../../providers/types.js').LLMProvider;
    if (config.type === 'copilot') {
      provider = new CopilotProvider(id, newName, config.model);
    } else if (config.type === 'anthropic') {
      provider = new ClaudeProvider({ ...config, apiKeyId: `caramelo.provider.${id}.apiKey` }, this.secrets);
    } else {
      provider = new OpenAICompatibleProvider({ ...config, apiKeyId: `caramelo.provider.${id}.apiKey` }, this.secrets);
    }
    await provider.authenticate().catch(() => {});
    this.registry.register(provider);
    this.refresh();
  }

  private async fetchModelsFromAPI(type: string, endpoint: string, apiKey?: string, customAuthHeader?: string, customAuthPrefix?: string): Promise<ModelInfo[]> {
    // Try fetching from API first
    try {
      const url = type === 'anthropic'
        ? `${endpoint.replace(/\/+$/, '')}/v1/models`
        : `${endpoint.replace(/\/+$/, '')}/models`;

      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (apiKey) {
        const headerName = customAuthHeader || (type === 'anthropic' ? 'x-api-key' : 'Authorization');
        const prefix = customAuthPrefix ?? (type === 'anthropic' ? '' : 'Bearer');
        headers[headerName] = prefix ? `${prefix} ${apiKey}` : apiKey;
      }
      if (type === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
      }

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ id: string; name?: string }>; models?: Array<{ id: string; name?: string }> };
        const list = data.data ?? data.models ?? [];
        if (list.length > 0) {
          return list.map((m) => ({ id: m.id, name: m.name ?? m.id })).sort((a, b) => a.name.localeCompare(b.name));
        }
      }
    } catch {
      // API fetch failed — fall through to known models
    }

    // No models from API — return empty, user will get manual input
    return [];
  }

  private getHtml(addingPresetIndex?: number): string {
    const providers = this.registry.getAll();
    const activeId = this.registry.activeProvider?.id;
    const configs = vscode.workspace.getConfiguration().get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
    const jiraConfigs = configs.filter((c) => c.type === 'jira');

    // Provider list
    const providersHtml = providers.map((p) => {
      const config = configs.find((c) => c.id === p.id);
      const isActive = p.id === activeId;
      return `<div class="provider-item ${isActive ? 'active' : ''}" onclick="msg('selectActive',{id:'${p.id}'})">
        <div class="provider-main">
          <span class="provider-dot ${isActive ? 'on' : ''}"></span>
          <div class="provider-info">
            <span class="provider-name" onclick="event.stopPropagation(); msg('renameProvider',{id:'${p.id}'})" title="Click to rename">${esc(p.displayName)}</span>
            <span class="provider-model" id="model-${p.id}" onclick="event.stopPropagation(); msg('changeModel',{id:'${p.id}'})" title="Click to change model">${esc(config?.model ?? '')}</span>
            <div id="model-picker-${p.id}" class="model-picker-slot"></div>
          </div>
          <button class="provider-delete" onclick="event.stopPropagation(); msg('deleteProvider',{id:'${p.id}'})" title="Delete">×</button>
        </div>
      </div>`;
    }).join('');

    // Jira providers
    const jiraHtml = jiraConfigs.map((c) => `
      <div class="provider-item jira">
        <div class="provider-main">
          <span class="provider-icon">📋</span>
          <div class="provider-info">
            <span class="provider-name">${esc(c.name)}</span>
            <span class="provider-model">${esc(c.boardName ?? '')}</span>
          </div>
          <button class="provider-delete" onclick="msg('deleteProvider',{id:'${c.id}'})" title="Delete">×</button>
        </div>
      </div>
    `).join('');

    // Add provider section
    let addSection: string;
    if (addingPresetIndex !== undefined) {
      const preset = PROVIDER_PRESETS[addingPresetIndex];
      if (preset.type === 'jira') {
        addSection = `<div class="add-form">
          <div class="add-header">${preset.icon} ${preset.label}<button class="btn-cancel" onclick="msg('cancelAdd')">×</button></div>
          <p class="form-hint">Connect to Jira Cloud to import issues as specs.</p>
          <input id="jiraUrl" class="input" placeholder="https://mycompany.atlassian.net" value="https://" />
          <input id="jiraEmail" class="input" placeholder="you@company.com" type="email" />
          <input id="jiraToken" class="input" placeholder="API token (from id.atlassian.com)" type="password" />
          <div id="jiraBoardSection" style="display:none">
            <input id="jiraBoardSearch" class="input" placeholder="Search board name..." oninput="searchBoards()" />
            <select id="jiraBoard" class="input" size="5" style="display:none"></select>
            <div id="jiraBoardHint" class="form-hint"></div>
          </div>
          <button class="btn-primary" id="btnJira" onclick="testJira()" disabled>Enter credentials first</button>
          <div id="jiraStatus" class="form-status"></div>
        </div>`;
      } else if (preset.type === 'copilot') {
        addSection = `<div class="add-form">
          <div class="add-header">${preset.icon} ${preset.label}<button class="btn-cancel" onclick="msg('cancelAdd')">×</button></div>
          <p class="form-hint">Uses your GitHub Copilot subscription. No API key needed.</p>
          <div id="modelSection" style="display:none">
            <select id="addModel" class="input"><option>Loading models...</option></select>
          </div>
          <input id="addModelManual" class="input" placeholder="Model family" style="display:none" />
          <button class="btn-primary" id="btnAdd" onclick="submitAdd('Copilot','copilot')" disabled>Loading models...</button>
        </div>`;
      } else {
        addSection = `<div class="add-form">
          <div class="add-header">${preset.icon} ${preset.label}<button class="btn-cancel" onclick="msg('cancelAdd')">×</button></div>
          <input id="addEndpoint" class="input" value="${preset.endpoint}" placeholder="Endpoint URL" />
          ${preset.needsKey ? `<input id="addApiKey" class="input" type="password" placeholder="API Key" />
          <details class="auth-details"><summary>Custom auth header (optional)</summary>
            <input id="addAuthHeader" class="input" placeholder="Header name (default: ${preset.type === 'anthropic' ? 'x-api-key' : 'Authorization'})" />
            <input id="addAuthPrefix" class="input" placeholder="Value prefix (default: ${preset.type === 'anthropic' ? 'none' : 'Bearer'})" />
          </details>` : ''}
          <div id="modelSection" style="display:none">
            <select id="addModel" class="input"><option>Loading models...</option></select>
          </div>
          <input id="addModelManual" class="input" placeholder="Model name" style="display:none" />
          <button class="btn-primary" id="btnAdd" onclick="submitAdd('${preset.label}','${preset.type}')" ${preset.needsKey ? 'disabled' : ''}>
            ${preset.needsKey ? 'Enter API key first' : 'Add'}
          </button>
        </div>`;
      }
    } else {
      addSection = `<div class="presets">
        ${PROVIDER_PRESETS.map((p, i) => `<button class="preset-btn" onclick="msg('startAdd',{presetIndex:${i}})">${p.icon} ${p.label}</button>`).join('')}
      </div>`;
    }

    return `<!DOCTYPE html><html><head>${STYLES}</head><body>
      ${providersHtml}${jiraHtml}
      <div class="divider"></div>
      ${addSection}
      ${SCRIPT(addingPresetIndex)}
    </body></html>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

const SCRIPT = (addingPresetIndex?: number) => `<script>
const vscode = acquireVsCodeApi();
function msg(cmd, data) { vscode.postMessage({ command: cmd, ...data }); }

${addingPresetIndex !== undefined ? `
// Enable Jira test button when all fields filled
['jiraUrl','jiraEmail','jiraToken'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => {
    const url = document.getElementById('jiraUrl')?.value || '';
    const email = document.getElementById('jiraEmail')?.value || '';
    const token = document.getElementById('jiraToken')?.value || '';
    const btn = document.getElementById('btnJira');
    if (btn && url.length > 8 && email.includes('@') && token.length > 5) {
      btn.textContent = 'Test Connection';
      btn.disabled = false;
      btn.onclick = function() { testJira(); };
    }
  });
});

// Auto-fetch models when API key is entered
const keyInput = document.getElementById('addApiKey');
const endpointInput = document.getElementById('addEndpoint');
const btnAdd = document.getElementById('btnAdd');
let debounce;

function triggerFetchModels() {
  clearTimeout(debounce);
  const apiKey = keyInput?.value || '';
  const authHeader = document.getElementById('addAuthHeader')?.value || '';
  const authPrefix = document.getElementById('addAuthPrefix')?.value || '';
  if (keyInput && apiKey.length < 10) return;
  debounce = setTimeout(() => {
    if (btnAdd) { btnAdd.textContent = 'Loading models...'; btnAdd.disabled = true; }
    msg('fetchModels', {
      type: '${PROVIDER_PRESETS[addingPresetIndex]?.type}',
      endpoint: endpointInput?.value || '',
      apiKey: apiKey || undefined,
      authHeader: authHeader || undefined,
      authPrefix: authPrefix || undefined
    });
  }, 500);
}

if (keyInput) {
  keyInput.addEventListener('input', triggerFetchModels);
} else {
  // No key needed — fetch models immediately
  setTimeout(triggerFetchModels, 300);
}

// Re-fetch models when auth header fields change
['addAuthHeader', 'addAuthPrefix'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', triggerFetchModels);
});

// Handle models response
window.addEventListener('message', (event) => {
  const evt = event.data;
  if (evt.command === 'modelsLoaded') {
    const models = evt.models || [];
    const select = document.getElementById('addModel');
    const manual = document.getElementById('addModelManual');
    const section = document.getElementById('modelSection');

    if (models.length > 0) {
      section.style.display = 'block';
      manual.style.display = 'none';
      select.innerHTML = models.map(m =>
        '<option value="' + m.id + '">' + m.name + '</option>'
      ).join('');
    } else {
      section.style.display = 'none';
      manual.style.display = 'block';
      manual.placeholder = 'Model name (e.g., llama3)';
    }

    if (btnAdd) {
      btnAdd.textContent = 'Add';
      btnAdd.disabled = false;
    }
  }

  // Handle Jira progress
  if (evt.command === 'jiraProgress') {
    const btn = document.getElementById('btnJira');
    const statusEl = document.getElementById('jiraStatus');
    if (btn) btn.textContent = evt.message || 'Loading...';
    if (statusEl) { statusEl.textContent = evt.message || ''; statusEl.style.color = ''; }
  }

  // Handle Jira board search results
  if (evt.command === 'jiraBoardResults') {
    const select = document.getElementById('jiraBoard');
    const hint = document.getElementById('jiraBoardHint');
    const btnJira = document.getElementById('btnJira');
    const boards = evt.boards || [];

    if (boards.length > 0) {
      select.style.display = 'block';
      select.innerHTML = boards.map(b =>
        '<option value="' + b.id + '" data-name="' + b.name.replace(/"/g, '&quot;') + '">' + b.name + ' (' + b.type + ')</option>'
      ).join('');
      if (hint) hint.textContent = boards.length + ' board(s) found';
      select.onchange = function() {
        if (btnJira) { btnJira.textContent = 'Add Jira Provider'; btnJira.disabled = false; btnJira.onclick = function() { submitJira(); }; }
      };
      if (boards.length === 1 && btnJira) { btnJira.textContent = 'Add Jira Provider'; btnJira.disabled = false; btnJira.onclick = function() { submitJira(); }; }
    } else {
      select.style.display = 'none';
      if (hint) hint.textContent = evt.error ? 'Error: ' + evt.error : 'No boards found. Try a different name.';
      if (btnJira) { btnJira.textContent = 'Select a board first'; btnJira.disabled = true; }
    }
  }

  // Handle Jira test result
  if (evt.command === 'jiraTestResult') {
    const statusEl = document.getElementById('jiraStatus');
    const btnJira = document.getElementById('btnJira');
    const boardSection = document.getElementById('jiraBoardSection');
    const boardSelect = document.getElementById('jiraBoard');

    if (statusEl && btnJira) {
      if (evt.success) {
        statusEl.textContent = '✓ Connected — search for your board below';
        statusEl.style.color = '#4CAF50';
        if (boardSection) boardSection.style.display = 'block';
        const searchInput = document.getElementById('jiraBoardSearch');
        if (searchInput) searchInput.focus();
        btnJira.textContent = 'Select a board first';
        btnJira.disabled = true;
      } else {
        statusEl.textContent = '✗ ' + (evt.error || 'Connection failed');
        statusEl.style.color = '#f44';
        btnJira.textContent = 'Retry';
        btnJira.disabled = false;
        btnJira.onclick = function() { testJira(); };
      }
    }
  }
});
` : ''}

// Global message handler (always active, not just when adding)
window.addEventListener('message', (event) => {
  const evt = event.data;

  // Handle inline model picker
  if (evt.command === 'showModelPicker') {
    const modelSpan = document.getElementById('model-' + evt.id);
    const slot = document.getElementById('model-picker-' + evt.id);
    if (!modelSpan || !slot) return;

    modelSpan.style.display = 'none';
    slot.innerHTML = '';

    const models = evt.models || [];
    if (models.length > 0) {
      const select = document.createElement('select');
      select.className = 'input';
      select.style.fontSize = '0.8em';
      models.forEach(function(m) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === evt.currentModel) opt.selected = true;
        select.appendChild(opt);
      });
      var pickerId = evt.id;
      select.onchange = function() { msg('setModel', { id: pickerId, model: select.value }); };
      select.onblur = function() { slot.innerHTML = ''; modelSpan.style.display = ''; };
      slot.appendChild(select);
      select.focus();
    } else {
      const input = document.createElement('input');
      input.className = 'input';
      input.style.fontSize = '0.8em';
      input.value = evt.currentModel || '';
      input.placeholder = 'Model name';
      var inputId = evt.id;
      var curModel = evt.currentModel;
      input.onkeydown = function(e) {
        if (e.key === 'Enter' && input.value.trim()) { msg('setModel', { id: inputId, model: input.value.trim() }); }
        if (e.key === 'Escape') { slot.innerHTML = ''; modelSpan.style.display = ''; }
      };
      input.onblur = function() {
        if (input.value.trim() && input.value.trim() !== curModel) {
          msg('setModel', { id: inputId, model: input.value.trim() });
        } else { slot.innerHTML = ''; modelSpan.style.display = ''; }
      };
      slot.appendChild(input);
      input.focus();
      input.select();
    }
  }

  // Handle model validation result
  if (evt.command === 'modelValidation') {
    const modelSpan = document.getElementById('model-' + evt.id);
    const slot = document.getElementById('model-picker-' + evt.id);
    if (slot) slot.innerHTML = '';
    if (modelSpan) {
      modelSpan.style.display = '';
      if (evt.status === 'validating') {
        modelSpan.textContent = '⏳ Validating...';
        modelSpan.style.color = '';
      } else if (evt.status === 'valid') {
        modelSpan.textContent = '✓ ' + evt.model;
        modelSpan.style.color = '#4CAF50';
        setTimeout(function() { modelSpan.textContent = evt.model; modelSpan.style.color = ''; }, 2000);
      } else {
        modelSpan.textContent = '✗ ' + evt.model + ' (invalid)';
        modelSpan.style.color = '#f44';
        setTimeout(function() { modelSpan.textContent = evt.model; modelSpan.style.color = ''; }, 3000);
      }
    }
  }
});

let boardDebounce;

function searchBoards() {
  clearTimeout(boardDebounce);
  const query = (document.getElementById('jiraBoardSearch')?.value || '').trim();
  const hint = document.getElementById('jiraBoardHint');
  if (query.length < 2) {
    document.getElementById('jiraBoard').style.display = 'none';
    if (hint) hint.textContent = 'Type at least 2 characters to search';
    return;
  }
  if (hint) hint.textContent = 'Searching...';
  boardDebounce = setTimeout(() => {
    const url = document.getElementById('jiraUrl')?.value || '';
    const email = document.getElementById('jiraEmail')?.value || '';
    const token = document.getElementById('jiraToken')?.value || '';
    msg('searchJiraBoards', { url, email, token, query });
  }, 400);
}

function testJira() {
  const url = document.getElementById('jiraUrl')?.value || '';
  const email = document.getElementById('jiraEmail')?.value || '';
  const token = document.getElementById('jiraToken')?.value || '';
  if (!url || !email || !token) return;
  const btn = document.getElementById('btnJira');
  const statusEl = document.getElementById('jiraStatus');
  btn.textContent = 'Testing...';
  btn.disabled = true;
  statusEl.textContent = '';
  msg('testJiraConnection', { url, email, token });

  // Fallback: re-enable button after 60s if no response
  setTimeout(() => {
    if (btn.disabled && (btn.textContent === 'Testing...' || btn.textContent.startsWith('Loading'))) {
      btn.textContent = 'Retry';
      btn.disabled = false;
      btn.onclick = function() { testJira(); };
      statusEl.textContent = 'Timeout — no response. Check URL and try again.';
      statusEl.style.color = '#f44';
    }
  }, 60000);
}

function submitJira() {
  const url = document.getElementById('jiraUrl')?.value || '';
  const email = document.getElementById('jiraEmail')?.value || '';
  const token = document.getElementById('jiraToken')?.value || '';
  const select = document.getElementById('jiraBoard');
  const boardId = select?.value || '';
  const boardName = select?.options[select.selectedIndex]?.dataset?.name || '';
  if (!url || !email || !token || !boardId) return;
  msg('addJiraProvider', { url, email, token, boardId, boardName });
}

function submitAdd(name, type) {
  const endpoint = document.getElementById('addEndpoint')?.value || '';
  const apiKey = document.getElementById('addApiKey')?.value || '';
  const select = document.getElementById('addModel');
  const manual = document.getElementById('addModelManual');
  const model = (select && select.style?.display !== 'none' && select.parentElement?.style?.display !== 'none')
    ? select.value
    : (manual?.value || 'default');

  if (!model) return;
  const authHeader = document.getElementById('addAuthHeader')?.value || undefined;
  const authPrefix = document.getElementById('addAuthPrefix')?.value ?? undefined;
  msg('addProvider', { name, type, endpoint, model, apiKey: apiKey || undefined, authHeader, authPrefix });
}
</script>`;

const STYLES = `<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; padding: 6px; font-size: 12px; }

.provider-item {
  display: flex; flex-direction: column; padding: 6px 8px; border-radius: 5px; cursor: pointer;
  margin-bottom: 3px; border-left: 3px solid transparent;
}
.provider-item:hover { background: var(--vscode-list-hoverBackground); }
.provider-item.active { border-left-color: #4CAF50; background: rgba(76,175,80,0.06); }
.provider-item.jira { border-left-color: #0052CC; cursor: default; }

.provider-main { display: flex; align-items: center; gap: 6px; }
.provider-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: 0.3; flex-shrink: 0; }
.provider-dot.on { background: #4CAF50; opacity: 1; box-shadow: 0 0 4px rgba(76,175,80,0.5); }
.provider-icon { font-size: 1em; flex-shrink: 0; }
.provider-info { flex: 1; min-width: 0; }
.provider-name { display: block; font-weight: 600; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.provider-name:hover { color: var(--vscode-textLink-foreground); }
.model-picker-slot { width: 100%; }
.model-picker-slot select, .model-picker-slot input { width: 100%; }
.provider-model {
  display: block; font-size: 0.78em; color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.provider-model:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
.provider-delete {
  background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer;
  font-size: 1.2em; padding: 0 2px; opacity: 0; transition: opacity 0.15s;
}
.provider-item:hover .provider-delete { opacity: 0.6; }
.provider-delete:hover { opacity: 1; color: var(--vscode-errorForeground); }

.divider { height: 1px; background: var(--vscode-widget-border, rgba(255,255,255,0.1)); margin: 6px 0; }

/* Preset buttons */
.presets { display: flex; flex-wrap: wrap; gap: 4px; }
.preset-btn {
  padding: 4px 8px; border: 1px solid var(--vscode-widget-border, #555); border-radius: 4px;
  background: transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 0.85em;
}
.preset-btn:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }

/* Add form */
.add-form { padding: 4px 0; }
.add-header {
  display: flex; align-items: center; justify-content: space-between;
  font-weight: 600; font-size: 0.9em; margin-bottom: 6px;
}
.btn-cancel { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 1.2em; }
.input {
  width: 100%; padding: 4px 8px; margin-bottom: 5px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #555); border-radius: 3px;
  font-family: inherit; font-size: 0.9em;
}
.input:focus { outline: none; border-color: var(--vscode-focusBorder); }
select.input { appearance: auto; }
.btn-primary {
  width: 100%; padding: 5px; border: none; border-radius: 3px; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  font-weight: 600; font-size: 0.85em;
}
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.btn-primary:disabled { opacity: 0.5; cursor: default; }
.form-hint { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
.form-status { font-size: 0.8em; margin-top: 4px; font-weight: 500; }
.auth-details { margin: 4px 0; font-size: 0.85em; }
.auth-details summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.auth-details summary:hover { color: var(--vscode-foreground); }
.auth-details .input { margin-top: 4px; }
</style>`;
