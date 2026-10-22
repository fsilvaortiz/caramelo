import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { installMockProvider } from './helpers/api.js';
import type { MockLLMProvider } from './helpers/mock-provider.js';
import {
  clearConstitution,
  readMeta,
  readSpecFile,
  removeSpec,
  seedConstitution,
  seedSpec,
  workspaceRoot,
} from './helpers/workspace.js';

/**
 * End-to-end hook engine: a demo extension installed under .specify/extensions,
 * registered in .specify/extensions.yml, executed through the real
 * resolve → render → provider path with the mock LLM. Only mandatory hooks and
 * after_* failures are exercised here — they never open a modal, which the
 * test host cannot answer. The optional/abort policy is unit-tested.
 */
suite('Spec Kit hooks (functional)', () => {
  let mock: MockLLMProvider;
  let uninstall: () => void;
  let registry: unknown;
  const root = () => workspaceRoot();
  const extDir = () => path.join(root(), '.specify', 'extensions', 'demo');
  const ymlPath = () => path.join(root(), '.specify', 'extensions.yml');

  suiteSetup(async function () {
    this.timeout(60_000);
    const installed = await installMockProvider({ id: 'mock-hooks', displayName: 'Mock (hooks)' });
    mock = installed.mock;
    uninstall = installed.uninstall;
    registry = installed.api.registry;

    fs.mkdirSync(path.join(extDir(), 'commands'), { recursive: true });
    fs.mkdirSync(path.join(extDir(), 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(extDir(), 'extension.yml'), [
      'extension:',
      '  id: demo',
      'provides:',
      '  commands:',
      '    - name: speckit.demo.verify',
      '      file: commands/speckit.demo.verify.md',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(extDir(), 'commands', 'speckit.demo.verify.md'), [
      '---',
      'description: Verify the plan',
      'scripts:',
      '  sh: scripts/check.sh --json',
      '  ps: scripts/check.ps1 -Json',
      '---',
      '',
      'Context: $ARGUMENTS',
      'Run `{SCRIPT}` then continue with __SPECKIT_COMMAND_TASKS__.',
      '',
    ].join('\n'));
  });

  suiteTeardown(() => {
    uninstall?.();
    fs.rmSync(extDir(), { recursive: true, force: true });
    fs.rmSync(ymlPath(), { force: true });
    delete process.env.CARAMELO_SMOKE_HOOK;
  });

  setup(() => mock.reset());

  async function run(timing: 'before' | 'after', action: 'plan'): Promise<boolean> {
    const { runActionHooks } = await import('../../speckit/hook-runner-vscode.js');
    return runActionHooks(timing, action, { workspaceRoot: root(), specName: 'feat-hooks' }, registry as never);
  }

  test('mandatory before_plan hook runs the rendered extension command through the provider', async function () {
    this.timeout(20_000);
    fs.writeFileSync(ymlPath(), 'hooks:\n  before_plan:\n    - extension: demo\n      command: speckit.demo.verify\n      optional: false\n');
    mock.queueReply('Plan verified.');

    assert.strictEqual(await run('before', 'plan'), true);
    assert.strictEqual(mock.calls.length, 1, 'hook should call the provider once');
    const user = mock.calls[0].messages.find((m) => m.role === 'user')!.content;
    const script = process.platform === 'win32'
      ? '.specify/extensions/demo/scripts/check.ps1 -Json'
      : '.specify/extensions/demo/scripts/check.sh --json';
    assert.ok(user.includes(`Run \`${script}\` then continue with /speckit.tasks.`), `rendered body wrong:\n${user}`);
    assert.ok(user.includes('Context: Invoked automatically by Caramelo as the `before_plan` hook for feature "feat-hooks"'), user);
    assert.ok(!user.includes('---'), 'frontmatter must be stripped');
  });

  test('disabled hooks and unmet conditions do not call the provider', async function () {
    this.timeout(20_000);
    fs.writeFileSync(ymlPath(), [
      'hooks:',
      '  before_plan:',
      '    - command: speckit.demo.verify',
      '      optional: false',
      '      enabled: false',
      '    - command: speckit.demo.verify',
      '      optional: false',
      "      condition: \"env.CARAMELO_SMOKE_HOOK == 'yes'\"",
      '',
    ].join('\n'));
    delete process.env.CARAMELO_SMOKE_HOOK;
    assert.strictEqual(await run('before', 'plan'), true);
    assert.strictEqual(mock.calls.length, 0);

    process.env.CARAMELO_SMOKE_HOOK = 'yes';
    mock.queueReply('ok');
    await run('before', 'plan');
    assert.strictEqual(mock.calls.length, 1, 'condition met → the second hook runs');
  });

  test('an after_* hook whose command is not installed is reported but never blocks', async function () {
    this.timeout(20_000);
    fs.writeFileSync(ymlPath(), 'hooks:\n  after_plan:\n    - command: speckit.ghost.missing\n      optional: false\n');
    assert.strictEqual(await run('after', 'plan'), true);
    assert.strictEqual(mock.calls.length, 0);
  });

  test('caramelo.hooks.run=false turns hook execution off', async function () {
    this.timeout(20_000);
    const vscode = await import('vscode');
    fs.writeFileSync(ymlPath(), 'hooks:\n  before_plan:\n    - command: speckit.demo.verify\n      optional: false\n');
    const cfg = vscode.workspace.getConfiguration();
    await cfg.update('caramelo.hooks.run', false, vscode.ConfigurationTarget.Workspace);
    try {
      assert.strictEqual(await run('before', 'plan'), true);
      assert.strictEqual(mock.calls.length, 0);
    } finally {
      await cfg.update('caramelo.hooks.run', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});

suite('Spec Kit hooks wired into Caramelo actions (functional)', () => {
  let mock: MockLLMProvider;
  let uninstall: () => void;
  let api: { registry: unknown; workflowEngine: unknown; templateManager: unknown };
  let workspace: unknown;
  const root = () => workspaceRoot();
  const extDir = () => path.join(root(), '.specify', 'extensions', 'wired');
  const ymlPath = () => path.join(root(), '.specify', 'extensions.yml');
  const isHookCall = (c: { messages: Array<{ role: string; content: string }> }) =>
    c.messages.some((m) => m.role === 'system' && m.content.includes('executing a Spec Kit extension hook'));
  const hookCommandOf = (c: { messages: Array<{ role: string; content: string }> }) =>
    /HOOK:(\S+)/.exec(c.messages.find((m) => m.role === 'user')!.content)?.[1];

  suiteSetup(async function () {
    this.timeout(60_000);
    const installed = await installMockProvider({ id: 'mock-hooks-wired', displayName: 'Mock (hooks wired)' });
    mock = installed.mock;
    uninstall = installed.uninstall;
    api = installed.api as never;
    seedConstitution();
    const vscode = await import('vscode');
    const { SpecWorkspace } = await import('../../specs/workspace.js');
    workspace = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);

    const cmds = ['before-plan', 'after-plan', 'before-converge', 'after-converge'];
    fs.mkdirSync(path.join(extDir(), 'commands'), { recursive: true });
    fs.writeFileSync(path.join(extDir(), 'extension.yml'), [
      'provides:',
      '  commands:',
      ...cmds.flatMap((c) => [`    - name: speckit.wired.${c}`, `      file: commands/${c}.md`]),
      '',
    ].join('\n'));
    for (const c of cmds) fs.writeFileSync(path.join(extDir(), 'commands', `${c}.md`), `HOOK:${c}\n$ARGUMENTS\n`);
    fs.writeFileSync(ymlPath(), [
      'hooks:',
      ...['before_plan', 'after_plan', 'before_converge', 'after_converge'].flatMap((e) => [
        `  ${e}:`,
        '    - extension: wired',
        `      command: speckit.wired.${e.replace('_', '-')}`,
        '      optional: false',
      ]),
      '',
    ].join('\n'));
  });

  suiteTeardown(() => {
    uninstall?.();
    clearConstitution();
    fs.rmSync(extDir(), { recursive: true, force: true });
    fs.rmSync(ymlPath(), { force: true });
  });

  setup(() => mock.reset());

  async function runDesign(specName: string): Promise<void> {
    const { runPhase } = await import('../../commands/run-phase.js');
    await runPhase(specName, 'design', workspace as never, api.registry as never, api.templateManager as never,
      api.workflowEngine as never, { refresh: () => { /* noop */ } } as never);
  }

  test('plan generation runs before_plan → generation → after_plan, in that order', async function () {
    this.timeout(30_000);
    mock.setDispatcher((messages) => {
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      return { reply: sys.includes('executing a Spec Kit extension hook') ? 'hook done' : '# Plan\n\n1. Do it\n' };
    });
    const spec = seedSpec({ statuses: { requirements: 'approved', design: 'pending' }, files: { spec: '# Req\n' } });
    try {
      await runDesign(spec.name);
      const order = mock.calls.map((c) => (isHookCall(c) ? hookCommandOf(c) : 'generate'));
      // design also generates intermediate artifacts after the plan; they sit between plan and after_plan.
      assert.strictEqual(order[0], 'before-plan', `order: ${order.join(', ')}`);
      assert.strictEqual(order[1], 'generate', `order: ${order.join(', ')}`);
      assert.strictEqual(order[order.length - 1], 'after-plan', `order: ${order.join(', ')}`);
      assert.ok(!order.includes('before-converge') && !order.includes('after-converge'), 'unrelated events must not fire');
      assert.strictEqual(readMeta(spec).phases.design, 'pending-approval');
    } finally {
      removeSpec(spec);
    }
  });

  test('after_plan does not run when plan generation fails', async function () {
    this.timeout(30_000);
    mock.setDispatcher((messages) => {
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      return sys.includes('executing a Spec Kit extension hook') ? { reply: 'hook done' } : { error: new Error('LLM down') };
    });
    const spec = seedSpec({ statuses: { requirements: 'approved', design: 'pending' }, files: { spec: '# Req\n' } });
    try {
      await runDesign(spec.name);
      const hooks = mock.calls.filter(isHookCall).map(hookCommandOf);
      assert.deepStrictEqual(hooks, ['before-plan']);
      assert.notStrictEqual(readMeta(spec).phases.design, 'pending-approval');
    } finally {
      removeSpec(spec);
    }
  });

  test('converge runs before_converge and after_converge around the append', async function () {
    this.timeout(30_000);
    mock.setDispatcher((messages) => {
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      return { reply: sys.includes('executing a Spec Kit extension hook')
        ? 'hook done'
        : '```json\n{"findings":[{"gapType":"missing","severity":"HIGH","sourceRef":"FR-001","evidence":"src","task":"Added by converge"}]}\n```' };
    });
    const spec = seedSpec({
      statuses: { requirements: 'approved', design: 'approved', tasks: 'approved' },
      files: { spec: '# Req\n', plan: '# Plan\n', tasks: '# Tasks\n\n- [ ] Existing\n' },
    });
    try {
      const { convergeTasks } = await import('../../commands/converge.js');
      await convergeTasks(spec.name, workspace as never, api.registry as never, { refresh: () => { /* noop */ } });
      const order = mock.calls.map((c) => (isHookCall(c) ? hookCommandOf(c) : 'converge'));
      assert.deepStrictEqual(order, ['before-converge', 'converge', 'after-converge']);
      assert.ok(readSpecFile(spec, 'tasks.md')!.includes('- [ ] T001 Added by converge per FR-001 (missing)'));
    } finally {
      removeSpec(spec);
    }
  });
});
