import { describe, it, expect } from 'vitest';
import {
  extractBalancedJsonObject,
  parseConstitutionResponse,
  parseMarkdownConstitution,
  tryParseJSON,
} from '../edit-constitution.js';

describe('tryParseJSON — regression: do NOT clobber apostrophes', () => {
  it('parses a JSON value containing an apostrophe (the prior bug)', () => {
    // The prior implementation did `.replace(/'/g, '"')` which broke any
    // legitimate JSON whose string values contained apostrophes — exactly
    // what Opus 4.7 produced when describing principles in English prose.
    const out = tryParseJSON('{"description": "Don\'t break things"}');
    expect(out).toEqual({ description: "Don't break things" });
  });

  it('parses possessive apostrophes too', () => {
    const out = tryParseJSON(`{"principle": "Respect users' privacy"}`);
    expect(out).toEqual({ principle: "Respect users' privacy" });
  });

  it('still cleans line comments at the start of a line', () => {
    const input = `// header comment\n{"a": 1}\n// trailing`;
    expect(tryParseJSON(input)).toEqual({ a: 1 });
  });

  it('does NOT strip URLs inside string values that contain "//"', () => {
    // The prior global comment-strip would chew "https://…" text inside a
    // string. The line-anchored version leaves it alone.
    const out = tryParseJSON('{"href": "https://example.com/path"}');
    expect(out).toEqual({ href: 'https://example.com/path' });
  });

  it('handles trailing commas before } or ]', () => {
    expect(tryParseJSON('{"a": 1,}')).toEqual({ a: 1 });
    expect(tryParseJSON('{"a": [1, 2,]}')).toEqual({ a: [1, 2] });
  });

  it('returns null on unrecoverable JSON', () => {
    expect(tryParseJSON('not json at all')).toBeNull();
  });

  it('returns null on JSON whose root is not an object (array / scalar)', () => {
    expect(tryParseJSON('42')).toBeNull();
    expect(tryParseJSON('[1,2,3]')).toBeNull();
  });
});

describe('extractBalancedJsonObject', () => {
  it('finds the first balanced object and ignores trailing prose', () => {
    const s = 'Here is the result: {"a":1, "b":{"c":2}} — let me know if questions.';
    expect(extractBalancedJsonObject(s)).toBe('{"a":1, "b":{"c":2}}');
  });

  it('respects braces inside string values', () => {
    // The string `"text {with brace}"` should NOT throw the balance off.
    const s = '{"k": "text {with brace} here", "n": 1}';
    expect(extractBalancedJsonObject(s)).toBe(s);
  });

  it('respects escaped quotes inside string values', () => {
    const s = '{"q": "she said \\"yes\\"", "n": 2}';
    expect(extractBalancedJsonObject(s)).toBe(s);
  });

  it('returns null when there is no { at all', () => {
    expect(extractBalancedJsonObject('plain prose')).toBeNull();
  });

  it('returns null when braces are unbalanced', () => {
    expect(extractBalancedJsonObject('{"a": 1')).toBeNull();
  });
});

describe('parseConstitutionResponse — full integration', () => {
  it('parses ```json fenced output', () => {
    const r = '```json\n{"projectName":"Foo","principles":[{"name":"A","description":"D"}]}\n```';
    const out = parseConstitutionResponse(r);
    expect(out?.projectName).toBe('Foo');
    expect(out?.principles).toEqual([{ name: 'A', description: 'D' }]);
  });

  it('parses bare JSON with apostrophe-containing prose (the original failure case)', () => {
    const r = '{"projectName":"Caramelo","principles":[' +
      '{"name":"Test-First","description":"Don\'t merge code without tests."},' +
      '{"name":"Privacy","description":"Respect users\' data."}' +
      ']}';
    const out = parseConstitutionResponse(r);
    expect(out?.principles).toHaveLength(2);
    expect(out?.principles[0].description).toBe("Don't merge code without tests.");
    expect(out?.principles[1].description).toBe("Respect users' data.");
  });

  it('parses JSON wrapped in chat preamble', () => {
    const r = `Sure! Here's the constitution:\n\n{"projectName":"X","principles":[{"name":"P","description":"D"}]}\n\nLet me know!`;
    const out = parseConstitutionResponse(r);
    expect(out?.projectName).toBe('X');
  });

  it('falls back to markdown headings when no JSON is present', () => {
    const r = [
      '# Caramelo Constitution',
      '',
      '## Core Principles',
      '',
      '### 1. Test-First',
      '',
      'Tests are written before implementation. No code merges without coverage.',
      '',
      '### 2. Simplicity',
      '',
      'YAGNI. Start simple, expand only when needed.',
      '',
      '## Constraints',
      '',
      'TypeScript strict mode. No external SDKs.',
      '',
      '## Development Workflow',
      '',
      'PR review before merge. CI must pass.',
    ].join('\n');
    const out = parseConstitutionResponse(r);
    expect(out?.projectName).toBe('Caramelo');
    expect(out?.principles).toHaveLength(2);
    expect(out?.principles[0].name).toBe('Test-First');
    expect(out?.principles[0].description).toMatch(/written before implementation/);
    expect(out?.principles[1].name).toBe('Simplicity');
    expect(out?.constraints).toMatch(/strict mode/);
    expect(out?.workflow).toMatch(/CI must pass/);
  });

  it('falls back to single-line shorthand when no headings exist', () => {
    const r = [
      'Here are some principles:',
      '1. **Test-First**: TDD mandatory; tests written before code.',
      '2. **Simplicity**: YAGNI; start with the smallest viable surface.',
    ].join('\n');
    const out = parseConstitutionResponse(r);
    expect(out?.principles).toHaveLength(2);
    expect(out?.principles[0].name).toBe('Test-First');
    expect(out?.principles[0].description).toMatch(/TDD mandatory/);
  });

  it('returns null when the response has no parseable structure', () => {
    expect(parseConstitutionResponse('I cannot help with that')).toBeNull();
  });

  it('handles JSON with line comments (older Opus output style)', () => {
    const r = '// generated\n{"projectName":"X","principles":[{"name":"A","description":"B"}]}';
    const out = parseConstitutionResponse(r);
    expect(out?.projectName).toBe('X');
  });
});

describe('parseMarkdownConstitution', () => {
  it('captures multi-paragraph descriptions intact', () => {
    const r = [
      '### 1. Recoverable',
      '',
      'First paragraph explaining the rule.',
      '',
      'Second paragraph with a follow-up clause that elaborates.',
      '',
      '### 2. Other',
      '',
      'Short description.',
    ].join('\n');
    const out = parseMarkdownConstitution(r);
    expect(out.principles).toHaveLength(2);
    expect(out.principles[0].description).toContain('First paragraph');
    expect(out.principles[0].description).toContain('Second paragraph');
  });

  it('strips template-style HTML comments from descriptions', () => {
    const r = '### 1. Test-First\n\nMandatory.<!-- example: TDD -->';
    const out = parseMarkdownConstitution(r);
    expect(out.principles[0].description).toBe('Mandatory.');
  });
});
