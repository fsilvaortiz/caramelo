import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getApi } from './helpers/api.js';
import { MockAnthropicServer, taskLine, toolResults, type MessagesRequestBody, type MockTurn } from './helpers/mock-llm-server.js';
import { clearConstitution, removeSpec, seedConstitution, seedSpec, workspaceRoot } from './helpers/workspace.js';

/**
 * End-to-end: real ClaudeProvider → local mock Anthropic server, driven
 * through startTask and the agent loop in a real extension host.
 *
 * Covers what the in-process MockLLMProvider cannot: request
 * cancellation inside the real adapter (parallel [P] tasks used to abort
 * each other — "This operation was aborted"), SSE/tool_use decoding,
 * and the shell approval rules (read-only auto-approval, Always allow,
 * don't ask again this session).
 */
suite('Agent loop with a real provider against a mock LLM server', () => {
  const server = new MockAnthropicServer();
  let api: Awaited<ReturnType<typeof getApi>>;
  let providerId: string;
  let previousActive: string | undefined;
  const cfg = () => vscode.workspace.getConfiguration();
  let savedAgentLoop: unknown;

  // The agent's shell tool runs `/bin/sh -c`, which does not exist on
  // Windows yet (spec 008-cross-platform-agent-shell).
  const skipOnWindows = (ctx: Mocha.Context) => {
    if (process.platform === 'win32') ctx.skip();
  };

  suiteSetup(async function () {
    this.timeout(60_000);
    const endpoint = await server.start();
    api = await getApi();
    previousActive = api.registry.activeProvider?.id;

    const { ClaudeProvider } = await import('../../providers/claude.js');
    const secrets = {
      get: async () => 'test-key',
      store: async () => { /* noop */ },
      delete: async () => { /* noop */ },
      onDidChange: () => ({ dispose: () => { /* noop */ } }),
    };
    const provider = new ClaudeProvider(
      { id: 'e2e-claude-mock-server', name: 'Claude (mock server)', endpoint, model: 'mock-model', apiKeyId: 'e2e' },
      secrets as never,
    );
    assert.ok(await provider.authenticate(), 'provider should authenticate with the stub secret');
    providerId = provider.id;
    api.registry.register(provider);
    await api.registry.setActive(providerId);

    savedAgentLoop = cfg().inspect('caramelo.useAgentLoop')?.workspaceValue;
    await cfg().update('caramelo.useAgentLoop', true, vscode.ConfigurationTarget.Workspace);
    seedConstitution();
  });

  suiteTeardown(async () => {
    await cfg().update('caramelo.useAgentLoop', savedAgentLoop, vscode.ConfigurationTarget.Workspace);
    await cfg().update('caramelo.agent.bashAllowList', undefined, vscode.ConfigurationTarget.Workspace);
    try { api.registry.unregister(providerId); } catch { /* ignore */ }
    if (previousActive) await api.registry.setActive(previousActive).catch(() => { /* ignore */ });
    clearConstitution();
    await server.stop();
  });

  let restoreDialogs: (() => void) | undefined;
  setup(async () => {
    server.reset();
    const { resetBashSessionApproval } = await import('../../agent/approval.js');
    resetBashSessionApproval();
    await cfg().update('caramelo.agent.bashAllowList', undefined, vscode.ConfigurationTarget.Workspace);
  });
  teardown(() => {
    restoreDialogs?.();
    restoreDialogs = undefined;
  });

  /**
   * Replace the modal shell-approval dialog. Every call is recorded; the
   * stub answers with `answer(buttons)`. Without a stub an unexpected
   * modal would hang the test until its timeout, which is how tests
   * below prove that NO prompt was shown.
   */
  function stubShellPrompt(answer: (buttons: string[]) => string | undefined): Array<{ message: string; buttons: string[] }> {
    const shown: Array<{ message: string; buttons: string[] }> = [];
    const win = vscode.window as unknown as { showWarningMessage: (...a: unknown[]) => Thenable<unknown> };
    const original = win.showWarningMessage;
    win.showWarningMessage = (message: unknown, ...rest: unknown[]) => {
      const options = rest[0];
      const isModal = typeof options === 'object' && options !== null && (options as { modal?: boolean }).modal;
      if (!isModal || !String(message).startsWith('Caramelo agent wants to run')) {
        return original.call(vscode.window, message, ...rest);
      }
      const buttons = rest.slice(1).map(String);
      shown.push({ message: String(message), buttons });
      return Promise.resolve(answer(buttons));
    };
    restoreDialogs = () => { win.showWarningMessage = original; };
    return shown;
  }

  /** Two-turn script per task: run `command` through the shell tool, then finish. */
  function shellThenDone(commandFor: (task: string) => string | null, delayMs = 0) {
    return (body: MessagesRequestBody): MockTurn => {
      if (toolResults(body).length > 0) return { text: 'Done.' };
      const command = commandFor(taskLine(body));
      return command ? { toolUse: { name: 'bash', input: { command } }, delayMs } : { text: 'Nothing to do.' };
    };
  }

  async function runTask(spec: { dir: string }, line: number, text: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(path.join(spec.dir, 'tasks.md'));
    const { startTask } = await import('../../commands/start-task.js');
    await startTask(line, text, doc.uri, api.registry as never);
  }

  const resultFor = (task: string) =>
    server.requests
      .filter((r) => taskLine(r.body).startsWith(`Task: ${task}`))
      .flatMap((r) => toolResults(r.body))
      .join('\n');

  test('parallel [P] tasks on one real provider do not abort each other', async function () {
    skipOnWindows(this);
    this.timeout(60_000);
    const spec = seedSpec({
      files: {
        tasks: [
          '- [ ] [P] T1 First parallel task',
          '- [ ] [P] T2 Second parallel task',
          '- [ ] [P] T3 Third parallel task',
          '',
        ].join('\n'),
      },
    });
    // Each first turn holds its stream open so the three requests overlap.
    server.setHandler(shellThenDone(() => 'pwd', 400));
    try {
      await Promise.allSettled([
        runTask(spec, 0, '[P] T1 First parallel task'),
        runTask(spec, 1, '[P] T2 Second parallel task'),
        runTask(spec, 2, '[P] T3 Third parallel task'),
      ]);

      const aborted = server.requests.filter((r) => r.aborted).map((r) => taskLine(r.body));
      assert.deepStrictEqual(aborted, [], `no request may be cancelled by a sibling task; aborted: ${aborted.join(' | ')}`);
      assert.strictEqual(server.requests.length, 6, 'each task makes a tool turn and a final turn');
      const tasks = fs.readFileSync(path.join(spec.dir, 'tasks.md'), 'utf-8');
      for (const id of ['T1', 'T2', 'T3']) {
        assert.ok(new RegExp(`- \\[x\\] \\[P\\] ${id}`).test(tasks), `${id} must be ticked. tasks.md:\n${tasks}`);
      }
    } finally {
      removeSpec(spec);
    }
  });

  test('read-only shell commands run without a prompt and their output reaches the LLM', async function () {
    skipOnWindows(this);
    this.timeout(30_000);
    const marker = `e2e-marker-${Date.now()}.txt`;
    fs.writeFileSync(path.join(workspaceRoot(), marker), 'x');
    const spec = seedSpec({ files: { tasks: '- [ ] T1 Inspect the workspace\n' } });
    const prompts = stubShellPrompt(() => 'Abort run');
    server.setHandler(shellThenDone(() => 'ls -a && git status 2>/dev/null; pwd'));
    try {
      await runTask(spec, 0, 'T1 Inspect the workspace');
      assert.strictEqual(prompts.length, 0, 'read-only commands must not prompt');
      assert.ok(resultFor('T1').includes(marker), `ls output must be sent back as tool_result; got: ${resultFor('T1')}`);
    } finally {
      fs.rmSync(path.join(workspaceRoot(), marker), { force: true });
      removeSpec(spec);
    }
  });

  test('a command that writes a file still prompts, and "Skip" keeps it from running', async function () {
    skipOnWindows(this);
    this.timeout(30_000);
    const target = `e2e-should-not-exist-${Date.now()}.txt`;
    const spec = seedSpec({ files: { tasks: '- [ ] T1 Write a file\n' } });
    const prompts = stubShellPrompt(() => 'Skip');
    server.setHandler(shellThenDone(() => `echo hi > ${target}`));
    try {
      await runTask(spec, 0, 'T1 Write a file');
      assert.strictEqual(prompts.length, 1, 'redirection must prompt');
      assert.ok(!prompts[0].buttons.some((b) => b.startsWith('Always allow')), 'no "Always allow" for redirection');
      assert.ok(!fs.existsSync(path.join(workspaceRoot(), target)), 'skipped command must not run');
    } finally {
      removeSpec(spec);
    }
  });

  test('"Always allow" saves the rule and the next matching command runs without a prompt', async function () {
    skipOnWindows(this);
    this.timeout(40_000);
    const spec = seedSpec({ files: { tasks: '- [ ] T1 Check git\n- [ ] T2 Check git again\n' } });
    const prompts = stubShellPrompt((buttons) => buttons.find((b) => b.startsWith('Always allow')));
    server.setHandler(shellThenDone((task) => (task.startsWith('Task: T1') ? 'git --version' : 'git --version --build-options')));
    try {
      await runTask(spec, 0, 'T1 Check git');
      assert.strictEqual(prompts.length, 1);
      assert.ok(prompts[0].buttons.includes('Always allow "git --version"'), `buttons: ${prompts[0].buttons.join(', ')}`);
      assert.deepStrictEqual(
        cfg().inspect<string[]>('caramelo.agent.bashAllowList')?.workspaceValue,
        ['git --version'],
        'rule must be saved to workspace settings',
      );
      assert.ok(/git version/.test(resultFor('T1')), `command must have run; got: ${resultFor('T1')}`);

      await runTask(spec, 1, 'T2 Check git again');
      assert.strictEqual(prompts.length, 1, 'the saved rule must cover the second command');
      assert.ok(/git version/.test(resultFor('T2')), `second command must have run; got: ${resultFor('T2')}`);
    } finally {
      removeSpec(spec);
    }
  });

  test('"don\'t ask again this session" approves every later command', async function () {
    skipOnWindows(this);
    this.timeout(40_000);
    const spec = seedSpec({ files: { tasks: '- [ ] T1 First command\n- [ ] T2 Different command\n' } });
    const prompts = stubShellPrompt((buttons) => buttons.find((b) => b.includes("don't ask again this session")));
    server.setHandler(shellThenDone((task) => (task.startsWith('Task: T1') ? 'git --version' : 'echo session-approved')));
    try {
      await runTask(spec, 0, 'T1 First command');
      await runTask(spec, 1, 'T2 Different command');
      assert.strictEqual(prompts.length, 1, 'only the first command may prompt');
      assert.ok(resultFor('T2').includes('session-approved'), `second command must have run; got: ${resultFor('T2')}`);
      assert.strictEqual(cfg().inspect('caramelo.agent.bashAllowList')?.workspaceValue, undefined, 'session approval saves nothing');
    } finally {
      removeSpec(spec);
    }
  });
});
