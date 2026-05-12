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
  'caramelo.showLockedMessage',
];

/**
 * Race a promise against a deadline without misattributing rejections.
 *
 * - settled('resolved' | 'rejected'): the promise finished within the deadline.
 *   The caller can inspect `error` to see the rejection reason.
 * - settled('pending'): the deadline elapsed before the promise settled. The
 *   promise's eventual rejection (if any) is swallowed silently — we only use
 *   this signal for "did it block?" checks where the operation is fire-and-forget.
 */
type RaceOutcome =
  | { settled: 'resolved' }
  | { settled: 'rejected'; error: unknown }
  | { settled: 'pending' };

async function raceWithDeadline(p: Thenable<unknown>, ms: number): Promise<RaceOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<RaceOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ settled: 'pending' }), ms);
  });
  const wrapped = Promise.resolve(p).then(
    (): RaceOutcome => ({ settled: 'resolved' }),
    (error): RaceOutcome => ({ settled: 'rejected', error }),
  );
  const outcome = await Promise.race([wrapped, deadline]);
  if (timer) clearTimeout(timer);
  // Attach a no-op handler to the losing branch so a late rejection doesn't
  // surface as an unhandledRejection in the extension host.
  void wrapped.catch(() => undefined);
  return outcome;
}

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

  test('workflow sidebar view focus command resolves', async () => {
    // Contributed by package.json's `views` declaration; resolves only if the
    // WorkflowViewProvider was registered during activate(). Regression guard
    // for the v0.1.1 webview-wiring bug class.
    const out = await raceWithDeadline(
      vscode.commands.executeCommand('caramelo.workflow.focus'),
      5000,
    );
    if (out.settled === 'rejected') {
      assert.fail(`workflow.focus rejected: ${(out.error as Error)?.message ?? String(out.error)}`);
    }
  });

  test('providers sidebar view focus command resolves', async () => {
    const out = await raceWithDeadline(
      vscode.commands.executeCommand('caramelo.providers.focus'),
      5000,
    );
    if (out.settled === 'rejected') {
      assert.fail(`providers.focus rejected: ${(out.error as Error)?.message ?? String(out.error)}`);
    }
  });

  test('selectProvider with no args routes to sidebar (no top-bar QuickPick)', async () => {
    // The contract (memory: feedback_no_quickpick.md): no-arg invocation MUST
    // dispatch to caramelo.providers.focus, not block on a top-bar picker.
    // A real QuickPick keeps the returned promise pending indefinitely; a real
    // bug (missing view, exception) rejects. Distinguish the two so failures
    // are diagnosed on the right axis.
    const out = await raceWithDeadline(
      vscode.commands.executeCommand('caramelo.selectProvider'),
      3000,
    );
    if (out.settled === 'pending') {
      assert.fail('selectProvider() did not settle in 3s — likely opened a QuickPick');
    }
    if (out.settled === 'rejected') {
      assert.fail(
        `selectProvider() rejected: ${(out.error as Error)?.message ?? String(out.error)}`,
      );
    }
  });

  test('addProvider with no args routes to sidebar (no top-bar QuickPick)', async () => {
    const out = await raceWithDeadline(
      vscode.commands.executeCommand('caramelo.addProvider'),
      3000,
    );
    if (out.settled === 'pending') {
      assert.fail('addProvider() did not settle in 3s — likely opened a QuickPick');
    }
    if (out.settled === 'rejected') {
      assert.fail(
        `addProvider() rejected: ${(out.error as Error)?.message ?? String(out.error)}`,
      );
    }
  });

  test('newSpec resolves', async () => {
    const out = await raceWithDeadline(vscode.commands.executeCommand('caramelo.newSpec'), 3000);
    if (out.settled === 'rejected') {
      assert.fail(`newSpec rejected: ${(out.error as Error)?.message ?? String(out.error)}`);
    }
  });

  test('syncTemplates dispatches without rejecting on wiring failure', async function () {
    this.timeout(10000);
    // The real implementation hits the network; we don't want CI runners to be
    // gated on Spec Kit upstream reachability. Race against a short deadline:
    // pending = normal (network in flight), resolved = also fine, rejected =
    // wiring bug (missing TemplateSync, command handler threw).
    const out = await raceWithDeadline(
      vscode.commands.executeCommand('caramelo.syncTemplates'),
      5000,
    );
    if (out.settled === 'rejected') {
      assert.fail(
        `syncTemplates rejected: ${(out.error as Error)?.message ?? String(out.error)}`,
      );
    }
  });

  test('configuration schema exposes documented caramelo settings', () => {
    const cfg = vscode.workspace.getConfiguration();
    assert.strictEqual(typeof cfg.get('caramelo.useAgentLoop'), 'boolean');
    assert.strictEqual(typeof cfg.get('caramelo.enableBashTool'), 'boolean');
    assert.strictEqual(typeof cfg.get('caramelo.autoApplyEdits'), 'boolean');
    assert.strictEqual(typeof cfg.get('caramelo.sse.timeoutMs'), 'number');
  });
});
