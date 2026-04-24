import type { Tool } from '../types.js';
import { resolveInsideWorkspace } from './io.js';

export const listDirTool: Tool<{ path?: string }> = {
  name: 'list_dir',
  description:
    'List the direct children of a workspace directory (non-recursive). Returns ' +
    'file names (with trailing slash for subdirectories). Use glob for recursive ' +
    'discovery. Paths are workspace-relative; omit to list the workspace root.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative directory path. Default: root.' },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const rel = input.path ?? '.';
    const abs = resolveInsideWorkspace(rel, ctx.workspaceRoot);
    if (!abs) {
      return {
        summary: `list_dir refused: outside workspace — ${rel}`,
        content: `error: "${rel}" is outside the workspace and was refused.`,
        isError: true,
      };
    }
    const stat = ctx.io.stat(abs);
    if (!stat || !stat.isDirectory) {
      return {
        summary: `list_dir: not a directory — ${rel}`,
        content: `error: "${rel}" does not exist or is not a directory.`,
        isError: true,
      };
    }
    const entries = ctx.io.readdir(abs);
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const rendered = entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join('\n');
    return {
      summary: `list_dir ${rel} (${entries.length} entries)`,
      content: `dir: ${rel}\nentries:\n${rendered || '(empty)'}`,
    };
  },
};
