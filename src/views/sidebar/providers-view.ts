import * as vscode from 'vscode';
import type { ProviderRegistry } from '../../providers/registry.js';
import { OpenAICompatibleProvider } from '../../providers/openai-compatible.js';
import { ClaudeProvider } from '../../providers/claude.js';
import { CopilotProvider, getCopilotModels } from '../../providers/copilot.js';
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
          await this.handleChangeModel(msg.id);
          break;
        case 'cancelAdd':
          this.refresh();
          break;
        case 'addJira':
          vscode.commands.executeCommand('caramelo.addProvider');
          break;
      }
    });

    this.refresh();
  }

  refresh(addingPresetIndex?: number): void {
    if (!this.view) return;
    this.view.webview.html = this.getHtml(addingPresetIndex);
  }

  private async handleAdd(msg: { name: string; type: string; endpoint: string; model: string; apiKey?: string }): Promise<void> {
    const id = msg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const apiKeyId = `caramelo.provider.${id}.apiKey`;

    if (msg.apiKey) {
      await this.secrets.store(apiKeyId, msg.apiKey);
    }

    const config: ProviderConfig = {
      id, name: msg.name, type: msg.type as ProviderConfig['type'],
      endpoint: msg.endpoint, model: msg.model,
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

  private async handleFetchModels(msg: { type: string; endpoint: string; apiKey?: string }): Promise<void> {
    let models: ModelInfo[];
    if (msg.type === 'copilot') {
      const copilotModels = await getCopilotModels();
      models = copilotModels.map((m) => ({ id: m.family, name: m.name }));
    } else {
      models = await this.fetchModelsFromAPI(msg.type, msg.endpoint, msg.apiKey);
    }
    this.view?.webview.postMessage({ command: 'modelsLoaded', models });
  }

  private async handleChangeModel(id: string): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration();
    const configs = vsConfig.get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
    const config = configs.find((c) => c.id === id);
    if (!config) return;

    let models: ModelInfo[];
    if (config.type === 'copilot') {
      const copilotModels = await getCopilotModels();
      models = copilotModels.map((m) => ({ id: m.family, name: m.name }));
    } else {
      const apiKey = await this.secrets.get(`caramelo.provider.${id}.apiKey`);
      models = await this.fetchModelsFromAPI(config.type, config.endpoint, apiKey ?? undefined);
    }

    const items = models.map((m) => ({
      label: m.id === config.model ? `$(check) ${m.name}` : m.name,
      description: m.id,
    }));

    if (items.length === 0) {
      const manual = await vscode.window.showInputBox({ prompt: 'Model name', value: config.model });
      if (!manual) return;
      config.model = manual;
    } else {
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select model' });
      if (!pick) return;
      config.model = pick.description!;
    }

    await vsConfig.update(SETTINGS_KEYS.providers, configs, vscode.ConfigurationTarget.Workspace);

    // Re-register provider with new model
    this.registry.unregister(id);
    let provider: import('../../providers/types.js').LLMProvider;
    if (config.type === 'copilot') {
      provider = new CopilotProvider(id, config.name, config.model);
    } else {
      const apiKeyId = `caramelo.provider.${id}.apiKey`;
      provider = config.type === 'anthropic'
        ? new ClaudeProvider({ ...config, apiKeyId }, this.secrets)
        : new OpenAICompatibleProvider({ ...config, apiKeyId }, this.secrets);
    }
    await provider.authenticate().catch(() => {});
    this.registry.register(provider);
    await this.registry.setActive(id);
    this.refresh();
  }

  private async fetchModelsFromAPI(type: string, endpoint: string, apiKey?: string): Promise<ModelInfo[]> {
    try {
      const url = type === 'anthropic'
        ? 'https://api.anthropic.com/v1/models'
        : `${endpoint.replace(/\/+$/, '')}/models`;

      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (type === 'anthropic' && apiKey) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];

      const data = await res.json() as { data?: Array<{ id: string; name?: string }>; models?: Array<{ id: string; name?: string }> };
      const list = data.data ?? data.models ?? [];
      return list.map((m) => ({ id: m.id, name: m.name ?? m.id })).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
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
            <span class="provider-name">${esc(p.displayName)}</span>
            <span class="provider-model" onclick="event.stopPropagation(); msg('changeModel',{id:'${p.id}'})" title="Click to change model">${esc(config?.model ?? '')}</span>
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
          <button class="btn-primary" onclick="msg('addJira')">Configure Jira</button>
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
          ${preset.needsKey ? '<input id="addApiKey" class="input" type="password" placeholder="API Key" />' : ''}
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
// Auto-fetch models when API key is entered
const keyInput = document.getElementById('addApiKey');
const endpointInput = document.getElementById('addEndpoint');
const btnAdd = document.getElementById('btnAdd');
let debounce;

if (keyInput) {
  keyInput.addEventListener('input', () => {
    clearTimeout(debounce);
    if (keyInput.value.length > 10) {
      debounce = setTimeout(() => {
        btnAdd.textContent = 'Loading models...';
        btnAdd.disabled = true;
        msg('fetchModels', {
          type: '${PROVIDER_PRESETS[addingPresetIndex]?.type}',
          endpoint: endpointInput.value,
          apiKey: keyInput.value
        });
      }, 500);
    }
  });
} else {
  // No key needed — fetch models immediately
  setTimeout(() => {
    msg('fetchModels', {
      type: '${PROVIDER_PRESETS[addingPresetIndex]?.type}',
      endpoint: endpointInput?.value || ''
    });
  }, 300);
}

// Handle models response
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.command === 'modelsLoaded') {
    const models = msg.models || [];
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
});
` : ''}

function submitAdd(name, type) {
  const endpoint = document.getElementById('addEndpoint')?.value || '';
  const apiKey = document.getElementById('addApiKey')?.value || '';
  const select = document.getElementById('addModel');
  const manual = document.getElementById('addModelManual');
  const model = (select && select.style?.display !== 'none' && select.parentElement?.style?.display !== 'none')
    ? select.value
    : (manual?.value || 'default');

  if (!model) return;
  msg('addProvider', { name, type, endpoint, model, apiKey: apiKey || undefined });
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
.provider-name { display: block; font-weight: 600; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
</style>`;
