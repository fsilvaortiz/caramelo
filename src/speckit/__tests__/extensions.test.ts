import { describe, it, expect } from 'vitest';
import { parseHooksYaml, groupHooksByPhase, type HookEntry } from '../extensions.js';

describe('parseHooksYaml', () => {
  it('returns an empty list for an empty file', () => {
    expect(parseHooksYaml('')).toEqual([]);
  });

  it('returns an empty list for malformed YAML', () => {
    // Unclosed brace — the parser throws, we swallow and log, return empty.
    expect(parseHooksYaml('hooks:\n  before_converge: [')).toEqual([]);
  });

  it('returns an empty list when the root is not an object', () => {
    expect(parseHooksYaml('42')).toEqual([]);
    expect(parseHooksYaml('- 1\n- 2')).toEqual([]);
  });

  it('returns an empty list when `hooks:` is missing', () => {
    expect(parseHooksYaml('name: project\nversion: 1')).toEqual([]);
  });

  it('parses a well-formed single-hook entry', () => {
    const raw = `
hooks:
  before_converge:
    - name: run-tests
      optional: true
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed).toEqual([
      { phaseKey: 'before_converge', name: 'run-tests', optional: true },
    ]);
  });

  it('parses multiple hooks under the same phase, preserving order', () => {
    const raw = `
hooks:
  before_implement:
    - name: lint
    - name: typecheck
      optional: true
    - name: tests
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed.map((h) => h.name)).toEqual(['lint', 'typecheck', 'tests']);
    expect(parsed[0].optional).toBe(false); // default
    expect(parsed[1].optional).toBe(true);
  });

  it('drops hooks explicitly disabled with `enabled: false`', () => {
    const raw = `
hooks:
  before_plan:
    - name: active
    - name: inactive
      enabled: false
    - name: also-active
      enabled: true
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed.map((h) => h.name)).toEqual(['active', 'also-active']);
  });

  it('drops hooks with no name or an empty name', () => {
    const raw = `
hooks:
  after_tasks:
    - optional: true
    - name: ""
    - name: "   "
    - name: real-hook
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed).toEqual([
      { phaseKey: 'after_tasks', name: 'real-hook', optional: false },
    ]);
  });

  it('ignores unknown phase keys without failing the whole parse', () => {
    const raw = `
hooks:
  before_plan:
    - name: known
  mystery_phase:
    - name: future-hook
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed).toEqual([
      { phaseKey: 'before_plan', name: 'known', optional: false },
    ]);
  });

  it('surfaces conditions as opaque strings without evaluating them', () => {
    const raw = `
hooks:
  before_converge:
    - name: gated
      condition: "env.CI == 'true'"
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed[0].condition).toBe("env.CI == 'true'");
  });

  it('drops a blank/whitespace-only condition rather than storing it', () => {
    const raw = `
hooks:
  before_converge:
    - name: nocondition
      condition: "   "
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed[0].condition).toBeUndefined();
  });

  it('skips non-array phase buckets instead of throwing', () => {
    const raw = `
hooks:
  before_plan: not-a-list
  after_plan:
    - name: good
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed).toEqual([
      { phaseKey: 'after_plan', name: 'good', optional: false },
    ]);
  });

  it('handles every known phase key', () => {
    const raw = `
hooks:
  before_specify:
    - name: a
  after_specify:
    - name: b
  before_plan:
    - name: c
  after_plan:
    - name: d
  before_tasks:
    - name: e
  after_tasks:
    - name: f
  before_implement:
    - name: g
  after_implement:
    - name: h
  before_clarify:
    - name: i
  after_clarify:
    - name: j
  before_analyze:
    - name: k
  after_analyze:
    - name: l
  before_constitution:
    - name: m
  after_constitution:
    - name: n
  before_checklist:
    - name: o
  after_checklist:
    - name: p
  before_converge:
    - name: q
  after_converge:
    - name: r
    `;
    const parsed = parseHooksYaml(raw);
    expect(parsed).toHaveLength(18);
  });
});

describe('groupHooksByPhase', () => {
  it('buckets entries by phaseKey preserving insertion order', () => {
    const hooks: HookEntry[] = [
      { phaseKey: 'before_plan', name: 'a', optional: false },
      { phaseKey: 'after_plan', name: 'b', optional: false },
      { phaseKey: 'before_plan', name: 'c', optional: false },
    ];
    const grouped = groupHooksByPhase(hooks);
    expect([...grouped.keys()]).toEqual(['before_plan', 'after_plan']);
    expect(grouped.get('before_plan')!.map((h) => h.name)).toEqual(['a', 'c']);
    expect(grouped.get('after_plan')!.map((h) => h.name)).toEqual(['b']);
  });

  it('returns an empty map for empty input', () => {
    expect(groupHooksByPhase([]).size).toBe(0);
  });
});
