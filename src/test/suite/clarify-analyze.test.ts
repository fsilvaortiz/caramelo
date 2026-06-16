import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getApi, installMockProvider } from './helpers/api.js';
import type { MockLLMProvider } from './helpers/mock-provider.js';
import {
  clearConstitution,
  removeSpec,
  seedConstitution,
  seedSpec,
} from './helpers/workspace.js';

/**
 * The clarify pipeline ends at a sidebar handoff (`workflowView.startClarify`)
 * that we cannot observe from outside. We test the parts we *can* observe:
 *   - the LLM provider is invoked with the spec contents,
 *   - the function does not throw for valid / empty / unparseable replies,
 *   - the analyze command writes analysis.md from the LLM JSON.
 * The branching inside parseQuestions / parseFindings is covered in
 * `src/commands/__tests__/clarify.test.ts` and clarify-orchestrator.test.ts
 * — this suite is the end-to-end glue check.
 */

suite('clarifySpec — extension-host end-to-end', () => {
  let mock: MockLLMProvider;
  let uninstall: () => void;

  suiteSetup(async function () {
    this.timeout(60_000);
    const installed = await installMockProvider({ id: 'mock-clarify', displayName: 'Mock (clarify)' });
    mock = installed.mock;
    uninstall = installed.uninstall;
    seedConstitution();
  });

  suiteTeardown(() => {
    uninstall?.();
    clearConstitution();
  });

  setup(() => {
    mock.reset();
  });

  test('calls the active LLM provider with the spec contents', async function () {
    this.timeout(20_000);
    mock.queueJsonReply([], { fence: true });

    const spec = seedSpec({
      statuses: { requirements: 'pending-approval' },
      files: { spec: '# Requirements\n\nA specific marker text 0xCAFE for the assert.\n' },
    });
    try {
      const { SpecWorkspace } = await import('../../specs/workspace.js');
      const { clarifySpec } = await import('../../commands/clarify.js');
      const api = await getApi();
      const ws = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);

      // A tiny stub matching the surface clarifySpec calls into.
      const startClarifyStub: { startClarify: (specName: string, specPath: string, questions: unknown[]) => Promise<void> } = {
        startClarify: async () => { /* not expected to be called for empty list */ },
      };

      await clarifySpec(spec.name, ws, api.registry as never, startClarifyStub as never);

      assert.strictEqual(mock.calls.length, 1, 'clarifySpec must invoke the provider exactly once');
      const userMsg = mock.calls[0].messages.find((m) => m.role === 'user');
      assert.ok(userMsg, 'a user message should be sent');
      assert.ok(userMsg!.content.includes('0xCAFE'),
        'the spec contents must be forwarded to the LLM');
    } finally {
      removeSpec(spec);
    }
  });

  test('returns cleanly on unparseable response (no thrown error reaches the host)', async function () {
    this.timeout(20_000);
    mock.queueReply('not even close to JSON');

    const spec = seedSpec({
      files: { spec: '# Requirements' },
    });
    try {
      const { SpecWorkspace } = await import('../../specs/workspace.js');
      const { clarifySpec } = await import('../../commands/clarify.js');
      const api = await getApi();
      const ws = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);

      let panelOpened = false;
      await clarifySpec(spec.name, ws, api.registry as never, {
        startClarify: async () => { panelOpened = true; },
      } as never);

      assert.strictEqual(panelOpened, false,
        'an unparseable response must not open the clarify panel');
    } finally {
      removeSpec(spec);
    }
  });
});

suite('analyzeConsistency — extension-host end-to-end', () => {
  let mock: MockLLMProvider;
  let uninstall: () => void;

  suiteSetup(async function () {
    this.timeout(60_000);
    const installed = await installMockProvider({ id: 'mock-analyze', displayName: 'Mock (analyze)' });
    mock = installed.mock;
    uninstall = installed.uninstall;
    seedConstitution();
  });

  suiteTeardown(() => {
    uninstall?.();
    clearConstitution();
  });

  setup(() => {
    mock.reset();
  });

  test('writes analysis.md with the findings from the LLM', async function () {
    this.timeout(30_000);
    const findings = [
      { severity: 'high', finding: 'Inconsistent term: "user" vs "actor"', documents: ['spec.md', 'plan.md'], section: 'Glossary' },
      { severity: 'low', finding: 'Tasks list mentions a step not in the plan', documents: ['plan.md', 'tasks.md'], section: 'Step 3' },
    ];
    mock.queueJsonReply(findings, { fence: true });

    const spec = seedSpec({
      files: {
        spec: '# Requirements\n\nThe user must do X.\n',
        plan: '# Plan\n\nThe actor performs X via step 1, 2, 3, 4.\n',
        tasks: '# Tasks\n\n- [ ] Step 1\n- [ ] Step 2\n- [ ] Step 3\n',
      },
    });
    try {
      const { SpecWorkspace } = await import('../../specs/workspace.js');
      const { analyzeConsistency } = await import('../../commands/analyze.js');
      const api = await getApi();
      const ws = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);
      await analyzeConsistency(spec.name, ws, api.registry as never);

      const analysisPath = path.join(spec.dir, 'analysis.md');
      assert.ok(fs.existsSync(analysisPath), 'analysis.md should be written by analyzeConsistency');
      const body = fs.readFileSync(analysisPath, 'utf-8');
      assert.ok(body.includes('Inconsistent term'),
        'analysis.md should embed the LLM finding text — got: ' + body.slice(0, 200));
    } finally {
      removeSpec(spec);
    }
  });

  test('empty findings still writes a report (so users see "no issues")', async function () {
    this.timeout(20_000);
    mock.queueJsonReply([], { fence: true });

    const spec = seedSpec({
      files: { spec: '# Requirements', plan: '# Plan' },
    });
    try {
      const { SpecWorkspace } = await import('../../specs/workspace.js');
      const { analyzeConsistency } = await import('../../commands/analyze.js');
      const api = await getApi();
      const ws = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);
      await analyzeConsistency(spec.name, ws, api.registry as never);

      const analysisPath = path.join(spec.dir, 'analysis.md');
      assert.ok(fs.existsSync(analysisPath),
        'analysis.md should be written even when no findings are returned');
    } finally {
      removeSpec(spec);
    }
  });
});
