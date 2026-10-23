import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { log } from '../utils/log.js';
import { isObject } from '../utils/safe-json.js';

/**
 * Lifecycle hooks registered in `.specify/extensions.yml`, mirroring
 * Spec Kit v1.x's `HookExecutor` (src/specify_cli/extensions/__init__.py):
 *
 * ```yaml
 * hooks:
 *   after_tasks:
 *     - extension: jira
 *       command: speckit.jira.specstoissues
 *       enabled: true        # default true
 *       optional: true       # default true
 *       priority: 10         # default 10, lower runs first
 *       prompt: "Create Jira issues from tasks?"
 *       description: "..."
 *       condition: null
 * ```
 */
export interface HookEntry {
  /** Lifecycle event, e.g. `before_plan`, `after_tasks`, `before_bug_fix`. */
  readonly event: string;
  /** Position inside the event's list in the file; identifies the entry for edits. */
  readonly index: number;
  readonly command: string;
  readonly extension?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly condition?: string;
  readonly optional: boolean;
  readonly enabled: boolean;
  readonly priority: number;
}

export const DEFAULT_HOOK_PRIORITY = 10;

/** Events Spec Kit core emits; extensions may add more (`before_bug_assess`, …). */
export const CORE_HOOK_EVENTS: readonly string[] = [
  'before_constitution', 'after_constitution',
  'before_specify', 'after_specify',
  'before_clarify', 'after_clarify',
  'before_plan', 'after_plan',
  'before_tasks', 'after_tasks',
  'before_checklist', 'after_checklist',
  'before_analyze', 'after_analyze',
  'before_converge', 'after_converge',
  'before_implement', 'after_implement',
  'before_taskstoissues', 'after_taskstoissues',
];

const EVENT_PATTERN = /^(before|after)_[a-z0-9_]+$/;

const MAX_EXTENSIONS_YML_BYTES = 256 * 1024;

export function extensionsYmlPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.specify', 'extensions.yml');
}

/** Port of Spec Kit's `normalize_priority`: invalid, boolean or < 1 → default. */
export function normalizePriority(value: unknown): number {
  let n: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return DEFAULT_HOOK_PRIORITY;
    n = Math.trunc(value);
  } else if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) {
    n = parseInt(value, 10);
  } else {
    return DEFAULT_HOOK_PRIORITY;
  }
  return n >= 1 ? n : DEFAULT_HOOK_PRIORITY;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Read and parse `.specify/extensions.yml`. Missing file → `[]` silently;
 * unreadable / oversized / malformed → `[]` with a warning (Spec Kit's
 * templates likewise tell the user instead of skipping silently).
 */
export function loadHooks(workspaceRoot: string): readonly HookEntry[] {
  const filePath = extensionsYmlPath(workspaceRoot);
  let raw: string;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_EXTENSIONS_YML_BYTES) {
      log.warn(`[speckit-extensions] ${filePath} is ${stat.size} B — refusing to parse (max ${MAX_EXTENSIONS_YML_BYTES}).`);
      return [];
    }
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      log.warn(`[speckit-extensions] cannot read ${filePath} (${e.code ?? 'EUNKNOWN'}):`, e.message ?? err);
    }
    return [];
  }
  return parseHooksYaml(raw);
}

/**
 * Pure parser, exported for tests. Returns every well-formed entry,
 * including disabled ones (`enabled: false`) so the UI can offer to
 * re-enable them. Each event's entries are sorted by priority with a
 * stable sort, like `get_hooks_for_event`. Entries without a `command`
 * are dropped — there is nothing to show or run.
 */
export function parseHooksYaml(raw: string): readonly HookEntry[] {
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    log.warn('[speckit-extensions] YAML parse failed:', err instanceof Error ? err.message : err);
    return [];
  }
  if (!isObject(doc) || !isObject(doc.hooks)) return [];

  const out: HookEntry[] = [];
  for (const [event, bucket] of Object.entries(doc.hooks)) {
    if (!EVENT_PATTERN.test(event)) {
      log.debug(`[speckit-extensions] ignoring non-lifecycle key "hooks.${event}".`);
      continue;
    }
    const entries = Array.isArray(bucket) ? bucket : isObject(bucket) ? [bucket] : null;
    if (!entries) {
      log.warn(`[speckit-extensions] hooks.${event} is neither a mapping nor a list — skipped.`);
      continue;
    }
    const parsed: HookEntry[] = [];
    entries.forEach((entry, index) => {
      if (!isObject(entry)) return;
      const command = optionalString(entry.command);
      if (!command) {
        log.warn(`[speckit-extensions] hooks.${event}[${index}] has no command — skipped.`);
        return;
      }
      parsed.push({
        event,
        index,
        command,
        extension: optionalString(entry.extension),
        description: optionalString(entry.description),
        prompt: optionalString(entry.prompt),
        condition: optionalString(entry.condition),
        optional: entry.optional !== false,
        enabled: entry.enabled !== false,
        priority: normalizePriority(entry.priority),
      });
    });
    parsed.sort((a, b) => a.priority - b.priority);
    out.push(...parsed);
  }
  return out;
}

/** Group by event, core events first in lifecycle order, then the rest alphabetically. */
export function groupHooksByEvent(hooks: readonly HookEntry[]): Map<string, HookEntry[]> {
  const byEvent = new Map<string, HookEntry[]>();
  for (const h of hooks) {
    const bucket = byEvent.get(h.event);
    if (bucket) bucket.push(h);
    else byEvent.set(h.event, [h]);
  }
  const rank = (e: string): number => {
    const i = CORE_HOOK_EVENTS.indexOf(e);
    return i === -1 ? CORE_HOOK_EVENTS.length : i;
  };
  const ordered = [...byEvent.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return new Map(ordered.map((e) => [e, byEvent.get(e)!]));
}
