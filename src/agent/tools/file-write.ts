import * as path from 'path';
import type { Tool } from '../types.js';
import { resolveInsideWorkspace } from './io.js';
import { detectDominantEol, fromLF, toLF } from './edit-core.js';

export const fileWriteTool: Tool<{
  path: string;
  content: string;
  overwrite?: boolean;
}> = {
  name: 'file_write',
  description:
    'Create or overwrite a UTF-8 text file at a workspace-relative path. By ' +
    'default refuses to overwrite an existing file — pass overwrite=true to ' +
    'replace its contents (rare; prefer file_edit for targeted changes). Parent ' +
    'directories are created automatically. The file is written with LF line ' +
    'endings unless the existing file had CRLF, in which case CRLF is preserved.',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      content: { type: 'string', description: 'Full file contents.' },
      overwrite: { type: 'boolean', description: 'Allow overwriting an existing file.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const abs = resolveInsideWorkspace(input.path, ctx.workspaceRoot);
    if (!abs) {
      return {
        summary: `file_write refused: path outside workspace — ${input.path}`,
        content: `error: path "${input.path}" is outside the workspace and was refused.`,
        isError: true,
      };
    }
    const existed = ctx.io.exists(abs);
    if (existed && !input.overwrite) {
      return {
        summary: `file_write refused: file exists — ${input.path}`,
        content:
          `error: "${input.path}" already exists. To change an existing file, ` +
          `prefer file_edit with a precise SEARCH/REPLACE; to replace the whole ` +
          `file, call file_write again with overwrite=true.`,
        isError: true,
      };
    }

    const mkdir = ctx.io.mkdirp(path.dirname(abs));
    if (!mkdir.ok) {
      return {
        summary: `file_write failed: ${mkdir.code} — ${input.path}`,
        content: `error: mkdirp failed for "${input.path}" (${mkdir.code}): ${mkdir.message}`,
        isError: true,
      };
    }

    // When overwriting, preserve the file's dominant EOL so we don't flip
    // a CRLF file to LF under the LLM's feet.
    let body = input.content;
    if (existed) {
      const current = ctx.io.read(abs);
      if (!current.ok) {
        return {
          summary: `file_write failed: ${current.code} reading existing — ${input.path}`,
          content: `error: could not read existing "${input.path}" for EOL detection (${current.code}): ${current.message}`,
          isError: true,
        };
      }
      body = fromLF(toLF(body), detectDominantEol(current.value));
    }

    const write = ctx.io.write(abs, body);
    if (!write.ok) {
      return {
        summary: `file_write failed: ${write.code} — ${input.path}`,
        content: `error: write failed for "${input.path}" (${write.code}): ${write.message}`,
        isError: true,
      };
    }
    return {
      summary: existed
        ? `file_write overwrote ${input.path} (${body.length} B)`
        : `file_write created ${input.path} (${body.length} B)`,
      content: `ok: ${existed ? 'overwrote' : 'created'} "${input.path}" (${body.length} bytes).`,
    };
  },
};
