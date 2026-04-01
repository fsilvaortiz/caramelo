import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ConstitutionTreeDataProvider } from '../views/sidebar/constitution-tree.js';

export function editConstitution(
  context: vscode.ExtensionContext,
  constitutionTree: ConstitutionTreeDataProvider
): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('No workspace folder open');
    return;
  }

  const constitutionPath = path.join(workspaceFolder.uri.fsPath, '.specify', 'memory', 'constitution.md');
  const existing = loadExistingConstitution(constitutionPath);

  const panel = vscode.window.createWebviewPanel(
    'caramelo.constitution',
    'Project Constitution',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = getWebviewContent(existing);

  panel.webview.onDidReceiveMessage(
    (message) => {
      if (message.command === 'save') {
        saveConstitution(constitutionPath, message.data);
        constitutionTree.refresh();
        vscode.window.showInformationMessage('Constitution saved!');
        panel.dispose();
      }
    },
    undefined,
    context.subscriptions
  );
}

interface ConstitutionData {
  projectName: string;
  principles: Array<{ name: string; description: string }>;
  constraints: string;
  workflow: string;
}

function loadExistingConstitution(filePath: string): ConstitutionData {
  const data: ConstitutionData = {
    projectName: '',
    principles: [{ name: '', description: '' }],
    constraints: '',
    workflow: '',
  };

  if (!fs.existsSync(filePath)) return data;

  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes('[PRINCIPLE_1_NAME]')) return data; // Template, treat as empty

  // Parse existing constitution
  const nameMatch = content.match(/^# (.+?) Constitution/m);
  if (nameMatch) data.projectName = nameMatch[1];

  const principles: Array<{ name: string; description: string }> = [];
  const principleRegex = /### (.+?)\n([\s\S]*?)(?=\n### |\n## |$)/g;
  let match;
  while ((match = principleRegex.exec(content)) !== null) {
    const name = match[1].trim();
    const desc = match[2].trim().replace(/<!--[\s\S]*?-->/g, '').trim();
    if (name && desc) principles.push({ name, description: desc });
  }
  if (principles.length > 0) data.principles = principles;

  return data;
}

function saveConstitution(filePath: string, data: ConstitutionData): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const principles = data.principles
    .filter((p) => p.name.trim() && p.description.trim())
    .map((p, i) => `### ${i + 1}. ${p.name}\n\n${p.description}`)
    .join('\n\n');

  const sections = [`# ${data.projectName || 'Project'} Constitution\n\n## Core Principles\n\n${principles}`];

  if (data.constraints?.trim()) {
    sections.push(`## Constraints\n\n${data.constraints.trim()}`);
  }

  if (data.workflow?.trim()) {
    sections.push(`## Development Workflow\n\n${data.workflow.trim()}`);
  }

  sections.push(`\n**Version**: 1.0 | **Ratified**: ${new Date().toISOString().split('T')[0]}`);

  fs.writeFileSync(filePath, sections.join('\n\n'), 'utf-8');
}

function getWebviewContent(data: ConstitutionData): string {
  const principlesHtml = data.principles
    .map(
      (p, i) => `
      <div class="principle" data-index="${i}">
        <div class="principle-header">
          <span class="principle-number">${i + 1}</span>
          <input type="text" class="principle-name" placeholder="Principle name (e.g., Test-First, Simplicity)" value="${escapeHtml(p.name)}" />
          <button class="btn-remove" onclick="removePrinciple(${i})" title="Remove">×</button>
        </div>
        <textarea class="principle-desc" placeholder="Describe this principle. What rules does it enforce? What should developers always/never do?">${escapeHtml(p.description)}</textarea>
      </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 24px;
      max-width: 720px;
      margin: 0 auto;
    }
    h1 { font-size: 1.6em; margin-bottom: 4px; }
    .subtitle { color: var(--vscode-descriptionForeground, #888); margin-bottom: 24px; font-size: 0.9em; }
    label { display: block; font-weight: 600; margin: 16px 0 6px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground, #999); }
    input[type="text"], textarea {
      width: 100%;
      padding: 8px 12px;
      background: var(--vscode-input-background, #333);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      font-family: inherit;
      font-size: 0.95em;
    }
    input[type="text"]:focus, textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder, #007acc);
    }
    textarea { min-height: 80px; resize: vertical; }
    .section { margin-bottom: 24px; }
    .principle {
      background: var(--vscode-editor-inactiveSelectionBackground, #2a2a2a);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .principle-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .principle-number {
      background: var(--vscode-badge-background, #007acc);
      color: var(--vscode-badge-foreground, #fff);
      width: 24px; height: 24px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.8em; font-weight: 600;
      flex-shrink: 0;
    }
    .principle-name { flex: 1; font-weight: 600; }
    .principle-desc { margin-top: 4px; }
    .btn-remove {
      background: none; border: none; color: var(--vscode-errorForeground, #f44); cursor: pointer;
      font-size: 1.4em; padding: 0 4px; line-height: 1; opacity: 0.6;
    }
    .btn-remove:hover { opacity: 1; }
    .btn-add {
      background: none;
      border: 1px dashed var(--vscode-input-border, #555);
      color: var(--vscode-descriptionForeground, #888);
      padding: 10px;
      border-radius: 6px;
      width: 100%;
      cursor: pointer;
      font-size: 0.9em;
      margin-top: 4px;
    }
    .btn-add:hover { border-color: var(--vscode-focusBorder, #007acc); color: var(--vscode-foreground, #ccc); }
    .actions { margin-top: 32px; display: flex; gap: 12px; }
    .btn-save {
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 10px 24px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 1em;
      font-weight: 600;
    }
    .btn-save:hover { background: var(--vscode-button-hoverBackground, #005a9e); }
    .hint { color: var(--vscode-descriptionForeground, #777); font-size: 0.82em; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>Project Constitution</h1>
  <p class="subtitle">Define the non-negotiable principles that guide all development in this project. These will be used as context when generating specs.</p>

  <div class="section">
    <label>Project Name</label>
    <input type="text" id="projectName" placeholder="e.g., Caramelo" value="${escapeHtml(data.projectName)}" />
  </div>

  <div class="section">
    <label>Core Principles</label>
    <p class="hint">What rules should always be followed? (e.g., "Test-First: TDD mandatory", "Simplicity: YAGNI, start simple")</p>
    <div id="principles">${principlesHtml}</div>
    <button class="btn-add" onclick="addPrinciple()">+ Add Principle</button>
  </div>

  <div class="section">
    <label>Constraints (optional)</label>
    <textarea id="constraints" placeholder="Technology constraints, compliance requirements, performance standards...">${escapeHtml(data.constraints)}</textarea>
  </div>

  <div class="section">
    <label>Development Workflow (optional)</label>
    <textarea id="workflow" placeholder="Code review requirements, testing gates, deployment process...">${escapeHtml(data.workflow)}</textarea>
  </div>

  <div class="actions">
    <button class="btn-save" onclick="save()">Save Constitution</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function addPrinciple() {
      const container = document.getElementById('principles');
      const index = container.children.length;
      const div = document.createElement('div');
      div.className = 'principle';
      div.dataset.index = index;
      div.innerHTML = \`
        <div class="principle-header">
          <span class="principle-number">\${index + 1}</span>
          <input type="text" class="principle-name" placeholder="Principle name" />
          <button class="btn-remove" onclick="removePrinciple(this)" title="Remove">×</button>
        </div>
        <textarea class="principle-desc" placeholder="Describe this principle..."></textarea>
      \`;
      container.appendChild(div);
      renumber();
    }

    function removePrinciple(el) {
      const principle = typeof el === 'number'
        ? document.querySelector('.principle[data-index="' + el + '"]')
        : el.closest('.principle');
      if (principle && document.querySelectorAll('.principle').length > 1) {
        principle.remove();
        renumber();
      }
    }

    function renumber() {
      document.querySelectorAll('.principle').forEach((el, i) => {
        el.dataset.index = i;
        el.querySelector('.principle-number').textContent = i + 1;
      });
    }

    function save() {
      const principles = [];
      document.querySelectorAll('.principle').forEach(el => {
        principles.push({
          name: el.querySelector('.principle-name').value,
          description: el.querySelector('.principle-desc').value
        });
      });

      vscode.postMessage({
        command: 'save',
        data: {
          projectName: document.getElementById('projectName').value,
          principles,
          constraints: document.getElementById('constraints').value,
          workflow: document.getElementById('workflow').value
        }
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
