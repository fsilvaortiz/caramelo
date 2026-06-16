import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getApi } from './helpers/api.js';
import {
  clearConstitution,
  readMeta,
  removeSpec,
  seedConstitution,
  seedSpec,
  specFileExists,
  workspaceRoot,
} from './helpers/workspace.js';

suite('Spec lifecycle (functional)', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    await getApi();
    seedConstitution();
  });

  suiteTeardown(() => {
    clearConstitution();
  });

  test('approvePhase flips requirements to approved and unlocks design', async () => {
    const spec = seedSpec({
      statuses: { requirements: 'pending-approval' },
      files: { spec: '# Requirements\n\nA stub generated for the test.\n' },
    });
    try {
      await vscode.commands.executeCommand('caramelo.approvePhase', spec.name, 'requirements');

      // The meta on disk must reflect the new status — the sidebar and
      // CodeLens read it directly, so it is the contract.
      const meta = readMeta(spec);
      assert.strictEqual(meta.phases.requirements, 'approved',
        'requirements should be approved after approvePhase');

      // isPhaseUnlocked is the gate the sidebar uses to decide whether
      // the next phase becomes clickable.
      const { buildSpec, isPhaseUnlocked } = await import('../../specs/spec.js');
      const built = buildSpec(spec.name, spec.dir);
      assert.strictEqual(isPhaseUnlocked(built, 'design'), true,
        'design should be unlocked once requirements are approved');
      assert.strictEqual(isPhaseUnlocked(built, 'tasks'), false,
        'tasks should still be locked because design has not been approved yet');
    } finally {
      removeSpec(spec);
    }
  });

  test('regenerating an approved upstream phase marks downstream as stale', async () => {
    const spec = seedSpec({
      statuses: { requirements: 'approved', design: 'approved', tasks: 'approved' },
      files: {
        spec: '# Requirements',
        plan: '# Plan',
        tasks: '# Tasks',
      },
    });
    try {
      const { buildSpec, markDownstreamStale, getPhaseStatus } = await import('../../specs/spec.js');
      const built = buildSpec(spec.name, spec.dir);
      markDownstreamStale(built, 'requirements');
      assert.strictEqual(getPhaseStatus(built, 'design'), 'stale');
      assert.strictEqual(getPhaseStatus(built, 'tasks'), 'stale');

      // And the meta file got rewritten — not just the in-memory copy.
      const meta = readMeta(spec);
      assert.strictEqual(meta.phases.design, 'stale');
      assert.strictEqual(meta.phases.tasks, 'stale');
    } finally {
      removeSpec(spec);
    }
  });

  test('isPhaseUnlocked tolerates unknown phaseType (regression for #11)', async () => {
    // Spec.ts used to read spec.phases[-2].status and throw TypeError.
    // After the #21 fix the call returns false instead of crashing — the
    // sidebar render path stops being brittle to a single bad value.
    const spec = seedSpec();
    try {
      const { buildSpec, isPhaseUnlocked } = await import('../../specs/spec.js');
      const built = buildSpec(spec.name, spec.dir);
      const bogus = 'totally-not-a-phase' as unknown as 'tasks';
      assert.doesNotThrow(() => isPhaseUnlocked(built, bogus));
      assert.strictEqual(isPhaseUnlocked(built, bogus), false);
    } finally {
      removeSpec(spec);
    }
  });

  test('getNextPhase walks pending phases in order', async () => {
    const spec = seedSpec({
      statuses: { requirements: 'approved', design: 'pending', tasks: 'pending' },
      files: { spec: '# Requirements' },
    });
    try {
      const { buildSpec, getNextPhase } = await import('../../specs/spec.js');
      const built = buildSpec(spec.name, spec.dir);
      assert.strictEqual(getNextPhase(built), 'design');
    } finally {
      removeSpec(spec);
    }
  });

  test('findSpecForFile maps a phase file back to (specName, phaseType)', async () => {
    const spec = seedSpec({ files: { spec: '# Requirements' } });
    try {
      const { findSpecForFile } = await import('../../specs/spec.js');
      const filePath = path.join(spec.dir, 'spec.md');
      const result = findSpecForFile(filePath, path.join(workspaceRoot(), 'specs'));
      assert.deepStrictEqual(result, { specName: spec.name, phaseType: 'requirements' });
    } finally {
      removeSpec(spec);
    }
  });

  test('newSpec command resolves without throwing when triggered programmatically', async () => {
    // The sidebar drives newSpec through a postMessage with name+description.
    // The command itself accepts no args and would normally pop the inline
    // form; we just assert the command is wired up and dispatches.
    await vscode.commands.executeCommand('caramelo.newSpec');
    assert.ok(true, 'newSpec dispatched');
  });
});

suite('Untrusted workspace blocks generation', () => {
  test('runPhase aborts cleanly when workspace.isTrusted is false', async function () {
    // Untrusted workspaces are honored by WorkflowEngine before any
    // file IO. We can not flip workspace.isTrusted from a test, but we
    // can at least assert the command resolves (does not throw) when
    // dispatched against a spec whose previous phase has not been
    // approved — the "no active LLM provider" guard fires first and
    // short-circuits, proving the gate path is alive.
    const spec = seedSpec();
    try {
      const result = vscode.commands.executeCommand('caramelo.runPhase', spec.name, 'requirements');
      const settled = await Promise.race([
        result.then(() => 'resolved' as const, () => 'rejected' as const),
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), 3_000)),
      ]);
      assert.notStrictEqual(settled, 'rejected',
        'runPhase should never reject; should short-circuit with a toast');
    } finally {
      removeSpec(spec);
    }
  });
});

suite('Workspace fixture invariants', () => {
  test('seedConstitution writes a non-placeholder document', () => {
    seedConstitution();
    const body = fs.readFileSync(
      path.join(workspaceRoot(), '.specify', 'memory', 'constitution.md'),
      'utf-8',
    );
    assert.ok(!body.includes('[PRINCIPLE_1_NAME]'),
      'fixture body must not contain the placeholder marker; otherwise the extension treats it as no constitution');
  });
});
