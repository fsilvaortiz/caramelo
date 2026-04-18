/**
 * Parser for the task-edit protocol. Every write the LLM is allowed to
 * perform MUST arrive as one of these two block shapes; anything else is
 * a hard error, never a silent fall-through to raw-content overwrite.
 *
 *   === FILE: path/to/file ===
 *   <<<<<<< SEARCH
 *   <text that exists in the file byte-for-byte>
 *   =======
 *   <replacement>
 *   >>>>>>> REPLACE
 *   === END FILE ===
 *
 *   === CREATE: path/to/new-file ===
 *   <full content>
 *   === END CREATE ===
 *
 * A single FILE block may contain several SEARCH/REPLACE pairs.
 */

export type Edit =
  | { kind: 'edit'; filePath: string; search: string; replace: string }
  | { kind: 'create'; filePath: string; content: string };

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Thrown when the output looks like the pre-0.0.9 "whole-file overwrite"
 * protocol (=== FILE === <body> === END FILE === with no SEARCH marker).
 * The caller must abort — applying such a block would clobber the file.
 */
export class LegacyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyFormatError';
  }
}

const FILE_HEADER = /^=== FILE: (.+?) ===$/;
const FILE_FOOTER = /^=== END FILE ===$/;
const CREATE_HEADER = /^=== CREATE: (.+?) ===$/;
const CREATE_FOOTER = /^=== END CREATE ===$/;
const SEARCH_MARKER = /^<<<<<<< SEARCH\s*$/;
const DIVIDER_MARKER = /^=======\s*$/;
const REPLACE_MARKER = /^>>>>>>> REPLACE\s*$/;

export function parseEdits(raw: string): Edit[] {
  const lines = raw.split(/\r?\n/);
  const edits: Edit[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      const filePath = fileMatch[1].trim();
      const bodyStart = i + 1;
      const footerIdx = findClosing(lines, bodyStart, FILE_FOOTER);
      if (footerIdx === -1) {
        throw new ParseError(`Missing "=== END FILE ===" for FILE block at line ${i + 1} (path: ${filePath}).`);
      }
      const body = lines.slice(bodyStart, footerIdx);
      const pairs = parseSearchReplacePairs(body, filePath, bodyStart);
      if (pairs.length === 0) {
        throw new LegacyFormatError(
          `FILE block for "${filePath}" has no SEARCH/REPLACE pair. ` +
          `Caramelo no longer accepts whole-file overwrites — ask the model to emit ` +
          `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE sections, or a CREATE block for a new file.`,
        );
      }
      for (const pair of pairs) {
        edits.push({ kind: 'edit', filePath, search: pair.search, replace: pair.replace });
      }
      i = footerIdx + 1;
      continue;
    }

    const createMatch = CREATE_HEADER.exec(line);
    if (createMatch) {
      const filePath = createMatch[1].trim();
      const bodyStart = i + 1;
      const footerIdx = findClosing(lines, bodyStart, CREATE_FOOTER);
      if (footerIdx === -1) {
        throw new ParseError(`Missing "=== END CREATE ===" for CREATE block at line ${i + 1} (path: ${filePath}).`);
      }
      const content = lines.slice(bodyStart, footerIdx).join('\n');
      edits.push({ kind: 'create', filePath, content });
      i = footerIdx + 1;
      continue;
    }

    i++;
  }

  return edits;
}

function findClosing(lines: string[], from: number, footer: RegExp): number {
  for (let j = from; j < lines.length; j++) {
    if (footer.test(lines[j])) return j;
  }
  return -1;
}

interface Pair { search: string; replace: string }

function parseSearchReplacePairs(body: string[], filePath: string, offset: number): Pair[] {
  const pairs: Pair[] = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i];

    if (!SEARCH_MARKER.test(line)) {
      // Non-marker lines outside a pair are ignored (LLMs often put a
      // blank line or comment between pairs) — but a stray divider or
      // replace marker without a preceding SEARCH is a hard error.
      if (DIVIDER_MARKER.test(line) || REPLACE_MARKER.test(line)) {
        throw new ParseError(
          `Stray "${line.trim()}" without preceding "<<<<<<< SEARCH" in FILE block "${filePath}" (line ${offset + i + 1}).`,
        );
      }
      i++;
      continue;
    }

    // We're on <<<<<<< SEARCH — find the divider.
    const searchStart = i + 1;
    const dividerIdx = findNext(body, searchStart, DIVIDER_MARKER);
    if (dividerIdx === -1) {
      throw new ParseError(
        `Missing "=======" divider after "<<<<<<< SEARCH" in FILE block "${filePath}" (line ${offset + i + 1}).`,
      );
    }
    // A nested <<<<<<< SEARCH before the divider is ambiguous.
    for (let k = searchStart; k < dividerIdx; k++) {
      if (SEARCH_MARKER.test(body[k])) {
        throw new ParseError(
          `Nested "<<<<<<< SEARCH" inside SEARCH section of FILE block "${filePath}" (line ${offset + k + 1}).`,
        );
      }
    }

    const replaceStart = dividerIdx + 1;
    const replaceEndIdx = findNext(body, replaceStart, REPLACE_MARKER);
    if (replaceEndIdx === -1) {
      throw new ParseError(
        `Missing ">>>>>>> REPLACE" after divider in FILE block "${filePath}" (line ${offset + dividerIdx + 1}).`,
      );
    }
    for (let k = replaceStart; k < replaceEndIdx; k++) {
      if (DIVIDER_MARKER.test(body[k]) || SEARCH_MARKER.test(body[k])) {
        throw new ParseError(
          `Unexpected marker "${body[k].trim()}" inside REPLACE section of FILE block "${filePath}" (line ${offset + k + 1}).`,
        );
      }
    }

    const search = body.slice(searchStart, dividerIdx).join('\n');
    const replace = body.slice(replaceStart, replaceEndIdx).join('\n');
    pairs.push({ search, replace });
    i = replaceEndIdx + 1;
  }
  return pairs;
}

function findNext(lines: string[], from: number, marker: RegExp): number {
  for (let j = from; j < lines.length; j++) {
    if (marker.test(lines[j])) return j;
  }
  return -1;
}
