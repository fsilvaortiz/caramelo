import * as assert from 'assert';
import * as vscode from 'vscode';
import { removeSpec, seedSpec } from './helpers/workspace.js';

suite('Workflow Map (DAG) webview', () => {
  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  function workflowMapTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputWebview && t.label === 'Workflow Map');
  }

  test('opens with a spec whose folder name contains markup', async function () {
    // `<` and `>` are not valid in Windows file names.
    if (process.platform === 'win32') this.skip();
    this.timeout(20_000);
    const spec = seedSpec({
      name: '<img src=x onerror=alert(1)>',
      files: { spec: '# Spec\n', tasks: '- [ ] T1 Do it\n' },
    });
    try {
      await vscode.commands.executeCommand('caramelo.openDag');
      // Tab state is updated asynchronously after the panel is created.
      const deadline = Date.now() + 5_000;
      while (workflowMapTabs().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const all = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
      assert.strictEqual(workflowMapTabs().length, 1, `the Workflow Map panel must open; tabs: ${all.join(', ')}`);

      // The renderer the panel used must have escaped the name.
      const { buildDagHtml } = await import('../../views/webview/dag-view.js');
      const { html } = buildDagHtml(
        { hasConstitution: false, specs: [{ name: spec.name, phases: [], tasksDone: 0, tasksTotal: 1 }] },
        'n',
      );
      assert.ok(!html.includes('<img'), 'spec name must be escaped');
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    } finally {
      removeSpec(spec);
    }
  });
});
