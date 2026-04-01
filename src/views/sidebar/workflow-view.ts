import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SPECS_DIR_NAME, PHASE_FILES, COMMAND_IDS } from '../../constants.js';

export class WorkflowViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'caramelo.workflow';
  private view?: vscode.WebviewView;
  private workspaceUri: vscode.Uri | undefined;
  private onSpecCreatedCallback?: (name: string) => void;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;

    if (this.workspaceUri) {
      const pattern = new vscode.RelativePattern(this.workspaceUri, `**/.specify/**`);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(() => this.refresh());
      watcher.onDidCreate(() => this.refresh());
      watcher.onDidDelete(() => this.refresh());
    }

    vscode.workspace.onDidSaveTextDocument(() => this.refresh());
  }

  onSpecCreated(cb: (name: string) => void): void {
    this.onSpecCreatedCallback = cb;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg.command) {
        case 'openConstitution':
          vscode.commands.executeCommand(COMMAND_IDS.editConstitution);
          break;
        case 'createSpec':
          this.handleCreateSpec(msg.name, msg.description);
          break;
        case 'runPhase':
          vscode.commands.executeCommand(COMMAND_IDS.runPhase, msg.specName, msg.phaseType);
          break;
        case 'approvePhase':
          vscode.commands.executeCommand(COMMAND_IDS.approvePhase, msg.specName, msg.phaseType);
          setTimeout(() => this.refresh(), 300);
          break;
        case 'openFile':
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
          break;
        case 'toggleTask':
          this.toggleTask(msg.filePath, msg.line, msg.done);
          break;
        case 'runAllTasks':
          if (msg.path) {
            vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path)).then(() => {
              setTimeout(() => vscode.commands.executeCommand('caramelo.runAllTasks'), 500);
            });
          }
          break;
        case 'createSpecFromJira':
          vscode.commands.executeCommand('caramelo.createSpecFromJira');
          setTimeout(() => this.refresh(), 500);
          break;
        case 'openExternal':
          if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
        case 'openDag':
          vscode.commands.executeCommand('caramelo.openDag');
          break;
      }
    });

    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    this.view.webview.html = this.getHtml();
  }

  private handleCreateSpec(name: string, description: string): void {
    if (!this.workspaceUri) return;
    if (!this.hasConstitution()) {
      vscode.window.showErrorMessage('Set up a Constitution first.', 'Set Up').then((a) => {
        if (a) vscode.commands.executeCommand(COMMAND_IDS.editConstitution);
      });
      return;
    }
    const specsRoot = path.join(this.workspaceUri.fsPath, SPECS_DIR_NAME);
    if (!fs.existsSync(specsRoot)) fs.mkdirSync(specsRoot, { recursive: true });
    const specDir = path.join(specsRoot, name);
    if (!fs.existsSync(specDir)) fs.mkdirSync(specDir, { recursive: true });
    const metaPath = path.join(specDir, '.caramelo-meta.json');
    if (!fs.existsSync(metaPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({ phases: { requirements: 'pending', design: 'pending', tasks: 'pending' } }, null, 2));
    }
    this.refresh();
    this.onSpecCreatedCallback?.(name);
    vscode.window.showInformationMessage(`Spec "${name}" created.`, 'Generate Requirements').then((a) => {
      if (a) vscode.commands.executeCommand(COMMAND_IDS.runPhase, name, 'requirements');
    });
  }

  private toggleTask(filePath: string, lineNumber: number, done: boolean): void {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    if (lineNumber >= lines.length) return;
    lines[lineNumber] = done
      ? lines[lineNumber].replace('- [ ]', '- [x]')
      : lines[lineNumber].replace(/- \[x\]/i, '- [ ]');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    this.refresh();
  }

  private hasConstitution(): boolean {
    if (!this.workspaceUri) return false;
    const p = path.join(this.workspaceUri.fsPath, '.specify', 'memory', 'constitution.md');
    if (!fs.existsSync(p)) return false;
    return !fs.readFileSync(p, 'utf-8').includes('[PRINCIPLE_1_NAME]');
  }

  private getHtml(): string {
    const hasCon = this.hasConstitution();
    const specs = this.getSpecs();

    return `<!DOCTYPE html><html><head>${STYLES}</head><body>

    ${this.renderConstitution(hasCon)}
    ${this.renderNewSpecForm(hasCon)}
    ${specs.length === 0 ? '<div class="empty-hint">No specs yet. Create one above.</div>' : ''}
    ${specs.map((s) => this.renderSpecCard(s)).join('')}

    ${SCRIPT}
    </body></html>`;
  }

  private renderConstitution(has: boolean): string {
    if (has) {
      return `<div class="constitution ok" onclick="msg('openConstitution')">
        <span class="con-icon">✓</span>
        <span>Constitution</span>
        <span class="con-edit">Edit</span>
      </div>`;
    }
    return `<div class="constitution warn" onclick="msg('openConstitution')">
      <span class="con-icon">⚠</span>
      <span>Set up Constitution to begin</span>
      <span class="con-edit">→</span>
    </div>`;
  }

  private renderNewSpecForm(hasCon: boolean): string {
    if (!hasCon) return '';
    return `<div class="new-spec">
      <div class="new-spec-toggle" onclick="toggle('newSpecBody')">
        <span>＋ New Spec</span>
      </div>
      <div id="newSpecBody" style="display:none" class="new-spec-body">
        <input id="specName" class="input" placeholder="feature-name" onkeydown="if(event.key==='Enter')createSpec()" />
        <textarea id="specDesc" class="input textarea" placeholder="Brief description..."></textarea>
        <button class="btn-primary" onclick="createSpec()">Create</button>
        ${this.hasJiraProvider() ? '<button class="btn-jira" onclick="msg(\'createSpecFromJira\')">From Jira</button>' : ''}
      </div>
    </div>`;
  }

  private hasJiraProvider(): boolean {
    const configs = vscode.workspace.getConfiguration().get<Array<{ type: string }>>('caramelo.providers') ?? [];
    return configs.some((c) => c.type === 'jira');
  }

  private renderSpecCard(spec: SpecData): string {
    const phasePercent = Math.round((spec.approvedCount / 3) * 100);
    const taskPercent = spec.taskStats.total > 0
      ? Math.round((spec.taskStats.completed / spec.taskStats.total) * 100) : -1;

    // Overall progress: phases = 50%, tasks = 50%
    // If no tasks exist yet, phases = 100% of progress
    let overallPercent: number;
    if (spec.taskStats.total > 0) {
      overallPercent = Math.round((phasePercent * 0.5) + (taskPercent * 0.5));
    } else {
      // Cap at 80% until tasks are generated and being worked on
      overallPercent = Math.min(Math.round((spec.approvedCount / 3) * 80), 80);
    }

    const phasesHtml = spec.phases.map((p) => {
      const cls = `phase-step ${p.status}`;
      const icon = { pending: '○', generating: '⟳', 'pending-approval': '●', approved: '✓', stale: '⚠' }[p.status] || '○';
      const label = p.type.charAt(0).toUpperCase() + p.type.slice(1);

      let action = '';
      const fileExists = fs.existsSync(p.filePath);
      if (p.status === 'pending' && p.unlocked && !fileExists) {
        action = `<button class="phase-btn generate" onclick="msg('runPhase',{specName:'${spec.name}',phaseType:'${p.type}'})">Generate</button>`;
      } else if (p.status === 'pending' && p.unlocked && fileExists) {
        // Failed/partial generation — show both Open and Regenerate
        action = `
          <button class="phase-btn regenerate" onclick="msg('runPhase',{specName:'${spec.name}',phaseType:'${p.type}'})">Retry</button>
          <button class="phase-btn-sm" onclick="msg('openFile',{path:'${esc(p.filePath)}'})">Open</button>`;
      } else if (p.status === 'generating') {
        action = `<span class="phase-generating-text">Generating...</span>`;
      } else if (p.status === 'pending-approval') {
        const hasPendingTasksReview = p.type === 'tasks' && spec.taskStats.total > 0 && spec.taskStats.completed < spec.taskStats.total;
        action = `
          <button class="phase-btn approve" onclick="msg('approvePhase',{specName:'${spec.name}',phaseType:'${p.type}'})">Approve</button>
          ${hasPendingTasksReview ? `<button class="phase-btn implement" onclick="msg('runAllTasks',{path:'${esc(p.filePath)}'})">▶ Run</button>` : ''}
          <button class="phase-btn-sm" onclick="msg('openFile',{path:'${esc(p.filePath)}'})">Open</button>`;
      } else if (p.status === 'approved') {
        const hasPendingTasks = p.type === 'tasks' && spec.taskStats.total > 0 && spec.taskStats.completed < spec.taskStats.total;
        const allTasksDone = p.type === 'tasks' && spec.taskStats.total > 0 && spec.taskStats.completed === spec.taskStats.total;
        action = `
          ${hasPendingTasks ? `<button class="phase-btn implement" onclick="msg('runAllTasks',{path:'${esc(p.filePath)}'})">▶ Implement</button>` : ''}
          ${allTasksDone ? '<span class="phase-done-text">✓ Done</span>' : ''}
          <button class="phase-btn-sm" onclick="msg('openFile',{path:'${esc(p.filePath)}'})">Open</button>
          <button class="phase-btn-sm" onclick="msg('runPhase',{specName:'${spec.name}',phaseType:'${p.type}'})">⟳</button>`;
      } else if (p.status === 'stale') {
        action = `<button class="phase-btn regenerate" onclick="msg('runPhase',{specName:'${spec.name}',phaseType:'${p.type}'})">Regenerate</button>`;
      }

      // Sub-artifacts for any phase
      let artifacts = '';
      if (p.artifacts.length > 0) {
        artifacts = `<div class="artifacts-list">${p.artifacts.map((a) =>
          `<div class="artifact-item">
            <span class="artifact-icon">📄</span>
            <span class="artifact-name" onclick="msg('openFile',{path:'${esc(a.path)}'})">${a.name}</span>
            <button class="artifact-btn" onclick="msg('openFile',{path:'${esc(a.path)}'})">Open</button>
          </div>`
        ).join('')}</div>`;
      }

      return `<div class="${cls}">
        <div class="phase-header">
          <span class="phase-icon">${icon}</span>
          <span class="phase-label">${label}</span>
          <div class="phase-actions">${action}</div>
        </div>
        ${artifacts}
      </div>`;
    }).join('');

    // Task section
    let tasksHtml = '';
    if (spec.taskStats.total > 0) {
      const barWidth = taskPercent;
      tasksHtml = `
        <div class="task-section">
          <div class="task-header" onclick="toggle('tasks-${spec.name}')">
            <span>Tasks</span>
            <span class="task-count">${spec.taskStats.completed}/${spec.taskStats.total}</span>
            <div class="task-bar"><div class="task-bar-fill" style="width:${barWidth}%"></div></div>
          </div>
          <div id="tasks-${spec.name}" style="display:none" class="task-list">
            ${spec.tasks.slice(0, 40).map((t) => `
              <label class="task-item ${t.done ? 'done' : ''}">
                <input type="checkbox" ${t.done ? 'checked' : ''}
                  onchange="msg('toggleTask',{filePath:'${esc(spec.tasksFilePath!)}',line:${t.line},done:this.checked})" />
                <span>${escHtml(t.text.slice(0, 80))}</span>
              </label>`).join('')}
          </div>
        </div>`;
    }

    // Progress ring
    const ringColor = overallPercent === 100 ? '#4CAF50' : overallPercent >= 50 ? '#2196F3' : 'var(--vscode-descriptionForeground)';
    const ringHtml = `<svg viewBox="0 0 36 36" class="ring">
      <circle cx="18" cy="18" r="15.9" class="ring-bg"/>
      <circle cx="18" cy="18" r="15.9" class="ring-fill" style="stroke:${ringColor}" stroke-dasharray="${overallPercent} 100"/>
      <text x="18" y="21" class="ring-text">${overallPercent}%</text>
    </svg>`;

    // Check for Jira link
    const meta = this.readMeta(path.join(this.workspaceUri!.fsPath, SPECS_DIR_NAME, spec.name));
    const jiraBadge = meta.jira
      ? `<span class="jira-badge" onclick="msg('openExternal',{url:'${esc(meta.jira.url)}'})">${escHtml(meta.jira.key)}</span>`
      : '';

    return `<div class="spec-card">
      <div class="spec-top">
        <div class="spec-name">${spec.name} ${jiraBadge}</div>
        ${ringHtml}
      </div>
      <div class="phases">${phasesHtml}</div>
      ${tasksHtml}
    </div>`;
  }

  private getSpecs(): SpecData[] {
    if (!this.workspaceUri) return [];
    const specsRoot = path.join(this.workspaceUri.fsPath, SPECS_DIR_NAME);
    if (!fs.existsSync(specsRoot)) return [];

    return fs.readdirSync(specsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = path.join(specsRoot, e.name);
        const metaData = this.readMeta(dir);
        let approvedCount = 0;

        const phases: PhaseData[] = (['requirements', 'design', 'tasks'] as const).map((type, i) => {
          let status = metaData.phases[type] ?? 'pending';
          const filePath = path.join(dir, PHASE_FILES[type]);
          const fileExists = fs.existsSync(filePath);
          if (status === 'pending' && fileExists && fs.readFileSync(filePath, 'utf-8').trim().length > 0) {
            status = 'pending-approval';
          }
          if (status === 'approved') approvedCount++;
          const unlocked = i === 0 || metaData.phases[(['requirements', 'design', 'tasks'] as const)[i - 1]] === 'approved';

          // Get artifacts per phase
          const artifacts: { name: string; path: string }[] = [];
          const artifactMap: Record<string, string[]> = {
            requirements: ['jira-context.md'],
            design: ['research.md', 'data-model.md'],
            tasks: ['analysis.md'],
          };
          for (const af of (artifactMap[type] ?? [])) {
            const ap = path.join(dir, af);
            if (fs.existsSync(ap)) artifacts.push({ name: af, path: ap });
          }
          // Check contracts/ directory for design phase
          if (type === 'design') {
            const contractsDir = path.join(dir, 'contracts');
            if (fs.existsSync(contractsDir)) {
              const cFiles = fs.readdirSync(contractsDir).filter((f) => f.endsWith('.md'));
              for (const cf of cFiles) {
                artifacts.push({ name: `contracts/${cf}`, path: path.join(contractsDir, cf) });
              }
            }
          }
          // Check checklists/ for any phase
          const checklistPath = path.join(dir, 'checklists', `${type}.md`);
          if (fs.existsSync(checklistPath)) {
            artifacts.push({ name: `checklist`, path: checklistPath });
          }

          return { type, status, filePath, unlocked, artifacts };
        });

        // Parse tasks
        const tasks: TaskItem[] = [];
        const taskStats = { total: 0, completed: 0 };
        const tasksPath = path.join(dir, PHASE_FILES.tasks);
        let tasksFilePath: string | undefined;
        if (fs.existsSync(tasksPath)) {
          tasksFilePath = tasksPath;
          const lines = fs.readFileSync(tasksPath, 'utf-8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trimStart();
            if (/^- \[ \] /.test(t)) {
              taskStats.total++;
              tasks.push({ line: i, text: t.replace(/^- \[ \] /, ''), done: false });
            } else if (/^- \[x\] /i.test(t)) {
              taskStats.total++; taskStats.completed++;
              tasks.push({ line: i, text: t.replace(/^- \[x\] /i, ''), done: true });
            }
          }
        }

        return { name: e.name, phases, approvedCount, taskStats, tasks, tasksFilePath };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private readMeta(dir: string): { phases: Record<string, string>; jira?: { key: string; url: string; boardName: string } } {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, '.caramelo-meta.json'), 'utf-8'));
      return { phases: raw.phases ?? {}, jira: raw.jira };
    } catch { return { phases: {} }; }
  }
}

function esc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function escHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

interface TaskItem { line: number; text: string; done: boolean; }
interface PhaseData { type: string; status: string; filePath: string; unlocked: boolean; artifacts: { name: string; path: string }[]; }
interface SpecData { name: string; phases: PhaseData[]; approvedCount: number; taskStats: { total: number; completed: number }; tasks: TaskItem[]; tasksFilePath?: string; }

const SCRIPT = `<script>
const vscode = acquireVsCodeApi();
function msg(cmd, data) { vscode.postMessage({ command: cmd, ...data }); }
function toggle(id) {
  const el = document.getElementById(id);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function createSpec() {
  const name = document.getElementById('specName').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const desc = document.getElementById('specDesc').value.trim();
  if (!name) { document.getElementById('specName').style.borderColor = '#f44'; return; }
  msg('createSpec', { name, description: desc || name });
  document.getElementById('specName').value = '';
  document.getElementById('specDesc').value = '';
  document.getElementById('newSpecBody').style.display = 'none';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'specName') createSpec(); });
</script>`;

const STYLES = `<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; padding: 6px; font-size: 12px; }

/* Constitution */
.constitution {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 6px; cursor: pointer;
  margin-bottom: 8px; font-size: 0.9em; font-weight: 500;
}
.constitution.ok { background: rgba(76,175,80,0.08); border: 1px solid rgba(76,175,80,0.25); }
.constitution.ok .con-icon { color: #4CAF50; }
.constitution.warn { background: rgba(255,193,7,0.08); border: 1px solid rgba(255,193,7,0.3); }
.constitution.warn .con-icon { color: #FFC107; }
.constitution:hover { opacity: 0.85; }
.con-edit { margin-left: auto; opacity: 0.5; font-size: 0.85em; }

/* New Spec */
.new-spec { margin-bottom: 8px; }
.new-spec-toggle {
  padding: 7px 10px; border-radius: 6px; cursor: pointer;
  border: 1px dashed var(--vscode-widget-border, rgba(255,255,255,0.15));
  text-align: center; font-size: 0.9em; color: var(--vscode-descriptionForeground);
}
.new-spec-toggle:hover { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
.new-spec-body { padding: 8px 0 0; }
.input {
  width: 100%; padding: 5px 8px; margin-bottom: 6px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #555); border-radius: 4px;
  font-family: inherit; font-size: 0.9em;
}
.input:focus { outline: none; border-color: var(--vscode-focusBorder); }
.textarea { min-height: 40px; resize: vertical; }
.btn-primary {
  width: 100%; padding: 6px; border: none; border-radius: 4px; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  font-weight: 600; font-size: 0.9em;
}
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }

.empty-hint { text-align: center; padding: 16px 8px; opacity: 0.5; font-size: 0.9em; }

/* Spec Card */
.spec-card {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
  border-radius: 8px; padding: 10px; margin-bottom: 8px;
}
.spec-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.spec-name { font-weight: 700; font-size: 1em; }

/* Progress Ring */
.ring { width: 38px; height: 38px; flex-shrink: 0; }
.ring-bg { fill: none; stroke: var(--vscode-widget-border, rgba(255,255,255,0.1)); stroke-width: 3; }
.ring-fill {
  fill: none; stroke: #4CAF50; stroke-width: 3; stroke-linecap: round;
  transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dasharray 0.5s;
}
.ring-text { fill: var(--vscode-foreground); font-size: 9px; font-weight: 700; text-anchor: middle; }

/* Phases */
.phases { display: flex; flex-direction: column; gap: 4px; }
.phase-step { padding: 5px 8px; border-radius: 5px; border-left: 3px solid transparent; }
.phase-step.approved { border-left-color: #4CAF50; background: rgba(76,175,80,0.06); }
.phase-step.pending-approval { border-left-color: #2196F3; background: rgba(33,150,243,0.06); }
.phase-step.generating { border-left-color: #FF9800; background: rgba(255,152,0,0.06); }
.phase-step.stale { border-left-color: #FFC107; background: rgba(255,193,7,0.06); }
.phase-step.pending { border-left-color: var(--vscode-widget-border, #555); opacity: 0.6; }

.phase-header { display: flex; align-items: center; gap: 6px; }
.phase-icon { font-size: 0.9em; flex-shrink: 0; width: 14px; text-align: center; }
.phase-label { font-weight: 500; font-size: 0.85em; flex: 1; }
.phase-actions { display: flex; gap: 4px; }
.phase-btn, .phase-btn-sm {
  border: none; border-radius: 3px; cursor: pointer; font-size: 0.75em; font-weight: 600; padding: 2px 8px;
}
.phase-btn.generate { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.phase-btn.approve { background: #4CAF50; color: white; }
.phase-btn.regenerate { background: #FFC107; color: #333; }
.phase-btn.implement { background: #4CAF50; color: white; }
.phase-done-text { font-size: 0.75em; color: #4CAF50; font-weight: 600; }
.phase-btn-sm { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border, #555); }
.phase-btn:hover, .phase-btn-sm:hover { opacity: 0.8; }
.phase-generating-text { font-size: 0.75em; color: #FF9800; font-weight: 500; animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.artifacts-list { margin: 4px 0 0 20px; }
.artifact-item {
  display: flex; align-items: center; gap: 4px; padding: 2px 0; font-size: 0.8em;
}
.artifact-icon { font-size: 0.9em; flex-shrink: 0; }
.artifact-name {
  flex: 1; cursor: pointer; color: var(--vscode-textLink-foreground);
}
.artifact-name:hover { text-decoration: underline; }
.artifact-btn {
  border: none; background: transparent; color: var(--vscode-descriptionForeground);
  font-size: 0.75em; cursor: pointer; padding: 1px 4px; border-radius: 2px;
  border: 1px solid var(--vscode-widget-border, #555);
}
.artifact-btn:hover { color: var(--vscode-foreground); }

/* Tasks */
.task-section { margin-top: 6px; border-top: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.08)); padding-top: 6px; }
.task-header {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  font-size: 0.8em; font-weight: 500; color: var(--vscode-descriptionForeground);
}
.task-count { font-weight: 700; color: var(--vscode-foreground); }
.task-bar { flex: 1; height: 4px; background: var(--vscode-widget-border, rgba(255,255,255,0.1)); border-radius: 2px; overflow: hidden; }
.task-bar-fill { height: 100%; background: #4CAF50; border-radius: 2px; transition: width 0.3s; }
.task-list { padding: 4px 0; max-height: 200px; overflow-y: auto; }
.task-item {
  display: flex; align-items: flex-start; gap: 5px; padding: 2px 0;
  font-size: 0.8em; cursor: pointer; line-height: 1.3;
}
.task-item.done span { text-decoration: line-through; opacity: 0.4; }
.task-item input[type="checkbox"] { margin-top: 2px; flex-shrink: 0; accent-color: #4CAF50; }

/* Jira */
.jira-badge {
  display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7em; font-weight: 600;
  background: #0052CC; color: white; cursor: pointer; margin-left: 4px; vertical-align: middle;
}
.jira-badge:hover { background: #0065FF; }
.btn-jira {
  width: 100%; padding: 6px; margin-top: 4px; border: 1px solid #0052CC; border-radius: 4px;
  background: transparent; color: #0052CC; cursor: pointer; font-size: 0.9em; font-weight: 600;
}
.btn-jira:hover { background: rgba(0,82,204,0.1); }
</style>`;
