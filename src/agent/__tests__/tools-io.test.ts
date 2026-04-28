import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nodeFs, resolveInsideWorkspace } from '../tools/io.js';
import { fileReadTool } from '../tools/file-read.js';
import { fileWriteTool } from '../tools/file-write.js';
import { fileEditTool } from '../tools/file-edit.js';
import { listDirTool } from '../tools/list-dir.js';
import type { ToolContext } from '../types.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-tools-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

function ctx(): ToolContext {
  const controller = new AbortController();
  return {
    workspaceRoot: tmp,
    signal: controller.signal,
    log: () => { /* noop */ },
    io: nodeFs,
  };
}

describe('resolveInsideWorkspace', () => {
  it('resolves paths inside the workspace', () => {
    expect(resolveInsideWorkspace('src/a.ts', tmp)).toBe(path.resolve(tmp, 'src/a.ts'));
  });

  it('refuses paths that escape the workspace', () => {
    expect(resolveInsideWorkspace('../outside.ts', tmp)).toBeNull();
    expect(resolveInsideWorkspace('src/../../outside.ts', tmp)).toBeNull();
  });

  it('refuses empty/invalid paths', () => {
    expect(resolveInsideWorkspace('', tmp)).toBeNull();
  });
});

describe('file_read tool', () => {
  it('returns the file contents', async () => {
    writeFile('src/a.ts', 'const x = 1;\n');
    const result = await fileReadTool.execute({ path: 'src/a.ts' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain('const x = 1;');
  });

  it('errors on non-existent files', async () => {
    const result = await fileReadTool.execute({ path: 'ghost.ts' }, ctx());
    expect(result.isError).toBe(true);
  });

  it('refuses paths outside the workspace', async () => {
    const result = await fileReadTool.execute({ path: '../outside.ts' }, ctx());
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/outside/);
  });

  it('supports line-range slicing', async () => {
    writeFile('src/a.ts', 'one\ntwo\nthree\nfour\n');
    const result = await fileReadTool.execute(
      { path: 'src/a.ts', start_line: 2, end_line: 3 },
      ctx(),
    );
    expect(String(result.content)).toContain('two');
    expect(String(result.content)).toContain('three');
    expect(String(result.content)).not.toContain('four');
  });
});

describe('file_write tool', () => {
  it('creates a new file and parent dirs', async () => {
    const result = await fileWriteTool.execute(
      { path: 'src/new/file.ts', content: 'export const a = 1;\n' },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(tmp, 'src/new/file.ts'), 'utf-8')).toBe('export const a = 1;\n');
  });

  it('refuses to overwrite by default', async () => {
    writeFile('src/a.ts', 'original');
    const result = await fileWriteTool.execute(
      { path: 'src/a.ts', content: 'hijack' },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'src/a.ts'), 'utf-8')).toBe('original');
  });

  it('overwrites when overwrite=true', async () => {
    writeFile('src/a.ts', 'original');
    const result = await fileWriteTool.execute(
      { path: 'src/a.ts', content: 'replaced', overwrite: true },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(tmp, 'src/a.ts'), 'utf-8')).toBe('replaced');
  });

  it('refuses paths outside the workspace', async () => {
    const result = await fileWriteTool.execute(
      { path: '../escape.ts', content: 'x' },
      ctx(),
    );
    expect(result.isError).toBe(true);
  });
});

describe('file_edit tool', () => {
  it('applies a unique-match edit', async () => {
    writeFile('src/a.ts', 'const x = 1;\nconst y = 2;\n');
    const result = await fileEditTool.execute(
      { path: 'src/a.ts', search: 'const x = 1;', replace: 'const x = 42;' },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(tmp, 'src/a.ts'), 'utf-8')).toBe(
      'const x = 42;\nconst y = 2;\n',
    );
  });

  it('errors on no match, file unchanged', async () => {
    const file = writeFile('src/a.ts', 'const x = 1;\n');
    const before = fs.readFileSync(file, 'utf-8');
    const result = await fileEditTool.execute(
      { path: 'src/a.ts', search: 'MISSING', replace: 'X' },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/did not match/);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('errors on ambiguous match, file unchanged', async () => {
    const file = writeFile('src/a.ts', 'foo\nfoo\nfoo\n');
    const result = await fileEditTool.execute(
      { path: 'src/a.ts', search: 'foo', replace: 'bar' },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/3 places/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('foo\nfoo\nfoo\n');
  });

  it('preserves dominant CRLF EOL', async () => {
    const file = writeFile('src/a.ts', 'a = 1;\r\nb = 2;\r\n');
    const result = await fileEditTool.execute(
      { path: 'src/a.ts', search: 'b = 2;', replace: 'b = 99;' },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe('a = 1;\r\nb = 99;\r\n');
  });
});

describe('list_dir tool', () => {
  it('lists files and subdirs with trailing slash', async () => {
    writeFile('a.ts', 'x');
    writeFile('b/c.ts', 'y');
    const result = await listDirTool.execute({}, ctx());
    expect(result.isError).toBeFalsy();
    const out = String(result.content);
    expect(out).toContain('a.ts');
    expect(out).toContain('b/');
  });

  it('errors on non-directory path', async () => {
    writeFile('a.ts', 'x');
    const result = await listDirTool.execute({ path: 'a.ts' }, ctx());
    expect(result.isError).toBe(true);
  });

  it('refuses paths outside the workspace', async () => {
    const result = await listDirTool.execute({ path: '..' }, ctx());
    expect(result.isError).toBe(true);
  });
});
