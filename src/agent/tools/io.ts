import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal filesystem interface shared by every tool. Swapping in an in-memory
 * implementation is the standard way to unit-test tool behaviour without
 * touching the real disk.
 */
export interface FileIO {
  read(abs: string): string | null;
  write(abs: string, content: string): void;
  exists(abs: string): boolean;
  mkdirp(abs: string): void;
  /** Returns `undefined` if the path cannot be stat-ed. */
  stat(abs: string): { isFile: boolean; isDirectory: boolean; size: number } | undefined;
  /** Returns entries without the containing directory. Empty array on error. */
  readdir(abs: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
}

export const nodeFs: FileIO = {
  read(abs) {
    try {
      return fs.readFileSync(abs, 'utf-8');
    } catch {
      return null;
    }
  },
  write(abs, content) {
    fs.writeFileSync(abs, content, 'utf-8');
  },
  exists(abs) {
    return fs.existsSync(abs);
  },
  mkdirp(abs) {
    fs.mkdirSync(abs, { recursive: true });
  },
  stat(abs) {
    try {
      const s = fs.statSync(abs);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return undefined;
    }
  },
  readdir(abs) {
    try {
      return fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
};

/**
 * Resolve a workspace-relative path to an absolute one, refusing anything that
 * escapes the workspace root (via `..`, absolute paths, or symlink traversal
 * in the form of a resolved path that lies outside root). Returns null on
 * refusal. This is the ONLY place every filesystem tool should consult.
 */
export function resolveInsideWorkspace(rel: string, root: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
  const normalisedRoot = path.resolve(root);
  const relFromRoot = path.relative(normalisedRoot, abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
  return abs;
}

/** Convenience: true if the path resolves inside the workspace. */
export function isInsideWorkspace(rel: string, root: string): boolean {
  return resolveInsideWorkspace(rel, root) !== null;
}
