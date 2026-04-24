import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildTaskContext, extractReferencedPaths } from '../context.js';

let tmp: string;
let specDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-ctx-'));
  specDir = path.join(tmp, 'specs', 'feature-a');
  fs.mkdirSync(specDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeWs(rel: string, content: string) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

describe('extractReferencedPaths', () => {
  it('finds paths wrapped in backticks', () => {
    const text = 'Update `src/foo.ts` and maybe `lib/bar.tsx`.';
    expect(extractReferencedPaths(text).sort()).toEqual(['lib/bar.tsx', 'src/foo.ts']);
  });

  it('finds bare paths with known extensions', () => {
    const text = 'Touch src/baz.ts and package.json, skip example.txt only once.';
    const result = extractReferencedPaths(text);
    expect(result).toContain('src/baz.ts');
    expect(result).toContain('package.json');
    expect(result).toContain('example.txt');
  });

  it('ignores random tokens that are not file-like', () => {
    expect(extractReferencedPaths('Hello world, nothing here.')).toEqual([]);
  });

  it('deduplicates when the same path appears more than once', () => {
    const text = '`src/foo.ts` again and bare src/foo.ts.';
    expect(extractReferencedPaths(text)).toEqual(['src/foo.ts']);
  });
});

describe('buildTaskContext', () => {
  it('includes spec docs first', () => {
    writeWs('specs/feature-a/spec.md', '# Spec body');
    writeWs('specs/feature-a/plan.md', '# Plan body');

    const ctx = buildTaskContext({ specDir, workspaceRoot: tmp, taskText: 'do the thing' });
    expect(ctx.text).toContain('--- SPEC: specs/feature-a/spec.md ---');
    expect(ctx.text).toContain('# Spec body');
    expect(ctx.includedFiles).toEqual([
      'specs/feature-a/spec.md',
      'specs/feature-a/plan.md',
    ]);
  });

  it('attaches current content of files referenced by the task', () => {
    writeWs('specs/feature-a/spec.md', 'See `src/foo.ts`.');
    writeWs('src/foo.ts', 'export const foo = 1;\n');

    const ctx = buildTaskContext({
      specDir,
      workspaceRoot: tmp,
      taskText: 'Update src/foo.ts to export 2',
    });

    expect(ctx.text).toContain('--- EXISTING FILE: src/foo.ts ---');
    expect(ctx.text).toContain('export const foo = 1;');
    expect(ctx.includedFiles).toContain('src/foo.ts');
  });

  it('truncates files larger than maxFileBytes with a marker', () => {
    const big = 'x'.repeat(200);
    writeWs('specs/feature-a/spec.md', `See \`src/big.ts\`.`);
    writeWs('src/big.ts', big);

    const ctx = buildTaskContext({
      specDir,
      workspaceRoot: tmp,
      taskText: 'touch src/big.ts',
      options: { maxFileBytes: 50 },
    });

    expect(ctx.text).toContain('[…truncated, original was 200 bytes]');
  });

  it('stops including candidates once the total budget is exhausted', () => {
    writeWs('specs/feature-a/spec.md', 'refs: `src/a.ts` `src/b.ts`');
    writeWs('src/a.ts', 'A'.repeat(400));
    writeWs('src/b.ts', 'B'.repeat(400));

    const ctx = buildTaskContext({
      specDir,
      workspaceRoot: tmp,
      taskText: 'edit `src/a.ts` and `src/b.ts`',
      // spec + one code file fits, second one should be skipped
      options: { maxFileBytes: 500, maxTotalBytes: 700 },
    });

    expect(ctx.skippedFiles.length).toBeGreaterThan(0);
    const combined = ctx.includedFiles.concat(ctx.skippedFiles);
    expect(combined).toContain('src/a.ts');
    expect(combined).toContain('src/b.ts');
  });

  it('refuses to include paths that resolve outside the workspace root', () => {
    writeWs('specs/feature-a/spec.md', 'See `../escape/secret.ts`.');
    // Create the file *outside* the workspace so we can tell if it leaked in.
    const outside = path.join(os.tmpdir(), 'caramelo-escape-' + Date.now() + '.ts');
    fs.writeFileSync(outside, 'SECRETS', 'utf-8');
    try {
      const ctx = buildTaskContext({ specDir, workspaceRoot: tmp, taskText: '' });
      expect(ctx.text).not.toContain('SECRETS');
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it('silently skips candidates that do not exist on disk', () => {
    writeWs('specs/feature-a/spec.md', 'Refers to `src/ghost.ts`.');
    const ctx = buildTaskContext({ specDir, workspaceRoot: tmp, taskText: '' });
    expect(ctx.includedFiles).not.toContain('src/ghost.ts');
  });

  it('suffix-matches candidates against existing workspace files', () => {
    // Task mentions src/main/.../Foo.java but the real file lives at a
    // module prefix — simulates a monorepo / Gradle multi-module layout.
    writeWs('some-module/src/main/java/Foo.java', 'class Foo {}');
    writeWs('specs/feature-a/spec.md', '# spec');
    const ctx = buildTaskContext({
      specDir,
      workspaceRoot: tmp,
      taskText: 'Edit `src/main/java/Foo.java` to rename Foo.',
    });
    expect(ctx.text).toContain('--- EXISTING FILE: some-module/src/main/java/Foo.java ---');
    expect(ctx.includedFiles).toContain('some-module/src/main/java/Foo.java');
  });

  it('prefers literal match over suffix match when both exist', () => {
    writeWs('src/foo.ts', 'literal');
    writeWs('packages/pkg/src/foo.ts', 'suffix');
    writeWs('specs/feature-a/spec.md', '# spec');
    const ctx = buildTaskContext({
      specDir,
      workspaceRoot: tmp,
      taskText: 'Edit `src/foo.ts`',
    });
    expect(ctx.includedFiles).toContain('src/foo.ts');
    // We don't aggressively expand to unrelated suffix matches when the
    // literal path exists; only one file gets attached for that candidate.
    expect(ctx.includedFiles).not.toContain('packages/pkg/src/foo.ts');
  });
});
