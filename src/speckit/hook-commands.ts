import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { isObject, safeJsonParse } from '../utils/safe-json.js';

/**
 * Locate and render the prompt behind a hook's `command`, reproducing what
 * Spec Kit v1.2.2's `CommandRegistrar` does when it registers an extension
 * command for a Markdown-command agent (src/specify_cli/agents.py):
 *
 *   parse_frontmatter → rewrite_extension_paths → _adjust_script_paths →
 *   resolve_command_refs → resolve_skill_placeholders
 *
 * The result is the same prompt Spec Kit would hand its own agent, with
 * `$ARGUMENTS` left for the caller to fill.
 */

export interface ResolvedHookCommand {
  readonly extensionId: string;
  readonly extensionDir: string;
  readonly filePath: string;
}

export class HookCommandNotFoundError extends Error {}

/** Spec Kit refuses to register such a command (ValueError); so do we. */
export class HookCommandRenderError extends Error {}

function extensionsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.specify', 'extensions');
}

function readManifest(extensionDir: string): Record<string, unknown> {
  try {
    const data: unknown = YAML.parse(fs.readFileSync(path.join(extensionDir, 'extension.yml'), 'utf-8'));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

function listExtensionIds(workspaceRoot: string): string[] {
  try {
    return fs.readdirSync(extensionsRoot(workspaceRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find the command file via `provides.commands[].name` / `aliases` in the
 * extension manifest. Searches the hook's own extension when it names one,
 * otherwise every installed extension. The file must stay inside its
 * extension directory.
 */
export function resolveHookCommand(
  workspaceRoot: string,
  command: string,
  extensionId?: string,
): ResolvedHookCommand {
  const candidates = extensionId ? [extensionId] : listExtensionIds(workspaceRoot);
  for (const id of candidates) {
    if (id.includes('/') || id.includes('\\') || id.startsWith('.')) continue;
    const extensionDir = path.join(extensionsRoot(workspaceRoot), id);
    const provides = readManifest(extensionDir).provides;
    const commands = isObject(provides) && Array.isArray(provides.commands) ? provides.commands : [];
    for (const entry of commands) {
      if (!isObject(entry) || typeof entry.file !== 'string') continue;
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      if (entry.name !== command && !aliases.includes(command)) continue;
      const filePath = path.resolve(extensionDir, entry.file);
      const rel = path.relative(extensionDir, filePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new HookCommandNotFoundError(`${command}: manifest file "${entry.file}" escapes the extension directory.`);
      }
      return { extensionId: id, extensionDir, filePath };
    }
  }
  const where = extensionId ? `extension "${extensionId}"` : 'any installed extension';
  throw new HookCommandNotFoundError(`${command} is not provided by ${where} under .specify/extensions/.`);
}

/** Port of `CommandRegistrar.parse_frontmatter` (line-anchored closing `---`). */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith('---')) return { frontmatter: {}, body: content };
  const lines = content.split(/(?<=\n)/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') { end = i; break; }
  }
  if (end === -1) return { frontmatter: {}, body: content };
  const fmText = lines.slice(1, end).join('').trim();
  const body = lines.slice(end + 1).join('').trim();
  let fm: unknown;
  try {
    fm = YAML.parse(fmText) ?? {};
  } catch {
    fm = {};
  }
  return { frontmatter: isObject(fm) ? fm : {}, body };
}

/** Port of `rewrite_extension_paths`: only existing subdirs, never commands/specs/.git/dot-dirs. */
export function rewriteExtensionPaths(text: string, extensionId: string, extensionDir: string): string {
  if (!text) return text;
  let subdirs: string[];
  try {
    subdirs = fs.readdirSync(extensionDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !['commands', '.git', 'specs'].includes(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return text;
  }
  for (const subdir of subdirs) {
    const replacement = `.specify/extensions/${extensionId}/${subdir}/`;
    const re = new RegExp(`(^|[\\s\`"'(])(?:\\./)?${escapeRegExp(subdir)}/`, 'gu');
    text = text.replace(re, (_m, lead: string) => lead + replacement);
  }
  return text;
}

const PROJECT_PATH_RE =
  /(?:(?<![.\p{L}\p{N}_])(?<parent>(?:\.\.\/){2,})|(?<boundary>^|[\s`"'([{<=])(?<rel>\.specify\/|(?:\.?\/))?)(?<target>scripts|memory|templates)\//gu;

/** Port of `rewrite_project_relative_paths`. */
export function rewriteProjectRelativePaths(text: string, extensionId?: string): string {
  if (!text) return text;
  const scriptsReplacement = extensionId ? `.specify/extensions/${extensionId}/scripts/` : '.specify/scripts/';
  return text.replace(PROJECT_PATH_RE, (match, ...args) => {
    const groups = args[args.length - 1] as { parent?: string; boundary?: string; rel?: string; target: string };
    if (groups.parent) return `.specify/${groups.target}/`;
    if (groups.rel === '.specify/') return match;
    if (groups.target === 'scripts') return `${groups.boundary ?? ''}${scriptsReplacement}`;
    return `${groups.boundary ?? ''}.specify/${groups.target}/`;
  });
}

/** Port of `IntegrationBase.resolve_command_refs` with the `.` separator and `/` prefix. */
export function resolveCommandRefs(text: string): string {
  return text.replace(/__SPECKIT_COMMAND_([A-Z][A-Z0-9_-]*)__/g, (_m, name: string) =>
    `/speckit.${name.toLowerCase().replace(/_/g, '.')}`);
}

/** Port of `IntegrationBase.select_script_variant`; undefined when nothing is runnable. */
export function selectScriptVariant(
  requested: unknown,
  scripts: Record<string, string>,
  platform: NodeJS.Platform,
): string | undefined {
  if (typeof requested === 'string' && requested in scripts) return requested;
  const primary = platform === 'win32' ? 'ps' : 'sh';
  const secondary = primary === 'ps' ? 'sh' : 'ps';
  const fallbacks = requested === 'py' ? [primary, 'py'] : [primary, secondary, 'py'];
  return fallbacks.find((v) => v in scripts);
}

function onPath(name: string, platform: NodeJS.Platform): string | undefined {
  const exts = platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return undefined;
}

/** On Windows the Store "App Execution Alias" stub exists but cannot run Python. */
function interpreterRuns(executable: string): boolean {
  try {
    execFileSync(executable, ['-c', ''], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Port of `IntegrationBase.resolve_python_interpreter`. */
function pythonInterpreter(workspaceRoot: string, platform: NodeJS.Platform): string {
  for (const venv of ['.venv/bin/python', '.venv/Scripts/python.exe']) {
    if (fs.existsSync(path.join(workspaceRoot, venv))) return venv;
  }
  for (const name of ['python3', 'python']) {
    const found = onPath(name, platform);
    if (!found) continue;
    if (platform === 'win32' && !interpreterRuns(found)) continue;
    return name;
  }
  return 'python3';
}

function readInitOptions(workspaceRoot: string): Record<string, unknown> {
  try {
    return safeJsonParse(fs.readFileSync(path.join(workspaceRoot, '.specify', 'init-options.json'), 'utf-8'), isObject) ?? {};
  } catch {
    return {};
  }
}

export interface RenderOptions {
  workspaceRoot: string;
  extensionId: string;
  extensionDir: string;
  platform?: NodeJS.Platform;
  agentName?: string;
}

/** Render a command file's content into the prompt body Spec Kit would register. */
export function renderExtensionCommand(content: string, opts: RenderOptions): string {
  const platform = opts.platform ?? process.platform;
  const { frontmatter, body: rawBody } = parseFrontmatter(content);
  let body = rewriteExtensionPaths(rawBody, opts.extensionId, opts.extensionDir);

  const scripts: Record<string, string> = {};
  if (isObject(frontmatter.scripts)) {
    for (const [k, v] of Object.entries(frontmatter.scripts)) {
      if (typeof v === 'string') scripts[k] = rewriteProjectRelativePaths(v, opts.extensionId);
    }
  }

  body = resolveCommandRefs(body);

  if (Object.keys(scripts).length > 0) {
    const requested = readInitOptions(opts.workspaceRoot).script;
    const variant = selectScriptVariant(requested, scripts, platform);
    if (!variant) {
      throw new HookCommandRenderError(
        `No runnable script variant for this platform: requested ${JSON.stringify(requested ?? null)}; ` +
        `available: ${Object.keys(scripts).sort().join(', ')}`,
      );
    }
    let scriptCommand = scripts[variant];
    if (variant === 'py') scriptCommand = `${pythonInterpreter(opts.workspaceRoot, platform)} ${scriptCommand}`;
    body = body.split('{SCRIPT}').join(scriptCommand.split('{ARGS}').join('$ARGUMENTS'));
  }
  body = body.split('{ARGS}').join('$ARGUMENTS').split('__AGENT__').join(opts.agentName ?? 'caramelo');
  return rewriteProjectRelativePaths(body, opts.extensionId);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
