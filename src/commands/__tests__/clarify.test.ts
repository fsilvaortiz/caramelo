import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseQuestions, writeAnswersToSpec } from '../clarify.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-clarify-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseQuestions', () => {
  it('extracts a JSON block delimited by ```json fences', () => {
    const input = 'preamble\n```json\n[{"question":"Q?","options":["A","B"],"recommended":0}]\n```\nepilogue';
    const out = parseQuestions(input);
    expect(out).toEqual([{ question: 'Q?', options: ['A', 'B'], recommended: 0 }]);
  });

  it('parses a bare JSON array (no fences)', () => {
    const out = parseQuestions('[{"question":"Q","options":["x","y"],"recommended":1}]');
    expect(out).toHaveLength(1);
    expect(out![0].recommended).toBe(1);
  });

  it('returns null for non-array root', () => {
    expect(parseQuestions('{"foo":"bar"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseQuestions('not json at all')).toBeNull();
  });

  it('returns null when items lack the required shape', () => {
    expect(parseQuestions('[{"question":"Q","options":[]}]')).toBeNull();
    expect(parseQuestions('[{"question":1,"options":["A","B"],"recommended":0}]')).toBeNull();
    expect(parseQuestions('[{"question":"Q","options":["A",1],"recommended":0}]')).toBeNull();
  });

  it('returns an empty array for "no ambiguities"', () => {
    expect(parseQuestions('```json\n[]\n```')).toEqual([]);
  });

  it('rejects empty / whitespace-only questions', () => {
    expect(parseQuestions('[{"question":"","options":["A","B"],"recommended":0}]')).toBeNull();
    expect(parseQuestions('[{"question":"   ","options":["A","B"],"recommended":0}]')).toBeNull();
  });

  it('rejects options arrays with fewer than 2 or more than 5 entries', () => {
    expect(parseQuestions('[{"question":"Q","options":["A"],"recommended":0}]')).toBeNull();
    const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((s) => `"${s}"`).join(',');
    expect(parseQuestions(`[{"question":"Q","options":[${six}],"recommended":0}]`)).toBeNull();
  });

  it('rejects empty option strings', () => {
    expect(parseQuestions('[{"question":"Q","options":["A",""],"recommended":0}]')).toBeNull();
  });

  it('rejects out-of-bounds or non-integer recommended', () => {
    // recommended === options.length is out of range.
    expect(parseQuestions('[{"question":"Q","options":["A","B"],"recommended":2}]')).toBeNull();
    expect(parseQuestions('[{"question":"Q","options":["A","B"],"recommended":-1}]')).toBeNull();
    expect(parseQuestions('[{"question":"Q","options":["A","B"],"recommended":1.5}]')).toBeNull();
    expect(parseQuestions('[{"question":"Q","options":["A","B"],"recommended":"0"}]')).toBeNull();
  });

  it('accepts the recommended-equals-last-index case', () => {
    expect(
      parseQuestions('[{"question":"Q","options":["A","B","C"],"recommended":2}]'),
    ).toEqual([{ question: 'Q', options: ['A', 'B', 'C'], recommended: 2 }]);
  });
});

describe('writeAnswersToSpec', () => {
  it('inserts a Clarifications section before Assumptions when missing', () => {
    const specPath = path.join(tmp, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n\n## Requirements\n\nfoo\n\n## Assumptions\n\nbar\n', 'utf-8');
    writeAnswersToSpec(specPath, [{ question: 'Q1', answer: 'A1' }]);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toContain('## Clarifications');
    expect(out.indexOf('## Clarifications')).toBeLessThan(out.indexOf('## Assumptions'));
    expect(out).toContain('- Q: Q1 → A: A1');
  });

  it('appends a new dated subsection (with HH:MM differentiator) when Clarifications already exists', () => {
    const specPath = path.join(tmp, 'spec.md');
    fs.writeFileSync(
      specPath,
      '# Spec\n\n## Clarifications\n\n### Session 2026-01-01\n\n- Q: old → A: ans\n\n## Assumptions\n',
      'utf-8',
    );
    const result = writeAnswersToSpec(specPath, [{ question: 'NewQ', answer: 'NewA' }]);
    expect(result.ok).toBe(true);
    const out = fs.readFileSync(specPath, 'utf-8');
    // Both sessions present; new one inserted right after the existing
    // header. HH:MM differentiator means same-day re-runs don't collide.
    expect(out).toContain('### Session 2026-01-01');
    expect(out).toContain('- Q: old → A: ans');
    expect(out).toMatch(/### Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\n- Q: NewQ → A: NewA/);
  });

  it('appends to end of file when neither Clarifications nor Assumptions exists', () => {
    const specPath = path.join(tmp, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n\nbody\n', 'utf-8');
    writeAnswersToSpec(specPath, [{ question: 'Q', answer: 'A' }]);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/body\n\n## Clarifications/);
    expect(out).toContain('- Q: Q → A: A');
  });

  it('returns no-answers reason and does NOT touch disk on empty list', () => {
    const specPath = path.join(tmp, 'spec.md');
    const before = '# Spec\n\nfoo\n';
    fs.writeFileSync(specPath, before, 'utf-8');
    const result = writeAnswersToSpec(specPath, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-answers');
    expect(fs.readFileSync(specPath, 'utf-8')).toBe(before);
  });

  it('returns read-failed reason when the spec file does not exist', () => {
    const result = writeAnswersToSpec(
      path.join(tmp, 'missing.md'),
      [{ question: 'Q', answer: 'A' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('read-failed');
  });

  it('only matches a Clarifications heading at start of line', () => {
    const specPath = path.join(tmp, 'spec.md');
    // Body text mentions "## Clarifications" inside a quoted paragraph;
    // the real heading for the section is on its own line below.
    fs.writeFileSync(
      specPath,
      '# Spec\n\nThis project has a "## Clarifications" convention.\n\n## Assumptions\n\nbar\n',
      'utf-8',
    );
    const result = writeAnswersToSpec(specPath, [{ question: 'Q', answer: 'A' }]);
    expect(result.ok).toBe(true);
    const out = fs.readFileSync(specPath, 'utf-8');
    // The body text mention is preserved untouched; the new section is
    // inserted at the Assumptions anchor.
    expect(out).toContain('"## Clarifications" convention');
    expect(out).toMatch(/## Clarifications\n\n### Session.*\n\n- Q: Q → A: A/);
  });

  it('returns success result with bytesWritten on success', () => {
    const specPath = path.join(tmp, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n\nbody\n', 'utf-8');
    const result = writeAnswersToSpec(specPath, [{ question: 'Q', answer: 'A' }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytesWritten).toBeGreaterThan(0);
    }
  });
});
