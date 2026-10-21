import { describe, it, expect } from 'vitest';
import { computeSettingsMerge, applyApprovedOverwrites } from '../apply-vscode-settings.js';

describe('computeSettingsMerge', () => {
  it('adds every upstream key when the workspace settings are empty', () => {
    const upstream = {
      'chat.promptFilesRecommendations': { 'speckit.plan': true },
      'chat.tools.terminal.autoApprove': { '.specify/scripts/bash/': true },
    };
    const result = computeSettingsMerge({}, upstream);
    expect(result.added.sort()).toEqual([
      'chat.promptFilesRecommendations',
      'chat.tools.terminal.autoApprove',
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual(upstream);
  });

  it('leaves existing user settings untouched when the key is absent upstream', () => {
    const current = { 'editor.fontSize': 14, 'workbench.colorTheme': 'Dracula' };
    const upstream = { 'chat.promptFilesRecommendations': { 'speckit.plan': true } };
    const result = computeSettingsMerge(current, upstream);
    expect(result.merged).toEqual({
      ...current,
      'chat.promptFilesRecommendations': { 'speckit.plan': true },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.added).toEqual(['chat.promptFilesRecommendations']);
  });

  it('treats byte-identical values as a no-op (not a conflict)', () => {
    // User has already applied Spec Kit settings; a repeat apply should
    // not surface a conflict modal for identical values.
    const value = { 'speckit.plan': true, 'speckit.tasks': true };
    const result = computeSettingsMerge(
      { 'chat.promptFilesRecommendations': value },
      { 'chat.promptFilesRecommendations': { 'speckit.plan': true, 'speckit.tasks': true } },
    );
    expect(result.added).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('flags a differing value as a conflict and preserves the current value in merged', () => {
    const current = { 'chat.promptFilesRecommendations': { 'speckit.plan': false } };
    const upstream = { 'chat.promptFilesRecommendations': { 'speckit.plan': true } };
    const result = computeSettingsMerge(current, upstream);
    expect(result.added).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].key).toBe('chat.promptFilesRecommendations');
    expect(result.conflicts[0].currentValue).toEqual({ 'speckit.plan': false });
    expect(result.conflicts[0].newValue).toEqual({ 'speckit.plan': true });
    // Merged keeps the user's value until applyApprovedOverwrites runs.
    expect(result.merged['chat.promptFilesRecommendations']).toEqual({ 'speckit.plan': false });
  });

  it('does not descend into nested objects — top-level key comparison only', () => {
    // Design decision: the upstream file uses dotted-key form at the top
    // level. We refuse to auto-merge inside those objects to avoid
    // silently editing settings the user can't see from the modal.
    const current = {
      'chat.promptFilesRecommendations': {
        'speckit.plan': true,
        'my.custom.key': 'preserve-me',
      },
    };
    const upstream = {
      'chat.promptFilesRecommendations': {
        'speckit.plan': true,
        'speckit.tasks': true,
      },
    };
    const result = computeSettingsMerge(current, upstream);
    // Values differ → conflict, not a deep merge.
    expect(result.conflicts).toHaveLength(1);
    expect(result.added).toEqual([]);
  });

  it('mixed case: some keys added, some conflict, some match', () => {
    const current = {
      'A': 1,
      'B': 'old',
      'editor.fontSize': 14,
    };
    const upstream = {
      'A': 1,       // match → no-op
      'B': 'new',   // conflict
      'C': [1, 2],  // added
    };
    const result = computeSettingsMerge(current, upstream);
    expect(result.added).toEqual(['C']);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].key).toBe('B');
    expect(result.merged['editor.fontSize']).toBe(14); // user key untouched
    expect(result.merged['C']).toEqual([1, 2]);
  });

  it('does not mutate the input objects', () => {
    const current = { 'A': 1 };
    const upstream = { 'A': 2, 'B': 3 };
    const currentCopy = { ...current };
    const upstreamCopy = { ...upstream };
    computeSettingsMerge(current, upstream);
    expect(current).toEqual(currentCopy);
    expect(upstream).toEqual(upstreamCopy);
  });
});

describe('applyApprovedOverwrites', () => {
  it('overwrites only the approved keys', () => {
    const base = { A: 'old-a', B: 'old-b', C: 'keep-c' };
    const upstream = { A: 'new-a', B: 'new-b' };
    const result = applyApprovedOverwrites(base, upstream, ['A']);
    expect(result).toEqual({ A: 'new-a', B: 'old-b', C: 'keep-c' });
  });

  it('ignores approved keys not present in upstream (defensive)', () => {
    // The call site builds the approved list from upstream keys, but the
    // helper refuses to invent a value for a key it does not know.
    const result = applyApprovedOverwrites({ A: 1 }, { B: 2 }, ['C']);
    expect(result).toEqual({ A: 1 });
  });

  it('is a no-op when no keys are approved', () => {
    const base = { A: 1 };
    const result = applyApprovedOverwrites(base, { A: 2 }, []);
    expect(result).toEqual({ A: 1 });
    expect(result).not.toBe(base); // still returns a copy
  });
});
