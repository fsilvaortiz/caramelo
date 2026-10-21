import { describe, it, expect } from 'vitest';
import {
  parseConvergeOutput,
  appendConvergedTasks,
  buildConvergeMessages,
} from '../converge.js';

describe('parseConvergeOutput', () => {
  it('returns empty for the NONE sentinel in any case', () => {
    expect(parseConvergeOutput('NONE')).toEqual([]);
    expect(parseConvergeOutput('none')).toEqual([]);
    expect(parseConvergeOutput('  None  ')).toEqual([]);
  });

  it('returns empty for an empty / whitespace-only body', () => {
    expect(parseConvergeOutput('')).toEqual([]);
    expect(parseConvergeOutput('   \n\n')).toEqual([]);
  });

  it('parses properly-formatted checkbox lines', () => {
    const raw = `
- [ ] First task
- [ ] Second task
- [ ] Third task
    `;
    expect(parseConvergeOutput(raw)).toEqual([
      '- [ ] First task',
      '- [ ] Second task',
      '- [ ] Third task',
    ]);
  });

  it('normalises already-checked items back to unchecked (new tasks are not pre-done)', () => {
    const raw = '- [x] Should start as pending\n- [X] Even uppercase X\n';
    expect(parseConvergeOutput(raw)).toEqual([
      '- [ ] Should start as pending',
      '- [ ] Even uppercase X',
    ]);
  });

  it('accepts numbered lists and converts them to checkboxes', () => {
    const raw = `
1. Alpha
2) Beta
3. Gamma
    `;
    expect(parseConvergeOutput(raw)).toEqual([
      '- [ ] Alpha',
      '- [ ] Beta',
      '- [ ] Gamma',
    ]);
  });

  it('accepts plain bullets and converts them to checkboxes', () => {
    const raw = `
- plain dash
* asterisk bullet
+ plus bullet
    `;
    expect(parseConvergeOutput(raw)).toEqual([
      '- [ ] plain dash',
      '- [ ] asterisk bullet',
      '- [ ] plus bullet',
    ]);
  });

  it('discards free-form prose that is not a list line', () => {
    // A chatty model preamble must not leak into tasks.md.
    const raw = `
Here are the new tasks you need to add:

- [ ] Real task

Let me know if you want to iterate.
    `;
    expect(parseConvergeOutput(raw)).toEqual(['- [ ] Real task']);
  });

  it('mixes shapes without losing any task', () => {
    const raw = `
- [ ] A proper checkbox
1. A numbered item
* A bullet
- [X] A pre-checked item
    `;
    expect(parseConvergeOutput(raw)).toEqual([
      '- [ ] A proper checkbox',
      '- [ ] A numbered item',
      '- [ ] A bullet',
      '- [ ] A pre-checked item',
    ]);
  });
});

describe('appendConvergedTasks', () => {
  const BASE = `# Tasks\n\n- [ ] Alpha\n- [ ] Beta\n`;

  it('is a no-op when there are no new tasks', () => {
    expect(appendConvergedTasks(BASE, [], '2026-10-21')).toBe(BASE);
  });

  it('preserves every byte of the original file as a prefix of the output', () => {
    // The core invariant — the LLM only adds, never edits.
    const out = appendConvergedTasks(BASE, ['- [ ] Gamma'], '2026-10-21');
    expect(out.startsWith(BASE)).toBe(true);
  });

  it('appends a dated section with the new tasks', () => {
    const out = appendConvergedTasks(BASE, ['- [ ] Gamma', '- [ ] Delta'], '2026-10-21');
    expect(out).toContain('## Converged Tasks — 2026-10-21');
    expect(out).toContain('- [ ] Gamma');
    expect(out).toContain('- [ ] Delta');
    expect(out).toMatch(/\n$/); // trailing newline
  });

  it('coerces a bare task string into a checkbox line', () => {
    // Defence in depth: parseConvergeOutput already normalises, but if a
    // caller supplies a raw string we still get valid markdown.
    const out = appendConvergedTasks(BASE, ['Raw task text'], '2026-10-21');
    expect(out).toContain('- [ ] Raw task text');
  });

  it('handles a base file that already ends with a newline (no double blank line insertion)', () => {
    const out = appendConvergedTasks(BASE, ['- [ ] One'], '2026-10-21');
    // Expect at most two consecutive newlines between the original and the heading.
    expect(out).not.toMatch(/\n{3,}## Converged/);
  });

  it('handles a base file that does NOT end with a newline', () => {
    const noNewline = `# Tasks\n\n- [ ] Alpha`;
    const out = appendConvergedTasks(noNewline, ['- [ ] Beta'], '2026-10-21');
    expect(out.startsWith(noNewline)).toBe(true);
    expect(out).toContain('## Converged Tasks — 2026-10-21');
  });

  it('each converge run appends a new dated section (audit trail stays legible)', () => {
    const first = appendConvergedTasks(BASE, ['- [ ] T1'], '2026-10-20');
    const second = appendConvergedTasks(first, ['- [ ] T2'], '2026-10-21');
    expect(second).toContain('## Converged Tasks — 2026-10-20');
    expect(second).toContain('## Converged Tasks — 2026-10-21');
    expect(second.indexOf('2026-10-20')).toBeLessThan(second.indexOf('2026-10-21'));
  });
});

describe('buildConvergeMessages', () => {
  it('produces a system message with the never-edit constraint', () => {
    const msgs = buildConvergeMessages('spec', 'plan', 'tasks');
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/MUST NOT edit, reorder, or restate/);
  });

  it('inlines all three artifacts in the user message, labelled', () => {
    const msgs = buildConvergeMessages('SPEC BODY', 'PLAN BODY', 'TASKS BODY');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('--- SPEC: spec.md ---');
    expect(msgs[1].content).toContain('SPEC BODY');
    expect(msgs[1].content).toContain('--- PLAN: plan.md ---');
    expect(msgs[1].content).toContain('PLAN BODY');
    expect(msgs[1].content).toContain('--- TASKS: tasks.md (current) ---');
    expect(msgs[1].content).toContain('TASKS BODY');
  });

  it('instructs the model to respond with NONE when nothing is missing', () => {
    const msgs = buildConvergeMessages('a', 'b', 'c');
    const combined = msgs.map((m) => m.content).join('\n');
    expect(combined).toContain('NONE');
  });
});
