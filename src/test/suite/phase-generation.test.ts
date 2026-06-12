import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi, installMockProvider } from './helpers/api.js';
import type { MockLLMProvider } from './helpers/mock-provider.js';
import {
  clearConstitution,
  readMeta,
  readSpecFile,
  removeSpec,
  seedConstitution,
  seedSpec,
  specFileExists,
} from './helpers/workspace.js';

/**
 * Phase generation tests call `commands/run-phase.ts` directly. The
 * registered VS Code command (`caramelo.runPhase`) discards the returned
 * promise (fire-and-forget), so awaiting `executeCommand` resolves
 * before the LLM round-trip finishes. Wiring of the command itself is
 * covered by commands-surface.test.ts; here we exercise the engine.
 */
suite('Phase generation with mock LLM', () => {
  let mock: MockLLMProvider;
  let uninstall: () => void;
  let workspace: unknown;
  let workflowEngine: unknown;
  let templateManager: unknown;
  let registry: unknown;

  suiteSetup(async function () {
    this.timeout(60_000);
    const installed = await installMockProvider({ id: 'mock-phase', displayName: 'Mock (phase-gen)' });
    mock = installed.mock;
    uninstall = installed.uninstall;
    seedConstitution();

    const api = await getApi();
    const { SpecWorkspace } = await import('../../specs/workspace.js');
    workspace = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);
    workflowEngine = api.workflowEngine;
    templateManager = api.templateManager;
    registry = api.registry;
  });

  suiteTeardown(() => {
    uninstall?.();
    clearConstitution();
  });

  setup(() => {
    mock.reset();
  });

  async function runPhaseDirect(specName: string, phaseType: 'requirements' | 'design' | 'tasks'): Promise<void> {
    const { runPhase } = await import('../../commands/run-phase.js');
    await runPhase(
      specName,
      phaseType,
      workspace as never,
      registry as never,
      templateManager as never,
      workflowEngine as never,
      { refresh: () => { /* noop */ } } as never,
    );
  }

  test('writes spec.md from mock LLM output and marks phase pending-approval', async function () {
    this.timeout(20_000);
    mock.queueReply('# Feature requirements\n\n- The system shall do the thing.\n');

    const spec = seedSpec({ statuses: { requirements: 'pending' } });
    try {
      await runPhaseDirect(spec.name, 'requirements');

      const onDisk = readSpecFile(spec, 'spec.md');
      assert.ok(onDisk, 'spec.md should exist after runPhase');
      assert.ok(onDisk!.includes('The system shall do the thing'),
        `spec.md should contain the LLM output. Got: ${onDisk!.slice(0, 200)}…`);

      assert.strictEqual(mock.calls.length, 1, 'mock should have been called once');
      const sys = mock.calls[0].messages.find((m) => m.role === 'system');
      assert.ok(sys, 'system message should be present');

      const meta = readMeta(spec);
      assert.strictEqual(meta.phases.requirements, 'pending-approval');
    } finally {
      removeSpec(spec);
    }
  });

  test('design phase uses the plan template and writes plan.md', async function () {
    this.timeout(20_000);
    mock.queueReply('# Plan\n\n1. Sketch the data model\n2. Carve the API\n');

    const spec = seedSpec({
      statuses: { requirements: 'approved', design: 'pending' },
      files: { spec: '# Requirements\n\nApproved.\n' },
    });
    try {
      await runPhaseDirect(spec.name, 'design');
      const plan = readSpecFile(spec, 'plan.md');
      assert.ok(plan, 'plan.md should exist after design phase');
      assert.ok(plan!.includes('Sketch the data model'),
        'plan.md should contain the LLM output');
      assert.strictEqual(readMeta(spec).phases.design, 'pending-approval');
    } finally {
      removeSpec(spec);
    }
  });

  test('streams chunks through the AsyncIterable (chunked output)', async function () {
    this.timeout(20_000);
    mock.queueReply('# Requirements\n\nA chunked body for streaming.', /* chunkSize */ 7);

    const spec = seedSpec();
    try {
      await runPhaseDirect(spec.name, 'requirements');
      const body = readSpecFile(spec, 'spec.md');
      assert.ok(body?.includes('chunked body for streaming'),
        `expected chunked body to survive aggregation, got: ${body?.slice(0, 200)}`);
    } finally {
      removeSpec(spec);
    }
  });

  test('short-circuits cleanly when no active provider is configured', async function () {
    this.timeout(10_000);
    // Briefly uninstall the mock to exercise the "no provider" branch.
    uninstall();
    const spec = seedSpec();
    try {
      await runPhaseDirect(spec.name, 'requirements');
      assert.strictEqual(specFileExists(spec, 'spec.md'), false,
        'no provider → no file should be written');
    } finally {
      // Re-install for the next test in the suite.
      const reinstalled = await installMockProvider({ id: 'mock-phase', displayName: 'Mock (phase-gen)' });
      mock = reinstalled.mock;
      uninstall = reinstalled.uninstall;
      removeSpec(spec);
    }
  });

  test('regenerate path overwrites the prior file with fresh LLM output', async function () {
    this.timeout(20_000);
    mock.queueReply('# Regenerated requirements\n\nFresh content.\n');
    const spec = seedSpec({
      statuses: { requirements: 'pending-approval' },
      files: { spec: 'stale content' },
    });
    try {
      await runPhaseDirect(spec.name, 'requirements');
      const body = readSpecFile(spec, 'spec.md');
      assert.ok(body?.includes('Fresh content'),
        'regenerate path should overwrite the file with the new LLM output');
    } finally {
      removeSpec(spec);
    }
  });
});
