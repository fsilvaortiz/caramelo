import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_MAX_FILE_BYTES = 50 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024;

/** Folders we never descend into while indexing the workspace. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.specify', 'dist', 'build', 'out', 'target',
  '.gradle', '.mvn', '.idea', '.vscode', '.next', '.nuxt', '.cache',
  'coverage', '__pycache__', '.pytest_cache', '.tox', 'venv', '.venv',
]);
const MAX_WALK_FILES = 5000;
const MAX_WALK_DEPTH = 12;

// Match backticked paths (`src/foo.ts`) and bare paths that look like
// workspace-relative code files. We intentionally restrict to extensions
// that a code-gen task is likely to edit — this keeps us out of prose noise.
const CODE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'm',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
  'md', 'mdx', 'rst', 'txt',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini',
  'css', 'scss', 'sass', 'less',
  'html', 'htm', 'vue', 'svelte',
  'sql', 'prisma', 'graphql', 'gql',
  'sh', 'bash', 'zsh', 'fish',
  'dockerfile',
];

const EXT_GROUP = CODE_EXTENSIONS.join('|');
const PATH_SEGMENT = `[A-Za-z0-9_./\\-]`;
const BACKTICK_PATH_RE = new RegExp(
  '`(' + PATH_SEGMENT + '+\\.(?:' + EXT_GROUP + '))`',
  'gi',
);
const BARE_PATH_RE = new RegExp(
  '(?<![A-Za-z0-9_./-])' +
  '(' + PATH_SEGMENT + '+\\.(?:' + EXT_GROUP + '))' +
  '(?![A-Za-z0-9_./-])',
  'gi',
);

export interface ContextOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** Extra paths to always consider (e.g. `spec.md`, `plan.md`, `tasks.md`). */
  specDocs?: string[];
}

export interface BuildContextArgs {
  specDir: string;
  workspaceRoot: string;
  /**
   * The concrete task text being executed — we scan it too so that a
   * task that says "edit `src/foo.ts`" gets `src/foo.ts` auto-attached.
   */
  taskText: string;
  options?: ContextOptions;
}

export interface BuiltContext {
  /** Final text to feed to the LLM (already delimited, safe to concatenate). */
  text: string;
  /** Files actually included, for the OutputChannel summary. */
  includedFiles: string[];
  /** Files that were found but skipped because they would exceed the budget. */
  skippedFiles: string[];
}

export function buildTaskContext(args: BuildContextArgs): BuiltContext {
  const maxFile = args.options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotal = args.options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const specDocs = args.options?.specDocs ?? ['spec.md', 'plan.md', 'tasks.md'];

  const parts: string[] = [];
  const includedFiles: string[] = [];
  const skippedFiles: string[] = [];
  let total = 0;

  const append = (label: string, relPath: string, content: string): boolean => {
    // Always emit POSIX-style separators so the LLM-facing context, the
    // `includedFiles` summary, and the test assertions match regardless
    // of host platform (Windows used to produce `specs\feature-a\foo`).
    const rel = toPosix(relPath);
    const header = `--- ${label}: ${rel} ---\n`;
    const footer = `\n--- END FILE ---\n`;
    const chunk = header + content + footer;
    if (total + chunk.length > maxTotal) {
      skippedFiles.push(rel);
      return false;
    }
    parts.push(chunk);
    includedFiles.push(rel);
    total += chunk.length;
    return true;
  };

  // 1. Spec docs from the current feature directory.
  const specDocsText: string[] = [];
  for (const name of specDocs) {
    const abs = path.join(args.specDir, name);
    const read = safeRead(abs, maxFile);
    if (!read) continue;
    specDocsText.push(read.content);
    append('SPEC', path.relative(args.workspaceRoot, abs) || name, read.content);
  }

  // 2. Collect candidate paths referenced anywhere in the task or in the
  //    spec docs. De-duplicate and filter to files inside the workspace.
  const scanText = [args.taskText, ...specDocsText].join('\n');
  const candidates = extractReferencedPaths(scanText);

  // 3. Include each candidate if it exists, fits in budget, and is inside
  //    the workspace root. If the literal candidate path doesn't exist we
  //    search the workspace for any file whose path ends with that candidate,
  //    so a task that says `src/main/.../Foo.java` still matches
  //    `some-module/src/main/.../Foo.java`. This is how we stop the LLM from
  //    emitting a CREATE for a file that already exists under a module prefix.
  const index = buildWorkspaceIndex(args.workspaceRoot);
  const resolved = new Set<string>();
  for (const rel of candidates) {
    const targets = resolveCandidate(rel, args.workspaceRoot, index);
    for (const resolvedRel of targets) {
      if (resolved.has(resolvedRel)) continue;
      resolved.add(resolvedRel);
      if (includedFiles.includes(resolvedRel)) continue;
      const abs = path.resolve(args.workspaceRoot, resolvedRel);
      // Don't re-include spec docs under a different label.
      if (path.relative(args.specDir, abs) && specDocs.includes(path.basename(abs))) continue;
      const read = safeRead(abs, maxFile);
      if (!read) continue;
      const ok = append('EXISTING FILE', resolvedRel, read.content);
      if (!ok) break; // budget exhausted
    }
  }

  return {
    text: parts.join('\n'),
    includedFiles,
    skippedFiles,
  };
}

export function extractReferencedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(BACKTICK_PATH_RE)) {
    found.add(match[1]);
  }
  for (const match of text.matchAll(BARE_PATH_RE)) {
    found.add(match[1]);
  }
  return Array.from(found);
}

interface ReadResult { content: string; truncated: boolean }

function safeRead(abs: string, maxBytes: number): ReadResult | null {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    const raw = fs.readFileSync(abs, 'utf-8');
    if (raw.length <= maxBytes) return { content: raw, truncated: false };
    return {
      content: raw.slice(0, maxBytes) + `\n[…truncated, original was ${raw.length} bytes]`,
      truncated: true,
    };
  } catch {
    return null;
  }
}

/**
 * Force POSIX-style forward-slash separators. Used so the workspace
 * paths we emit to the LLM and to consumers are platform-agnostic;
 * on Windows `path.join` / `path.relative` produce backslashes.
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function resolveInsideWorkspace(rel: string, root: string): string | null {
  if (path.isAbsolute(rel)) return null; // refuse absolute paths for context inclusion
  const abs = path.resolve(root, rel);
  const relFromRoot = path.relative(path.resolve(root), abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
  return abs;
}

/** Build a flat list of workspace-relative file paths (posix-separated). */
export function buildWorkspaceIndex(root: string): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_WALK_DEPTH) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
        if (out.length >= MAX_WALK_FILES) break;
      }
    }
  }
  return out;
}

/**
 * Map a candidate path (possibly missing a module/directory prefix) to one or
 * more real workspace-relative paths. Priority:
 *   1. Exact match at the literal location.
 *   2. Files whose path ENDS with the candidate (suffix match).
 *   3. Otherwise empty — the candidate might be a file to create.
 */
export function resolveCandidate(candidate: string, root: string, index: string[]): string[] {
  const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  const literal = resolveInsideWorkspace(normalized, root);
  if (literal) {
    try {
      if (fs.statSync(literal).isFile()) return [normalized];
    } catch { /* fall through */ }
  }
  const matches = index.filter(
    (rel) => rel === normalized || rel.endsWith('/' + normalized),
  );
  // Cap to a small number so a vague suffix like `config.json` doesn't flood
  // context with unrelated files.
  return matches.slice(0, 3);
}
