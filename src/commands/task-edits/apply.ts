import * as fs from 'fs';
import * as path from 'path';
import type { Edit } from './parser.js';

export type ApplyStatus =
  | 'applied'
  | 'aborted-no-match'
  | 'aborted-ambiguous'
  | 'aborted-exists'
  | 'aborted-missing'
  | 'error';

export interface ApplyOutcome {
  filePath: string;
  status: ApplyStatus;
  /** Human-readable reason; suitable for the OutputChannel. */
  detail: string;
  /** Whether the edit modified the disk. */
  wrote: boolean;
}

export interface FileIO {
  read(abs: string): string | null;
  write(abs: string, content: string): void;
  exists(abs: string): boolean;
  mkdirp(abs: string): void;
}

const nodeFs: FileIO = {
  read(abs) {
    try { return fs.readFileSync(abs, 'utf-8'); } catch { return null; }
  },
  write(abs, content) { fs.writeFileSync(abs, content, 'utf-8'); },
  exists(abs) { return fs.existsSync(abs); },
  mkdirp(abs) { fs.mkdirSync(abs, { recursive: true }); },
};

export interface ApplyOptions {
  workspaceRoot: string;
  io?: FileIO;
}

export function applyEdits(edits: Edit[], options: ApplyOptions): ApplyOutcome[] {
  const io = options.io ?? nodeFs;
  const outcomes: ApplyOutcome[] = [];

  for (const edit of edits) {
    const abs = resolveInsideWorkspace(edit.filePath, options.workspaceRoot);
    if (!abs) {
      outcomes.push({
        filePath: edit.filePath,
        status: 'error',
        detail: `Path escapes the workspace root and was refused: ${edit.filePath}`,
        wrote: false,
      });
      continue;
    }

    if (edit.kind === 'create') {
      if (io.exists(abs)) {
        outcomes.push({
          filePath: edit.filePath,
          status: 'aborted-exists',
          detail: `CREATE refused: "${edit.filePath}" already exists on disk. Use a SEARCH/REPLACE block to edit it.`,
          wrote: false,
        });
        continue;
      }
      io.mkdirp(path.dirname(abs));
      io.write(abs, edit.content);
      outcomes.push({
        filePath: edit.filePath,
        status: 'applied',
        detail: `Created "${edit.filePath}" (${edit.content.length} bytes).`,
        wrote: true,
      });
      continue;
    }

    // edit.kind === 'edit'
    const current = io.read(abs);
    if (current === null) {
      outcomes.push({
        filePath: edit.filePath,
        status: 'aborted-missing',
        detail: `SEARCH/REPLACE refused: "${edit.filePath}" does not exist. Use a CREATE block to make a new file.`,
        wrote: false,
      });
      continue;
    }

    const currentLF = toLF(current);
    const searchLF = toLF(edit.search);
    const count = countOccurrences(currentLF, searchLF);

    if (count === 0) {
      outcomes.push({
        filePath: edit.filePath,
        status: 'aborted-no-match',
        detail:
          `SEARCH block for "${edit.filePath}" did not match the file. ` +
          `Ask the model to copy the existing text byte-for-byte.\n` +
          `--- Expected SEARCH (${edit.search.length} bytes) ---\n${truncate(edit.search, 400)}\n` +
          `--- First 400 bytes of file ---\n${truncate(current, 400)}`,
        wrote: false,
      });
      continue;
    }

    if (count > 1) {
      outcomes.push({
        filePath: edit.filePath,
        status: 'aborted-ambiguous',
        detail:
          `SEARCH block for "${edit.filePath}" matches ${count} times. ` +
          `Ask the model to include more surrounding context to disambiguate.\n` +
          `--- SEARCH ---\n${truncate(edit.search, 400)}`,
        wrote: false,
      });
      continue;
    }

    // Exactly one match — safe to replace. Perform the substitution in the
    // normalised (LF) form, then translate back to the file's dominant EOL.
    const replacedLF = replaceFirst(currentLF, searchLF, toLF(edit.replace));
    const finalContent = fromLF(replacedLF, detectDominantEol(current));
    io.write(abs, finalContent);
    outcomes.push({
      filePath: edit.filePath,
      status: 'applied',
      detail: `Edited "${edit.filePath}" (1 hunk, ${edit.search.length} → ${edit.replace.length} bytes).`,
      wrote: true,
    });
  }

  return outcomes;
}

function resolveInsideWorkspace(rel: string, root: string): string | null {
  const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
  const normalisedRoot = path.resolve(root);
  // Allow files inside the workspace; refuse anything that resolves outside.
  const relFromRoot = path.relative(normalisedRoot, abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
  return abs;
}

function toLF(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function fromLF(s: string, eol: '\n' | '\r\n'): string {
  return eol === '\n' ? s : s.replace(/\n/g, '\r\n');
}

function detectDominantEol(s: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      if (i > 0 && s[i - 1] === '\r') crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + needle.length;
  }
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
