import { describe, it, expect } from 'vitest';
import { safeJsonParse, isObject } from '../safe-json.js';

describe('safeJsonParse', () => {
  it('returns the parsed value for valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
    expect(safeJsonParse('"hello"')).toBe('hello');
  });

  it('returns null for invalid JSON', () => {
    expect(safeJsonParse('{not json')).toBeNull();
    expect(safeJsonParse('')).toBeNull();
  });

  it('returns null when the guard rejects the value', () => {
    const result = safeJsonParse('[1,2]', isObject);
    expect(result).toBeNull();
  });

  it('returns the value when the guard accepts it', () => {
    const result = safeJsonParse<Record<string, unknown>>('{"phases":{}}', isObject);
    expect(result).toEqual({ phases: {} });
  });
});

describe('isObject', () => {
  it('identifies plain objects', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it('rejects arrays and primitives', () => {
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject('str')).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});
