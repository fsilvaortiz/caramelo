import { describe, it, expect } from 'vitest';
import { LegacyFormatError, ParseError, parseEdits } from '../parser.js';

describe('parseEdits', () => {
  it('returns an empty array for empty or prose-only output', () => {
    expect(parseEdits('')).toEqual([]);
    expect(parseEdits('Here is my explanation, no edits.')).toEqual([]);
  });

  it('parses a single SEARCH/REPLACE block', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      'const x = 1;',
      '=======',
      'const x = 2;',
      '>>>>>>> REPLACE',
      '=== END FILE ===',
    ].join('\n');

    expect(parseEdits(input)).toEqual([
      { kind: 'edit', filePath: 'src/a.ts', search: 'const x = 1;', replace: 'const x = 2;' },
    ]);
  });

  it('parses multiple SEARCH/REPLACE pairs inside one FILE block', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      'foo',
      '=======',
      'bar',
      '>>>>>>> REPLACE',
      '',
      '<<<<<<< SEARCH',
      'baz',
      '=======',
      'qux',
      '>>>>>>> REPLACE',
      '=== END FILE ===',
    ].join('\n');

    const edits = parseEdits(input);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ filePath: 'src/a.ts', search: 'foo', replace: 'bar' });
    expect(edits[1]).toMatchObject({ filePath: 'src/a.ts', search: 'baz', replace: 'qux' });
  });

  it('parses a CREATE block', () => {
    const input = [
      '=== CREATE: src/new.ts ===',
      'export const y = 10;',
      '=== END CREATE ===',
    ].join('\n');

    expect(parseEdits(input)).toEqual([
      { kind: 'create', filePath: 'src/new.ts', content: 'export const y = 10;' },
    ]);
  });

  it('parses mixed FILE and CREATE blocks across one response', () => {
    const input = [
      'Explanatory text before.',
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      'old',
      '=======',
      'new',
      '>>>>>>> REPLACE',
      '=== END FILE ===',
      'Text between.',
      '=== CREATE: src/b.ts ===',
      'line1',
      'line2',
      '=== END CREATE ===',
      'Text after.',
    ].join('\n');

    const edits = parseEdits(input);
    expect(edits).toHaveLength(2);
    expect(edits[0].kind).toBe('edit');
    expect(edits[1]).toEqual({ kind: 'create', filePath: 'src/b.ts', content: 'line1\nline2' });
  });

  it('throws LegacyFormatError for an old-style whole-file FILE block', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      'export const x = 1;',
      'export const y = 2;',
      '=== END FILE ===',
    ].join('\n');

    expect(() => parseEdits(input)).toThrow(LegacyFormatError);
    expect(() => parseEdits(input)).toThrow(/whole-file overwrite/);
  });

  it('throws ParseError when === END FILE === is missing', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      'foo',
      '=======',
      'bar',
      '>>>>>>> REPLACE',
    ].join('\n');

    expect(() => parseEdits(input)).toThrow(ParseError);
    expect(() => parseEdits(input)).toThrow(/END FILE/);
  });

  it('throws ParseError when === END CREATE === is missing', () => {
    const input = [
      '=== CREATE: src/new.ts ===',
      'foo',
    ].join('\n');

    expect(() => parseEdits(input)).toThrow(ParseError);
    expect(() => parseEdits(input)).toThrow(/END CREATE/);
  });

  it('throws ParseError when the ======= divider is missing', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      'foo',
      '>>>>>>> REPLACE',
      '=== END FILE ===',
    ].join('\n');

    expect(() => parseEdits(input)).toThrow(ParseError);
    expect(() => parseEdits(input)).toThrow(/divider/);
  });

  it('throws ParseError when >>>>>>> REPLACE is missing', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      'foo',
      '=======',
      'bar',
      '=== END FILE ===',
    ].join('\n');

    expect(() => parseEdits(input)).toThrow(ParseError);
    expect(() => parseEdits(input)).toThrow(/REPLACE/);
  });

  it('throws ParseError on nested <<<<<<< SEARCH markers', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      '<<<<<<< SEARCH',
      'foo',
      '=======',
      'bar',
      '>>>>>>> REPLACE',
      '=== END FILE ===',
    ].join('\n');

    expect(() => parseEdits(input)).toThrow(ParseError);
    expect(() => parseEdits(input)).toThrow(/Nested/);
  });

  it('throws ParseError on stray divider without a preceding SEARCH', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '=======',
      '=== END FILE ===',
    ].join('\n');

    expect(() => parseEdits(input)).toThrow(ParseError);
    expect(() => parseEdits(input)).toThrow(/Stray/);
  });

  it('tolerates CRLF line endings in the input stream', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      'foo',
      '=======',
      'bar',
      '>>>>>>> REPLACE',
      '=== END FILE ===',
    ].join('\r\n');

    expect(parseEdits(input)).toEqual([
      { kind: 'edit', filePath: 'src/a.ts', search: 'foo', replace: 'bar' },
    ]);
  });

  it('preserves internal blank lines inside SEARCH and REPLACE sections', () => {
    const input = [
      '=== FILE: src/a.ts ===',
      '<<<<<<< SEARCH',
      'line 1',
      '',
      'line 3',
      '=======',
      'only line',
      '>>>>>>> REPLACE',
      '=== END FILE ===',
    ].join('\n');

    const edits = parseEdits(input);
    expect(edits[0]).toMatchObject({
      search: 'line 1\n\nline 3',
      replace: 'only line',
    });
  });
});
