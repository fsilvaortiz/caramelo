import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseWebviewMsg, WorkflowViewProvider } from '../workflow-view.js';
import type { ClarificationQuestion } from '../../../commands/clarify.js';

describe('parseWebviewMsg', () => {
  it('accepts well-formed clarifyAnswer', () => {
    expect(
      parseWebviewMsg({ command: 'clarifyAnswer', questionIndex: 1, optionIndex: 2 }),
    ).toEqual({ command: 'clarifyAnswer', questionIndex: 1, optionIndex: 2 });
  });

  it('accepts well-formed clarifySkip', () => {
    expect(parseWebviewMsg({ command: 'clarifySkip', questionIndex: 0 })).toEqual({
      command: 'clarifySkip',
      questionIndex: 0,
    });
  });

  it('accepts no-payload commands', () => {
    expect(parseWebviewMsg({ command: 'clarifySubmit' })).toEqual({ command: 'clarifySubmit' });
    expect(parseWebviewMsg({ command: 'clarifyCancel' })).toEqual({ command: 'clarifyCancel' });
    expect(parseWebviewMsg({ command: 'openConstitution' })).toEqual({ command: 'openConstitution' });
  });

  it('rejects messages whose questionIndex is a string', () => {
    expect(parseWebviewMsg({ command: 'clarifyAnswer', questionIndex: '0', optionIndex: 0 })).toBeNull();
  });

  it('rejects messages whose optionIndex is non-integer', () => {
    expect(parseWebviewMsg({ command: 'clarifyAnswer', questionIndex: 0, optionIndex: 1.5 })).toBeNull();
  });

  it('rejects negative indices', () => {
    expect(parseWebviewMsg({ command: 'clarifyAnswer', questionIndex: -1, optionIndex: 0 })).toBeNull();
    expect(parseWebviewMsg({ command: 'clarifyAnswer', questionIndex: 0, optionIndex: -1 })).toBeNull();
  });

  it('rejects messages with missing required fields', () => {
    expect(parseWebviewMsg({ command: 'clarifyAnswer', questionIndex: 0 })).toBeNull();
    expect(parseWebviewMsg({ command: 'createSpec' })).toBeNull();
    expect(parseWebviewMsg({ command: 'createSpec', name: '' })).toBeNull();
  });

  it('rejects unknown commands', () => {
    expect(parseWebviewMsg({ command: 'somethingElse' })).toBeNull();
    expect(parseWebviewMsg({ command: 42 })).toBeNull();
  });

  it('rejects null / non-objects', () => {
    expect(parseWebviewMsg(null)).toBeNull();
    expect(parseWebviewMsg(undefined)).toBeNull();
    expect(parseWebviewMsg('clarifyCancel')).toBeNull();
    expect(parseWebviewMsg(42)).toBeNull();
  });

  it('rejects createSpec with non-string description', () => {
    expect(
      parseWebviewMsg({ command: 'createSpec', name: 'foo', description: 42 }),
    ).toBeNull();
  });

  it('accepts createSpec with empty description (only name is required)', () => {
    expect(
      parseWebviewMsg({ command: 'createSpec', name: 'foo', description: '' }),
    ).toEqual({ command: 'createSpec', name: 'foo', description: '' });
  });

  it('rejects toggleTask with negative line', () => {
    expect(
      parseWebviewMsg({ command: 'toggleTask', filePath: '/x', line: -1, done: true }),
    ).toBeNull();
  });

  it('rejects toggleTask with non-boolean done', () => {
    expect(
      parseWebviewMsg({ command: 'toggleTask', filePath: '/x', line: 0, done: 'true' }),
    ).toBeNull();
  });
});

const fakeQuestions: ClarificationQuestion[] = [
  { question: 'Q1?', options: ['A1', 'B1'], recommended: 0 },
  { question: 'Q2?', options: ['A2', 'B2', 'C2'], recommended: 1 },
];

let tmp: string;
let view: WorkflowViewProvider;
let specPath: string;
const showInfoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
const showWarnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
const showErrSpy = vi.spyOn(vscode.window, 'showErrorMessage');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-workflow-'));
  specPath = path.join(tmp, 'spec.md');
  fs.writeFileSync(specPath, '# Spec\n\nbody\n', 'utf-8');
  // workspaceFolders is undefined in the mock by default; tests that
  // need it set it directly.
  view = new WorkflowViewProvider({ fsPath: tmp } as unknown as vscode.Uri);
  showInfoSpy.mockClear();
  showWarnSpy.mockClear();
  showErrSpy.mockClear();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('WorkflowViewProvider — clarify session', () => {
  it('startClarify enters a session', async () => {
    await view.startClarify('myspec', specPath, fakeQuestions);
    // No public getter; we exercise via the handler interface.
    view.handleClarifyAnswer(0, 1);
    // Submit writes the answer and clears the session.
    view.handleClarifySubmit();
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toContain('## Clarifications');
    expect(out).toContain('- Q: Q1? → A: B1');
  });

  it('handleClarifyAnswer ignores out-of-bounds questionIndex', async () => {
    await view.startClarify('myspec', specPath, fakeQuestions);
    view.handleClarifyAnswer(99, 0); // no such question — must not throw
    view.handleClarifySubmit();
    // No answer was registered, so the spec is unchanged but a "no
    // clarifications recorded" toast fires.
    expect(showInfoSpy).toHaveBeenCalledWith(expect.stringContaining('No clarifications recorded'));
  });

  it('handleClarifyAnswer ignores out-of-bounds optionIndex', async () => {
    await view.startClarify('myspec', specPath, fakeQuestions);
    view.handleClarifyAnswer(0, 99);
    view.handleClarifySubmit();
    expect(showInfoSpy).toHaveBeenCalledWith(expect.stringContaining('No clarifications recorded'));
  });

  it('handleClarifyAnswer rejects non-integer indices', async () => {
    await view.startClarify('myspec', specPath, fakeQuestions);
    view.handleClarifyAnswer(0.5, 0);
    view.handleClarifyAnswer(0, 1.5);
    view.handleClarifySubmit();
    expect(showInfoSpy).toHaveBeenCalledWith(expect.stringContaining('No clarifications recorded'));
  });

  it('handleClarifySkip records skip; submit excludes skipped questions', async () => {
    await view.startClarify('myspec', specPath, fakeQuestions);
    view.handleClarifySkip(0);
    view.handleClarifyAnswer(1, 0);
    view.handleClarifySubmit();
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).not.toContain('Q1?');
    expect(out).toContain('- Q: Q2? → A: A2');
  });

  it('handleClarifyCancel discards in-flight answers without writing', async () => {
    await view.startClarify('myspec', specPath, fakeQuestions);
    view.handleClarifyAnswer(0, 0);
    const before = fs.readFileSync(specPath, 'utf-8');
    view.handleClarifyCancel();
    expect(fs.readFileSync(specPath, 'utf-8')).toBe(before);
    // After cancel, submitting again is a no-op (session cleared).
    showInfoSpy.mockClear();
    view.handleClarifySubmit();
    expect(showInfoSpy).not.toHaveBeenCalled();
  });

  it('all-skipped submit writes nothing and toasts "no clarifications"', async () => {
    await view.startClarify('myspec', specPath, fakeQuestions);
    view.handleClarifySkip(0);
    view.handleClarifySkip(1);
    const before = fs.readFileSync(specPath, 'utf-8');
    view.handleClarifySubmit();
    expect(fs.readFileSync(specPath, 'utf-8')).toBe(before);
    expect(showInfoSpy).toHaveBeenCalledWith(expect.stringContaining('No clarifications recorded'));
  });

  it('startClarify with picked answers in flight prompts before discard', async () => {
    await view.startClarify('first', specPath, fakeQuestions);
    view.handleClarifyAnswer(0, 0); // picked
    showWarnSpy.mockResolvedValueOnce('Keep current' as unknown as vscode.MessageItem);
    await view.startClarify('second', specPath, fakeQuestions);
    expect(showWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unsubmitted answers'),
      expect.objectContaining({ modal: true }),
      'Discard and continue',
      'Keep current',
    );
    // 'Keep current' aborts the new session — original is intact.
    view.handleClarifySubmit(); // should write the original first session's answer
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toContain('- Q: Q1? → A: A1');
  });

  it('startClarify with skipped-only in flight does NOT prompt (no picks to lose)', async () => {
    await view.startClarify('first', specPath, fakeQuestions);
    view.handleClarifySkip(0);
    showWarnSpy.mockClear();
    await view.startClarify('second', specPath, fakeQuestions);
    expect(showWarnSpy).not.toHaveBeenCalled();
  });

  it('submit toasts an error when writeAnswersToSpec fails', async () => {
    // Point the session at a path inside a non-existent dir to force a
    // write-failed (mkdir is not invoked by writeAnswersToSpec).
    const badPath = path.join(tmp, 'subdir', 'spec.md');
    fs.writeFileSync(specPath, '# x\n', 'utf-8'); // ensure tmp exists
    // Use a directory as the spec path so writeFileSync trips EISDIR:
    fs.mkdirSync(badPath.replace(/spec\.md$/, ''), { recursive: true });
    fs.mkdirSync(badPath); // make spec.md a directory
    await view.startClarify('myspec', badPath, fakeQuestions);
    view.handleClarifyAnswer(0, 0);
    view.handleClarifySubmit();
    expect(showErrSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to write clarifications'),
    );
  });
});
