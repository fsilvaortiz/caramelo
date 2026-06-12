import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getApi, installMockProvider } from './helpers/api.js';
import {
  clearConstitution,
  removeSpec,
  seedConstitution,
  seedSpec,
  workspaceRoot,
} from './helpers/workspace.js';

/**
 * Regression guards for the v0.1.3 bug-hunt fixes (#11, #12-14+20, #15-18, #19, #25).
 * Unit tests in src/ cover the leaf logic; these tests cover the full
 * extension-host code path so a future refactor that breaks the wiring
 * is caught even if the leaf module still has a green unit suite.
 */

suite('Regression: #11 — isPhaseUnlocked tolerates unknown phaseType', () => {
  test('isPhaseUnlocked returns false instead of crashing the sidebar render path', async () => {
    const spec = seedSpec({ statuses: { requirements: 'approved' } });
    try {
      const { buildSpec, isPhaseUnlocked } = await import('../../specs/spec.js');
      const built = buildSpec(spec.name, spec.dir);
      // The pre-fix behaviour was `spec.phases[-2].status` → TypeError.
      assert.doesNotThrow(() => isPhaseUnlocked(built, 'lol' as unknown as 'tasks'));
      assert.strictEqual(isPhaseUnlocked(built, 'lol' as unknown as 'tasks'), false);
      // Reordered phases still resolve correctly via type lookup.
      built.phases.reverse();
      assert.strictEqual(isPhaseUnlocked(built, 'design'), true,
        'design should remain unlocked after we shuffle the phases array');
    } finally {
      removeSpec(spec);
    }
  });
});

suite('Regression: #17, #18 — Jira client tolerates non-JSON and malformed payloads', () => {
  test('safeJson surfaces a clear error when the response is HTML', async () => {
    // Drive the failure mode directly so we do not need a Jira instance.
    const { JiraClient } = await import('../../jira/jira-client.js');
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response('<html>SSO challenge</html>', {
        status: 200, headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;
      const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token');
      await assert.rejects(client.getBoards(), /non-JSON response/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('getBoards drops malformed entries instead of crashing', async () => {
    const { JiraClient } = await import('../../jira/jira-client.js');
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        values: [
          { id: 1, name: 'Good', type: 'scrum' },
          { id: 2 /* missing name and type */ },
          { id: 3, name: 'Other', type: 'kanban' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
      const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token');
      const boards = await client.getBoards();
      assert.deepStrictEqual(boards.map((b) => b.id), ['1', '3']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

suite('Regression: #16 — acceptance-criteria heuristic is bounded against ReDoS', () => {
  test('adversarial "given/when/no-then" input completes in <200ms', async function () {
    this.timeout(2_000);
    // Same shape as the unit test in src/jira/__tests__/jira-client.test.ts
    // but exercised through the live extension-host module graph.
    const { JiraClient } = await import('../../jira/jira-client.js');
    const adversarial = 'given a user when they do ' + 'x '.repeat(5000);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        issues: [{
          key: 'PROJ-1',
          fields: {
            summary: 'foo', description: adversarial,
            status: { name: 'Open' }, assignee: null,
          },
        }],
        total: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
      const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token', '42');
      const start = Date.now();
      const result = await client.searchIssues();
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 200,
        `acceptance-criteria regex should not backtrack catastrophically — took ${elapsed}ms`);
      assert.strictEqual(result.issues[0].acceptanceCriteria, '',
        'no real "then" in the input → no criteria should have been extracted');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

suite('Regression: #25 — buildTaskContext emits POSIX paths on every platform', () => {
  test('no spec / file label ever contains a backslash', async () => {
    const { buildTaskContext } = await import('../../commands/task-edits/context.js');
    const root = workspaceRoot();
    const specDir = path.join(root, 'specs', 'reg-25');
    fs.mkdirSync(specDir, { recursive: true });
    const tmpSpec = path.join(specDir, 'spec.md');
    const tmpCode = path.join(root, 'src', 'reg25.ts');
    fs.writeFileSync(tmpSpec, '# Spec\n\nSee `src/reg25.ts`.\n', 'utf-8');
    fs.mkdirSync(path.dirname(tmpCode), { recursive: true });
    fs.writeFileSync(tmpCode, 'export const x = 1;\n', 'utf-8');

    try {
      const ctx = buildTaskContext({
        specDir,
        workspaceRoot: root,
        taskText: 'Edit `src/reg25.ts`',
      });
      for (const file of ctx.includedFiles) {
        assert.strictEqual(file.includes('\\'), false,
          `includedFiles should not contain a backslash on any platform — got "${file}"`);
      }
      assert.strictEqual(ctx.text.match(/--- (SPEC|EXISTING FILE): [^\n]*\\/) === null, true,
        'context text labels should never contain backslash separators');
    } finally {
      fs.rmSync(specDir, { recursive: true, force: true });
      try { fs.unlinkSync(tmpCode); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(tmpCode)); } catch { /* may not be empty */ }
    }
  });
});

suite('Regression: #19 — parallel startTask survives a single failure', () => {
  test('Promise.allSettled-shape: two successes survive a sibling that throws', async function () {
    this.timeout(30_000);
    const installed = await installMockProvider({ id: 'mock-reg19' });
    seedConstitution();
    const spec = seedSpec({
      files: {
        tasks: [
          '- [ ] [P] T1 First',
          '- [ ] [P] T2 Will fail',
          '- [ ] [P] T3 Third',
        ].join('\n'),
      },
    });
    const ok1 = `tmp-reg19-ok1-${Date.now()}.txt`;
    const ok2 = `tmp-reg19-ok2-${Date.now()}.txt`;
    const block = (p: string, c: string) => `=== CREATE: ${p} ===\n${c}=== END CREATE ===\n`;
    installed.mock.setDispatcher((messages) => {
      const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
      const firstLine = userMsg.split('\n', 1)[0];
      if (firstLine.startsWith('Task: T1 First')) return { reply: block(ok1, 'one\n') };
      if (firstLine.startsWith('Task: T2 Will fail')) return { error: new Error('simulated LLM error') };
      if (firstLine.startsWith('Task: T3 Third')) return { reply: block(ok2, 'three\n') };
      return null;
    });

    try {
      const doc = await vscode.workspace.openTextDocument(path.join(spec.dir, 'tasks.md'));
      const { startTask } = await import('../../commands/start-task.js');
      const api = await getApi();
      // Mirror the runAllTasks parallel batch shape — Promise.allSettled
      // is the contract that #19 added.
      await Promise.allSettled([
        startTask(0, 'T1 First', doc.uri, api.registry as never),
        startTask(1, 'T2 Will fail', doc.uri, api.registry as never),
        startTask(2, 'T3 Third', doc.uri, api.registry as never),
      ]);
      const root = workspaceRoot();
      assert.ok(fs.existsSync(path.join(root, ok1)), 'T1 must have written its file');
      assert.ok(fs.existsSync(path.join(root, ok2)), 'T3 must have written its file');
      try { fs.unlinkSync(path.join(root, ok1)); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(root, ok2)); } catch { /* ignore */ }
    } finally {
      removeSpec(spec);
      clearConstitution();
      installed.uninstall();
    }
  });
});
