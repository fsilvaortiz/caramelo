import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyPlaceholders, TemplateSync, _internals, type TemplateSyncPaths } from '../sync.js';
import { SPEC_KIT_API_URL } from '../../constants.js';

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
    // Conservative: a future placeholder we don't know about reaches
    // the LLM verbatim instead of being silently dropped.
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
    // Catch a maintenance error: if someone adds a token to the
    // substitution map but forgets the corresponding test case.
    for (const [token, replacement] of Object.entries(_internals.PLACEHOLDER_SUBSTITUTIONS)) {
      expect(applyPlaceholders(`prefix ${token} suffix`)).toBe(`prefix ${replacement} suffix`);
    }
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

  it('returns the cached version (no template fetch) when prior tag === latest tag', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(
      paths.versionFile,
      JSON.stringify({ tag: 'v0.8.6', downloadedAt: '2026-01-01' }),
    );

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tag_name: 'v0.8.6' }),
    } as unknown as Response);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: 'v0.8.6' });
    // Only the release lookup, never raw template fetches.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('falls back silently when the release API fails — keeps prior cache', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(
      paths.versionFile,
      JSON.stringify({ tag: 'v0.8.5', downloadedAt: '2026-01-01' }),
    );

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 } as unknown as Response);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: 'v0.8.5' });
  });

  it('falls back silently when the release lookup throws (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: undefined });
  });

  it('downloads, substitutes, and caches every template when the tag advances', async () => {
    const fetched: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      fetched.push(url);
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: 'v0.8.6' }),
        } as unknown as Response);
      }
      const fileName = url.split('/').pop()!;
      return Promise.resolve({
        ok: true,
        text: async () =>
          `# ${fileName}\n\nRun __SPECKIT_COMMAND_PLAN__ then __SPECKIT_COMMAND_TASKS__.\n`,
      } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: true, version: 'v0.8.6' });

    // Each known template file ends up cached with placeholders applied.
    for (const file of _internals.TEMPLATE_FILES) {
      const cachedPath = path.join(paths.templatesCacheDir, file);
      const cached = fs.readFileSync(cachedPath, 'utf-8');
      expect(cached).toContain('Run /speckit.plan then /speckit.tasks.');
      expect(cached).not.toContain('__SPECKIT_COMMAND_PLAN__');
    }

    // Version file written.
    const versionRaw = fs.readFileSync(paths.versionFile, 'utf-8');
    expect(JSON.parse(versionRaw).tag).toBe('v0.8.6');

    // We hit the release API once + one fetch per template file.
    expect(fetched).toContain(SPEC_KIT_API_URL);
    expect(fetched.filter((u) => u.includes('/templates/'))).toHaveLength(_internals.TEMPLATE_FILES.length);
  });

  it('keeps trying despite individual file 404s — partial success still saves version', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: 'v0.8.6' }),
        } as unknown as Response);
      }
      // Older tags don't have checklist-template.md; simulate a 404 for it.
      if (url.endsWith('checklist-template.md')) {
        return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        text: async () => 'OK\n',
      } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result.updated).toBe(true);
    expect(fs.existsSync(path.join(paths.templatesCacheDir, 'spec-template.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.templatesCacheDir, 'checklist-template.md'))).toBe(false);
  });

  it('does NOT bump the version stamp when EVERY template fetch fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: 'v0.9.0' }),
        } as unknown as Response);
      }
      // Simulate upstream restructuring templates/ — every file 404s.
      return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result.updated).toBe(false);
    // Version file should NOT have been written, so a future run retries.
    expect(fs.existsSync(paths.versionFile)).toBe(false);
  });

  it('respects force=true even when the tag matches the cache', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(
      paths.versionFile,
      JSON.stringify({ tag: 'v0.8.6', downloadedAt: '2026-01-01' }),
    );

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === SPEC_KIT_API_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: 'v0.8.6' }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        text: async () => 'forced\n',
      } as unknown as Response);
    });

    const result = await new TemplateSync(paths).checkForUpdates(true);
    expect(result).toEqual({ updated: true, version: 'v0.8.6' });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(calls.filter((u) => u.includes('/templates/'))).toHaveLength(_internals.TEMPLATE_FILES.length);
  });

  it('getCurrentVersion returns the cached tag', async () => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(
      paths.versionFile,
      JSON.stringify({ tag: 'v0.8.6', downloadedAt: '2026-01-01' }),
    );
    expect(new TemplateSync(paths).getCurrentVersion()).toBe('v0.8.6');
  });

  it('getCurrentVersion returns undefined when no cache exists', () => {
    expect(new TemplateSync(paths).getCurrentVersion()).toBeUndefined();
  });

  it('rejects a release JSON missing tag_name', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ wrong_field: 'v0.8.6' }),
    } as unknown as Response);

    const result = await new TemplateSync(paths).checkForUpdates();
    expect(result).toEqual({ updated: false, version: undefined });
  });
});
