import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { clarifySpec } from '../clarify.js';
import type { SpecWorkspace } from '../../specs/workspace.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { WorkflowViewProvider } from '../../views/sidebar/workflow-view.js';

let tmp: string;
const showWarnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
const showInfoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
const showErrSpy = vi.spyOn(vscode.window, 'showErrorMessage');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-clarify-orch-'));
  showWarnSpy.mockClear();
  showInfoSpy.mockClear();
  showErrSpy.mockClear();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeWorkspace(): SpecWorkspace {
  return { getSpecsRoot: () => tmp } as unknown as SpecWorkspace;
}

function makeRegistry(provider: unknown): ProviderRegistry {
  return { activeProvider: provider } as unknown as ProviderRegistry;
}

function makeWorkflowView(): WorkflowViewProvider & { startClarify: ReturnType<typeof vi.fn> } {
  const mock = { startClarify: vi.fn().mockResolvedValue(undefined) };
  return mock as unknown as WorkflowViewProvider & { startClarify: ReturnType<typeof vi.fn> };
}

function provider(chunks: string[]): { chat: ReturnType<typeof vi.fn> } {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      for (const c of chunks) yield c;
    }),
  };
}

describe('clarifySpec — orchestrator early returns', () => {
  it('warns and returns when no active provider', async () => {
    const wf = makeWorkflowView();
    await clarifySpec('any', makeWorkspace(), makeRegistry(undefined), wf);
    expect(showWarnSpy).toHaveBeenCalledWith(expect.stringContaining('No active LLM provider'));
    expect(wf.startClarify).not.toHaveBeenCalled();
  });

  it('errors and returns when the spec.md does not exist', async () => {
    const wf = makeWorkflowView();
    await clarifySpec('nonexistent-spec', makeWorkspace(), makeRegistry(provider([])), wf);
    expect(showErrSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(wf.startClarify).not.toHaveBeenCalled();
  });

  it('does NOT call startClarify when LLM returns an empty array (no ambiguities)', async () => {
    fs.mkdirSync(path.join(tmp, 'feat'));
    fs.writeFileSync(path.join(tmp, 'feat', 'spec.md'), '# Spec\n', 'utf-8');
    const wf = makeWorkflowView();
    await clarifySpec(
      'feat',
      makeWorkspace(),
      makeRegistry(provider(['```json\n[]\n```'])),
      wf,
    );
    expect(showInfoSpy).toHaveBeenCalledWith(expect.stringContaining('No critical ambiguities'));
    expect(wf.startClarify).not.toHaveBeenCalled();
  });

  it('toasts a warning and does NOT open the panel on unparseable LLM response', async () => {
    fs.mkdirSync(path.join(tmp, 'feat'));
    fs.writeFileSync(path.join(tmp, 'feat', 'spec.md'), '# Spec\n', 'utf-8');
    const wf = makeWorkflowView();
    await clarifySpec(
      'feat',
      makeWorkspace(),
      makeRegistry(provider(['totally not json'])),
      wf,
    );
    expect(showWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unparseable response'));
    expect(wf.startClarify).not.toHaveBeenCalled();
  });

  it('starts a clarify session when the LLM returns parseable questions', async () => {
    fs.mkdirSync(path.join(tmp, 'feat'));
    fs.writeFileSync(path.join(tmp, 'feat', 'spec.md'), '# Spec\n', 'utf-8');
    const wf = makeWorkflowView();
    const validJson =
      '```json\n[{"question":"Auth?","options":["JWT","OAuth"],"recommended":0}]\n```';
    await clarifySpec(
      'feat',
      makeWorkspace(),
      makeRegistry(provider([validJson])),
      wf,
    );
    expect(wf.startClarify).toHaveBeenCalledWith(
      'feat',
      path.join(tmp, 'feat', 'spec.md'),
      expect.arrayContaining([
        expect.objectContaining({ question: 'Auth?', options: ['JWT', 'OAuth'], recommended: 0 }),
      ]),
    );
  });

  it('rejects items whose recommended is out of bounds even if the JSON parses', async () => {
    fs.mkdirSync(path.join(tmp, 'feat'));
    fs.writeFileSync(path.join(tmp, 'feat', 'spec.md'), '# Spec\n', 'utf-8');
    const wf = makeWorkflowView();
    const badJson =
      '```json\n[{"question":"X?","options":["A","B"],"recommended":99}]\n```';
    await clarifySpec(
      'feat',
      makeWorkspace(),
      makeRegistry(provider([badJson])),
      wf,
    );
    expect(showWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unparseable response'));
    expect(wf.startClarify).not.toHaveBeenCalled();
  });
});
