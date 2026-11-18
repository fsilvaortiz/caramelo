import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getApi } from './helpers/api.js';
import { MockAnthropicServer, taskLine, toolResults, userText, type MessagesRequestBody, type MockTurn } from './helpers/mock-llm-server.js';
import { clearConstitution, readMeta, removeSpec, seedConstitution, seedSpec, workspaceRoot } from './helpers/workspace.js';

/**
 * The whole spec-driven flow, as a user runs it, against a real
 * ClaudeProvider talking to a local mock LLM server:
 *
 *   requirements → approve → design (agent writes contracts/) → approve
 *   → tasks (agent runs `ls`; optional after_tasks hook) → approve
 *   → Run All Tasks (sequential + [P] batch, each writes a file and runs
 *     a shell command) → Converge
 *
 * With default settings (no auto-apply, no saved rules), every dialog is
 * recorded. The user answers each kind of question once with its
 * "always" option; the test then asserts that NOTHING ELSE interrupted
 * them — no repeat prompts, no QuickPicks, no toast per task — and that
 * after a simulated reload the saved choices still hold.
 */
suite('Full SDD flow without needless interruptions (mock LLM server)', () => {
  const server = new MockAnthropicServer();
  let api: Awaited<ReturnType<typeof getApi>>;
  let providerId: string;
  let previousActive: string | undefined;
  let workspace: unknown;
  let engine: unknown;
  const cfg = () => vscode.workspace.getConfiguration();
  const root = () => workspaceRoot();
  const extDir = () => path.join(root(), '.specify', 'extensions', 'demo');
  const ymlPath = () => path.join(root(), '.specify', 'extensions.yml');
  /** Workspace values before the suite, restored afterwards (the fixture sets some). */
  const saved = new Map<string, unknown>();
  const SETTINGS: Array<[string, unknown]> = [
    ['caramelo.useAgentLoop', true],
    ['caramelo.autoApplyEdits', false],
    ['caramelo.agent.bashAllowList', undefined],
    ['caramelo.hooks.alwaysRun', undefined],
  ];

  suiteSetup(async function () {
    if (process.platform === 'win32') this.skip(); // agent shell tool needs /bin/sh (spec 008)
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
      { id: 'e2e-sdd-flow', name: 'Claude (mock server)', endpoint, model: 'mock-model', apiKeyId: 'e2e' },
      secrets as never,
    );
    await provider.authenticate();
    providerId = provider.id;
    api.registry.register(provider);
    await api.registry.setActive(providerId);

    for (const [key, value] of SETTINGS) {
      saved.set(key, cfg().inspect(key)?.workspaceValue);
      await cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
    }
    const { resetSessionApprovals } = await import('../../agent/approval.js');
    resetSessionApprovals();
    seedConstitution();

    const { SpecWorkspace } = await import('../../specs/workspace.js');
    const { WorkflowEngine } = await import('../../specs/workflow.js');
    workspace = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);
    engine = new WorkflowEngine();

    // An optional Spec Kit hook after the tasks phase.
    fs.mkdirSync(path.join(extDir(), 'commands'), { recursive: true });
    fs.writeFileSync(path.join(extDir(), 'extension.yml'), [
      'extension:', '  id: demo', 'provides:', '  commands:',
      '    - name: speckit.demo.review', '      file: commands/speckit.demo.review.md', '',
    ].join('\n'));
    fs.writeFileSync(path.join(extDir(), 'commands', 'speckit.demo.review.md'), 'Review the tasks. $ARGUMENTS\n');
    fs.writeFileSync(ymlPath(), 'hooks:\n  after_tasks:\n    - extension: demo\n      command: speckit.demo.review\n      optional: true\n');
  });

  suiteTeardown(async () => {
    if (process.platform === 'win32') return;
    restore?.();
    for (const [key] of SETTINGS) await cfg().update(key, saved.get(key), vscode.ConfigurationTarget.Workspace);
    try { api.registry.unregister(providerId); } catch { /* ignore */ }
    if (previousActive) await api.registry.setActive(previousActive).catch(() => { /* ignore */ });
    fs.rmSync(extDir(), { recursive: true, force: true });
    fs.rmSync(ymlPath(), { force: true });
    fs.rmSync(path.join(root(), 'src', 'sdd'), { recursive: true, force: true });
    clearConstitution();
    await server.stop();
  });

  // --- Dialog recorder ----------------------------------------------------

  interface Shown { kind: 'modal' | 'toast' | 'quickPick' | 'inputBox'; message: string; answer?: string }
  const shown: Shown[] = [];
  let restore: (() => void) | undefined;

  /** The user's answer to each modal: always the "don't ask again" option. */
  function answerModal(message: string, buttons: string[]): string | undefined {
    if (message.startsWith('Caramelo agent proposes')) return 'Always allow in this workspace';
    if (message.startsWith('Caramelo agent wants to run')) return buttons.find((b) => b.startsWith('Always allow'));
    if (message.startsWith('Run optional Spec Kit hook')) return 'Always run';
    return undefined;
  }

  function recordDialogs(): void {
    type Fn = (...args: unknown[]) => Thenable<unknown>;
    const win = vscode.window as unknown as Record<string, Fn>;
    const originals: Record<string, Fn> = {};
    for (const name of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage']) {
      originals[name] = win[name];
      win[name] = (message: unknown, ...rest: unknown[]) => {
        const opts = rest[0];
        const modal = typeof opts === 'object' && opts !== null && (opts as { modal?: boolean }).modal === true;
        const buttons = (modal ? rest.slice(1) : rest).filter((b): b is string => typeof b === 'string');
        if (!modal) {
          shown.push({ kind: 'toast', message: String(message) });
          return Promise.resolve(undefined);
        }
        const answer = answerModal(String(message), buttons);
        shown.push({ kind: 'modal', message: String(message), answer });
        return Promise.resolve(answer);
      };
    }
    for (const [name, kind] of [['showQuickPick', 'quickPick'], ['showInputBox', 'inputBox']] as const) {
      originals[name] = win[name];
      win[name] = (...args: unknown[]) => {
        shown.push({ kind, message: JSON.stringify(args[1] ?? args[0]).slice(0, 200) });
        return Promise.resolve(undefined);
      };
    }
    restore = () => { for (const [name, fn] of Object.entries(originals)) win[name] = fn; };
  }

  // --- Scripted LLM -------------------------------------------------------

  const TASKS_MD = [
    '# Tasks: SDD flow',
    '',
    '## Phase 1: Setup',
    '',
    '- [ ] T001 Create src/sdd/one.txt',
    '- [ ] T002 [P] Create src/sdd/two.txt',
    '- [ ] T003 [P] Create src/sdd/three.txt',
    '',
  ].join('\n');

  function llm(specName: string) {
    return (body: MessagesRequestBody): MockTurn => {
      const user = userText(body);
      const system = body.system ?? '';
      const answered = toolResults(body).length > 0;
      const task = /^Task: (T\d{3})/.exec(taskLine(body))?.[1];

      if (task) {
        if (answered) return { text: `${task} done.` };
        const file = { T001: 'one', T002: 'two', T003: 'three', T004: 'four' }[task] ?? task;
        return {
          toolUses: [
            { name: 'file_write', input: { path: `src/sdd/${file}.txt`, content: `${task}\n` } },
            { name: 'bash', input: { command: task === 'T001' ? 'git --version' : 'git --version --build-options' } },
          ],
          delayMs: task === 'T001' ? 0 : 200,
        };
      }
      if (user.includes('Generate the requirements document')) {
        return { text: '# Feature Specification: SDD flow\n\n- **FR-001**: Users can run the whole flow.\n' };
      }
      if (user.includes('Generate the design document')) {
        if (answered) return { text: '# Implementation Plan: SDD flow\n\nFiles live under `src/sdd/`.\n' };
        return { toolUse: { name: 'file_write', input: { path: `specs/${specName}/contracts/api.md`, content: '# API contract\n' } } };
      }
      if (user.includes('Generate the tasks document')) {
        if (answered) return { text: TASKS_MD };
        return { toolUse: { name: 'bash', input: { command: 'ls specs' } } };
      }
      if (system.includes('research decisions')) return { text: '# Research\n\n- Decision: plain files.\n' };
      if (system.includes('data model')) return { text: '# Data Model\n\nNo entities.\n' };
      if (system.includes('findings')) return { text: '```json\n{"findings": []}\n```' };
      return { text: 'Hook reviewed the tasks.' };
    };
  }

  // --- The flow -----------------------------------------------------------

  test('runs requirements → design → tasks → implement → converge asking each question once', async function () {
    this.timeout(120_000);
    const spec = seedSpec({ name: `feat-sdd-flow-${Date.now()}` });
    server.setHandler(llm(spec.name));
    recordDialogs();

    const { runPhase } = await import('../../commands/run-phase.js');
    const { approvePhase } = await import('../../commands/approve-phase.js');
    const { runAllTasks } = await import('../../commands/run-all-tasks.js');
    const { convergeTasks } = await import('../../commands/converge.js');
    const refresh = { refresh: () => { /* noop */ } };
    const phase = (p: 'requirements' | 'design' | 'tasks') =>
      runPhase(spec.name, p, workspace as never, api.registry as never, api.templateManager as never, engine as never, refresh);
    const approve = (p: string) => approvePhase(spec.name, p, workspace as never, refresh);

    try {
      await phase('requirements');
      await approve('requirements');
      await phase('design');
      await approve('design');
      await phase('tasks');
      await approve('tasks');
      assert.deepStrictEqual(readMeta(spec).phases, { requirements: 'approved', design: 'approved', tasks: 'approved' });
      assert.ok(fs.existsSync(path.join(spec.dir, 'contracts', 'api.md')), 'design agent must have written contracts/api.md');

      const tasksUri = vscode.Uri.file(path.join(spec.dir, 'tasks.md'));
      const summary = await runAllTasks(tasksUri, api.registry as never, { specsRoot: path.join(root(), 'specs') });
      assert.deepStrictEqual(summary, { total: 3, done: 3 }, `all tasks must complete. tasks.md:\n${fs.readFileSync(tasksUri.fsPath, "utf-8")}`);
      for (const f of ['one', 'two', 'three']) {
        assert.ok(fs.existsSync(path.join(root(), 'src', 'sdd', `${f}.txt`)), `src/sdd/${f}.txt must exist`);
      }

      await convergeTasks(spec.name, workspace as never, api.registry as never, refresh);
      assert.ok(!fs.readFileSync(tasksUri.fsPath, 'utf-8').includes('Convergence'), 'converged: nothing appended');

      // --- What interrupted the user ---
      const modals = shown.filter((d) => d.kind === 'modal');
      assert.deepStrictEqual(
        modals.map((m) => `${m.message.split('\n')[0]} → ${m.answer}`),
        [
          'Caramelo agent proposes 1 write → Always allow in this workspace', // design writes contracts/
          'Run optional Spec Kit hook /speckit.demo.review (demo)? (after_tasks) → Always run',
          'Caramelo agent wants to run: → Always allow "git --version"', // T001's shell command
        ],
        `exactly one question per kind. All dialogs:\n${shown.map((d) => `${d.kind}: ${d.message}`).join('\n')}`,
      );
      assert.deepStrictEqual(shown.filter((d) => d.kind === 'quickPick' || d.kind === 'inputBox'), []);
      const toasts = shown.filter((d) => d.kind === 'toast').map((d) => d.message);
      assert.deepStrictEqual(toasts.filter((t) => /^Task complete|Running task|tasks in parallel/.test(t)), [], `no per-task toasts: ${toasts.join(' | ')}`);
      assert.deepStrictEqual(toasts.filter((t) => /tasks completed/.test(t)), ['Caramelo: all 3 tasks completed.']);
      assert.deepStrictEqual(server.requests.filter((r) => r.aborted), [], 'no request may be aborted');

      // --- After a reload the saved choices still hold ---
      const { resetSessionApprovals } = await import('../../agent/approval.js');
      resetSessionApprovals();
      assert.strictEqual(cfg().inspect('caramelo.autoApplyEdits')?.workspaceValue, true);
      assert.deepStrictEqual(cfg().inspect('caramelo.agent.bashAllowList')?.workspaceValue, ['git --version']);
      assert.deepStrictEqual(cfg().inspect('caramelo.hooks.alwaysRun')?.workspaceValue, ['after_tasks:speckit.demo.review']);

      shown.length = 0;
      fs.appendFileSync(tasksUri.fsPath, '- [ ] T004 Create src/sdd/four.txt\n');
      assert.deepStrictEqual(await runAllTasks(tasksUri, api.registry as never), { total: 1, done: 1 });
      const { runActionHooks } = await import('../../speckit/hook-runner-vscode.js');
      assert.strictEqual(await runActionHooks('after', 'tasks', { workspaceRoot: root(), specName: spec.name }, api.registry as never), true);
      assert.deepStrictEqual(shown.filter((d) => d.kind !== 'toast'), [], `no question after reload: ${JSON.stringify(shown)}`);
    } finally {
      restore?.();
      restore = undefined;
      removeSpec(spec);
    }
  });
});
