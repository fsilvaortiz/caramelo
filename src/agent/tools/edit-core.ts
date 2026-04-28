/**
 * Pure helpers for file_edit. Lifted from task-edits/apply.ts so the agent's
 * `file_edit` tool and the legacy SEARCH/REPLACE applier share exactly one
 * implementation — there must never be a semantic drift between the two
 * while the legacy protocol is still in use.
 */

export function toLF(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

export function fromLF(s: string, eol: '\n' | '\r\n'): string {
  return eol === '\n' ? s : s.replace(/\n/g, '\r\n');
}

export function detectDominantEol(s: string): '\n' | '\r\n' {
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

export function countOccurrences(haystack: string, needle: string): number {
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

export function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
