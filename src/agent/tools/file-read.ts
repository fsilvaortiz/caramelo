import type { Tool } from '../types.js';
import { resolveInsideWorkspace } from './io.js';

const MAX_BYTES = 50 * 1024;

export const fileReadTool: Tool<{
  path: string;
  start_line?: number;
  end_line?: number;
}> = {
  name: 'file_read',
  description:
    'Read a UTF-8 text file from the workspace. Paths are workspace-relative. ' +
    'Optional start_line/end_line (1-indexed, inclusive) clamp the returned range. ' +
    'Output is capped at 50 KB; if the file is larger, the tail is truncated and ' +
    'a marker is appended. Returns an error if the path is outside the workspace ' +
    'or the file does not exist.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      start_line: { type: 'integer', minimum: 1, description: 'First line (1-indexed, inclusive).' },
      end_line: { type: 'integer', minimum: 1, description: 'Last line (1-indexed, inclusive).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const abs = resolveInsideWorkspace(input.path, ctx.workspaceRoot);
    if (!abs) {
      return {
        summary: `file_read refused: path outside workspace — ${input.path}`,
        content: `error: path "${input.path}" is outside the workspace and was refused.`,
        isError: true,
      };
    }
    const stat = ctx.io.stat(abs);
    if (!stat.ok) {
      return {
        summary: `file_read: ${stat.code} — ${input.path}`,
        content: `error: could not stat "${input.path}" (${stat.code}): ${stat.message}`,
        isError: true,
      };
    }
    if (!stat.value.isFile) {
      return {
        summary: `file_read: not a file — ${input.path}`,
        content: `error: "${input.path}" exists but is not a regular file (isDirectory=${stat.value.isDirectory}).`,
        isError: true,
      };
    }
    const raw = ctx.io.read(abs);
    if (!raw.ok) {
      return {
        summary: `file_read failed: ${raw.code} — ${input.path}`,
        content: `error: could not read "${input.path}" (${raw.code}): ${raw.message}`,
        isError: true,
      };
    }

    let body = raw.value;
    const totalLines = body.split('\n').length;
    if (input.start_line || input.end_line) {
      const lines = body.split('\n');
      const start = Math.max(1, input.start_line ?? 1) - 1;
      const end = Math.min(lines.length, input.end_line ?? lines.length);
      body = lines.slice(start, end).join('\n');
    }

    let truncated = false;
    if (body.length > MAX_BYTES) {
      body = body.slice(0, MAX_BYTES);
      truncated = true;
    }

    const header = `path: ${input.path}\nbytes: ${raw.value.length}\nlines: ${totalLines}${truncated ? '\ntruncated: true (first 50KB shown)' : ''}\n---\n`;
    return {
      summary: `file_read ${input.path} (${raw.value.length} B, ${totalLines} lines${truncated ? ', truncated' : ''})`,
      content: header + body,
    };
  },
};
