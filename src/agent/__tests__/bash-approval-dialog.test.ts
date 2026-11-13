import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import {
  autoAllAllPolicy,
  BASH_ALLOW_LIST_SETTING,
  BASH_READ_ONLY_SETTING,
  resetBashSessionApproval,
} from '../approval.js';
import type { Tool, ToolCallApproval } from '../types.js';

const lines: string[] = [];
vi.mock('../../utils/output-channel.js', () => ({
  getCarameloChannel: () => ({ appendLine: (l: string) => lines.push(l) }),
}));

const bashTool: Tool = {
  name: 'bash',
  description: 'bash',
  readOnly: false,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return { summary: '', content: '' };
  },
};
const ctx = { workspaceRoot: '/ws', turnIndex: 1 };
const bash = (id: string, command: string): ToolCallApproval => ({
  call: { id, name: 'bash', arguments: { command } },
  tool: bashTool,
});

/** Settings store backing the mocked getConfiguration(). */
let settings: Record<string, unknown>;
let workspaceValues: Record<string, unknown>;
let update: ReturnType<typeof vi.fn>;
let prompt: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetBashSessionApproval();
  settings = {};
  workspaceValues = {};
  lines.length = 0;
  update = vi.fn(async (key: string, value: unknown) => {
    workspaceValues[key] = value;
    settings[key] = value;
  });
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: (key: string, def?: unknown) => (key in settings ? settings[key] : def),
    update,
    inspect: (key: string) => ({ key, workspaceValue: workspaceValues[key] }),
  } as never);
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
  prompt = vi.fn();
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(prompt as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
});

const decide = async (command: string) =>
  (await autoAllAllPolicy().decide([bash('b', command)], ctx)).b;

describe('default bash approval dialog', () => {
  it('runs read-only workspace commands without prompting, and logs them', async () => {
    expect(await decide('ls src && git status')).toBe('allow');
    expect(prompt).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/bash auto-approved \(read-only\): \$ ls src && git status/);
  });

  it('prompts for read-only commands when the setting is off', async () => {
    settings[BASH_READ_ONLY_SETTING] = false;
    prompt.mockResolvedValue('Run');
    expect(await decide('ls src')).toBe('allow');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('offers Run, Always allow <rule>, session, Skip and Abort', async () => {
    prompt.mockResolvedValue('Skip');
    expect(await decide('npm test -- --run')).toBe('deny');
    const buttons = prompt.mock.calls[0].slice(2);
    expect(buttons).toEqual([
      'Run',
      'Always allow "npm test"',
      "Run — don't ask again this session",
      'Skip',
      'Abort run',
    ]);
  });

  it('omits "Always allow" for compound commands', async () => {
    prompt.mockResolvedValue('Run');
    await decide('npm ci && npm test');
    expect(prompt.mock.calls[0].slice(2)).not.toContainEqual(expect.stringMatching(/^Always allow/));
  });

  it('"Always allow" saves the rule to workspace settings and stops asking for it', async () => {
    prompt.mockResolvedValue('Always allow "npm test"');
    expect(await decide('npm test')).toBe('allow');
    expect(update).toHaveBeenCalledWith(BASH_ALLOW_LIST_SETTING, ['npm test'], vscode.ConfigurationTarget.Workspace);

    prompt.mockClear();
    expect(await decide('npm test -- src/agent')).toBe('allow');
    expect(prompt).not.toHaveBeenCalled();

    prompt.mockResolvedValue('Skip');
    expect(await decide('npm run build')).toBe('deny');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('"don\'t ask again this session" allows every later command until reset', async () => {
    prompt.mockResolvedValue("Run — don't ask again this session");
    expect(await decide('npm run build')).toBe('allow');
    prompt.mockClear();
    expect(await decide('rm -rf dist')).toBe('allow');
    expect(prompt).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/allowed for this session\): \$ rm -rf dist/);

    resetBashSessionApproval();
    prompt.mockResolvedValue(undefined);
    expect(await decide('rm -rf dist')).toBe('abort');
  });

  it('closing the dialog aborts the run', async () => {
    prompt.mockResolvedValue(undefined);
    expect(await decide('npm test')).toBe('abort');
  });
});
