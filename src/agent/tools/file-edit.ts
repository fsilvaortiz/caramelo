import type { Tool } from '../types.js';
import { resolveInsideWorkspace } from './io.js';
import {
  countOccurrences,
  detectDominantEol,
  fromLF,
  replaceFirst,
  toLF,
  truncate,
} from './edit-core.js';

export const fileEditTool: Tool<{
  path: string;
  search: string;
  replace: string;
}> = {
  name: 'file_edit',
  description:
    'Replace an exact, unique snippet in an existing file. The search parameter ' +
    'must match the current file byte-for-byte (whitespace, indentation, punctuation) ' +
    'and must be unique in the file — include enough surrounding context to ' +
    'disambiguate. Returns an error (and makes no change) if the search did not ' +
    'match, or matched more than once. Line endings are normalised and the ' +
    'file\'s dominant EOL is preserved.',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path to an EXISTING file.' },
      search: {
        type: 'string',
        description: 'Exact text currently in the file. Must be unique.',
      },
      replace: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'search', 'replace'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const abs = resolveInsideWorkspace(input.path, ctx.workspaceRoot);
    if (!abs) {
      return {
        summary: `file_edit refused: path outside workspace — ${input.path}`,
        content: `error: path "${input.path}" is outside the workspace and was refused.`,
        isError: true,
      };
    }
    const current = ctx.io.read(abs);
    if (current === null) {
      return {
        summary: `file_edit failed: file missing — ${input.path}`,
        content:
          `error: "${input.path}" does not exist. Use file_write to create a new ` +
          `file, or file_read first to inspect an existing path.`,
        isError: true,
      };
    }
    const currentLF = toLF(current);
    const searchLF = toLF(input.search);
    const count = countOccurrences(currentLF, searchLF);
    if (count === 0) {
      return {
        summary: `file_edit no match — ${input.path}`,
        content:
          `error: the search block did not match "${input.path}". ` +
          `Read the file again with file_read and copy the existing text byte-for-byte.\n` +
          `expected search (${input.search.length} B):\n${truncate(input.search, 400)}\n` +
          `first 400 B of file:\n${truncate(current, 400)}`,
        isError: true,
      };
    }
    if (count > 1) {
      return {
        summary: `file_edit ambiguous (${count} matches) — ${input.path}`,
        content:
          `error: the search block matches ${count} places in "${input.path}". ` +
          `Include more surrounding context so the match is unique.\n` +
          `search:\n${truncate(input.search, 400)}`,
        isError: true,
      };
    }
    const replacedLF = replaceFirst(currentLF, searchLF, toLF(input.replace));
    const finalContent = fromLF(replacedLF, detectDominantEol(current));
    try {
      ctx.io.write(abs, finalContent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        summary: `file_edit write failed — ${input.path}`,
        content: `error: could not write "${input.path}": ${msg}`,
        isError: true,
      };
    }
    return {
      summary: `file_edit ${input.path} (${input.search.length} → ${input.replace.length} B)`,
      content:
        `ok: edited "${input.path}" (1 hunk, ${input.search.length} → ${input.replace.length} bytes).`,
    };
  },
};
