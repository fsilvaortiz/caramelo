import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { isObject, safeJsonParse } from '../utils/safe-json.js';

/**
 * Port of Spec Kit v1.2.2 `HookExecutor._evaluate_condition` and the
 * `ConfigManager` it reads from (src/specify_cli/extensions/__init__.py).
 * Behaviour is kept identical so a hook runs in Caramelo exactly when it
 * would run under Spec Kit's own agents.
 *
 * Supported forms (case-insensitive, anchored at the start only, like
 * Python's `re.match`); anything else evaluates to false:
 *   config.key.path is set
 *   config.key.path == 'value'   /   != 'value'
 *   env.VAR_NAME is set
 *   env.VAR_NAME == 'value'      /   != 'value'
 */

type Config = Record<string, unknown>;
type Env = Readonly<Record<string, string | undefined>>;

const CONFIG_IS_SET = /^config\.([a-z0-9_.]+)\s+is\s+set/i;
const CONFIG_COMPARE = /^config\.([a-z0-9_.]+)\s*(==|!=)\s*["']([^"']+)["']/i;
const ENV_IS_SET = /^env\.([A-Z0-9_]+)\s+is\s+set/i;
const ENV_COMPARE = /^env\.([A-Z0-9_]+)\s*(==|!=)\s*["']([^"']+)["']/i;

function loadYamlObject(file: string): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return {};
  }
  try {
    const data: unknown = YAML.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

function mergeConfigs(base: Config, override: Config): Config {
  const result: Config = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? mergeConfigs(current, value) : value;
  }
  return result;
}

function installedExtensionIds(workspaceRoot: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.specify', 'extensions', '.registry'), 'utf-8');
    const data = safeJsonParse(raw, isObject);
    return data && isObject(data.extensions) ? Object.keys(data.extensions) : [];
  } catch {
    return [];
  }
}

/** `SPECKIT_{EXT_ID}_{SECTION}_{KEY}` → nested object, honouring longer sibling IDs. */
function envConfig(workspaceRoot: string, extensionId: string, env: Env): Config {
  const extUpper = extensionId.replace(/-/g, '_').toUpperCase();
  const prefix = `SPECKIT_${extUpper}_`;
  const siblingPrefixes = installedExtensionIds(workspaceRoot)
    .filter((id) => id !== extensionId)
    .map((id) => id.replace(/-/g, '_').toUpperCase())
    .filter((sib) => sib.startsWith(`${extUpper}_`))
    .map((sib) => `${sib.slice(extUpper.length + 1)}_`);

  const out: Config = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith(prefix)) continue;
    const remainder = key.slice(prefix.length);
    if (siblingPrefixes.some((sp) => remainder.startsWith(sp))) continue;
    const parts = remainder.toLowerCase().split('_').filter(Boolean);
    if (parts.length === 0) continue;
    let current = out;
    for (const part of parts.slice(0, -1)) {
      if (!isObject(current[part])) current[part] = {};
      current = current[part] as Config;
    }
    const leaf = parts[parts.length - 1];
    if (!isObject(current[leaf])) current[leaf] = value;
  }
  return out;
}

/** defaults (extension.yml `config.defaults`) → `{id}-config.yml` → `local-config.yml` → env. */
export function loadExtensionConfig(workspaceRoot: string, extensionId: string, env: Env = process.env): Config {
  const dir = path.join(workspaceRoot, '.specify', 'extensions', extensionId);
  const manifest = loadYamlObject(path.join(dir, 'extension.yml'));
  const section = manifest.config;
  const defaults = isObject(section) && isObject(section.defaults) ? section.defaults : {};

  let config = mergeConfigs({}, defaults);
  config = mergeConfigs(config, loadYamlObject(path.join(dir, `${extensionId}-config.yml`)));
  config = mergeConfigs(config, loadYamlObject(path.join(dir, 'local-config.yml')));
  return mergeConfigs(config, envConfig(workspaceRoot, extensionId, env));
}

function lookup(config: Config, keyPath: string): { found: boolean; value: unknown } {
  let current: unknown = config;
  for (const key of keyPath.split('.')) {
    if (!isObject(current) || !(key in current)) return { found: false, value: undefined };
    current = current[key];
  }
  return { found: true, value: current };
}

/** Python `repr()` for YAML-produced values, used inside containers. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (isObject(value)) return `{${Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
  return String(value);
}

/** Python `str()` of the config value; top-level booleans lower-cased like Spec Kit. */
function toComparable(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  return pyRepr(value);
}

export interface ConditionContext {
  workspaceRoot: string;
  extensionId?: string;
  env?: Env;
}

/**
 * True when the hook should run. Like `should_execute_hook`, only an absent
 * or empty condition means "run"; a whitespace-only string is evaluated and
 * matches nothing, so it never runs. Unknown forms and errors → false.
 */
export function evaluateHookCondition(condition: string | undefined, ctx: ConditionContext): boolean {
  if (!condition) return true;
  try {
    return evaluate(condition.trim(), ctx);
  } catch {
    return false;
  }
}

function evaluate(condition: string, ctx: ConditionContext): boolean {
  const env = ctx.env ?? process.env;

  let m = CONFIG_IS_SET.exec(condition);
  if (m) {
    if (!ctx.extensionId) return false;
    return lookup(loadExtensionConfig(ctx.workspaceRoot, ctx.extensionId, env), m[1]).found;
  }

  m = CONFIG_COMPARE.exec(condition);
  if (m) {
    if (!ctx.extensionId) return false;
    const { value } = lookup(loadExtensionConfig(ctx.workspaceRoot, ctx.extensionId, env), m[1]);
    const equal = toComparable(value) === m[3];
    return m[2] === '==' ? equal : !equal;
  }

  m = ENV_IS_SET.exec(condition);
  if (m) return env[m[1].toUpperCase()] !== undefined;

  m = ENV_COMPARE.exec(condition);
  if (m) {
    const equal = (env[m[1].toUpperCase()] ?? '') === m[3];
    return m[2] === '==' ? equal : !equal;
  }

  return false;
}
