import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderRegistry } from '../providers/registry.js';
import { log } from '../utils/log.js';

interface Refreshable { refresh(): void }

export function editConstitution(
  context: vscode.ExtensionContext,
  constitutionTree: Refreshable,
  registry?: ProviderRegistry
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

  panel.webview.html = getWebviewContent(existing, !!registry?.activeProvider);

  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.command === 'save') {
        saveConstitution(constitutionPath, message.data);
        constitutionTree.refresh();
        vscode.window.showInformationMessage('Constitution saved!');
        panel.dispose();
      } else if (message.command === 'generate') {
        await generateWithAI(message.projectDescription, registry, panel);
      }
    },
    undefined,
    context.subscriptions
  );
}

async function generateWithAI(
  projectDescription: string,
  registry: ProviderRegistry | undefined,
  panel: vscode.WebviewPanel
): Promise<void> {
  const provider = registry?.activeProvider;
  if (!provider) {
    vscode.window.showWarningMessage('No active LLM provider. Configure one first.');
    return;
  }

  const systemPrompt =
    'You are helping define a project constitution for a software project. Based on the project description, generate:\n' +
    '\n' +
    '1. A project name (short, 1-3 words)\n' +
    '2. 3-5 core principles (each with a name and a 1-2 sentence description of what it enforces)\n' +
    '3. Key constraints (technology, performance, compliance — if applicable)\n' +
    '4. Development workflow rules (testing, review, deployment — if applicable)\n' +
    '\n' +
    'Output rules — these are NON-NEGOTIABLE and any deviation will fail downstream parsing:\n' +
    '\n' +
    '- Output a SINGLE JSON object. Nothing before it. Nothing after it. No greeting, no explanation, no closing remark.\n' +
    '- The first character of your response MUST be `{`. The last character MUST be `}`.\n' +
    '- Use double-quoted strings only. Inside string values, escape literal double quotes as `\\"` and apostrophes/contractions as plain `\'` (apostrophes do NOT need escaping in JSON).\n' +
    '- No comments. No trailing commas. No markdown fences.\n' +
    '\n' +
    'Schema:\n' +
    '{\n' +
    '  "projectName": "string",\n' +
    '  "principles": [ { "name": "string", "description": "string" } ],\n' +
    '  "constraints": "string (multi-line OK; use \\n)",\n' +
    '  "workflow": "string (multi-line OK; use \\n)"\n' +
    '}';

  panel.webview.postMessage({ command: 'generating' });

  const channel = vscode.window.createOutputChannel('Caramelo');
  channel.show(true);
  channel.appendLine('─'.repeat(50));
  channel.appendLine('▶ Generating constitution...');
  channel.appendLine('─'.repeat(50));

  let response = '';
  try {
    for await (const chunk of provider.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Project description: ${projectDescription}` },
      ],
      // temperature: 0 nudges the model toward deterministic JSON output.
      // Constitution generation is a structured-output task — no creativity
      // benefit, only parser-fragility risk.
      { temperature: 0 },
    )) {
      response += chunk;
      channel.append(chunk);
      panel.webview.postMessage({ command: 'streamChunk', text: chunk });
    }
    channel.appendLine('\n\n✓ Generation complete.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channel.appendLine(`\n\n✗ Error: ${msg}`);
    vscode.window.showErrorMessage(`Generation failed: ${msg}`);
    panel.webview.postMessage({ command: 'generateDone', data: null });
    return;
  }

  // Parse JSON from response — try multiple strategies.
  const data = parseConstitutionResponse(response);
  if (data) {
    panel.webview.postMessage({ command: 'generateDone', data });
  } else {
    // Surface the first 500 bytes of the raw response so the user (or
    // log readers) can see what the model emitted — silent "couldn't
    // parse" used to leave them guessing.
    channel.appendLine('\n\n✗ Parser could not extract a constitution from the response.');
    channel.appendLine(`Raw response (first 500 B): ${response.slice(0, 500)}`);
    log.warn('[edit-constitution] parse failed; first 500 B:', response.slice(0, 500));
    vscode.window.showWarningMessage(
      'Caramelo: could not parse the constitution from the LLM response. ' +
      'See the Caramelo output channel for the raw output. You can fill in the form manually or retry.',
    );
    panel.webview.postMessage({ command: 'generateDone', data: null });
  }
}

/**
 * Try, in order:
 *  1. JSON inside a `\`\`\`json … \`\`\`` fence.
 *  2. The largest balanced `{ … }` substring (handles nested objects
 *     correctly, unlike a greedy regex that would over-match across
 *     unbalanced braces in adjacent prose).
 *  3. Markdown-prose fallback: `### N. Name` headings + paragraphs.
 *
 * Returns `null` if none of the strategies recovers a constitution
 * with at least one principle. Caller surfaces the raw response in the
 * log so the failure isn't invisible.
 */
export function parseConstitutionResponse(response: string): ConstitutionData | null {
  // Strategy 1: ```json … ``` fence.
  const jsonBlockMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    const parsed = tryParseJSON(jsonBlockMatch[1]);
    if (parsed) return normalizeConstitution(parsed);
  }

  // Strategy 2: balanced outermost JSON object. We can't use a greedy
  // regex here — `/\{[\s\S]*\}/` matches from the first `{` to the LAST
  // `}` in the document, so a stray `{}` in surrounding prose pulls in
  // unrelated text. Walk the string, count brace depth, and slice the
  // first complete object.
  const balanced = extractBalancedJsonObject(response);
  if (balanced) {
    const parsed = tryParseJSON(balanced);
    if (parsed) return normalizeConstitution(parsed);
  }

  // Strategy 3: markdown-prose fallback.
  const fromProse = parseMarkdownConstitution(response);
  if (fromProse && fromProse.principles.length > 0) return fromProse;

  return null;
}

/**
 * Extract the first balanced `{ … }` substring while respecting
 * string-quoted braces and escape sequences. Returns null if no
 * balanced object exists. This is deliberately stricter than the
 * earlier `/\{[\s\S]*\}/` greedy regex which over-matched across
 * adjacent prose with stray braces.
 */
function extractBalancedJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJSON(str: string): Record<string, unknown> | null {
  // Clean common LLM-isms WITHOUT touching apostrophes inside string
  // values. The prior implementation did `replace(/'/g, '"')` which
  // butchered legitimate JSON like `{"description": "Don't break it"}`
  // by turning the apostrophe into a closing quote. Real Opus / Claude
  // output already uses double-quoted strings — we only need to handle
  // optional trailing-comma and JS-style line-comment noise.
  let cleaned = str.trim();
  // Strip line comments outside of strings. A naive global replace would
  // also clobber `//` inside URLs in string values; keep it scoped to
  // the start of a line where comment-style noise actually appears in
  // LLM output.
  cleaned = cleaned.replace(/^\s*\/\/[^\n]*$/gm, '');
  // Remove trailing commas before } or ].
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Last-resort prose extractor for models that ignore the "JSON only"
 * instruction and emit Markdown directly. Recognises:
 *
 *   # <ProjectName> Constitution
 *   ## Core Principles
 *   ### 1. Principle Name
 *   <description, possibly multi-line, until next heading or blank gap>
 *
 * Plus the older single-line shorthand (`1. **Name**: description`)
 * that the prior fallback handled. Heading-based parsing yields
 * multi-paragraph descriptions intact.
 */
function parseMarkdownConstitution(response: string): ConstitutionData {
  const data: ConstitutionData = { projectName: '', principles: [], constraints: '', workflow: '' };

  // Project name from heading or labelled prose.
  const headingName = response.match(/^#\s+(.+?)\s+Constitution\s*$/im);
  if (headingName) data.projectName = headingName[1].trim();
  if (!data.projectName) {
    const labelled = response.match(/project\s*name\s*[:\-]\s*["']?([^"'\n]+)/i);
    if (labelled) data.projectName = labelled[1].trim();
  }

  // Principles via `### N. Name` headings, capturing the body until the
  // next heading. JS regex has no `\Z` — we use `$(?![\s\S])` (end of
  // input) as the terminating alternative.
  const headingPrincipleRe = /^###\s+(?:\d+\.\s*)?(.+?)\s*$\n([\s\S]*?)(?=\n^###\s|\n^##\s|$(?![\s\S]))/gm;
  for (const m of response.matchAll(headingPrincipleRe)) {
    const name = m[1].trim().replace(/^\*+|\*+$/g, '');
    const desc = m[2]
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (name.length >= 2 && name.length <= 80 && desc.length >= 1) {
      data.principles.push({ name, description: desc });
    }
  }

  // Fallback to the prior single-line shorthand when no headings match.
  // Separator restricted to `:` (the original `[:\-]` class chewed
  // hyphens inside names like "Test-First", capturing only "Test").
  if (data.principles.length === 0) {
    const inlineRe = /^\s*\d+\.\s*\*{0,2}([^:*\n]+?)\*{0,2}\s*:\s*([^\n]+)/gm;
    for (const m of response.matchAll(inlineRe)) {
      const name = m[1].trim();
      const desc = m[2].trim();
      if (name.length >= 2 && name.length <= 60 && desc.length >= 10) {
        data.principles.push({ name, description: desc });
      }
    }
  }

  // Constraints / workflow sections, terminated at the next `## ` or EOI.
  const constraintsMatch = response.match(
    /^##\s*(?:Additional\s+)?Constraints?\s*$\n+([\s\S]*?)(?=\n^##\s|$(?![\s\S]))/im,
  );
  if (constraintsMatch) data.constraints = constraintsMatch[1].trim();
  const workflowMatch = response.match(
    /^##\s*(?:Development\s+)?Workflow[^\n]*$\n+([\s\S]*?)(?=\n^##\s|$(?![\s\S]))/im,
  );
  if (workflowMatch) data.workflow = workflowMatch[1].trim();

  return data;
}

// Exported only for tests.
export { tryParseJSON, extractBalancedJsonObject, parseMarkdownConstitution };

function normalizeConstitution(raw: Record<string, unknown>): ConstitutionData {
  const data: ConstitutionData = {
    projectName: String(raw.projectName ?? raw.project_name ?? raw.name ?? ''),
    principles: [],
    constraints: '',
    workflow: '',
  };

  // Handle principles as array of objects or strings
  const rawPrinciples = raw.principles as unknown[];
  if (Array.isArray(rawPrinciples)) {
    for (const p of rawPrinciples) {
      if (typeof p === 'string') {
        data.principles.push({ name: p, description: p });
      } else if (p && typeof p === 'object') {
        const obj = p as Record<string, unknown>;
        const name = String(obj.name ?? obj.title ?? '');
        const desc = String(obj.description ?? obj.desc ?? obj.detail ?? '');
        if (name) data.principles.push({ name, description: desc || name });
      }
    }
  }

  // Handle constraints as string or object/array
  if (typeof raw.constraints === 'string') {
    data.constraints = raw.constraints;
  } else if (raw.constraints && typeof raw.constraints === 'object') {
    data.constraints = JSON.stringify(raw.constraints, null, 2);
  }

  // Handle workflow as string or object
  if (typeof raw.workflow === 'string') {
    data.workflow = raw.workflow;
  } else if (raw.workflow && typeof raw.workflow === 'object') {
    data.workflow = JSON.stringify(raw.workflow, null, 2);
  }

  return data;
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
  if (content.includes('[PRINCIPLE_1_NAME]')) return data;

  const nameMatch = content.match(/^# (.+?) Constitution/m);
  if (nameMatch) data.projectName = nameMatch[1];

  const principles: Array<{ name: string; description: string }> = [];
  const principleRegex = /### (.+?)\n([\s\S]*?)(?=\n### |\n## |$)/g;
  let match;
  while ((match = principleRegex.exec(content)) !== null) {
    const name = match[1].trim().replace(/^\d+\.\s*/, '');
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

function getWebviewContent(data: ConstitutionData, hasLLM: boolean): string {
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

  const aiSection = hasLLM ? `
  <div class="ai-section">
    <div class="ai-header" onclick="toggleAI()">
      <span>🤖 Generate with AI</span>
      <span id="ai-toggle">▸</span>
    </div>
    <div id="ai-body" style="display:none">
      <p class="hint">Describe your project and the AI will suggest principles, constraints, and workflow rules.</p>
      <textarea id="projectDesc" class="ai-input" placeholder="e.g., A VS Code extension for spec-driven development. We use TypeScript, prefer no external SDKs, and want TDD with high code quality. The project is open source under MIT license."></textarea>
      <button class="btn-generate" id="btnGenerate" onclick="generateAI()">Generate Constitution</button>
      <div id="streamOutput" class="stream-output" style="display:none"></div>
    </div>
  </div>` : '';

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
      width: 100%; padding: 8px 12px;
      background: var(--vscode-input-background, #333); color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #555); border-radius: 4px;
      font-family: inherit; font-size: 0.95em;
    }
    input[type="text"]:focus, textarea:focus { outline: none; border-color: var(--vscode-focusBorder, #007acc); }
    textarea { min-height: 80px; resize: vertical; }
    .section { margin-bottom: 24px; }
    .principle {
      background: var(--vscode-editor-inactiveSelectionBackground, #2a2a2a);
      border-radius: 6px; padding: 12px; margin-bottom: 12px;
    }
    .principle-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .principle-number {
      background: var(--vscode-badge-background, #007acc); color: var(--vscode-badge-foreground, #fff);
      width: 24px; height: 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.8em; font-weight: 600; flex-shrink: 0;
    }
    .principle-name { flex: 1; font-weight: 600; }
    .principle-desc { margin-top: 4px; }
    .btn-remove {
      background: none; border: none; color: var(--vscode-errorForeground, #f44); cursor: pointer;
      font-size: 1.4em; padding: 0 4px; line-height: 1; opacity: 0.6;
    }
    .btn-remove:hover { opacity: 1; }
    .btn-add {
      background: none; border: 1px dashed var(--vscode-input-border, #555);
      color: var(--vscode-descriptionForeground, #888); padding: 10px;
      border-radius: 6px; width: 100%; cursor: pointer; font-size: 0.9em; margin-top: 4px;
    }
    .btn-add:hover { border-color: var(--vscode-focusBorder, #007acc); color: var(--vscode-foreground, #ccc); }
    .actions { margin-top: 32px; display: flex; gap: 12px; }
    .btn-save {
      background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff);
      border: none; padding: 10px 24px; border-radius: 4px; cursor: pointer;
      font-size: 1em; font-weight: 600;
    }
    .btn-save:hover { background: var(--vscode-button-hoverBackground, #005a9e); }
    .hint { color: var(--vscode-descriptionForeground, #777); font-size: 0.82em; margin-top: 4px; }

    /* AI section */
    .ai-section {
      background: rgba(33,150,243,0.06); border: 1px solid rgba(33,150,243,0.2);
      border-radius: 8px; padding: 12px; margin-bottom: 24px;
    }
    .ai-header { display: flex; justify-content: space-between; cursor: pointer; font-weight: 600; font-size: 0.95em; }
    .ai-input { min-height: 60px; margin: 8px 0; }
    .btn-generate {
      width: 100%; padding: 8px; border: none; border-radius: 4px; cursor: pointer;
      background: #2196F3; color: white; font-weight: 600; font-size: 0.95em;
    }
    .btn-generate:hover { background: #1976D2; }
    .btn-generate:disabled { opacity: 0.5; cursor: default; }
    .btn-generate.loading { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    .stream-output {
      margin-top: 10px; padding: 10px; border-radius: 6px; font-size: 0.82em;
      background: var(--vscode-editor-background, #1a1a1a);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
      max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-descriptionForeground, #999);
      line-height: 1.4;
    }
    .stream-label {
      font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground); margin-bottom: 4px; font-weight: 600;
    }
  </style>
</head>
<body>
  <h1>Project Constitution</h1>
  <p class="subtitle">Define the non-negotiable principles that guide all development in this project. These will be used as context when generating specs.</p>

  ${aiSection}

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

    function toggleAI() {
      const body = document.getElementById('ai-body');
      const toggle = document.getElementById('ai-toggle');
      if (body.style.display === 'none') { body.style.display = 'block'; toggle.textContent = '▾'; }
      else { body.style.display = 'none'; toggle.textContent = '▸'; }
    }

    function generateAI() {
      const desc = document.getElementById('projectDesc').value.trim();
      if (!desc) { document.getElementById('projectDesc').style.borderColor = '#f44'; return; }
      const btn = document.getElementById('btnGenerate');
      btn.textContent = 'Generating...';
      btn.disabled = true;
      btn.classList.add('loading');

      // Show and clear the stream output
      const streamEl = document.getElementById('streamOutput');
      streamEl.style.display = 'block';
      const label = document.createElement('div');
      label.className = 'stream-label';
      label.textContent = 'LLM Output';
      streamEl.replaceChildren(label);

      vscode.postMessage({ command: 'generate', projectDescription: desc });
    }

    // Listen for AI response
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'streamChunk') {
        const streamEl = document.getElementById('streamOutput');
        if (streamEl) {
          streamEl.appendChild(document.createTextNode(msg.text));
          streamEl.scrollTop = streamEl.scrollHeight;
        }
      } else if (msg.command === 'generating') {
        // Already handled by button state
      } else if (msg.command === 'generateDone') {
        const btn = document.getElementById('btnGenerate');
        if (btn) { btn.textContent = 'Generate Constitution'; btn.disabled = false; btn.classList.remove('loading'); }

        // Hide stream output after a short delay
        const streamEl = document.getElementById('streamOutput');
        if (streamEl && msg.data) {
          setTimeout(() => { streamEl.style.display = 'none'; }, 500);
        }

        if (msg.data) {
          // Fill the form with generated data
          if (msg.data.projectName) document.getElementById('projectName').value = msg.data.projectName;
          if (msg.data.constraints) document.getElementById('constraints').value = msg.data.constraints;
          if (msg.data.workflow) document.getElementById('workflow').value = msg.data.workflow;

          if (msg.data.principles && msg.data.principles.length > 0) {
            const container = document.getElementById('principles');
            container.replaceChildren(...msg.data.principles.map((p, i) => {
              return buildPrinciple(i, p.name, p.description);
            }));
          }

          // Close the AI section
          document.getElementById('ai-body').style.display = 'none';
          document.getElementById('ai-toggle').textContent = '▸';
        }
      }
    });

    function buildPrinciple(index, name, description) {
      const div = document.createElement('div');
      div.className = 'principle';
      div.dataset.index = index;

      const header = document.createElement('div');
      header.className = 'principle-header';

      const num = document.createElement('span');
      num.className = 'principle-number';
      num.textContent = index + 1;

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'principle-name';
      if (name != null) nameInput.value = name;
      else nameInput.placeholder = 'Principle name';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => removePrinciple(removeBtn));

      header.append(num, nameInput, removeBtn);

      const descArea = document.createElement('textarea');
      descArea.className = 'principle-desc';
      if (description != null) descArea.value = description;
      else descArea.placeholder = 'Describe this principle...';

      div.append(header, descArea);
      return div;
    }

    function addPrinciple() {
      const container = document.getElementById('principles');
      container.appendChild(buildPrinciple(container.children.length));
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
