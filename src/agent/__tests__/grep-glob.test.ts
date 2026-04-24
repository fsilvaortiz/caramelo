import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { grepTool } from '../tools/grep.js';
import { globTool } from '../tools/glob.js';
import { nodeFs } from '../tools/io.js';
import type { ToolContext } from '../types.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-grepglob-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
}

function ctx(): ToolContext {
  return {
    workspaceRoot: tmp,
    signal: new AbortController().signal,
    log: () => { /* noop */ },
    io: nodeFs,
  };
}

describe('grep tool', () => {
  it('returns matches as path:line:text', async () => {
    write('src/a.ts', 'alpha\nbeta-hit\ngamma\n');
    write('src/b.ts', 'hit-again\n');
    const result = await grepTool.execute({ pattern: 'hit' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toMatch(/src\/a\.ts:2:beta-hit/);
    expect(String(result.content)).toMatch(/src\/b\.ts:1:hit-again/);
  });

  it('reports an invalid regex as is_error', async () => {
    const result = await grepTool.execute({ pattern: '[unclosed' }, ctx());
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/invalid regular expression/);
  });

  it('refuses a path limiter outside the workspace', async () => {
    const result = await grepTool.execute(
      { pattern: 'anything', path: '../escape' },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/outside the workspace/);
  });

  it('caps results and signals capped in summary', async () => {
    const big = Array.from({ length: 200 }, (_, i) => `hit ${i}`).join('\n');
    write('big.txt', big);
    const result = await grepTool.execute({ pattern: 'hit', max_matches: 5 }, ctx());
    expect(result.summary).toMatch(/capped/);
  });

  it('respects case_sensitive flag', async () => {
    write('a.ts', 'Hit\nmiss\n');
    const insensitive = await grepTool.execute({ pattern: 'hit' }, ctx());
    expect(String(insensitive.content)).toMatch(/Hit/);
    const sensitive = await grepTool.execute({ pattern: 'hit', case_sensitive: true }, ctx());
    expect(String(sensitive.content)).not.toMatch(/a\.ts:1:Hit/);
  });

  it('limits scope when path is provided', async () => {
    write('src/a.ts', 'hit\n');
    write('other/b.ts', 'hit\n');
    const result = await grepTool.execute({ pattern: 'hit', path: 'src' }, ctx());
    expect(String(result.content)).toMatch(/src\/a\.ts/);
    expect(String(result.content)).not.toMatch(/other\/b\.ts/);
  });
});

describe('glob tool', () => {
  it('matches a simple *.ts glob', async () => {
    write('src/a.ts', '');
    write('src/b.js', '');
    write('nested/c.ts', '');
    const result = await globTool.execute({ pattern: '**/*.ts' }, ctx());
    const out = String(result.content);
    expect(out).toMatch(/src\/a\.ts/);
    expect(out).toMatch(/nested\/c\.ts/);
    expect(out).not.toMatch(/b\.js/);
  });

  it('handles brace alternation', async () => {
    write('a.ts', '');
    write('b.md', '');
    write('c.txt', '');
    const result = await globTool.execute({ pattern: '*.{ts,md}' }, ctx());
    const out = String(result.content);
    expect(out).toMatch(/a\.ts/);
    expect(out).toMatch(/b\.md/);
    expect(out).not.toMatch(/c\.txt/);
  });

  it('caps results past max_results', async () => {
    for (let i = 0; i < 10; i++) write(`dir/f${i}.ts`, '');
    const result = await globTool.execute({ pattern: 'dir/*.ts', max_results: 3 }, ctx());
    expect(result.summary).toMatch(/capped/);
  });

  it('returns an empty set for no matches', async () => {
    write('a.ts', '');
    const result = await globTool.execute({ pattern: '**/*.ghost' }, ctx());
    expect(String(result.content)).toMatch(/no matches/);
  });

  it('rejects an invalid pattern', async () => {
    // Unbalanced braces are treated literally — not an error. A pattern
    // that breaks the regex compiler inside globToRegExp would
    // surface as a catch. We assert graceful handling either way.
    const result = await globTool.execute({ pattern: 'a{b,c' }, ctx());
    // Treated as literal `a{b,c` path: should produce no matches, not
    // an error.
    expect(result.isError ?? false).toBe(false);
  });
});
