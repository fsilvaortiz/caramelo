import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SPECS_DIR_NAME, PHASE_FILES } from '../../constants.js';

export class DagView {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly workspaceUri: vscode.Uri | undefined) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'caramelo.dag',
      'Workflow Map',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'openFile' && msg.path) {
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
      }
    });

    this.refresh();

    // Auto-refresh
    if (this.workspaceUri) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.workspaceUri, `${SPECS_DIR_NAME}/**`)
      );
      watcher.onDidChange(() => this.refresh());
      watcher.onDidCreate(() => this.refresh());
      watcher.onDidDelete(() => this.refresh());
    }
  }

  private refresh(): void {
    if (!this.panel) return;
    const data = this.gatherData();
    this.panel.webview.html = this.getHtml(data);
  }

  private gatherData(): DagData {
    const data: DagData = { hasConstitution: false, specs: [] };
    if (!this.workspaceUri) return data;

    const constitutionPath = path.join(this.workspaceUri.fsPath, '.specify', 'memory', 'constitution.md');
    if (fs.existsSync(constitutionPath)) {
      const content = fs.readFileSync(constitutionPath, 'utf-8');
      data.hasConstitution = !content.includes('[PRINCIPLE_1_NAME]');
    }

    const specsRoot = path.join(this.workspaceUri.fsPath, SPECS_DIR_NAME);
    if (!fs.existsSync(specsRoot)) return data;

    const entries = fs.readdirSync(specsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const specDir = path.join(specsRoot, entry.name);
      const metaPath = path.join(specDir, '.caramelo-meta.json');

      let statuses: Record<string, string> = {};
      try { statuses = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).phases ?? {}; } catch { /* */ }

      const phases: Array<{ type: string; status: string; filePath: string }> = [];
      for (const [type, fileName] of Object.entries(PHASE_FILES)) {
        const filePath = path.join(specDir, fileName);
        let status = statuses[type] ?? 'pending';
        if (status === 'pending' && fs.existsSync(filePath)) status = 'pending-approval';
        phases.push({ type, status, filePath });
      }

      // Count tasks
      let tasksDone = 0, tasksTotal = 0;
      const tasksPath = path.join(specDir, PHASE_FILES.tasks);
      if (fs.existsSync(tasksPath)) {
        const content = fs.readFileSync(tasksPath, 'utf-8');
        for (const line of content.split('\n')) {
          const t = line.trimStart();
          if (/^- \[ \] /.test(t)) tasksTotal++;
          else if (/^- \[x\] /i.test(t)) { tasksTotal++; tasksDone++; }
        }
      }

      data.specs.push({ name: entry.name, phases, tasksDone, tasksTotal });
    }
    return data;
  }

  private getHtml(data: DagData): string {
    const constitutionColor = data.hasConstitution ? '#4CAF50' : '#9E9E9E';
    const constitutionLabel = data.hasConstitution ? '✓ Constitution' : '○ Constitution';

    const specNodes = data.specs.map((spec, si) => {
      const phaseNodes = spec.phases.map((p, pi) => {
        const color = statusColor(p.status);
        const icon = statusIcon(p.status);
        const label = p.type.charAt(0).toUpperCase() + p.type.slice(1);
        const x = 350 + pi * 180;
        const y = 80 + si * 120;
        return { x, y, color, icon, label, filePath: p.filePath, status: p.status };
      });

      const taskLabel = spec.tasksTotal > 0 ? ` (${spec.tasksDone}/${spec.tasksTotal})` : '';

      return { name: spec.name, y: 80 + si * 120, phases: phaseNodes, taskLabel };
    }).filter(Boolean);

    const svgHeight = Math.max(200, 80 + data.specs.length * 120 + 40);

    const nodesSvg = specNodes.map((spec) => {
      const featureX = 160;
      const featureY = spec.y;

      let svg = `
        <g class="node feature" transform="translate(${featureX},${featureY})">
          <rect x="-70" y="-18" width="140" height="36" rx="6" fill="var(--vscode-editor-background)" stroke="var(--vscode-widget-border)" stroke-width="1.5"/>
          <text text-anchor="middle" dy="5" fill="var(--vscode-foreground)" font-size="11" font-weight="600">${spec.name}${spec.taskLabel}</text>
        </g>`;

      // Edge from constitution to feature
      svg += `<line x1="70" y1="50" x2="${featureX - 70}" y2="${featureY}" stroke="var(--vscode-widget-border)" stroke-width="1.5" stroke-dasharray="4"/>`;

      // Phase nodes + edges
      let prevX = featureX + 70;
      for (const phase of spec.phases) {
        svg += `<line x1="${prevX}" y1="${featureY}" x2="${phase.x - 55}" y2="${phase.y}" stroke="var(--vscode-widget-border)" stroke-width="1.5"/>`;
        svg += `
          <g class="node phase" data-path="${phase.filePath}" onclick="openFile('${phase.filePath.replace(/'/g, "\\'")}')" style="cursor:pointer">
            <rect x="${phase.x - 55}" y="${phase.y - 18}" width="110" height="36" rx="6" fill="${phase.color}" opacity="0.15" stroke="${phase.color}" stroke-width="2"/>
            <text x="${phase.x}" y="${phase.y + 1}" text-anchor="middle" dy="4" fill="${phase.color}" font-size="10" font-weight="600">${phase.icon} ${phase.label}</text>
          </g>`;
        prevX = phase.x + 55;
      }

      return svg;
    }).join('');

    return `<!DOCTYPE html>
<html><head>
<style>
  body { margin: 0; padding: 16px; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); overflow: auto; }
  h2 { margin: 0 0 16px; font-size: 1.2em; }
  svg { display: block; }
  .node:hover rect { stroke-width: 3; }
  .legend { display: flex; gap: 16px; margin-top: 12px; font-size: 11px; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
</style>
</head><body>
<h2>Workflow Map</h2>
<svg width="900" height="${svgHeight}" viewBox="0 0 900 ${svgHeight}">
  <!-- Constitution node -->
  <g class="node constitution" transform="translate(0, 32)">
    <rect x="0" y="0" width="140" height="36" rx="6" fill="${constitutionColor}" opacity="0.15" stroke="${constitutionColor}" stroke-width="2"/>
    <text x="70" y="22" text-anchor="middle" fill="${constitutionColor}" font-size="11" font-weight="600">${constitutionLabel}</text>
  </g>
  ${nodesSvg}
</svg>
<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#9E9E9E"></div> Pending</div>
  <div class="legend-item"><div class="legend-dot" style="background:#2196F3"></div> Review</div>
  <div class="legend-item"><div class="legend-dot" style="background:#4CAF50"></div> Approved</div>
  <div class="legend-item"><div class="legend-dot" style="background:#FF9800"></div> Generating</div>
  <div class="legend-item"><div class="legend-dot" style="background:#FFC107"></div> Stale</div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  function openFile(path) { vscode.postMessage({ command: 'openFile', path }); }
</script>
</body></html>`;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'approved': return '#4CAF50';
    case 'pending-approval': return '#2196F3';
    case 'generating': return '#FF9800';
    case 'stale': return '#FFC107';
    default: return '#9E9E9E';
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'approved': return '✓';
    case 'pending-approval': return '●';
    case 'generating': return '⟳';
    case 'stale': return '⚠';
    default: return '○';
  }
}

interface DagData {
  hasConstitution: boolean;
  specs: Array<{
    name: string;
    phases: Array<{ type: string; status: string; filePath: string }>;
    tasksDone: number;
    tasksTotal: number;
  }>;
}
