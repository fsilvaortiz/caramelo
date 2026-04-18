import { describe, it, expect } from 'vitest';
import {
  AuthError,
  CarameloError,
  NetworkError,
  ProviderError,
  TimeoutError,
  isAbortError,
} from '../../errors.js';

describe('error hierarchy', () => {
  it('preserves the class name', () => {
    expect(new TimeoutError('x').name).toBe('TimeoutError');
    expect(new AuthError('x').name).toBe('AuthError');
    expect(new NetworkError('x').name).toBe('NetworkError');
  });

  it('carries cause and status on ProviderError', () => {
    const cause = new Error('root');
    const err = new ProviderError('failed', 429, cause);
    expect(err.status).toBe(429);
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(CarameloError);
  });
});

describe('isAbortError', () => {
  it('detects fetch abort errors', () => {
    const err = new Error('The user aborted a request.');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isAbortError(new Error('generic'))).toBe(false);
    expect(isAbortError('string')).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
