import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderRegistry } from '../providers/registry.js';
import { SPECS_DIR_NAME } from '../constants.js';
import { showProgress, updateProgress, hideProgress } from '../progress.js';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Caramelo');
  }
  return outputChannel;
}

export async function startTask(
  lineNumber: number,
  taskText: string,
  docUri: vscode.Uri,
  registry: ProviderRegistry
): Promise<void> {
  const provider = registry.activeProvider;
  if (!provider) {
    vscode.window.showWarningMessage('No active LLM provider configured.');
    vscode.commands.executeCommand('caramelo.selectProvider');
    return;
  }

  // Find parent spec directory
  const docPath = docUri.fsPath;
  const specDir = findSpecDir(docPath);
  const context = specDir ? loadSpecContext(specDir) : '';

  const systemPrompt = `You are a code generation assistant. The user will give you a task to implement.
Output your response as code changes in this format for EACH file you want to create or modify:

=== FILE: path/to/file.ext ===
<complete file content here>
=== END FILE ===

Only output file blocks. No explanations outside file blocks.`;

  const userPrompt = `Task: ${taskText}\n\n${context ? `Context:\n${context}` : ''}`;

  const abortController = new AbortController();
  showProgress(`Task: ${taskText.slice(0, 40)}...`, () => abortController.abort());

  try {
      const channel = getOutputChannel();
      channel.show(true);
      channel.appendLine(`\n${'─'.repeat(60)}`);
      channel.appendLine(`▶ Task: ${taskText}`);
      channel.appendLine(`  ${new Date().toLocaleTimeString()}`);
      channel.appendLine('─'.repeat(60));

      let output = '';
      try {
        for await (const chunk of provider.chat(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          { signal: abortController.signal }
        )) {
          output += chunk;
          channel.append(chunk);
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          channel.appendLine('\n\n⚠ Task cancelled.');
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        channel.appendLine(`\n\n✗ Error: ${msg}`);
        vscode.window.showErrorMessage(`Task failed: ${msg}`);
        return;
      }

      // Parse file blocks
      const fileBlocks = parseFileBlocks(output);
      if (fileBlocks.length === 0) {
        channel.appendLine('\n\n⚠ No file changes detected in LLM output.');
        vscode.window.showInformationMessage('No file changes proposed by the LLM.');
        return;
      }

      channel.appendLine(`\n\n${'─'.repeat(40)}`);
      channel.appendLine(`✓ ${fileBlocks.length} file(s) to apply:`);
      fileBlocks.forEach((b) => channel.appendLine(`  → ${b.filePath}`));

      // Apply changes directly
      const applied = await applyChanges(fileBlocks);
      if (applied > 0) {
        await markTaskComplete(docUri, lineNumber, taskText);
        channel.appendLine(`✓ Task complete. ${applied} file(s) created/updated.`);
        vscode.window.showInformationMessage(`Task complete. ${applied} file(s) created/updated.`);
      }
  } finally {
    hideProgress();
  }
}

interface FileBlock {
  filePath: string;
  content: string;
}

function parseFileBlocks(output: string): FileBlock[] {
  const blocks: FileBlock[] = [];

  // Try strict format first: === FILE: path === ... === END FILE ===
  const strictRegex = /=== FILE: (.+?) ===\n([\s\S]*?)\n=== END FILE ===/g;
  let match;
  while ((match = strictRegex.exec(output)) !== null) {
    blocks.push({ filePath: match[1].trim(), content: match[2] });
  }
  if (blocks.length > 0) return blocks;

  // Fallback: handle truncated output where === END FILE === is missing
  // Split on === FILE: headers and take content until next header or end
  const headerRegex = /=== FILE: (.+?) ===/g;
  const headers: Array<{ path: string; start: number }> = [];
  while ((match = headerRegex.exec(output)) !== null) {
    headers.push({ path: match[1].trim(), start: match.index + match[0].length + 1 });
  }

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].start;
    const end = i + 1 < headers.length
      ? headers[i + 1].start - headers[i + 1].path.length - 14 // back up past "=== FILE: x ==="
      : output.length;
    let content = output.slice(start, end).trim();
    // Remove trailing === END FILE === if present
    content = content.replace(/\n=== END FILE ===\s*$/, '');
    if (content.length > 0) {
      blocks.push({ filePath: headers[i].path, content });
    }
  }

  return blocks;
}

async function applyChanges(blocks: FileBlock[]): Promise<number> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return 0;

  let applied = 0;
  const fileNames: string[] = [];

  for (const block of blocks) {
    const absPath = path.isAbsolute(block.filePath)
      ? block.filePath
      : path.join(workspaceRoot, block.filePath);

    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, block.content);
    applied++;
    fileNames.push(block.filePath);
  }

  // Open the first created/modified file
  if (fileNames.length > 0) {
    const firstPath = path.isAbsolute(fileNames[0])
      ? fileNames[0]
      : path.join(workspaceRoot, fileNames[0]);
    const doc = await vscode.workspace.openTextDocument(firstPath);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  return applied;
}

// Mutex to prevent concurrent writes to the same tasks file
let writeLock: Promise<void> = Promise.resolve();

async function markTaskComplete(docUri: vscode.Uri, lineNumber: number, taskText?: string): Promise<void> {
  // Serialize writes — wait for any pending write to finish
  writeLock = writeLock.then(async () => {
    const filePath = docUri.fsPath;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Strategy 1: try exact line number
    if (lineNumber < lines.length && lines[lineNumber].includes('- [ ]')) {
      lines[lineNumber] = lines[lineNumber].replace('- [ ]', '- [x]');
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      return;
    }

    // Strategy 2: find by task text (handles shifted lines)
    if (taskText) {
      const searchStr = taskText.slice(0, 30);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('- [ ]') && lines[i].includes(searchStr)) {
          lines[i] = lines[i].replace('- [ ]', '- [x]');
          fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
          return;
        }
      }
    }

    // Strategy 3: mark the first unchecked task (last resort)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('- [ ]')) {
        lines[i] = lines[i].replace('- [ ]', '- [x]');
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return;
      }
    }
  });
  await writeLock;
}

function findSpecDir(filePath: string): string | null {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (dir.includes(SPECS_DIR_NAME)) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function loadSpecContext(specDir: string): string {
  const parts: string[] = [];
  for (const file of ['spec.md', 'plan.md']) {
    const filePath = path.join(specDir, file);
    if (fs.existsSync(filePath)) {
      parts.push(fs.readFileSync(filePath, 'utf-8'));
    }
  }
  return parts.join('\n\n---\n\n');
}
