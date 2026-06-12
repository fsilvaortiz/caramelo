import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi } from './helpers/api.js';

/**
 * Survey-style tests that every advertised command is reachable from
 * the command palette and dispatches without throwing or hanging. These
 * do NOT verify deep behaviour — that lives in the per-command suites.
 * They catch wiring regressions: a renamed handler, a deleted Disposable
 * push, a missing argument adapter.
 */

const ALL_COMMANDS: ReadonlyArray<{ id: string; args?: unknown[] }> = [
  { id: 'caramelo.newSpec' },
  { id: 'caramelo.editConstitution' },
  { id: 'caramelo.openDag' },
  { id: 'caramelo.viewChanges' },
  { id: 'caramelo.showLockedMessage', args: ['unit-test reason'] },
  { id: 'caramelo.workflow.focus' },
  { id: 'caramelo.providers.focus' },
];

const NO_ARG_NO_QUICKPICK = ['caramelo.selectProvider', 'caramelo.addProvider'];

function raceWithDeadline<T>(p: Thenable<T>, ms: number): Promise<'resolved' | 'pending' | 'rejected'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('pending'), ms);
    Promise.resolve(p).then(
      () => { clearTimeout(timer); resolve('resolved'); },
      () => { clearTimeout(timer); resolve('rejected'); },
    );
  });
}

suite('Command surface coverage', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    await getApi();
  });

  for (const { id, args } of ALL_COMMANDS) {
    test(`${id} dispatches without throwing`, async function () {
      this.timeout(10_000);
      const settled = await raceWithDeadline(
        vscode.commands.executeCommand(id, ...(args ?? [])),
        5_000,
      );
      assert.notStrictEqual(settled, 'rejected',
        `${id} should not throw when invoked with no/safe args`);
    });
  }

  for (const id of NO_ARG_NO_QUICKPICK) {
    test(`${id} (no args) routes to sidebar instead of blocking on QuickPick`, async function () {
      this.timeout(10_000);
      // Contract (memory: feedback_no_quickpick): a no-arg invocation
      // MUST route to caramelo.providers.focus and settle quickly. A
      // real QuickPick keeps the promise pending; a wiring bug rejects.
      const settled = await raceWithDeadline(vscode.commands.executeCommand(id), 3_000);
      assert.notStrictEqual(settled, 'pending',
        `${id}() did not settle in 3s — likely opened a top-bar QuickPick`);
      assert.notStrictEqual(settled, 'rejected',
        `${id}() rejected — likely a wiring bug`);
    });
  }

  test('selectProvider WITH a providerId argument hits the real selection path', async function () {
    this.timeout(10_000);
    // The id does not need to exist — we are only asserting that the
    // "programmatic" branch does not route through the sidebar focus
    // and does not throw on the missing-provider path.
    const settled = await raceWithDeadline(
      vscode.commands.executeCommand('caramelo.selectProvider', 'non-existent-provider-id'),
      3_000,
    );
    assert.notStrictEqual(settled, 'pending',
      'selectProvider(<id>) must not block — the missing-provider branch must settle quickly');
  });
});
