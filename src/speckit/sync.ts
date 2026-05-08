import * as fs from 'fs';
import * as path from 'path';
import { CACHE_DIR, TEMPLATES_CACHE_DIR, VERSION_FILE, SPEC_KIT_API_URL } from '../constants.js';
import { isObject, safeJsonParse } from '../utils/safe-json.js';
import { log } from '../utils/log.js';

interface VersionInfo {
  tag: string;
  downloadedAt: string;
  /** Reserved for future per-file ETag caching. */
  etag?: string;
}

/**
 * Spec Kit stopped attaching `*generic*.zip` release assets after
 * `v0.7.x` — the `release.assets` array is now empty for every release,
 * which previously caused our sync to silently no-op forever. The
 * authoritative source is the repository tree itself, so we fetch
 * individual template files at the latest tag via raw.githubusercontent.com.
 */
const RAW_BASE_URL = 'https://raw.githubusercontent.com/github/spec-kit';

/**
 * Templates Caramelo consumes today. Adding a new file here makes it
 * appear in `TEMPLATES_CACHE_DIR` after the next sync; the
 * TemplateManager only knows about spec/plan/tasks for now, but we sync
 * the constitution and checklist too so a future feature can pick them
 * up without another sync rewrite.
 */
const TEMPLATE_FILES: readonly string[] = [
  'spec-template.md',
  'plan-template.md',
  'tasks-template.md',
  'constitution-template.md',
  'checklist-template.md',
];

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

const FETCH_TIMEOUT_MS = 10_000;

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
   * Production callers use the default paths under `~/.caramelo/spec-kit`.
   * Tests inject a temp directory so each run is hermetic.
   */
  constructor(private readonly paths: TemplateSyncPaths = DEFAULT_PATHS) {}

  async checkForUpdates(force = false): Promise<{ updated: boolean; version?: string }> {
    if (!fs.existsSync(this.paths.cacheDir)) fs.mkdirSync(this.paths.cacheDir, { recursive: true });

    const current = this.readVersionInfo();
    const tag = await this.fetchLatestTag();
    if (!tag) {
      // Network error or rate-limit — keep whatever we have cached.
      return { updated: false, version: current?.tag };
    }

    if (!force && current?.tag === tag) {
      return { updated: false, version: tag };
    }

    const fetched = await this.downloadTemplates(tag);
    if (fetched === 0) {
      // No file came down at all — likely the repo restructured templates/
      // out from under us. Don't write a version stamp so we retry next time.
      log.warn(`[speckit-sync] no templates fetched for ${tag} — keeping prior cache.`);
      return { updated: false, version: current?.tag };
    }

    const versionInfo: VersionInfo = {
      tag,
      downloadedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.paths.versionFile, JSON.stringify(versionInfo, null, 2));

    return { updated: true, version: tag };
  }

  /**
   * Fetch the latest release tag from the GitHub API. Returns null on
   * failure so the caller can fall back to the prior cache silently —
   * the bundled fallback in TemplateManager covers offline / outage.
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
   * Download every known template file from the upstream tag's
   * templates/ directory. Each file is fetched independently — a 404
   * on one (e.g. checklist-template.md not yet in older tags) does NOT
   * abort the others. Returns the count of files written.
   */
  private async downloadTemplates(tag: string): Promise<number> {
    if (!fs.existsSync(this.paths.templatesCacheDir)) {
      fs.mkdirSync(this.paths.templatesCacheDir, { recursive: true });
    }
    let written = 0;
    for (const file of TEMPLATE_FILES) {
      const url = `${RAW_BASE_URL}/${tag}/templates/${file}`;
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'caramelo-vscode-extension' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          log.debug(`[speckit-sync] ${file}: ${res.status}`);
          continue;
        }
        const raw = await res.text();
        const substituted = applyPlaceholders(raw);
        fs.writeFileSync(path.join(this.paths.templatesCacheDir, file), substituted, 'utf-8');
        written++;
      } catch (err) {
        log.warn(`[speckit-sync] ${file} download error:`, err);
      }
    }
    return written;
  }

  private readVersionInfo(): VersionInfo | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.paths.versionFile, 'utf-8');
    } catch {
      return null;
    }
    return safeJsonParse<VersionInfo>(raw, (v): v is VersionInfo => isObject(v) && typeof v.tag === 'string');
  }

  getCurrentVersion(): string | undefined {
    return this.readVersionInfo()?.tag;
  }
}

/**
 * Replace every `__SPECKIT_COMMAND_*__` placeholder with the canonical
 * Caramelo slash-command name. Pure function, exported for tests.
 */
export function applyPlaceholders(text: string): string {
  let out = text;
  for (const [token, replacement] of Object.entries(PLACEHOLDER_SUBSTITUTIONS)) {
    // Token is a literal string (no regex specials), so plain split/join
    // is faster and avoids the global-regex state pitfall.
    if (out.includes(token)) {
      out = out.split(token).join(replacement);
    }
  }
  return out;
}

// Exported for tests.
export const _internals = { TEMPLATE_FILES, RAW_BASE_URL, PLACEHOLDER_SUBSTITUTIONS };
