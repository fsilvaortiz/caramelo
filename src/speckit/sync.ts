import * as fs from 'fs';
import * as path from 'path';
import { CACHE_DIR, TEMPLATES_CACHE_DIR, VERSION_FILE, SPEC_KIT_API_URL } from '../constants.js';
import { isObject, safeJsonParse } from '../utils/safe-json.js';
import { log } from '../utils/log.js';

interface VersionInfo {
  tag: string;
  downloadedAt: string;
}

/**
 * Discriminated outcome of `checkForUpdates`. Callers branch on
 * `updated` (success path with a fresh version) or, when `updated:false`,
 * on `reason` to distinguish "we checked and the user is current",
 * "couldn't reach upstream", and "upstream returned a tag but every
 * required template fetch failed". The caller-visible toast in
 * `commands/sync-templates.ts` and the activation path in
 * `extension.ts` rely on these distinctions to avoid lying to the user
 * (the prior "Templates already up to date" message fired even when the
 * network had failed entirely).
 */
export type UpdateResult =
  | { updated: true; version: string; missingOptional: readonly string[] }
  | { updated: false; version: string; reason: 'up-to-date' }
  | { updated: false; version: string | undefined; reason: 'network-error' | 'all-failed' };

/**
 * Spec Kit dropped release-asset attachments — every recent release ships
 * with `assets: []`. The authoritative source is the repository tree
 * itself, so we fetch individual template files directly.
 */
const RAW_BASE_URL = 'https://raw.githubusercontent.com/github/spec-kit';

/**
 * Required templates — `TemplateManager` reads these, so a missing one
 * means a phase generation will fall back to the bundled copy. We refuse
 * to write the version stamp unless every required file is fetched and
 * passes the minimum-content check.
 */
const REQUIRED_TEMPLATES: readonly string[] = [
  'spec-template.md',
  'plan-template.md',
  'tasks-template.md',
];

/**
 * Optional templates — synced opportunistically so a future feature can
 * pick them up without another sync rewrite. A 404 (or empty body) on
 * any of these is logged but does NOT abort the batch; the version
 * stamp is still written and the file appears in `missingOptional` so
 * the caller can surface a hint.
 */
const OPTIONAL_TEMPLATES: readonly string[] = [
  'constitution-template.md',
  'checklist-template.md',
];

const ALL_TEMPLATES: readonly string[] = [...REQUIRED_TEMPLATES, ...OPTIONAL_TEMPLATES];

/**
 * Spec Kit upstream embeds slash-command name placeholders that the CLI
 * rewrites at install time per the chosen agent (claude/copilot/etc.).
 * Caramelo speaks the canonical `/speckit.<command>` names directly, so
 * we substitute them in-place when caching a template. Anything not
 * listed here is left untouched — a future placeholder we don't know
 * about will reach the LLM verbatim, which is conservative and visible.
 */
const PLACEHOLDER_SUBSTITUTIONS: Record<string, string> = {
  __SPECKIT_COMMAND_SPECIFY__: '/speckit.specify',
  __SPECKIT_COMMAND_PLAN__: '/speckit.plan',
  __SPECKIT_COMMAND_TASKS__: '/speckit.tasks',
  __SPECKIT_COMMAND_IMPLEMENT__: '/speckit.implement',
  __SPECKIT_COMMAND_CLARIFY__: '/speckit.clarify',
  __SPECKIT_COMMAND_ANALYZE__: '/speckit.analyze',
  __SPECKIT_COMMAND_CONSTITUTION__: '/speckit.constitution',
  __SPECKIT_COMMAND_CHECKLIST__: '/speckit.checklist',
};

/**
 * Tokens are processed longest-first so a hypothetical future addition
 * like `__SPECKIT_COMMAND_SPECIFY_FOO__` cannot be partially eaten by
 * the shorter `__SPECKIT_COMMAND_SPECIFY__` substitution. Computed once
 * at module load.
 */
const SORTED_PLACEHOLDER_KEYS: readonly string[] = Object.keys(PLACEHOLDER_SUBSTITUTIONS).sort(
  (a, b) => b.length - a.length,
);

/**
 * GitHub raw and API both serve the typical p99 in well under 2s. 10s
 * tolerates a slow corporate proxy without blocking extension activation
 * visibly. Lower bound dominated by user-perceived latency, not network.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** Below this many bytes a "200 OK" body is treated as a failed fetch. */
const MIN_TEMPLATE_BYTES = 50;

export interface TemplateSyncPaths {
  cacheDir: string;
  templatesCacheDir: string;
  versionFile: string;
}

const DEFAULT_PATHS: TemplateSyncPaths = {
  cacheDir: CACHE_DIR,
  templatesCacheDir: TEMPLATES_CACHE_DIR,
  versionFile: VERSION_FILE,
};

export class TemplateSync {
  /**
   * In-flight promise so a manual `Sync Templates` invocation cannot
   * race the fire-and-forget activation sync. Both callers share the
   * single in-flight result. Reset when the run completes (success OR
   * thrown error).
   */
  private inflight: Promise<UpdateResult> | null = null;

  /**
   * Production callers use the default paths anchored at `constants.ts`.
   * Tests inject a temp directory so each run is hermetic. The shape
   * is all-or-nothing rather than `Partial<>` to encode the invariant
   * that the three paths must be co-located — overriding only one would
   * leak writes to the real home directory.
   */
  constructor(private readonly paths: TemplateSyncPaths = DEFAULT_PATHS) {}

  /**
   * Fetch the latest release tag and, if it differs from the cache,
   * download the corresponding templates.
   *
   * Failure-mode policy:
   *
   * - **Release lookup fails** (rate-limit, network, malformed JSON):
   *   return `{updated:false, reason:'network-error', version: <prior cache or undefined>}`.
   *   No write to the cache. Caller can keep using the bundled fallback.
   * - **Required template fetch fails** (any of spec/plan/tasks 404 /
   *   transient 5xx / network throw / empty body): return
   *   `{updated:false, reason:'all-failed', version: <prior cache or undefined>}`.
   *   Version stamp NOT written so the next run retries.
   * - **Optional template fetch fails** (constitution / checklist):
   *   logged as a warning, included in `missingOptional`, version stamp
   *   IS written. The user can still proceed.
   * - **Up to date**: `{updated:false, reason:'up-to-date', version}`.
   * - **Updated**: `{updated:true, version, missingOptional}`.
   */
  async checkForUpdates(force = false): Promise<UpdateResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doCheckForUpdates(force);
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async doCheckForUpdates(force: boolean): Promise<UpdateResult> {
    if (!fs.existsSync(this.paths.cacheDir)) fs.mkdirSync(this.paths.cacheDir, { recursive: true });

    const current = this.readVersionInfo();
    const tag = await this.fetchLatestTag();
    if (!tag) {
      return { updated: false, version: current?.tag, reason: 'network-error' };
    }

    if (!force && current?.tag === tag) {
      return { updated: false, version: tag, reason: 'up-to-date' };
    }

    const downloaded = await this.downloadTemplates(tag);
    const requiredMissing = REQUIRED_TEMPLATES.filter((f) => !downloaded.has(f));
    if (requiredMissing.length > 0) {
      log.warn(
        `[speckit-sync] ${tag}: required template(s) unavailable: ${requiredMissing.join(', ')}. ` +
        `Keeping prior cache.`,
      );
      return { updated: false, version: current?.tag, reason: 'all-failed' };
    }

    if (!fs.existsSync(this.paths.templatesCacheDir)) {
      fs.mkdirSync(this.paths.templatesCacheDir, { recursive: true });
    }
    for (const [file, content] of downloaded) {
      atomicWrite(path.join(this.paths.templatesCacheDir, file), content);
    }

    const versionInfo: VersionInfo = {
      tag,
      downloadedAt: new Date().toISOString(),
    };
    atomicWrite(this.paths.versionFile, JSON.stringify(versionInfo, null, 2));

    const missingOptional = OPTIONAL_TEMPLATES.filter((f) => !downloaded.has(f));
    return { updated: true, version: tag, missingOptional };
  }

  /**
   * Returns the latest tag string, or `null` on any network / parse
   * failure. The caller falls back to the prior cache silently — the
   * bundled fallback in TemplateManager covers offline / outage.
   */
  private async fetchLatestTag(): Promise<string | null> {
    try {
      const res = await fetch(SPEC_KIT_API_URL, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'caramelo-vscode-extension',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn(`[speckit-sync] release lookup failed: ${res.status}`);
        return null;
      }
      const json = (await res.json()) as unknown;
      if (!isObject(json) || typeof json.tag_name !== 'string') return null;
      return json.tag_name;
    } catch (err) {
      log.warn('[speckit-sync] release lookup error:', err);
      return null;
    }
  }

  /**
   * Fetch every known template into memory. Returns a map keyed by file
   * name. Missing / empty / 5xx files are simply absent from the map —
   * the caller decides whether their absence is fatal by checking
   * `REQUIRED_TEMPLATES`.
   *
   * 5xx and 429 are logged at WARN; 404 at DEBUG. Empty bodies (sub-
   * `MIN_TEMPLATE_BYTES`) are skipped because we've seen captive-portal
   * proxies hand back zero-byte 200s, which previously corrupted the
   * cache with a blank template forever.
   */
  private async downloadTemplates(tag: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const file of ALL_TEMPLATES) {
      const url = `${RAW_BASE_URL}/${tag}/templates/${file}`;
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'caramelo-vscode-extension' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          if (res.status === 404) {
            log.debug(`[speckit-sync] ${file}: 404 — upstream may have renamed it.`);
          } else {
            log.warn(`[speckit-sync] ${file}: ${res.status} ${res.statusText}`);
          }
          continue;
        }
        const raw = await res.text();
        if (raw.length < MIN_TEMPLATE_BYTES) {
          log.warn(`[speckit-sync] ${file}: response too small (${raw.length} B), skipping.`);
          continue;
        }
        out.set(file, applyPlaceholders(raw));
      } catch (err) {
        log.warn(`[speckit-sync] ${file} download error:`, err);
      }
    }
    return out;
  }

  /**
   * Read the cached version stamp. ENOENT (no cache yet) returns null
   * silently; any other read error (EACCES / EISDIR / EIO) is logged
   * before falling through, so an operator can see why their cache
   * "isn't working" instead of staring at an opaque silent miss.
   */
  private readVersionInfo(): VersionInfo | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.paths.versionFile, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        log.warn(`[speckit-sync] version file unreadable (${e.code ?? 'EUNKNOWN'}):`, e.message ?? err);
      }
      return null;
    }
    return safeJsonParse<VersionInfo>(raw, (v): v is VersionInfo => isObject(v) && typeof v.tag === 'string');
  }

  getCurrentVersion(): string | undefined {
    return this.readVersionInfo()?.tag;
  }
}

/**
 * Replace every known `__SPECKIT_COMMAND_*__` placeholder with the
 * canonical Caramelo slash-command name. Tokens are processed longest-
 * first so a future addition like `__SPECKIT_COMMAND_SPECIFY_FOO__`
 * cannot be partially eaten by the shorter `__SPECKIT_COMMAND_SPECIFY__`
 * substitution. Pure function; exported for tests.
 */
export function applyPlaceholders(text: string): string {
  let out = text;
  for (const token of SORTED_PLACEHOLDER_KEYS) {
    if (out.includes(token)) {
      // Plain literal split/join is faster than `replaceAll` (avoids
      // allocating a RegExp for every call) and avoids the stateful-
      // `lastIndex` pitfall that bites global-flag regexes shared
      // across invocations.
      out = out.split(token).join(PLACEHOLDER_SUBSTITUTIONS[token]);
    }
  }
  return out;
}

/**
 * Atomic write via temp + rename. Cheap protection against torn writes
 * if the process crashes mid-write or two `checkForUpdates` calls race
 * (rare today thanks to the in-flight mutex, but the rename is still
 * the cheapest correct shape). On POSIX `rename` is atomic; on Windows
 * `fs.renameSync` falls back to a copy/replace that's "atomic enough"
 * for a single template file.
 */
function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup; the rename failure itself is the operative
    // error and is propagated.
    try {
      fs.unlinkSync(tmp);
    } catch { /* ignore */ }
    throw err;
  }
}

/** @internal — exported for tests. */
export const REQUIRED_TEMPLATES_FOR_TESTS = REQUIRED_TEMPLATES;
/** @internal — exported for tests. */
export const OPTIONAL_TEMPLATES_FOR_TESTS = OPTIONAL_TEMPLATES;
/** @internal — exported for tests. */
export const ALL_TEMPLATES_FOR_TESTS = ALL_TEMPLATES;
/** @internal — exported for tests. */
export const PLACEHOLDER_SUBSTITUTIONS_FOR_TESTS = PLACEHOLDER_SUBSTITUTIONS;
/** @internal — exported for tests. */
export const RAW_BASE_URL_FOR_TESTS = RAW_BASE_URL;
