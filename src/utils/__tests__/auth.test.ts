import { describe, it, expect } from 'vitest';
import { buildAuthHeaders, resolveHelperHeaderTarget, sanitizeHeaderName, sanitizeHeaderPrefix } from '../auth.js';

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

describe('resolveHelperHeaderTarget', () => {
  it('returns null when no helper header is set or it equals the auth header', () => {
    expect(resolveHelperHeaderTarget({}, 'x-api-key')).toBeNull();
    expect(resolveHelperHeaderTarget({ apiKeyHelperHeader: '  ' }, 'x-api-key')).toBeNull();
    expect(resolveHelperHeaderTarget({ apiKeyHelperHeader: 'X-API-KEY' }, 'x-api-key')).toBeNull();
  });

  it('defaults the prefix to Bearer for Authorization and to none otherwise', () => {
    expect(resolveHelperHeaderTarget({ apiKeyHelperHeader: 'Authorization' }, 'Ocp-Apim-Subscription-Key'))
      .toEqual({ header: 'Authorization', prefix: 'Bearer' });
    expect(resolveHelperHeaderTarget({ apiKeyHelperHeader: 'X-Token' }, 'Ocp-Apim-Subscription-Key'))
      .toEqual({ header: 'X-Token', prefix: '' });
    expect(resolveHelperHeaderTarget({ apiKeyHelperHeader: 'X-Token', apiKeyHelperPrefix: 'Token' }, 'x-api-key'))
      .toEqual({ header: 'X-Token', prefix: 'Token' });
  });

  it('ignores invalid header names', () => {
    expect(resolveHelperHeaderTarget({ apiKeyHelperHeader: 'Bad Header:\r\n' }, 'x-api-key')).toBeNull();
  });
});

describe('buildAuthHeaders', () => {
  const base = { authHeader: 'Ocp-Apim-Subscription-Key', authPrefix: '' };

  it('helper output replaces the stored key when it has no own header', () => {
    expect(buildAuthHeaders({ ...base, helperTarget: null, storedKey: 'sub', helperToken: 'tok' }))
      .toEqual({ 'Ocp-Apim-Subscription-Key': 'tok' });
  });

  it('sends both headers when the helper has its own header', () => {
    expect(buildAuthHeaders({
      ...base,
      helperTarget: { header: 'Authorization', prefix: 'Bearer' },
      storedKey: 'sub',
      helperToken: 'tok',
    })).toEqual({ 'Ocp-Apim-Subscription-Key': 'sub', Authorization: 'Bearer tok' });
  });

  it('sends only the stored key without a helper, and nothing without either', () => {
    expect(buildAuthHeaders({ ...base, helperTarget: null, storedKey: 'sub', helperToken: null }))
      .toEqual({ 'Ocp-Apim-Subscription-Key': 'sub' });
    expect(buildAuthHeaders({ ...base, helperTarget: null, storedKey: null, helperToken: null })).toEqual({});
  });
});
