import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSafetyStash } from '../git-safety.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-git-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(args: string[]) {
  execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
}

function initRepo() {
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'caramelo-test@example.com']);
  git(['config', 'user.name', 'Caramelo Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(tmp, 'seed.txt'), 'seed', 'utf-8');
  git(['add', '.']);
  git(['commit', '-m', 'seed']);
}

describe('createSafetyStash', () => {
  it('reports no-git when the directory is not a repository', async () => {
    const result = await createSafetyStash(tmp);
    expect(result.kind).toBe('no-git');
  });

  it('reports clean when the working tree has no changes', async () => {
    initRepo();
    const result = await createSafetyStash(tmp);
    expect(result.kind).toBe('clean');
    expect(result.stashName).toBeUndefined();
  });

  it('creates a stash and returns its label when the tree is dirty', async () => {
    initRepo();
    fs.writeFileSync(path.join(tmp, 'seed.txt'), 'dirty', 'utf-8');
    fs.writeFileSync(path.join(tmp, 'extra.txt'), 'untracked', 'utf-8');

    const result = await createSafetyStash(tmp, new Date('2026-04-18T10:00:00Z'));

    expect(result.kind).toBe('stashed');
    expect(result.stashName).toMatch(/^caramelo-pre-task-/);

    const stashes = execFileSync('git', ['stash', 'list'], { cwd: tmp }).toString();
    expect(stashes).toContain(result.stashName!);

    // Stash should have restored the working tree to clean.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: tmp }).toString();
    expect(status.trim()).toBe('');
  });
});
