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
    expect(parseQuestions('[{"question":1,"options":["A"],"recommended":0}]')).toBeNull();
    expect(parseQuestions('[{"question":"Q","options":["A",1],"recommended":0}]')).toBeNull();
  });

  it('returns an empty array for "no ambiguities"', () => {
    expect(parseQuestions('```json\n[]\n```')).toEqual([]);
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

  it('appends a new dated subsection when Clarifications already exists', () => {
    const specPath = path.join(tmp, 'spec.md');
    fs.writeFileSync(
      specPath,
      '# Spec\n\n## Clarifications\n\n### Session 2026-01-01\n\n- Q: old → A: ans\n\n## Assumptions\n',
      'utf-8',
    );
    writeAnswersToSpec(specPath, [{ question: 'NewQ', answer: 'NewA' }]);
    const out = fs.readFileSync(specPath, 'utf-8');
    // Both sessions present; new one inserted right after the existing
    // header (so older sessions remain visible below).
    expect(out).toContain('### Session 2026-01-01');
    expect(out).toContain('- Q: old → A: ans');
    expect(out).toMatch(/### Session \d{4}-\d{2}-\d{2}\n\n- Q: NewQ → A: NewA/);
  });

  it('appends to end of file when neither Clarifications nor Assumptions exists', () => {
    const specPath = path.join(tmp, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n\nbody\n', 'utf-8');
    writeAnswersToSpec(specPath, [{ question: 'Q', answer: 'A' }]);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/body\n\n## Clarifications/);
    expect(out).toContain('- Q: Q → A: A');
  });

  it('does nothing when answers list is empty (no file write)', () => {
    const specPath = path.join(tmp, 'spec.md');
    const before = '# Spec\n\nfoo\n';
    fs.writeFileSync(specPath, before, 'utf-8');
    writeAnswersToSpec(specPath, []);
    expect(fs.readFileSync(specPath, 'utf-8')).toBe(before);
  });

  it('silently no-ops when the spec file does not exist (returns without throwing)', () => {
    expect(() =>
      writeAnswersToSpec(path.join(tmp, 'missing.md'), [{ question: 'Q', answer: 'A' }]),
    ).not.toThrow();
  });
});
