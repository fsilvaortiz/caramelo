import * as path from 'path';
import type { Tool } from '../types.js';
import { resolveInsideWorkspace } from './io.js';
import { buildWorkspaceIndex } from '../../commands/task-edits/context.js';

const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 256 * 1024;

export const grepTool: Tool<{
  pattern: string;
  path?: string;
  case_sensitive?: boolean;
  max_matches?: number;
}> = {
  name: 'grep',
  description:
    'Search file contents for a regular expression. Returns up to 100 matches ' +
    'as "path:line:text" lines. The pattern uses JavaScript RegExp syntax. ' +
    'Provide `path` to limit the search to a subdirectory; otherwise searches ' +
    'the whole workspace (excluding node_modules, .git, dist, etc.). Files ' +
    'larger than 256 KB and non-text files are skipped.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript RegExp source.' },
      path: {
        type: 'string',
        description: 'Workspace-relative directory to limit the search (optional).',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Default false (case-insensitive).',
      },
      max_matches: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description: 'Cap the number of results. Default 100, hard max 500.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.case_sensitive ? '' : 'i');
    } catch (err) {
      return {
        summary: `grep: invalid pattern`,
        content: `error: invalid regular expression: ${(err as Error).message}`,
        isError: true,
      };
    }

    const cap = Math.min(Math.max(1, input.max_matches ?? MAX_MATCHES), 500);

    const index = buildWorkspaceIndex(ctx.workspaceRoot);
    let pool = index;
    if (input.path) {
      const absDir = resolveInsideWorkspace(input.path, ctx.workspaceRoot);
      if (!absDir) {
        return {
          summary: `grep refused: outside workspace — ${input.path}`,
          content: `error: path "${input.path}" is outside the workspace.`,
          isError: true,
        };
      }
      const relDir = path.relative(ctx.workspaceRoot, absDir).replace(/\\/g, '/');
      pool = index.filter((rel) => rel === relDir || rel.startsWith(`${relDir}/`));
    }

    const results: string[] = [];
    const errors: string[] = [];
    let scanned = 0;
    for (const rel of pool) {
      if (ctx.signal.aborted) break;
      scanned++;
      const abs = path.resolve(ctx.workspaceRoot, rel);
      const stat = ctx.io.stat(abs);
      if (!stat.ok) {
        // A permission error on a workspace file is worth surfacing so
        // the user knows why a grep is incomplete.
        errors.push(`${rel}: ${stat.code}`);
        continue;
      }
      if (!stat.value.isFile || stat.value.size > MAX_FILE_BYTES) continue;
      const body = ctx.io.read(abs);
      if (!body.ok) {
        errors.push(`${rel}: ${body.code}`);
        continue;
      }
      const lines = body.value.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`);
          if (results.length >= cap) break;
        }
      }
      if (results.length >= cap) break;
    }

    const truncated = results.length >= cap;
    const errorBlock = errors.length > 0
      ? `\nunreadable (${errors.length}): ${errors.slice(0, 10).join(', ')}${errors.length > 10 ? ', …' : ''}`
      : '';
    return {
      summary: `grep /${input.pattern}/ → ${results.length} match${results.length === 1 ? '' : 'es'}${truncated ? ' (capped)' : ''}${errors.length ? ` (${errors.length} unreadable)` : ''}`,
      content:
        `pattern: ${input.pattern}\ncase_sensitive: ${Boolean(input.case_sensitive)}\n` +
        `scanned_files: ${scanned}\nmatches: ${results.length}${truncated ? ' (capped)' : ''}${errorBlock}\n---\n` +
        (results.length === 0 ? '(no matches)' : results.join('\n')),
    };
  },
};
