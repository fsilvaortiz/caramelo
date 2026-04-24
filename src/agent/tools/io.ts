import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal filesystem interface shared by every tool. Each method returns a
 * discriminated result rather than collapsing every failure to
 * null/undefined — callers need to distinguish ENOENT (missing) from
 * EACCES (permission) from EISDIR (wrong kind) so the tool can report an
 * accurate error to the model. Swapping in an in-memory implementation is
 * the standard way to unit-test tool behaviour without touching the real
 * disk.
 */
export interface FileIO {
  read(abs: string): FileOpResult<string>;
  write(abs: string, content: string): FileOpResult<void>;
  exists(abs: string): boolean;
  mkdirp(abs: string): FileOpResult<void>;
  stat(abs: string): FileOpResult<FileStat>;
  readdir(abs: string): FileOpResult<FileEntry[]>;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
}

export interface FileEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export type FileOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

function err(error: unknown): { ok: false; code: string; message: string } {
  const e = error as NodeJS.ErrnoException & { message?: string };
  return {
    ok: false,
    code: e?.code ?? 'EUNKNOWN',
    message: e?.message ?? String(error),
  };
}

export const nodeFs: FileIO = {
  read(abs) {
    try {
      return { ok: true, value: fs.readFileSync(abs, 'utf-8') };
    } catch (e) {
      return err(e);
    }
  },
  write(abs, content) {
    try {
      fs.writeFileSync(abs, content, 'utf-8');
      return { ok: true, value: undefined };
    } catch (e) {
      return err(e);
    }
  },
  exists(abs) {
    return fs.existsSync(abs);
  },
  mkdirp(abs) {
    try {
      fs.mkdirSync(abs, { recursive: true });
      return { ok: true, value: undefined };
    } catch (e) {
      return err(e);
    }
  },
  stat(abs) {
    try {
      const s = fs.statSync(abs);
      const l = fs.lstatSync(abs);
      return {
        ok: true,
        value: {
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          isSymbolicLink: l.isSymbolicLink(),
          size: s.size,
        },
      };
    } catch (e) {
      return err(e);
    }
  },
  readdir(abs) {
    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
      return { ok: true, value: entries };
    } catch (e) {
      return err(e);
    }
  },
};

/**
 * Resolve a workspace-relative path to an absolute one, refusing anything
 * that escapes the workspace root. Defence-in-depth:
 *   1. Lexical check — reject `..` escapes and absolute paths that lie
 *      outside the root.
 *   2. `fs.realpathSync` — resolve symlinks on any existing prefix of the
 *      path and re-check; a symlink inside the workspace pointing to
 *      `~/.ssh` must be refused even though the lexical path is fine.
 *
 * Returns `null` on refusal or if the path is empty/invalid. Non-existent
 * paths are permitted (tools like `file_write` need to create new files) —
 * realpath only resolves the existing prefix.
 */
export function resolveInsideWorkspace(rel: string, root: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
  const normalisedRoot = path.resolve(root);
  const relFromRoot = path.relative(normalisedRoot, abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;

  // Resolve symlinks on the existing prefix. We walk upward from the
  // resolved path until we hit something that exists, realpath it, then
  // re-check that the real location is still inside the workspace root.
  // A symlink farm pointing at ~/.ssh fails this step even though the
  // lexical path would pass.
  const realRoot = safeRealpath(normalisedRoot) ?? normalisedRoot;
  const realAbs = resolveExistingPrefixRealpath(abs);
  const realFromRoot = path.relative(realRoot, realAbs);
  if (realFromRoot.startsWith('..') || path.isAbsolute(realFromRoot)) return null;

  return abs;
}

function safeRealpath(abs: string): string | null {
  try {
    return fs.realpathSync(abs);
  } catch {
    return null;
  }
}

function resolveExistingPrefixRealpath(abs: string): string {
  let current = abs;
  // Walk up at most path-depth times. Stop when we hit a directory that
  // exists — at that point realpath gives us the canonical location.
  for (let i = 0; i < 64; i++) {
    const real = safeRealpath(current);
    if (real !== null) {
      // Re-append the tail we walked past so the final absolute is the
      // canonical existing prefix + the yet-to-be-created suffix.
      const tail = path.relative(current, abs);
      return tail.length === 0 ? real : path.resolve(real, tail);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return abs;
}

/** Convenience: true if the path resolves inside the workspace. */
export function isInsideWorkspace(rel: string, root: string): boolean {
  return resolveInsideWorkspace(rel, root) !== null;
}
