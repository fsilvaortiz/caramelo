import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { log } from '../utils/log.js';
import { isObject } from '../utils/safe-json.js';

/**
 * Spec Kit v1.x reads `.specify/extensions.yml` for lifecycle hooks
 * attached to phase commands. Caramelo does not execute these hooks
 * (Spec Kit's own CLI / runners do), but surfacing them in the
 * workflow sidebar prevents the UI from lying about what will happen
 * when a phase runs.
 *
 * Hook list is scoped to known phase keys. Spec Kit adds more over
 * time; unknown keys under `hooks:` are not surfaced but also do not
 * fail the parse — a conservative, visible policy that matches how
 * `applyPlaceholders` handles unknown tokens.
 */
export type HookPhaseKey =
  | 'before_specify'
  | 'after_specify'
  | 'before_plan'
  | 'after_plan'
  | 'before_tasks'
  | 'after_tasks'
  | 'before_implement'
  | 'after_implement'
  | 'before_clarify'
  | 'after_clarify'
  | 'before_analyze'
  | 'after_analyze'
  | 'before_constitution'
  | 'after_constitution'
  | 'before_checklist'
  | 'after_checklist'
  | 'before_converge'
  | 'after_converge';

const KNOWN_HOOK_KEYS: ReadonlySet<string> = new Set<HookPhaseKey>([
  'before_specify', 'after_specify',
  'before_plan', 'after_plan',
  'before_tasks', 'after_tasks',
  'before_implement', 'after_implement',
  'before_clarify', 'after_clarify',
  'before_analyze', 'after_analyze',
  'before_constitution', 'after_constitution',
  'before_checklist', 'after_checklist',
  'before_converge', 'after_converge',
]);

export interface HookEntry {
  /** Phase lifecycle slot the hook runs on (e.g. `before_converge`). */
  readonly phaseKey: HookPhaseKey;
  /** Hook identifier (never empty — entries missing a name are dropped). */
  readonly name: string;
  /** Whether Spec Kit treats this hook as skippable. Absent → false. */
  readonly optional: boolean;
  /**
   * Opaque expression Spec Kit may evaluate before running the hook.
   * Caramelo does not interpret this — it just displays it so the user
   * knows the hook is conditional.
   */
  readonly condition?: string;
}

/** Guards against pathological file sizes — anything over 256 KiB is almost certainly not a hooks config. */
const MAX_EXTENSIONS_YML_BYTES = 256 * 1024;

/**
 * Read and parse `.specify/extensions.yml` from the workspace root.
 * Returns an empty array on any failure (missing file, parse error,
 * malformed shape). All failure modes are logged at WARN with enough
 * context to debug — a conservative, visible policy that matches
 * `TemplateSync.doCheckForUpdates`.
 */
export function loadHooks(workspaceRoot: string): readonly HookEntry[] {
  const filePath = path.join(workspaceRoot, '.specify', 'extensions.yml');
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
 * Pure parser: raw YAML text → `HookEntry[]`. Exported for tests.
 *
 * Shape expected:
 *
 * ```yaml
 * hooks:
 *   before_converge:
 *     - name: my-check
 *       optional: true
 *       enabled: false   # entries explicitly disabled are dropped
 *       condition: "something"
 * ```
 *
 * Deviations we silently drop (and log at DEBUG):
 * - Entries whose `enabled` is `false`.
 * - Entries missing a non-empty `name`.
 * - Unknown phase keys under `hooks:`.
 * - Non-array values under a known phase key.
 */
export function parseHooksYaml(raw: string): readonly HookEntry[] {
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    log.warn('[speckit-extensions] YAML parse failed:', err instanceof Error ? err.message : err);
    return [];
  }

  if (!isObject(doc)) return [];
  const hooks = (doc as Record<string, unknown>).hooks;
  if (!isObject(hooks)) return [];

  const out: HookEntry[] = [];
  for (const [key, bucket] of Object.entries(hooks)) {
    if (!KNOWN_HOOK_KEYS.has(key)) {
      log.debug(`[speckit-extensions] unknown hook phase "${key}" — skipped.`);
      continue;
    }
    if (!Array.isArray(bucket)) {
      log.warn(`[speckit-extensions] hooks.${key} is not a list — skipped.`);
      continue;
    }
    for (const entry of bucket) {
      if (!isObject(entry)) continue;
      const rec = entry as Record<string, unknown>;
      // `enabled` is implicit-true. Only `enabled: false` disables.
      if (rec.enabled === false) continue;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!name) continue;
      const optional = rec.optional === true;
      const condition =
        typeof rec.condition === 'string' && rec.condition.trim().length > 0
          ? rec.condition.trim()
          : undefined;
      out.push({ phaseKey: key as HookPhaseKey, name, optional, condition });
    }
  }
  return out;
}

/** Group hooks by their phase key for UI rendering. */
export function groupHooksByPhase(hooks: readonly HookEntry[]): Map<HookPhaseKey, HookEntry[]> {
  const out = new Map<HookPhaseKey, HookEntry[]>();
  for (const h of hooks) {
    const bucket = out.get(h.phaseKey);
    if (bucket) bucket.push(h);
    else out.set(h.phaseKey, [h]);
  }
  return out;
}
