import { describe, it, expect } from 'vitest';
import {
  parseHooksYaml,
  groupHooksByEvent,
  normalizePriority,
  DEFAULT_HOOK_PRIORITY,
  type HookEntry,
} from '../extensions.js';

// Verbatim from spec-kit v1.2.2 extensions/EXTENSION-API-REFERENCE.md "Hook Configuration".
const UPSTREAM_EXAMPLE = `
hooks:
  after_tasks:
    - extension: jira
      command: speckit.jira.specstoissues
      enabled: true
      optional: true
      prompt: "Create Jira issues from tasks?"
      description: "..."
      condition: null
`;

describe('parseHooksYaml — Spec Kit v1.x schema', () => {
  it('parses the upstream documentation example', () => {
    expect(parseHooksYaml(UPSTREAM_EXAMPLE)).toEqual([
      {
        event: 'after_tasks',
        index: 0,
        command: 'speckit.jira.specstoissues',
        extension: 'jira',
        description: '...',
        prompt: 'Create Jira issues from tasks?',
        condition: undefined,
        optional: true,
        enabled: true,
        priority: DEFAULT_HOOK_PRIORITY,
      },
    ]);
  });

  it('defaults optional and enabled to true when absent (regression: v0.1.4 defaulted optional to false)', () => {
    const [h] = parseHooksYaml('hooks:\n  before_plan:\n    - command: speckit.x.y\n');
    expect(h.optional).toBe(true);
    expect(h.enabled).toBe(true);
  });

  it('respects optional: false as mandatory', () => {
    const [h] = parseHooksYaml('hooks:\n  before_plan:\n    - command: speckit.x.y\n      optional: false\n');
    expect(h.optional).toBe(false);
  });

  it('accepts a single mapping instead of a list (manifest form)', () => {
    const raw = `
hooks:
  after_tasks:
    command: "speckit.jira.specstoissues"
    optional: true
`;
    const parsed = parseHooksYaml(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].command).toBe('speckit.jira.specstoissues');
  });

  it('keeps disabled hooks, flagged, so the UI can re-enable them', () => {
    const raw = `
hooks:
  before_plan:
    - command: speckit.a.on
    - command: speckit.a.off
      enabled: false
`;
    expect(parseHooksYaml(raw).map((h) => [h.command, h.enabled])).toEqual([
      ['speckit.a.on', true],
      ['speckit.a.off', false],
    ]);
  });

  it('drops entries without a command (regression: v0.1.4 required a non-existent `name` field)', () => {
    const raw = `
hooks:
  after_plan:
    - name: legacy-shape
    - command: ""
    - command: speckit.real.cmd
`;
    expect(parseHooksYaml(raw).map((h) => h.command)).toEqual(['speckit.real.cmd']);
  });

  it('records the original list index so edits target the right entry', () => {
    const raw = `
hooks:
  after_plan:
    - command: speckit.a.first
      priority: 20
    - foo: no-command
    - command: speckit.a.third
      priority: 5
`;
    expect(parseHooksYaml(raw).map((h) => [h.command, h.index])).toEqual([
      ['speckit.a.third', 2],
      ['speckit.a.first', 0],
    ]);
  });

  it('sorts by priority ascending with a stable tie-break on file order', () => {
    const raw = `
hooks:
  after_plan:
    - command: speckit.p.report
      priority: 10
    - command: speckit.p.verify
      priority: 5
    - command: speckit.p.notify
    - command: speckit.p.lint
      priority: 5
`;
    expect(parseHooksYaml(raw).map((h) => h.command)).toEqual([
      'speckit.p.verify',
      'speckit.p.lint',
      'speckit.p.report',
      'speckit.p.notify',
    ]);
  });

  it('accepts core events Caramelo does not map (taskstoissues) and extension events (bug_*)', () => {
    const raw = `
hooks:
  after_taskstoissues:
    - command: speckit.a.b
  before_bug_fix:
    - command: speckit.bug.c
`;
    expect(parseHooksYaml(raw).map((h) => h.event).sort()).toEqual(['after_taskstoissues', 'before_bug_fix']);
  });

  it('ignores keys under hooks that are not before_/after_ events', () => {
    expect(parseHooksYaml('hooks:\n  installed:\n    - command: speckit.a.b\n')).toEqual([]);
  });

  it('keeps condition as an opaque trimmed string; null/blank become undefined', () => {
    const raw = `
hooks:
  before_implement:
    - command: speckit.a.one
      condition: "  config.connection.url is set "
    - command: speckit.a.two
      condition: "   "
    - command: speckit.a.three
      condition: null
`;
    expect(parseHooksYaml(raw).map((h) => h.condition)).toEqual(['config.connection.url is set', undefined, undefined]);
  });

  it('returns [] for empty, malformed, non-object, or hooks-less documents', () => {
    expect(parseHooksYaml('')).toEqual([]);
    expect(parseHooksYaml('hooks:\n  before_plan: [')).toEqual([]);
    expect(parseHooksYaml('- 1\n- 2')).toEqual([]);
    expect(parseHooksYaml('installed: [jira]')).toEqual([]);
    expect(parseHooksYaml('hooks: [1, 2]')).toEqual([]);
  });

  it('skips scalar event buckets and non-object entries without failing the rest', () => {
    const raw = `
hooks:
  before_plan: not-a-list
  after_plan:
    - 42
    - command: speckit.ok.cmd
`;
    expect(parseHooksYaml(raw).map((h) => h.command)).toEqual(['speckit.ok.cmd']);
  });
});

describe('normalizePriority — port of Spec Kit normalize_priority', () => {
  it.each([
    [5, 5],
    [1, 1],
    ['7', 7],
    [' 3 ', 3],
    [5.9, 5],
    [0, DEFAULT_HOOK_PRIORITY],
    [-2, DEFAULT_HOOK_PRIORITY],
    [true, DEFAULT_HOOK_PRIORITY],
    [false, DEFAULT_HOOK_PRIORITY],
    [null, DEFAULT_HOOK_PRIORITY],
    [undefined, DEFAULT_HOOK_PRIORITY],
    ['high', DEFAULT_HOOK_PRIORITY],
    ['5.5', DEFAULT_HOOK_PRIORITY],
    [Number.NaN, DEFAULT_HOOK_PRIORITY],
    [Number.POSITIVE_INFINITY, DEFAULT_HOOK_PRIORITY],
  ])('%j → %j', (input, expected) => {
    expect(normalizePriority(input)).toBe(expected);
  });
});

describe('groupHooksByEvent', () => {
  const h = (event: string, command: string): HookEntry => ({
    event, index: 0, command, optional: true, enabled: true, priority: DEFAULT_HOOK_PRIORITY,
  });

  it('orders core events by lifecycle, extension events after, preserving per-event order', () => {
    const grouped = groupHooksByEvent([
      h('after_tasks', 'a'),
      h('before_bug_fix', 'b'),
      h('before_specify', 'c'),
      h('after_tasks', 'd'),
    ]);
    expect([...grouped.keys()]).toEqual(['before_specify', 'after_tasks', 'before_bug_fix']);
    expect(grouped.get('after_tasks')!.map((x) => x.command)).toEqual(['a', 'd']);
  });

  it('returns an empty map for empty input', () => {
    expect(groupHooksByEvent([]).size).toBe(0);
  });
});
