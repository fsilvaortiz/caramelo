import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SPECS_DIR_NAME, SETTINGS_KEYS } from '../constants.js';
import type { ProviderConfig } from '../constants.js';
import { JiraClient } from '../jira/jira-client.js';

export async function createSpecFromJira(workspaceUri: vscode.Uri | undefined): Promise<void> {
  if (!workspaceUri) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  // Find Jira providers from settings
  const configs = vscode.workspace.getConfiguration().get<ProviderConfig[]>(SETTINGS_KEYS.providers) ?? [];
  const jiraConfigs = configs.filter((c) => c.type === 'jira');

  if (jiraConfigs.length === 0) {
    vscode.window.showErrorMessage('No Jira provider configured. Add one in Providers first.');
    return;
  }

  // Select Jira provider if multiple
  let jiraConfig = jiraConfigs[0];
  if (jiraConfigs.length > 1) {
    const pick = await vscode.window.showQuickPick(
      jiraConfigs.map((c) => ({ label: c.name, description: c.boardName, config: c })),
      { placeHolder: 'Select Jira provider' }
    );
    if (!pick) return;
    jiraConfig = (pick as { config: ProviderConfig }).config;
  }

  // Get API token via internal command
  let token: string | undefined;
  try {
    // Try to get token via the extension context
    token = await vscode.commands.executeCommand<string>('caramelo._getJiraToken', jiraConfig.id);
  } catch {
    vscode.window.showErrorMessage('Could not retrieve Jira API token. Try re-adding the Jira provider.');
    return;
  }

  if (!token) {
    vscode.window.showErrorMessage('Jira API token not found. Try re-adding the Jira provider.');
    return;
  }

  const client = new JiraClient(
    jiraConfig.instanceUrl!,
    jiraConfig.email!,
    token,
    jiraConfig.boardId
  );

  // Fetch issues
  const quickPick = vscode.window.createQuickPick();
  quickPick.placeholder = 'Search issues...';
  quickPick.title = `Issues from ${jiraConfig.boardName}`;
  quickPick.busy = true;
  quickPick.show();

  let debounceTimer: ReturnType<typeof setTimeout>;

  const loadIssues = async (query?: string) => {
    quickPick.busy = true;
    try {
      const result = await client.searchIssues(query, 50);
      quickPick.items = result.issues.map((issue) => ({
        label: `${issue.key}  ${issue.summary}`,
        description: `${issue.status} — ${issue.assignee}`,
        detail: issue.description.slice(0, 200),
        issue,
      } as vscode.QuickPickItem & { issue: typeof issue }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to load issues: ${msg}`);
    }
    quickPick.busy = false;
  };

  // Initial load
  await loadIssues();

  // Dynamic search
  quickPick.onDidChangeValue((value) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadIssues(value || undefined), 300);
  });

  // Handle selection
  const selected = await new Promise<(vscode.QuickPickItem & { issue?: { key: string; summary: string; description: string; acceptanceCriteria: string; comments: string[]; url: string } }) | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0] as typeof quickPick.selectedItems[0] & { issue?: unknown };
      resolve(item as typeof quickPick.selectedItems[0] & { issue?: { key: string; summary: string; description: string; acceptanceCriteria: string; comments: string[]; url: string } });
      quickPick.dispose();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
      quickPick.dispose();
    });
  });

  if (!selected?.issue) return;

  const issue = selected.issue;

  // Get full issue detail
  const fullIssue = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Loading ${issue.key}...` },
    () => client.getIssue(issue.key)
  );

  // Compose spec name
  const slug = fullIssue.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const specName = `${fullIssue.key.toLowerCase()}-${slug}`;

  // Create spec directory
  const specsRoot = path.join(workspaceUri.fsPath, SPECS_DIR_NAME);
  if (!fs.existsSync(specsRoot)) fs.mkdirSync(specsRoot, { recursive: true });
  const specDir = path.join(specsRoot, specName);
  if (!fs.existsSync(specDir)) fs.mkdirSync(specDir, { recursive: true });

  // Write metadata with Jira link
  const metaPath = path.join(specDir, '.caramelo-meta.json');
  const meta = {
    phases: { requirements: 'pending', design: 'pending', tasks: 'pending' },
    jira: { key: fullIssue.key, url: fullIssue.url, boardName: jiraConfig.boardName },
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Compose feature description for LLM context
  const parts = [`# ${fullIssue.summary}`, '', `**Jira Issue**: [${fullIssue.key}](${fullIssue.url})`, ''];
  if (fullIssue.description) parts.push('## Description', '', fullIssue.description, '');
  if (fullIssue.acceptanceCriteria) parts.push('## Acceptance Criteria', '', fullIssue.acceptanceCriteria, '');
  if (fullIssue.comments.length > 0) {
    parts.push('## Discussion', '');
    fullIssue.comments.forEach((c, i) => parts.push(`### Comment ${i + 1}`, '', c, ''));
  }

  // Write the feature description as a reference file
  const descPath = path.join(specDir, 'jira-context.md');
  fs.writeFileSync(descPath, parts.join('\n'), 'utf-8');

  vscode.window.showInformationMessage(
    `Spec "${specName}" created from ${fullIssue.key}.`,
    'Generate Requirements'
  ).then((action) => {
    if (action) {
      vscode.commands.executeCommand('caramelo.runPhase', specName, 'requirements');
    }
  });
}
