import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyEdits } from '../apply.js';
import type { Edit } from '../parser.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-apply-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(rel: string, content: string) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

describe('applyEdits — SEARCH/REPLACE', () => {
  it('applies a unique-match edit and writes to disk', () => {
    const file = writeFile('src/a.ts', 'const x = 1;\nconst y = 2;\n');
    const edits: Edit[] = [
      { kind: 'edit', filePath: 'src/a.ts', search: 'const x = 1;', replace: 'const x = 42;' },
    ];

    const outcomes = applyEdits(edits, { workspaceRoot: tmp });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('applied');
    expect(outcomes[0].wrote).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('const x = 42;\nconst y = 2;\n');
  });

  it('aborts with aborted-no-match when the SEARCH is not in the file', () => {
    const file = writeFile('src/a.ts', 'const x = 1;\n');
    const before = fs.readFileSync(file, 'utf-8');

    const outcomes = applyEdits(
      [{ kind: 'edit', filePath: 'src/a.ts', search: 'const missing = 0;', replace: 'replacement' }],
      { workspaceRoot: tmp },
    );

    expect(outcomes[0].status).toBe('aborted-no-match');
    expect(outcomes[0].wrote).toBe(false);
    expect(outcomes[0].detail).toContain('did not match');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('aborts with aborted-ambiguous when the SEARCH matches multiple times', () => {
    const file = writeFile('src/a.ts', 'foo\nfoo\nfoo\n');
    const before = fs.readFileSync(file, 'utf-8');

    const outcomes = applyEdits(
      [{ kind: 'edit', filePath: 'src/a.ts', search: 'foo', replace: 'bar' }],
      { workspaceRoot: tmp },
    );

    expect(outcomes[0].status).toBe('aborted-ambiguous');
    expect(outcomes[0].wrote).toBe(false);
    expect(outcomes[0].detail).toContain('3 times');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('aborts with aborted-missing for edit against a file that does not exist', () => {
    const outcomes = applyEdits(
      [{ kind: 'edit', filePath: 'src/ghost.ts', search: 'a', replace: 'b' }],
      { workspaceRoot: tmp },
    );
    expect(outcomes[0].status).toBe('aborted-missing');
    expect(outcomes[0].wrote).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'src/ghost.ts'))).toBe(false);
  });

  it('normalises CRLF ↔ LF for matching but preserves the file\'s dominant EOL on write', () => {
    const crlf = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
    const file = writeFile('src/a.ts', crlf);

    const outcomes = applyEdits(
      [{ kind: 'edit', filePath: 'src/a.ts', search: 'const b = 2;', replace: 'const b = 99;' }],
      { workspaceRoot: tmp },
    );

    expect(outcomes[0].status).toBe('applied');
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe('const a = 1;\r\nconst b = 99;\r\nconst c = 3;\r\n');
    // Preserves CRLF throughout — no stray LF.
    expect(after.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(after)).toBe(false);
  });

  it('refuses paths that escape the workspace root', () => {
    const outcomes = applyEdits(
      [{ kind: 'edit', filePath: '../outside.ts', search: 'a', replace: 'b' }],
      { workspaceRoot: tmp },
    );
    expect(outcomes[0].status).toBe('error');
    expect(outcomes[0].detail).toMatch(/escapes/);
  });
});

describe('applyEdits — CREATE', () => {
  it('creates a new file, including parent directories', () => {
    const outcomes = applyEdits(
      [{ kind: 'create', filePath: 'src/new/file.ts', content: 'export const y = 10;\n' }],
      { workspaceRoot: tmp },
    );

    expect(outcomes[0].status).toBe('applied');
    expect(outcomes[0].wrote).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'src/new/file.ts'), 'utf-8')).toBe('export const y = 10;\n');
  });

  it('aborts with aborted-exists when the file is already on disk', () => {
    const file = writeFile('src/a.ts', 'original');
    const outcomes = applyEdits(
      [{ kind: 'create', filePath: 'src/a.ts', content: 'hijack' }],
      { workspaceRoot: tmp },
    );
    expect(outcomes[0].status).toBe('aborted-exists');
    expect(outcomes[0].wrote).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('original');
  });
});

describe('applyEdits — multi-edit batches', () => {
  it('applies each block independently and returns one outcome per edit', () => {
    writeFile('src/a.ts', 'alpha\n');
    writeFile('src/b.ts', 'duplicate\nduplicate\n');

    const outcomes = applyEdits(
      [
        { kind: 'edit', filePath: 'src/a.ts', search: 'alpha', replace: 'omega' },
        { kind: 'edit', filePath: 'src/b.ts', search: 'duplicate', replace: 'x' },
        { kind: 'create', filePath: 'src/c.ts', content: 'new' },
      ],
      { workspaceRoot: tmp },
    );

    expect(outcomes.map((o) => o.status)).toEqual(['applied', 'aborted-ambiguous', 'applied']);
    expect(fs.readFileSync(path.join(tmp, 'src/a.ts'), 'utf-8')).toBe('omega\n');
    // b.ts stays untouched because of the ambiguity abort
    expect(fs.readFileSync(path.join(tmp, 'src/b.ts'), 'utf-8')).toBe('duplicate\nduplicate\n');
    expect(fs.readFileSync(path.join(tmp, 'src/c.ts'), 'utf-8')).toBe('new');
  });
});
