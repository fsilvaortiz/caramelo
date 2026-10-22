import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { installMockProvider } from './helpers/api.js';
import type { MockLLMProvider } from './helpers/mock-provider.js';
import { clearConstitution, readSpecFile, removeSpec, seedConstitution, seedSpec, workspaceRoot } from './helpers/workspace.js';

const TASKS = '# Tasks\n\n## Phase 1: Setup\n\n- [x] T001 Create src/feature.ts\n- [ ] T002 Wire it up\n';

suite('Converge (functional, provider without tool calling)', () => {
  let mock: MockLLMProvider;
  let uninstall: () => void;
  let registry: unknown;
  let workspace: unknown;
  const codePath = () => path.join(workspaceRoot(), 'src', 'feature.ts');

  suiteSetup(async function () {
    this.timeout(60_000);
    const installed = await installMockProvider({ id: 'mock-converge', displayName: 'Mock (converge)' });
    mock = installed.mock;
    uninstall = installed.uninstall;
    registry = installed.api.registry;
    seedConstitution();
    const { SpecWorkspace } = await import('../../specs/workspace.js');
    workspace = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);
    fs.mkdirSync(path.dirname(codePath()), { recursive: true });
    fs.writeFileSync(codePath(), 'export const feature = "half done";\n');
  });

  suiteTeardown(() => {
    uninstall?.();
    clearConstitution();
    fs.rmSync(path.dirname(codePath()), { recursive: true, force: true });
  });

  setup(() => mock.reset());

  function seed() {
    return seedSpec({
      statuses: { requirements: 'approved', design: 'approved', tasks: 'approved' },
      files: { spec: '# Spec\n\n- FR-001 Users can log in\n', plan: '# Plan\n\nImplement in `src/feature.ts`.\n', tasks: TASKS },
    });
  }

  async function converge(specName: string): Promise<void> {
    const { convergeTasks } = await import('../../commands/converge.js');
    await convergeTasks(specName, workspace as never, registry as never, { refresh: () => { /* noop */ } });
  }

  test('appends a Convergence phase with continuing ids and inlines referenced code', async function () {
    this.timeout(20_000);
    mock.queueReply('```json\n' + JSON.stringify({ findings: [
      { gapType: 'partial', severity: 'HIGH', sourceRef: 'FR-001', evidence: 'src/feature.ts', task: 'Finish the login flow' },
      { gapType: 'contradicts', severity: 'CRITICAL', sourceRef: 'Constitution II', evidence: 'src/feature.ts', task: 'Add the missing tests' },
    ] }) + '\n```');
    const spec = seed();
    try {
      await converge(spec.name);
      const tasks = readSpecFile(spec, 'tasks.md')!;
      assert.ok(tasks.startsWith(TASKS), 'existing content must be untouched');
      assert.strictEqual(tasks.slice(TASKS.length),
        '\n## Phase 2: Convergence\n\n' +
        '- [ ] T003 CRITICAL: Add the missing tests per Constitution II (contradicts)\n' +
        '- [ ] T004 Finish the login flow per FR-001 (partial)\n');
      const user = mock.calls[0].messages.find((m) => m.role === 'user')!.content;
      assert.ok(user.includes('--- CODE: src/feature.ts ---\nexport const feature = "half done";'), 'referenced code must be inlined');
      assert.ok(user.includes('--- CONSTITUTION ---'), 'constitution must be provided');
      assert.ok(!fs.existsSync(path.join(spec.dir, 'tasks.pre-converge.md')), 'converge writes nothing but tasks.md');
    } finally {
      removeSpec(spec);
    }
  });

  test('converged: tasks.md stays byte-for-byte identical', async function () {
    this.timeout(20_000);
    mock.queueReply('```json\n{"findings": []}\n```');
    const spec = seed();
    try {
      await converge(spec.name);
      assert.strictEqual(readSpecFile(spec, 'tasks.md'), TASKS);
      assert.deepStrictEqual(fs.readdirSync(spec.dir).sort(), ['.caramelo-meta.json', 'plan.md', 'spec.md', 'tasks.md']);
    } finally {
      removeSpec(spec);
    }
  });

  test('an unparseable answer changes nothing', async function () {
    this.timeout(20_000);
    mock.queueReply('- [ ] I ignored the JSON contract');
    const spec = seed();
    try {
      await converge(spec.name);
      assert.strictEqual(readSpecFile(spec, 'tasks.md'), TASKS);
    } finally {
      removeSpec(spec);
    }
  });
});

suite('Converge (functional, tool-calling agent)', () => {
  let api: { registry: { register(p: unknown): void; unregister(id: string): void; setActive(id: string): Promise<void> } };
  let workspace: unknown;
  const codePath = () => path.join(workspaceRoot(), 'src', 'agent-feature.ts');
  const offeredTools: string[][] = [];
  const toolResults: string[] = [];

  // Turn 1 reads the code, turn 2 answers with findings that quote what it read.
  const provider = {
    id: 'scripted-agent',
    displayName: 'Scripted agent',
    authenticate: async () => true,
    isAvailable: async () => true,
    dispose: () => { /* noop */ },
    capabilities: () => new Set(['streaming', 'tool-calling']),
    async *chat() { yield ''; },
    async *chatWithTools(req: { tools: Array<{ name: string }>; messages: Array<{ role: string; content: string }> }) {
      offeredTools.push(req.tools.map((t) => t.name).sort());
      const tool = req.messages.filter((m) => m.role === 'tool');
      if (tool.length === 0) {
        yield { kind: 'tool_call', call: { id: 'c1', name: 'file_read', arguments: { path: 'src/agent-feature.ts' } } };
        return;
      }
      toolResults.push(tool[0].content);
      const saw = tool[0].content.includes('TODO login') ? 'TODO login still present' : 'nothing';
      yield { kind: 'text', delta: '```json\n' + JSON.stringify({ findings: [
        { gapType: 'partial', severity: 'HIGH', sourceRef: 'FR-001', evidence: `src/agent-feature.ts: ${saw}`, task: 'Implement login' },
      ] }) + '\n```' };
    },
  };

  suiteSetup(async function () {
    this.timeout(60_000);
    const { getApi } = await import('./helpers/api.js');
    api = (await getApi()) as never;
    api.registry.register(provider);
    await api.registry.setActive(provider.id);
    seedConstitution();
    const { SpecWorkspace } = await import('../../specs/workspace.js');
    workspace = new SpecWorkspace(vscode.workspace.workspaceFolders![0].uri);
    fs.mkdirSync(path.dirname(codePath()), { recursive: true });
    fs.writeFileSync(codePath(), '// TODO login\n');
  });

  suiteTeardown(() => {
    api.registry.unregister(provider.id);
    clearConstitution();
    fs.rmSync(codePath(), { force: true });
  });

  test('assesses the code with read-only tools and appends the findings', async function () {
    this.timeout(30_000);
    const spec = seedSpec({
      statuses: { requirements: 'approved', design: 'approved', tasks: 'approved' },
      files: { spec: '# Spec\n- FR-001 login\n', plan: '# Plan\n', tasks: TASKS },
    });
    // The smoke fixture turns the agent loop off for the other suites.
    const cfg = vscode.workspace.getConfiguration();
    await cfg.update('caramelo.useAgentLoop', true, vscode.ConfigurationTarget.Workspace);
    try {
      const { convergeTasks } = await import('../../commands/converge.js');
      await convergeTasks(spec.name, workspace as never, api.registry as never, { refresh: () => { /* noop */ } });
      assert.deepStrictEqual(offeredTools[0], ['file_read', 'glob', 'grep', 'list_dir'], 'only read-only tools may be offered');
      assert.ok(toolResults[0]?.includes('TODO login'), `file_read must have run against the workspace, got: ${toolResults[0]}`);
      assert.strictEqual(readSpecFile(spec, 'tasks.md'), `${TASKS}\n## Phase 2: Convergence\n\n- [ ] T003 Implement login per FR-001 (partial)\n`);
    } finally {
      await cfg.update('caramelo.useAgentLoop', undefined, vscode.ConfigurationTarget.Workspace);
      removeSpec(spec);
    }
  });
});
