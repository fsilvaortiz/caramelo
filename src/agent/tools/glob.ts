import type { Tool } from '../types.js';
import { buildWorkspaceIndex } from '../../commands/task-edits/context.js';

export const globTool: Tool<{ pattern: string; max_results?: number }> = {
  name: 'glob',
  description:
    'Find files whose workspace-relative path matches a glob pattern. Supports ' +
    '`*` (any characters within a path segment), `**` (any number of segments), ' +
    '`?` (single character), and brace alternation `{a,b}`. Returns up to 200 ' +
    'matching paths sorted lexicographically. Example: "src/**/*.ts" lists every ' +
    'TypeScript file under src/.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern.' },
      max_results: { type: 'integer', minimum: 1, maximum: 2000 },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cap = Math.min(Math.max(1, input.max_results ?? 200), 2000);
    let re: RegExp;
    try {
      re = globToRegExp(input.pattern);
    } catch (err) {
      return {
        summary: 'glob: invalid pattern',
        content: `error: ${(err as Error).message}`,
        isError: true,
      };
    }
    const index = buildWorkspaceIndex(ctx.workspaceRoot);
    const matches = index.filter((rel) => re.test(rel)).sort();
    const truncated = matches.length > cap;
    const shown = truncated ? matches.slice(0, cap) : matches;
    return {
      summary: `glob ${input.pattern} → ${matches.length} path${matches.length === 1 ? '' : 's'}${truncated ? ' (capped)' : ''}`,
      content:
        `pattern: ${input.pattern}\nmatches: ${matches.length}${truncated ? ` (showing first ${cap})` : ''}\n---\n` +
        (shown.length === 0 ? '(no matches)' : shown.join('\n')),
    };
  },
};

function globToRegExp(glob: string): RegExp {
  // Expand brace alternation {a,b,c} first — alternation is NOT a glob
  // primitive understood by the token scanner below.
  const expanded = expandBraces(glob);
  if (expanded.length > 1) {
    const parts = expanded.map(globToSegment);
    return new RegExp(`^(?:${parts.join('|')})$`);
  }
  return new RegExp(`^${globToSegment(expanded[0])}$`);
}

function globToSegment(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches any number of segments (including zero).
        out += '.*';
        i += 2;
        // consume a following `/` so `**/foo` matches `foo` at root too.
        if (glob[i] === '/') i++;
      } else {
        // `*` matches anything but `/`
        out += '[^/]*';
        i++;
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (c === '.' || c === '+' || c === '(' || c === ')' || c === '|' || c === '^' || c === '$' || c === '\\') {
      out += `\\${c}`;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function expandBraces(glob: string): string[] {
  // Minimal brace expansion: finds the first top-level {a,b,...} group and
  // fans it out, recursively. No nested brace support (sufficient for our
  // tools — the model can always emit multiple glob calls).
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++;
    else if (glob[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [glob]; // unbalanced — treat literally
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  const alternatives = glob.slice(open + 1, close).split(',');
  const out: string[] = [];
  for (const alt of alternatives) {
    for (const tail of expandBraces(suffix)) {
      out.push(`${prefix}${alt}${tail}`);
    }
  }
  return out;
}
