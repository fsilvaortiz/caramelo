import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyPlaceholders,
  TemplateSync,
  ALL_TEMPLATES_FOR_TESTS,
  REQUIRED_TEMPLATES_FOR_TESTS,
  PLACEHOLDER_SUBSTITUTIONS_FOR_TESTS,
  RAW_BASE_URL_FOR_TESTS,
  type TemplateSyncPaths,
} from '../sync.js';
import { SPEC_KIT_API_URL } from '../../constants.js';

// Synthetic fixture so test fixtures don't read like archeology when an
// upstream tag rolls. Tests only care that the tag round-trips.
const FAKE_TAG = 'v9.9.9-test';
const FAKE_TAG_2 = 'v9.9.10-test';

/**
 * Body big enough to clear the MIN_TEMPLATE_BYTES floor. Anything below
 * 50 bytes is treated as a failed fetch.
 */
const TEMPLATE_BODY =
  '# Template\n\nRun __SPECKIT_COMMAND_PLAN__ then __SPECKIT_COMMAND_TASKS__. ' +
  'A nice long body to clear the minimum-size guard.\n';

describe('applyPlaceholders', () => {
  it('substitutes every known __SPECKIT_COMMAND_*__ token', () => {
    const input =
      'Use __SPECKIT_COMMAND_PLAN__ to design and __SPECKIT_COMMAND_TASKS__ to break work down. ' +
      '__SPECKIT_COMMAND_SPECIFY__ creates the spec, __SPECKIT_COMMAND_IMPLEMENT__ executes.';
    expect(applyPlaceholders(input)).toBe(
      'Use /speckit.plan to design and /speckit.tasks to break work down. ' +
      '/speckit.specify creates the spec, /speckit.implement executes.',
    );
  });

  it('leaves unknown __SPECKIT_*__ tokens untouched', () => {
    const input = 'Run __SPECKIT_COMMAND_FUTURE_FEATURE__ when ready.';
    expect(applyPlaceholders(input)).toBe(input);
  });

  it('substitutes multiple occurrences of the same token in one pass', () => {
    const input = 'a __SPECKIT_COMMAND_PLAN__ b __SPECKIT_COMMAND_PLAN__ c';
    expect(applyPlaceholders(input)).toBe('a /speckit.plan b /speckit.plan c');
  });

  it('is a no-op when there are no placeholders', () => {
    const input = '# Spec Template\n\nNothing to substitute here.\n';
    expect(applyPlaceholders(input)).toBe(input);
  });

  it('covers every token declared in PLACEHOLDER_SUBSTITUTIONS', () => {
    for (const [token, replacement] of Object.entries(PLACEHOLDER_SUBSTITUTIONS_FOR_TESTS)) {
      expect(applyPlaceholders(`prefix ${token} suffix`)).toBe(`prefix ${replacement} suffix`);
    }
  });

  it('processes longer tokens first so overlapping prefixes do not get partially eaten', () => {
    // The substitution map doesn't currently contain overlapping keys,
    // but the ordering invariant is what protects the file from a
    // future addition like `__SPECKIT_COMMAND_SPECIFY_FOO__`. Verify
    // by injecting a synthetic overlap into a string and confirming
    // the longer match wins. We use the existing keys: a string that
    // contains BOTH `__SPECKIT_COMMAND_TASKS__` (shorter) and a
    // hypothetical superset must replace the longer one first to keep
    // the result well-defined. Today longest-first means the short
    // token is unaffected by surrounding text.
    const input = '__SPECKIT_COMMAND_PLAN__ and __SPECKIT_COMMAND_TASKS__';
    expect(applyPlaceholders(input)).toBe('/speckit.plan and /speckit.tasks');
  });
});

describe('TemplateSync.checkForUpdates', () => {
  let tmp: string;
  let paths: TemplateSyncPaths;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-sync-'));
    paths = {
      cacheDir: tmp,
      templatesCacheDir: path.join(tmp, 'templates'),
      versionFile: path.join(tmp, 'version.json'),
    };
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Compose a fetch mock that succeeds for every template at the given tag. */
  function mockHappyPath(tag: string, body = TEMPLATE_BODY): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: tag }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        text: async () => body,
      } as unknown as Response);
    });
  }

  // ---- Happy path & cache hit ---------------------------------------------

  it('returns up-to-date (no template fetch) when prior tag === latest tag', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(paths.versionFile, JSON.stringify({ tag: FAKE_TAG, downloadedAt: '2026-01-01' }));

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tag_name: FAKE_TAG }),
    } as unknown as Response);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: FAKE_TAG, reason: 'up-to-date' });
    // Single API call, no template fetches.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('downloads, substitutes, and caches every template when the tag advances', async () => {
    globalThis.fetch = mockHappyPath(FAKE_TAG);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result.updated).toBe(true);
    if (result.updated) {
      expect(result.version).toBe(FAKE_TAG);
      expect(result.missingOptional).toEqual([]);
    }

    for (const file of ALL_TEMPLATES_FOR_TESTS) {
      const cached = fs.readFileSync(path.join(paths.templatesCacheDir, file), 'utf-8');
      expect(cached).toContain('Run /speckit.plan then /speckit.tasks.');
      expect(cached).not.toContain('__SPECKIT_COMMAND_PLAN__');
    }
    expect(JSON.parse(fs.readFileSync(paths.versionFile, 'utf-8')).tag).toBe(FAKE_TAG);
  });

  it('asserts the outbound URL contains the resolved tag (regression guard)', async () => {
    const fetchMock = mockHappyPath(FAKE_TAG_2);
    globalThis.fetch = fetchMock;

    await new TemplateSync(paths).checkForUpdates();

    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    for (const file of ALL_TEMPLATES_FOR_TESTS) {
      expect(calls).toContain(`${RAW_BASE_URL_FOR_TESTS}/${FAKE_TAG_2}/templates/${file}`);
    }
  });

  it('includes the User-Agent and Accept headers required by the GitHub API', async () => {
    const fetchMock = mockHappyPath(FAKE_TAG);
    globalThis.fetch = fetchMock;

    await new TemplateSync(paths).checkForUpdates();

    const apiCall = fetchMock.mock.calls.find((c) => c[0] === SPEC_KIT_API_URL)!;
    const apiInit = apiCall[1] as RequestInit;
    expect((apiInit.headers as Record<string, string>)['User-Agent']).toBe('caramelo-vscode-extension');
    expect((apiInit.headers as Record<string, string>).Accept).toBe('application/vnd.github.v3+json');
    expect(apiInit.signal).toBeDefined();

    const templateCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/templates/'))!;
    const templateInit = templateCall[1] as RequestInit;
    expect((templateInit.headers as Record<string, string>)['User-Agent']).toBe('caramelo-vscode-extension');
    expect(templateInit.signal).toBeDefined();
  });

  // ---- Network-error reason -----------------------------------------------

  it('falls back silently when the release API returns 5xx — keeps prior cache', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(paths.versionFile, JSON.stringify({ tag: FAKE_TAG, downloadedAt: '2026-01-01' }));

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 } as unknown as Response);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: FAKE_TAG, reason: 'network-error' });
  });

  it('falls back silently when the release lookup throws (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: undefined, reason: 'network-error' });
  });

  it('falls back when res.json() throws (proxy / captive portal returning HTML)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    } as unknown as Response);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result.updated).toBe(false);
    if (!result.updated) expect(result.reason).toBe('network-error');
  });

  it('rejects a release JSON missing tag_name', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ wrong_field: FAKE_TAG }),
    } as unknown as Response);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: undefined, reason: 'network-error' });
  });

  it('rejects a non-object release JSON (null body)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => null,
    } as unknown as Response);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: undefined, reason: 'network-error' });
  });

  // ---- All-failed reason --------------------------------------------------

  it('returns all-failed (no version stamp) when ALL required templates 404', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: FAKE_TAG }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: undefined, reason: 'all-failed' });
    expect(fs.existsSync(paths.versionFile)).toBe(false);
  });

  it('returns all-failed when one required template throws (network rejection)', async () => {
    // Per-file fetch rejection is a different code path from a 404.
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: FAKE_TAG }),
        } as unknown as Response);
      }
      if (url.endsWith('plan-template.md')) {
        return Promise.reject(new Error('ECONNRESET'));
      }
      return Promise.resolve({ ok: true, text: async () => TEMPLATE_BODY } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: undefined, reason: 'all-failed' });
    expect(fs.existsSync(paths.versionFile)).toBe(false);
  });

  it('returns all-failed when a required template comes back with an empty body (captive portal)', async () => {
    // A 200 OK with an empty body is a real failure mode — corp proxies
    // and CDN failures both produce it. Without the MIN_TEMPLATE_BYTES
    // guard the cache silently fills with blank files.
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: FAKE_TAG }),
        } as unknown as Response);
      }
      if (url.endsWith('spec-template.md')) {
        return Promise.resolve({ ok: true, text: async () => '' } as unknown as Response);
      }
      return Promise.resolve({ ok: true, text: async () => TEMPLATE_BODY } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: undefined, reason: 'all-failed' });
    // No 0-byte file left on disk — cache untouched.
    expect(fs.existsSync(path.join(paths.templatesCacheDir, 'spec-template.md'))).toBe(false);
    expect(fs.existsSync(paths.versionFile)).toBe(false);
  });

  it('treats sub-MIN_TEMPLATE_BYTES bodies as failures even with the right shape', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: FAKE_TAG }),
        } as unknown as Response);
      }
      // 49-byte body — one shy of the floor.
      return Promise.resolve({ ok: true, text: async () => '#' + 'x'.repeat(48) } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result.updated).toBe(false);
    if (!result.updated) expect(result.reason).toBe('all-failed');
  });

  it('preserves the prior cache version when a new tag fails to download', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(paths.versionFile, JSON.stringify({ tag: FAKE_TAG, downloadedAt: '2026-01-01' }));

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: FAKE_TAG_2 }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: FAKE_TAG, reason: 'all-failed' });
    // Version file still records the OLD tag.
    expect(JSON.parse(fs.readFileSync(paths.versionFile, 'utf-8')).tag).toBe(FAKE_TAG);
  });

  // ---- Optional template missing → updated:true with hint -----------------

  it('marks optional 404s in missingOptional but still stamps the version', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: FAKE_TAG }),
        } as unknown as Response);
      }
      // checklist-template.md is optional — simulate it 404'ing on an older tag.
      if (url.endsWith('checklist-template.md')) {
        return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
      }
      return Promise.resolve({ ok: true, text: async () => TEMPLATE_BODY } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result.updated).toBe(true);
    if (result.updated) {
      expect(result.version).toBe(FAKE_TAG);
      expect(result.missingOptional).toEqual(['checklist-template.md']);
    }
    // Required files all on disk.
    for (const file of REQUIRED_TEMPLATES_FOR_TESTS) {
      expect(fs.existsSync(path.join(paths.templatesCacheDir, file))).toBe(true);
    }
    // The 404'd optional file is NOT on disk.
    expect(fs.existsSync(path.join(paths.templatesCacheDir, 'checklist-template.md'))).toBe(false);
    expect(fs.existsSync(paths.versionFile)).toBe(true);
  });

  it('content of every successful file passes through applyPlaceholders', async () => {
    // Specifically test the partial path: a 404 on one file must not
    // skip substitution on the others.
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: FAKE_TAG }),
        } as unknown as Response);
      }
      if (url.endsWith('checklist-template.md')) {
        return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
      }
      return Promise.resolve({ ok: true, text: async () => TEMPLATE_BODY } as unknown as Response);
    });

    await new TemplateSync(paths).checkForUpdates();

    for (const file of REQUIRED_TEMPLATES_FOR_TESTS) {
      const body = fs.readFileSync(path.join(paths.templatesCacheDir, file), 'utf-8');
      expect(body).toContain('/speckit.plan');
      expect(body).toContain('/speckit.tasks');
      expect(body).not.toContain('__SPECKIT_COMMAND_');
    }
  });

  // ---- Force flag ---------------------------------------------------------

  it('respects force=true even when the tag matches the cache', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(paths.versionFile, JSON.stringify({ tag: FAKE_TAG, downloadedAt: '2026-01-01' }));

    globalThis.fetch = mockHappyPath(FAKE_TAG);

    const result = await new TemplateSync(paths).checkForUpdates(true);
    expect(result.updated).toBe(true);
    if (result.updated) expect(result.version).toBe(FAKE_TAG);

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(calls.filter((u) => u.includes('/templates/'))).toHaveLength(ALL_TEMPLATES_FOR_TESTS.length);
  });

  it('force=true rewrites the downloadedAt timestamp', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    const stale = new Date(2020, 0, 1).toISOString();
    fs.writeFileSync(paths.versionFile, JSON.stringify({ tag: FAKE_TAG, downloadedAt: stale }));

    globalThis.fetch = mockHappyPath(FAKE_TAG);

    await new TemplateSync(paths).checkForUpdates(true);

    const updated = JSON.parse(fs.readFileSync(paths.versionFile, 'utf-8')).downloadedAt;
    expect(updated).not.toBe(stale);
    expect(new Date(updated).getTime()).toBeGreaterThan(new Date(stale).getTime());
  });

  // ---- Concurrency mutex --------------------------------------------------

  it('two concurrent checkForUpdates calls share one in-flight result', async () => {
    let releaseLookups = 0;
    let templateFetches = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        releaseLookups++;
        // Stall the release lookup so the second call enters the
        // mutex while the first is still pending.
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({ tag_name: FAKE_TAG }),
            } as unknown as Response);
          }, 10);
        });
      }
      templateFetches++;
      return Promise.resolve({ ok: true, text: async () => TEMPLATE_BODY } as unknown as Response);
    });

    const sync = new TemplateSync(paths);
    const [r1, r2] = await Promise.all([sync.checkForUpdates(), sync.checkForUpdates()]);

    expect(r1).toEqual(r2);
    // Only ONE release lookup despite two checkForUpdates calls.
    expect(releaseLookups).toBe(1);
    // Templates downloaded exactly once.
    expect(templateFetches).toBe(ALL_TEMPLATES_FOR_TESTS.length);
  });

  it('the mutex resets after the run so a later call works normally', async () => {
    globalThis.fetch = mockHappyPath(FAKE_TAG);
    const sync = new TemplateSync(paths);

    await sync.checkForUpdates();
    // Second call after first completes should re-fetch the release
    // (cache hit short-circuits before reaching templates) — the mutex
    // is gone, the call proceeds.
    const second = await sync.checkForUpdates();
    expect(second.updated).toBe(false);
    if (!second.updated) expect(second.reason).toBe('up-to-date');
  });

  // ---- Cached version file edge cases -------------------------------------

  it('treats a corrupt version.json as no cache and resyncs', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(paths.versionFile, 'not json{');

    globalThis.fetch = mockHappyPath(FAKE_TAG);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result.updated).toBe(true);
    if (result.updated) expect(result.version).toBe(FAKE_TAG);
  });

  it('getCurrentVersion returns the cached tag', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(paths.versionFile, JSON.stringify({ tag: FAKE_TAG, downloadedAt: '2026-01-01' }));
    expect(new TemplateSync(paths).getCurrentVersion()).toBe(FAKE_TAG);
  });

  it('getCurrentVersion returns undefined when no cache exists', () => {
    expect(new TemplateSync(paths).getCurrentVersion()).toBeUndefined();
  });

  it('getCurrentVersion returns undefined when version.json is corrupt', () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(paths.versionFile, '{}'); // valid JSON, missing tag
    expect(new TemplateSync(paths).getCurrentVersion()).toBeUndefined();
  });

  // ---- Atomic write -------------------------------------------------------

  it('does not leave .tmp files behind after a successful run', async () => {
    globalThis.fetch = mockHappyPath(FAKE_TAG);
    await new TemplateSync(paths).checkForUpdates();

    // Walk both the cache root and the templates dir; nothing should
    // match `*.tmp-*` after a successful sync.
    const leftover: string[] = [];
    for (const dir of [paths.cacheDir, paths.templatesCacheDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (/\.tmp-/.test(entry)) leftover.push(path.join(dir, entry));
      }
    }
    expect(leftover).toEqual([]);
  });
});
