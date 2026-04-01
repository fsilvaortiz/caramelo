import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SPECS_DIR_NAME, PHASE_FILES } from '../../constants.js';

export class ProgressViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'caramelo.progress';
  private view?: vscode.WebviewView;
  private workspaceUri: vscode.Uri | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;

    // Auto-refresh on file changes
    if (this.workspaceUri) {
      const pattern = new vscode.RelativePattern(this.workspaceUri, `${SPECS_DIR_NAME}/**`);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(() => this.refresh());
      watcher.onDidCreate(() => this.refresh());
      watcher.onDidDelete(() => this.refresh());
    }

    vscode.window.onDidChangeActiveTextEditor(() => this.refresh());
    vscode.workspace.onDidSaveTextDocument(() => this.refresh());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'toggleTask' && msg.filePath && msg.line !== undefined) {
        this.toggleTask(msg.filePath, msg.line, msg.done);
      } else if (msg.command === 'createSpec') {
        this.handleCreateSpec(msg.name, msg.description);
      } else if (msg.command === 'openConstitution') {
        vscode.commands.executeCommand('caramelo.editConstitution');
      }
    });

    this.refresh();
  }

  private onSpecCreated?: (name: string) => void;

  setOnSpecCreated(callback: (name: string) => void): void {
    this.onSpecCreated = callback;
  }

  private handleCreateSpec(name: string, description: string): void {
    if (!this.workspaceUri) return;

    // Check constitution
    const constitutionPath = path.join(this.workspaceUri.fsPath, '.specify', 'memory', 'constitution.md');
    const hasConstitution = fs.existsSync(constitutionPath) &&
      !fs.readFileSync(constitutionPath, 'utf-8').includes('[PRINCIPLE_1_NAME]');

    if (!hasConstitution) {
      vscode.window.showErrorMessage(
        'A project constitution is required before creating specs.',
        'Set Up Constitution'
      ).then((action) => {
        if (action) vscode.commands.executeCommand('caramelo.editConstitution');
      });
      return;
    }

    // Create the spec directory
    const specsRoot = path.join(this.workspaceUri.fsPath, SPECS_DIR_NAME);
    if (!fs.existsSync(specsRoot)) fs.mkdirSync(specsRoot, { recursive: true });
    const specDir = path.join(specsRoot, name);
    if (!fs.existsSync(specDir)) fs.mkdirSync(specDir, { recursive: true });

    const metaPath = path.join(specDir, '.caramelo-meta.json');
    if (!fs.existsSync(metaPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({ phases: { requirements: 'pending', design: 'pending', tasks: 'pending' } }, null, 2));
    }

    this.refresh();
    this.onSpecCreated?.(name);

    vscode.window.showInformationMessage(
      `Spec "${name}" created. Generate Requirements?`,
      'Generate', 'Later'
    ).then((action) => {
      if (action === 'Generate') {
        vscode.commands.executeCommand('caramelo.runPhase', name, 'requirements');
      }
    });
  }

  private toggleTask(filePath: string, lineNumber: number, done: boolean): void {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lineNumber >= lines.length) return;

    if (done) {
      lines[lineNumber] = lines[lineNumber].replace('- [ ]', '- [x]');
    } else {
      lines[lineNumber] = lines[lineNumber].replace(/- \[x\]/i, '- [ ]');
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    const data = this.gatherData();
    this.view.webview.html = this.getHtml(data);
  }

  private gatherData(): ProgressData {
    const data: ProgressData = { specs: [], hasConstitution: false };
    if (!this.workspaceUri) return data;

    const constitutionPath = path.join(this.workspaceUri.fsPath, '.specify', 'memory', 'constitution.md');
    data.hasConstitution = fs.existsSync(constitutionPath) &&
      !fs.readFileSync(constitutionPath, 'utf-8').includes('[PRINCIPLE_1_NAME]');

    const specsRoot = path.join(this.workspaceUri.fsPath, SPECS_DIR_NAME);
    if (!fs.existsSync(specsRoot)) return data;

    const entries = fs.readdirSync(specsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const specDir = path.join(specsRoot, entry.name);
      const specData: SpecProgress = {
        name: entry.name,
        phases: [],
        taskStats: { total: 0, completed: 0 },
        tasks: [],
      };

      // Read phase statuses
      const metaPath = path.join(specDir, '.caramelo-meta.json');
      let statuses: Record<string, string> = {};
      try {
        const raw = fs.readFileSync(metaPath, 'utf-8');
        statuses = JSON.parse(raw).phases ?? {};
      } catch { /* ignore */ }

      for (const [type, fileName] of Object.entries(PHASE_FILES)) {
        const filePath = path.join(specDir, fileName);
        const exists = fs.existsSync(filePath);
        let status = statuses[type] ?? 'pending';
        if (status === 'pending' && exists) {
          const content = fs.readFileSync(filePath, 'utf-8').trim();
          if (content.length > 0) status = 'pending-approval';
        }
        specData.phases.push({ type, status, hasFile: exists });
      }

      // Parse tasks if tasks.md exists
      const tasksPath = path.join(specDir, PHASE_FILES.tasks);
      if (fs.existsSync(tasksPath)) {
        const content = fs.readFileSync(tasksPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trimStart();
          if (/^- \[ \] /.test(trimmed)) {
            specData.taskStats.total++;
            specData.tasks.push({ line: i, text: trimmed.replace(/^- \[ \] /, '').trim(), done: false });
          } else if (/^- \[x\] /i.test(trimmed)) {
            specData.taskStats.total++;
            specData.taskStats.completed++;
            specData.tasks.push({ line: i, text: trimmed.replace(/^- \[x\] /i, '').trim(), done: true });
          }
        }
        specData.tasksFilePath = tasksPath;
      }

      data.specs.push(specData);
    }
    return data;
  }

  private getHtml(data: ProgressData): string {
    const newSpecForm = data.hasConstitution ? `
      <div class="new-spec-form" id="newSpecForm">
        <div class="section-label" style="cursor:pointer;" onclick="toggleForm()">
          New Spec <span id="form-toggle">▸</span>
        </div>
        <div id="form-body" style="display:none">
          <input type="text" id="specName" placeholder="feature-name" class="form-input" />
          <textarea id="specDesc" placeholder="Brief description of the feature..." class="form-input form-textarea"></textarea>
          <button class="form-btn" onclick="createSpec()">Create Spec</button>
        </div>
      </div>` : `
      <div class="new-spec-form">
        <div class="constitution-warning" onclick="openConstitution()">
          <span>⚠</span> Set up a Constitution to start creating specs
        </div>
      </div>`;

    if (data.specs.length === 0) {
      return `<!DOCTYPE html><html><head>${this.getStyles()}</head><body>
        ${newSpecForm}
        <div class="empty">
          <p class="empty-icon">📋</p>
          <p>No specs yet</p>
          <p class="hint">Create your first spec above</p>
        </div>
        ${this.getScript()}
        </body></html>`;
    }

    const specsHtml = data.specs.map((spec) => {
      const totalPhases = spec.phases.length;
      const approvedPhases = spec.phases.filter((p) => p.status === 'approved').length;
      const phasePercent = Math.round((approvedPhases / totalPhases) * 100);

      const taskPercent = spec.taskStats.total > 0
        ? Math.round((spec.taskStats.completed / spec.taskStats.total) * 100)
        : 0;

      const phaseDots = spec.phases.map((p) => {
        const label = p.type.charAt(0).toUpperCase() + p.type.slice(1);
        let cls = 'dot pending';
        if (p.status === 'approved') cls = 'dot approved';
        else if (p.status === 'pending-approval') cls = 'dot review';
        else if (p.status === 'generating') cls = 'dot generating';
        else if (p.status === 'stale') cls = 'dot stale';
        return `<div class="${cls}" title="${label}: ${p.status}"><span class="dot-label">${label}</span></div>`;
      }).join('<div class="dot-line"></div>');

      const hasTasksSection = spec.taskStats.total > 0;

      return `
        <div class="spec-card">
          <div class="spec-header">${spec.name}</div>

          <div class="section-label">Spec Phases</div>
          <div class="phase-track">${phaseDots}</div>

          <div class="progress-row">
            <div class="ring-container">
              <svg viewBox="0 0 36 36" class="ring">
                <path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                <path class="ring-fill" stroke-dasharray="${phasePercent}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                <text x="18" y="20.5" class="ring-text">${phasePercent}%</text>
              </svg>
              <div class="ring-label">Phases</div>
            </div>
            ${hasTasksSection ? `
            <div class="ring-container">
              <svg viewBox="0 0 36 36" class="ring">
                <path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                <path class="ring-fill tasks" stroke-dasharray="${taskPercent}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                <text x="18" y="20.5" class="ring-text">${taskPercent}%</text>
              </svg>
              <div class="ring-label">${spec.taskStats.completed}/${spec.taskStats.total} Tasks</div>
            </div>` : ''}
          </div>
          ${hasTasksSection ? `
          <div class="section-label" style="margin-top:12px; cursor:pointer;" onclick="toggleTasks('${spec.name}')">
            Tasks <span id="toggle-${spec.name}">▸</span>
          </div>
          <div id="tasks-${spec.name}" class="task-list" style="display:none">
            ${spec.tasks.slice(0, 30).map((t) => `
              <label class="task-item ${t.done ? 'done' : ''}">
                <input type="checkbox" ${t.done ? 'checked' : ''}
                  onchange="toggleTask('${spec.tasksFilePath?.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', ${t.line}, this.checked)" />
                <span>${escapeHtml(t.text.slice(0, 60))}${t.text.length > 60 ? '...' : ''}</span>
              </label>
            `).join('')}
            ${spec.tasks.length > 30 ? `<div class="hint">${spec.tasks.length - 30} more tasks...</div>` : ''}
          </div>` : ''}
        </div>`;
    }).join('');

    return `<!DOCTYPE html><html><head>${this.getStyles()}</head><body>
    ${newSpecForm}
    ${specsHtml}
    ${this.getScript()}
    </body></html>`;
  }

  private getScript(): string {
    return `<script>
      const vscode = acquireVsCodeApi();
      function toggleTask(filePath, line, done) {
        vscode.postMessage({ command: 'toggleTask', filePath, line, done });
      }
      function toggleTasks(specName) {
        const el = document.getElementById('tasks-' + specName);
        const toggle = document.getElementById('toggle-' + specName);
        if (el.style.display === 'none') { el.style.display = 'block'; toggle.textContent = '▾'; }
        else { el.style.display = 'none'; toggle.textContent = '▸'; }
      }
      function toggleForm() {
        const body = document.getElementById('form-body');
        const toggle = document.getElementById('form-toggle');
        if (body.style.display === 'none') { body.style.display = 'block'; toggle.textContent = '▾'; document.getElementById('specName').focus(); }
        else { body.style.display = 'none'; toggle.textContent = '▸'; }
      }
      function createSpec() {
        const name = document.getElementById('specName').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const desc = document.getElementById('specDesc').value.trim();
        if (!name) { document.getElementById('specName').style.borderColor = '#f44'; return; }
        vscode.postMessage({ command: 'createSpec', name, description: desc || name });
      }
      function openConstitution() {
        vscode.postMessage({ command: 'openConstitution' });
      }
      // Submit on Enter in name field
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && e.target.id === 'specName') createSpec();
      });
    </script>`;
  }

  private getStyles(): string {
    return `<style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: var(--vscode-font-family, sans-serif);
        color: var(--vscode-foreground);
        background: transparent;
        padding: 8px;
        font-size: 12px;
      }
      .empty { text-align: center; padding: 24px 8px; opacity: 0.7; }
      .empty-icon { font-size: 2em; margin-bottom: 8px; }
      .hint { font-size: 0.85em; opacity: 0.6; margin-top: 4px; }

      /* New spec form */
      .new-spec-form {
        margin-bottom: 10px;
      }
      .form-input {
        width: 100%;
        padding: 6px 8px;
        margin-top: 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #555);
        border-radius: 4px;
        font-family: inherit;
        font-size: 0.9em;
      }
      .form-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
      .form-textarea { min-height: 50px; resize: vertical; }
      .form-btn {
        width: 100%;
        margin-top: 8px;
        padding: 6px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9em;
        font-weight: 600;
      }
      .form-btn:hover { background: var(--vscode-button-hoverBackground); }
      .constitution-warning {
        padding: 8px 10px;
        background: rgba(255,193,7,0.1);
        border: 1px solid rgba(255,193,7,0.3);
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.85em;
        text-align: center;
      }
      .constitution-warning:hover { background: rgba(255,193,7,0.2); }

      .spec-card {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 10px;
      }
      .spec-header {
        font-weight: 700;
        font-size: 1.05em;
        margin-bottom: 10px;
        color: var(--vscode-foreground);
      }
      .section-label {
        font-size: 0.75em;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 6px;
        font-weight: 600;
      }

      /* Phase dots */
      .phase-track {
        display: flex;
        align-items: center;
        gap: 0;
        margin-bottom: 14px;
      }
      .dot {
        width: 28px; height: 28px;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        position: relative;
        flex-shrink: 0;
      }
      .dot-label {
        position: absolute;
        top: 32px;
        font-size: 0.7em;
        white-space: nowrap;
        color: var(--vscode-descriptionForeground);
      }
      .dot.approved {
        background: #4CAF50;
        box-shadow: 0 0 6px rgba(76,175,80,0.4);
      }
      .dot.approved::after { content: '✓'; color: white; font-size: 14px; font-weight: bold; }
      .dot.review {
        background: #2196F3;
        box-shadow: 0 0 6px rgba(33,150,243,0.4);
        animation: pulse 2s ease-in-out infinite;
      }
      .dot.review::after { content: '●'; color: white; font-size: 10px; }
      .dot.generating {
        background: #FF9800;
        animation: pulse 1s ease-in-out infinite;
      }
      .dot.generating::after { content: '⟳'; color: white; font-size: 14px; }
      .dot.stale {
        background: #FFC107;
        box-shadow: 0 0 6px rgba(255,193,7,0.4);
      }
      .dot.stale::after { content: '⚠'; color: #333; font-size: 12px; }
      .dot.pending {
        background: var(--vscode-badge-background, #555);
        opacity: 0.4;
      }
      .dot.pending::after { content: '○'; color: var(--vscode-badge-foreground); font-size: 12px; }
      .dot-line {
        flex: 1;
        height: 2px;
        min-width: 12px;
        background: var(--vscode-widget-border, rgba(255,255,255,0.15));
      }

      @keyframes pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.1); }
      }

      /* Progress rings */
      .progress-row {
        display: flex;
        justify-content: center;
        gap: 24px;
        margin-top: 8px;
      }
      .ring-container { text-align: center; }
      .ring { width: 64px; height: 64px; }
      .ring-bg {
        fill: none;
        stroke: var(--vscode-widget-border, rgba(255,255,255,0.1));
        stroke-width: 3;
      }
      .ring-fill {
        fill: none;
        stroke: #4CAF50;
        stroke-width: 3;
        stroke-linecap: round;
        transform: rotate(-90deg);
        transform-origin: 50% 50%;
        transition: stroke-dasharray 0.6s ease;
      }
      .ring-fill.tasks { stroke: #2196F3; }
      .ring-text {
        fill: var(--vscode-foreground);
        font-size: 8px;
        font-weight: 700;
        text-anchor: middle;
      }
      .ring-label {
        margin-top: 4px;
        font-size: 0.8em;
        color: var(--vscode-descriptionForeground);
      }

      /* Task checklist */
      .task-list { padding: 4px 0; }
      .task-item {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 3px 0;
        font-size: 0.85em;
        cursor: pointer;
        line-height: 1.3;
      }
      .task-item.done span { text-decoration: line-through; opacity: 0.5; }
      .task-item input[type="checkbox"] {
        margin-top: 2px;
        flex-shrink: 0;
        accent-color: #4CAF50;
      }
    </style>`;
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface PhaseProgress {
  type: string;
  status: string;
  hasFile: boolean;
}

interface TaskItem {
  line: number;
  text: string;
  done: boolean;
}

interface SpecProgress {
  name: string;
  phases: PhaseProgress[];
  taskStats: { total: number; completed: number };
  tasks: TaskItem[];
  tasksFilePath?: string;
}

interface ProgressData {
  specs: SpecProgress[];
  hasConstitution: boolean;
}
