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

function isPyTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * Raw condition, untrimmed: Spec Kit evaluates any truthy value, so a
 * whitespace-only string never matches (hook skipped) and a non-string
 * value raises inside the evaluator (also skipped). Coercing non-strings
 * to a string reproduces that outcome, since no pattern can match.
 */
function rawCondition(v: unknown): string | undefined {
  if (!isPyTruthy(v)) return undefined;
  return typeof v === 'string' ? v : `<invalid condition: ${JSON.stringify(v)}>`;
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
        condition: rawCondition(entry.condition),
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

export class HookChangedError extends Error {}

/**
 * Set `enabled` on one hook in `.specify/extensions.yml`, preserving
 * comments and formatting. The entry is located by event + list index and
 * must still carry the expected command; if the file changed underneath
 * (entry moved, removed or replaced) nothing is written and
 * `HookChangedError` is thrown so the caller can refresh instead of
 * editing the wrong hook.
 */
export function setHookEnabled(
  workspaceRoot: string,
  target: Pick<HookEntry, 'event' | 'index' | 'command'>,
  enabled: boolean,
): void {
  const filePath = extensionsYmlPath(workspaceRoot);
  const doc = YAML.parseDocument(fs.readFileSync(filePath, 'utf-8'));
  if (doc.errors.length > 0) {
    throw new Error(`${filePath} is not valid YAML: ${doc.errors[0].message}`);
  }

  const bucket = doc.getIn(['hooks', target.event], true);
  let entryPath: Array<string | number>;
  if (YAML.isSeq(bucket)) {
    entryPath = ['hooks', target.event, target.index];
  } else if (YAML.isMap(bucket) && target.index === 0) {
    entryPath = ['hooks', target.event];
  } else {
    throw new HookChangedError(`hooks.${target.event}[${target.index}] no longer exists.`);
  }

  const command = doc.getIn([...entryPath, 'command']);
  if (typeof command !== 'string' || command.trim() !== target.command) {
    throw new HookChangedError(`hooks.${target.event}[${target.index}] is no longer ${target.command}.`);
  }

  doc.setIn([...entryPath, 'enabled'], enabled);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, doc.toString(), 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
