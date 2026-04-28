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
    if (!stat.ok) {
      return {
        summary: `list_dir: ${stat.code} — ${rel}`,
        content: `error: could not stat "${rel}" (${stat.code}): ${stat.message}`,
        isError: true,
      };
    }
    if (!stat.value.isDirectory) {
      return {
        summary: `list_dir: not a directory — ${rel}`,
        content: `error: "${rel}" exists but is not a directory (isFile=${stat.value.isFile}).`,
        isError: true,
      };
    }
    const entries = ctx.io.readdir(abs);
    if (!entries.ok) {
      return {
        summary: `list_dir: ${entries.code} — ${rel}`,
        content: `error: could not read directory "${rel}" (${entries.code}): ${entries.message}`,
        isError: true,
      };
    }
    const sorted = entries.value.slice().sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const rendered = sorted.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join('\n');
    return {
      summary: `list_dir ${rel} (${sorted.length} entries)`,
      content: `dir: ${rel}\nentries:\n${rendered || '(empty)'}`,
    };
  },
};
