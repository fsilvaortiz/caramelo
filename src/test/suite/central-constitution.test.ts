import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { getApi, installMockProvider } from './helpers/api.js';
import type { MockLLMProvider } from './helpers/mock-provider.js';
import { readSpecFile, removeSpec, seedSpec, workspaceRoot } from './helpers/workspace.js';

/**
 * Central constitution against a real Git repository (a bare repo reached
 * over file://), driven through the real extension command and the real
 * generation gate.
 */
suite('Central constitution (functional, real git)', () => {
  let tmp: string;
  let work: string;
  let url: string;
  let mock: MockLLMProvider;
  let uninstall: () => void;
  const constitutionPath = () => path.join(workspaceRoot(), '.specify', 'memory', 'constitution.md');
  const metaPath = () => path.join(workspaceRoot(), '.specify', 'memory', 'constitution-source.json');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  function publish(content: string): string {
    fs.writeFileSync(path.join(work, 'standards', 'constitution.md'), content);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'update');
    git(work, 'push', '-q', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  }

  suiteSetup(async function () {
    this.timeout(60_000);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-central-smoke-'));
    const bare = path.join(tmp, 'standards.git');
    work = path.join(tmp, 'work');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
    git(tmp, 'clone', '-q', bare, work);
    git(work, 'config', 'user.email', 't@example.com');
    git(work, 'config', 'user.name', 'T');
    git(work, 'checkout', '-q', '-b', 'main');
    fs.mkdirSync(path.join(work, 'standards'));
    url = pathToFileURL(bare).href;
    publish('# Acme Constitution\n\n## I. Security first\n');

    const installed = await installMockProvider({ id: 'mock-central', displayName: 'Mock (central)' });
    mock = installed.mock;
    uninstall = installed.uninstall;
    await getApi();
  });

  suiteTeardown(async () => {
    uninstall?.();
    const cfg = vscode.workspace.getConfiguration('caramelo.constitution');
    for (const key of ['repository', 'path', 'ref']) await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    const { setCentralConstitution } = await import('../../constitution/central-vscode.js');
    setCentralConstitution(undefined);
    fs.rmSync(constitutionPath(), { force: true });
    fs.rmSync(metaPath(), { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('"Sync Central Constitution" makes constitution.md an exact copy of the repository file', async function () {
    this.timeout(30_000);
    const cfg = vscode.workspace.getConfiguration('caramelo.constitution');
    await cfg.update('repository', url, vscode.ConfigurationTarget.Workspace);
    await cfg.update('path', 'standards/constitution.md', vscode.ConfigurationTarget.Workspace);

    await vscode.commands.executeCommand('caramelo.syncConstitution');

    assert.strictEqual(fs.readFileSync(constitutionPath(), 'utf-8'), '# Acme Constitution\n\n## I. Security first\n');
    const meta = JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
    assert.strictEqual(meta.repository, url);
    assert.strictEqual(meta.path, 'standards/constitution.md');
    assert.strictEqual(meta.commit, git(work, 'rev-parse', 'HEAD'));
  });

  async function runRequirements(specName: string): Promise<void> {
    const api = await getApi();
    const { SpecWorkspace } = await import('../../specs/workspace.js');
    const { runPhase } = await import('../../commands/run-phase.js');
    await runPhase(specName, 'requirements', new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri) as never,
      api.registry as never, api.templateManager as never, api.workflowEngine as never, { refresh: () => { /* noop */ } } as never);
  }

  async function installGate(answer: string | undefined) {
    const { CentralConstitution, setCentralConstitution } = await import('../../constitution/central-vscode.js');
    const asked: string[] = [];
    const gate = new CentralConstitution(workspaceRoot(), {
      ask: async (message) => { asked.push(message); return answer; },
      notify: async () => undefined,
      error: (message) => { asked.push(`error:${message}`); },
      withProgress: (_t, task) => task(),
    });
    setCentralConstitution(gate);
    return asked;
  }

  test('a newer central version is offered before generating, and the generation uses it', async function () {
    this.timeout(30_000);
    publish('# Acme Constitution\n\n## I. Security first\n\n## II. Accessibility is mandatory\n');
    const asked = await installGate('Sync and continue');
    mock.reset();
    mock.queueReply('# Requirements\n\n- Accessible login.\n');
    const spec = seedSpec();
    try {
      await runRequirements(spec.name);
      assert.ok(asked[0]?.includes('central constitution was updated'), `asked: ${asked.join(' | ')}`);
      assert.ok(fs.readFileSync(constitutionPath(), 'utf-8').includes('II. Accessibility is mandatory'));
      const prompt = mock.calls[0].messages.map((m) => m.content).join('\n');
      assert.ok(prompt.includes('II. Accessibility is mandatory'), 'generation must use the freshly synced constitution');
      assert.ok(readSpecFile(spec, 'spec.md')?.includes('Accessible login'));
    } finally {
      removeSpec(spec);
    }
  });

  test('dismissing the question cancels the generation (no LLM call)', async function () {
    this.timeout(30_000);
    publish('# Acme Constitution v3\n');
    const asked = await installGate(undefined);
    mock.reset();
    const spec = seedSpec();
    try {
      await runRequirements(spec.name);
      assert.strictEqual(asked.length, 1);
      assert.strictEqual(mock.calls.length, 0, 'the generation must not run');
      assert.strictEqual(readSpecFile(spec, 'spec.md'), null);
      assert.ok(!fs.readFileSync(constitutionPath(), 'utf-8').includes('v3'), 'nothing synced without consent');
    } finally {
      removeSpec(spec);
    }
  });

  test('sidebar shows "update available" with a Sync button that syncs through the real command', async function () {
    this.timeout(30_000);
    const { CentralConstitution, setCentralConstitution } = await import('../../constitution/central-vscode.js');
    const { WorkflowViewProvider } = await import('../../views/sidebar/workflow-view.js');
    // Bring the workspace to the current central version, then publish a newer one.
    await vscode.commands.executeCommand('caramelo.syncConstitution');
    publish('# Acme Constitution v4\n');
    const central = new CentralConstitution(workspaceRoot(), {
      ask: async () => undefined, notify: async () => undefined, error: () => { /* noop */ }, withProgress: (_t, task) => task(),
    });
    setCentralConstitution(central);
    await central.checkRemote(true);

    const noop = { dispose() { /* noop */ } };
    const webview = { options: {}, cspSource: '', html: '', onDidReceiveMessage: () => noop };
    const view = new WorkflowViewProvider(vscode.Uri.file(workspaceRoot()));
    try {
      view.resolveWebviewView({ webview, onDidDispose: () => noop } as unknown as vscode.WebviewView);
      assert.ok(webview.html.includes('Update available'), 'status text');
      assert.ok(webview.html.includes("msg('syncConstitution')"), 'Sync button');

      view.dispatch({ command: 'syncConstitution' });
      const deadline = Date.now() + 15_000;
      while (!fs.readFileSync(constitutionPath(), 'utf-8').includes('v4') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.strictEqual(fs.readFileSync(constitutionPath(), 'utf-8'), '# Acme Constitution v4\n');
      central.refreshLocal();
      view.refresh();
      assert.ok(webview.html.includes('Central ·'), 'synced status after the click');
    } finally {
      view.dispose();
    }
  });
});
