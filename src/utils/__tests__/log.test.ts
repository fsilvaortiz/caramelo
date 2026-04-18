import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('log redactions', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('redacts Bearer tokens in string args', async () => {
    const { log } = await import('../log.js');
    log.info('request with', 'Header Bearer sk-secret-abc123 ends');
    const call = logSpy.mock.calls[0];
    const rendered = call.join(' ');
    expect(rendered).not.toContain('sk-secret-abc123');
    expect(rendered).toContain('Bearer [REDACTED]');
  });

  it('redacts values of Authorization headers regardless of scheme', async () => {
    const { log } = await import('../log.js');
    log.info('Authorization: Bearer sk-secret-abc123');
    const rendered = logSpy.mock.calls[0].join(' ');
    expect(rendered).not.toContain('sk-secret-abc123');
    expect(rendered).toContain('[REDACTED]');
  });

  it('redacts basic auth in urls', async () => {
    const { log } = await import('../log.js');
    log.error('failed: https://user:pass@api.example.com/v1');
    const call = errSpy.mock.calls[0];
    const rendered = call.join(' ');
    expect(rendered).not.toContain('user:pass');
    expect(rendered).toContain('[REDACTED]@api.example.com');
  });

  it('redacts token fields inside object args', async () => {
    const { log } = await import('../log.js');
    log.warn('payload', { token: 'xyz-secret-token', safe: 'value' });
    const call = warnSpy.mock.calls[0];
    const rendered = JSON.stringify(call);
    expect(rendered).not.toContain('xyz-secret-token');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).toContain('value');
  });

  it('suppresses debug output when CARAMELO_DEBUG is unset', async () => {
    vi.stubEnv('CARAMELO_DEBUG', '');
    vi.resetModules();
    const { log } = await import('../log.js');
    log.debug('hidden message');
    expect(logSpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('emits debug output when CARAMELO_DEBUG=1', async () => {
    vi.stubEnv('CARAMELO_DEBUG', '1');
    vi.resetModules();
    const { log } = await import('../log.js');
    log.debug('visible message');
    expect(logSpy).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
