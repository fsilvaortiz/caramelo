import { describe, it, expect } from 'vitest';
import { sanitizeHeaderName, sanitizeHeaderPrefix } from '../auth.js';

describe('sanitizeHeaderName', () => {
  it('accepts typical header names', () => {
    expect(sanitizeHeaderName('Authorization', 'x-api-key')).toBe('Authorization');
    expect(sanitizeHeaderName('x-api-key', 'x-api-key')).toBe('x-api-key');
    expect(sanitizeHeaderName('Ocp-Apim-Subscription-Key', 'x-api-key')).toBe('Ocp-Apim-Subscription-Key');
  });

  it('falls back when the value is missing', () => {
    expect(sanitizeHeaderName(undefined, 'x-api-key')).toBe('x-api-key');
    expect(sanitizeHeaderName('', 'x-api-key')).toBe('x-api-key');
  });

  it('rejects values containing CRLF or other control chars', () => {
    expect(sanitizeHeaderName('Auth\r\nX-Injected', 'x-api-key')).toBe('x-api-key');
    expect(sanitizeHeaderName('Auth Header', 'x-api-key')).toBe('x-api-key');
    expect(sanitizeHeaderName('Auth:Header', 'x-api-key')).toBe('x-api-key');
  });

  it('rejects absurdly long values', () => {
    const long = 'A'.repeat(128);
    expect(sanitizeHeaderName(long, 'x-api-key')).toBe('x-api-key');
  });
});

describe('sanitizeHeaderPrefix', () => {
  it('accepts empty prefix', () => {
    expect(sanitizeHeaderPrefix('', 'Bearer')).toBe('');
  });

  it('accepts typical prefixes', () => {
    expect(sanitizeHeaderPrefix('Bearer', 'Bearer')).toBe('Bearer');
    expect(sanitizeHeaderPrefix('Basic', 'Bearer')).toBe('Basic');
  });

  it('rejects CRLF injection attempts', () => {
    expect(sanitizeHeaderPrefix('Bearer\r\nX: y', 'Bearer')).toBe('Bearer');
  });

  it('falls back on undefined', () => {
    expect(sanitizeHeaderPrefix(undefined, 'Bearer')).toBe('Bearer');
  });
});
