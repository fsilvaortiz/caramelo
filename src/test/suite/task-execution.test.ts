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
  workspaceRoot,
} from './helpers/workspace.js';

/**
 * Build a CREATE block in the new task-edit protocol (see
 * src/commands/task-edits/parser.ts). The pre-0.0.9 "whole-file FILE"
 * shape is now a LegacyFormatError; use this for any *new* file write.
 * For modifying an existing file, use SEARCH/REPLACE inside FILE.
 */
function createBlock(relPath: string, content: string): string {
  return `=== CREATE: ${relPath} ===\n${content}=== END CREATE ===\n`;
}

suite('Task execution with mock LLM', () => {
  let mock: MockLLMProvider;
  let uninstall: () => void;

  suiteSetup(async function () {
    this.timeout(60_000);
    const installed = await installMockProvider({ id: 'mock-tasks', displayName: 'Mock (tasks)' });
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

  test('startTask applies a single FILE block from the mock and ticks the checkbox', async function () {
    this.timeout(20_000);
    const spec = seedSpec({
      files: { tasks: '- [ ] T1 Create the greeting module\n' },
    });
    const tasksDocPath = path.join(spec.dir, 'tasks.md');
    const outFile = `tmp-startTask-${Date.now()}.txt`;
    mock.queueReply(createBlock(outFile, 'hello world\n'));

    try {
      const doc = await vscode.workspace.openTextDocument(tasksDocPath);
      const { startTask } = await import('../../commands/start-task.js');
      const api = await getApi();
      await startTask(0, 'T1 Create the greeting module', doc.uri, api.registry as never);

      const absOut = path.join(workspaceRoot(), outFile);
      assert.ok(fs.existsSync(absOut), `mock-driven file write should land on disk at ${absOut}`);
      const body = fs.readFileSync(absOut, 'utf-8');
      // The applier may strip a single trailing newline; match contents
      // tolerantly so the assertion documents intent rather than
      // serialization detail.
      assert.ok(body === 'hello world\n' || body === 'hello world',
        `expected file content "hello world" (with or without trailing newline), got ${JSON.stringify(body)}`);
      fs.unlinkSync(absOut);

      // tasks.md should have its checkbox flipped to [x] (markTaskComplete).
      const refreshed = fs.readFileSync(tasksDocPath, 'utf-8');
      assert.ok(refreshed.includes('- [x] T1'),
        `expected the checkbox to be ticked after the task finished. tasks.md=${refreshed}`);
    } finally {
      removeSpec(spec);
    }
  });

  test('parallel batch survives a single failing task (regression for #19)', async function () {
    this.timeout(40_000);
    const ok1 = `tmp-allsettled-ok1-${Date.now()}.txt`;
    const ok2 = `tmp-allsettled-ok2-${Date.now()}.txt`;
    const tasksBody = [
      '- [ ] [P] T1 First parallel task',
      '- [ ] [P] T2 Second parallel task (will fail)',
      '- [ ] [P] T3 Third parallel task',
      '',
    ].join('\n');
    const spec = seedSpec({ files: { tasks: tasksBody } });

    // Match on the `Task: ` first line specifically — the rest of the
    // user message contains tasks.md as context, which mentions every
    // task line, so substring matching on the whole body would be
    // ambiguous and the wrong reply would land for siblings.
    mock.setDispatcher((messages) => {
      const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
      const firstLine = userMsg.split('\n', 1)[0];
      if (firstLine.startsWith('Task: T1 First')) return { reply: createBlock(ok1, 'one\n') };
      if (firstLine.startsWith('Task: T2 Second')) return { error: new Error('simulated LLM 500') };
      if (firstLine.startsWith('Task: T3 Third')) return { reply: createBlock(ok2, 'three\n') };
      return null;
    });

    try {
      const doc = await vscode.workspace.openTextDocument(path.join(spec.dir, 'tasks.md'));
      await vscode.window.showTextDocument(doc);
      const { startTask } = await import('../../commands/start-task.js');
      const api = await getApi();

      // Mirror what runAllTasks does for a [P] batch: Promise.allSettled
      // so a failure does not lose the surviving tasks' work.
      await Promise.allSettled([
        startTask(0, 'T1 First parallel task', doc.uri, api.registry as never),
        startTask(1, 'T2 Second parallel task (will fail)', doc.uri, api.registry as never),
        startTask(2, 'T3 Third parallel task', doc.uri, api.registry as never),
      ]);

      const root = workspaceRoot();
      assert.ok(fs.existsSync(path.join(root, ok1)),
        `T1 must have written its file; LLM call count=${mock.calls.length}`);
      assert.ok(fs.existsSync(path.join(root, ok2)),
        `T3 must have written its file even though T2 errored; call count=${mock.calls.length}`);
      try { fs.unlinkSync(path.join(root, ok1)); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(root, ok2)); } catch { /* ignore */ }
    } finally {
      removeSpec(spec);
    }
  });

  test('falls back to "find by text" when the line number is stale', async function () {
    this.timeout(20_000);
    const spec = seedSpec({
      files: {
        tasks: [
          '## Pre-existing tasks',
          '- [x] T0 Already done',
          '- [ ] T1 The task we will run',
          '',
        ].join('\n'),
      },
    });
    const tasksDocPath = path.join(spec.dir, 'tasks.md');
    const outFile = `tmp-stale-line-${Date.now()}.txt`;
    mock.queueReply(createBlock(outFile, 'ok\n'));

    try {
      // Sanity-check before calling startTask: the seed actually wrote tasks.md.
      assert.ok(fs.existsSync(tasksDocPath), `seedSpec should have written ${tasksDocPath}`);

      const doc = await vscode.workspace.openTextDocument(tasksDocPath);
      const { startTask } = await import('../../commands/start-task.js');
      const api = await getApi();
      // Pass an out-of-range line number (50) so strategy-1 misses
      // and strategy-2 ("find by text") must kick in.
      await startTask(50, 'T1 The task we will run', doc.uri, api.registry as never);

      assert.ok(fs.existsSync(tasksDocPath),
        `tasks.md should still exist after startTask. dir contents: ${
          fs.existsSync(spec.dir) ? fs.readdirSync(spec.dir).join(', ') : '(spec dir gone)'
        }`);
      const refreshed = fs.readFileSync(tasksDocPath, 'utf-8');
      assert.ok(/\- \[x\] T1/.test(refreshed),
        `expected T1 to be ticked via the fallback strategy. Got: ${refreshed}`);

      const absOut = path.join(workspaceRoot(), outFile);
      if (fs.existsSync(absOut)) fs.unlinkSync(absOut);
    } finally {
      removeSpec(spec);
    }
  });
});
