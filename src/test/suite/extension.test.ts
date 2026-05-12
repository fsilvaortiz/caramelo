import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'fsilvaortiz.caramelo';

const EXPECTED_COMMANDS = [
  'caramelo.newSpec',
  'caramelo.selectProvider',
  'caramelo.addProvider',
  'caramelo.editConstitution',
  'caramelo.runPhase',
  'caramelo.approvePhase',
  'caramelo.regeneratePhase',
  'caramelo.startTask',
  'caramelo.runNextTask',
  'caramelo.runAllTasks',
  'caramelo.syncTemplates',
  'caramelo.clarify',
  'caramelo.analyze',
  'caramelo.fixAllIssues',
  'caramelo.fixSingleIssue',
  'caramelo.generateChecklist',
  'caramelo.createSpecFromJira',
  'caramelo.openDag',
  'caramelo.viewChanges',
];

suite('Caramelo extension host smoke', () => {
  suiteSetup(async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found in extension host`);
    if (!ext.isActive) {
      await ext.activate();
    }
  });

  test('extension is installed and activated', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension not present');
    assert.strictEqual(ext.isActive, true, 'extension did not activate');
  });

  test('all advertised commands are registered', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = EXPECTED_COMMANDS.filter((c) => !registered.has(c));
    assert.deepStrictEqual(missing, [], `missing commands: ${missing.join(', ')}`);
  });

  test('selectProvider without an id focuses the providers sidebar (no QuickPick)', async () => {
    // The contract: invoking caramelo.selectProvider with no args MUST NOT throw
    // and MUST NOT block on a QuickPick. It should route to the sidebar webview.
    // We assert it resolves quickly; a QuickPick would never resolve here.
    const exec = vscode.commands.executeCommand('caramelo.selectProvider');
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('selectProvider() blocked — likely opened a QuickPick')), 2000)
    );
    await Promise.race([exec, timeout]);
  });

  test('newSpec resolves without throwing (focuses workflow webview)', async () => {
    await vscode.commands.executeCommand('caramelo.newSpec');
  });

  test('addProvider resolves without throwing (focuses providers webview)', async () => {
    await vscode.commands.executeCommand('caramelo.addProvider');
  });

  test('syncTemplates command is invocable', async function () {
    this.timeout(20000);
    // The real implementation hits the network; we accept either resolution.
    // A throw would indicate broken wiring (missing TemplateSync instance, etc.).
    try {
      await vscode.commands.executeCommand('caramelo.syncTemplates');
    } catch (err) {
      assert.fail(`syncTemplates threw: ${(err as Error).message}`);
    }
  });

  test('showLockedMessage invokes without synchronous error', async () => {
    // The command pops an info toast; the returned promise stays pending
    // until the user dismisses it. We only care that it dispatches.
    const p = vscode.commands.executeCommand('caramelo.showLockedMessage', 'test reason');
    assert.ok(p && typeof (p as Thenable<unknown>).then === 'function');
  });

  test('viewChanges invokes without synchronous error', async () => {
    const p = vscode.commands.executeCommand('caramelo.viewChanges');
    assert.ok(p && typeof (p as Thenable<unknown>).then === 'function');
  });

  test('configuration schema exposes documented caramelo settings', () => {
    const cfg = vscode.workspace.getConfiguration();
    // Read default values — if package.json contributes them, get() returns the default.
    assert.strictEqual(typeof cfg.get('caramelo.useAgentLoop'), 'boolean');
    assert.strictEqual(typeof cfg.get('caramelo.enableBashTool'), 'boolean');
    assert.strictEqual(typeof cfg.get('caramelo.autoApplyEdits'), 'boolean');
    assert.strictEqual(typeof cfg.get('caramelo.sse.timeoutMs'), 'number');
  });
});
