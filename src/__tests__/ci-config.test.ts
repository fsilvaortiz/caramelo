import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

const root = path.resolve(__dirname, '..', '..');

describe('CI configuration', () => {
  it('smoke floor job tests the engines.vscode minimum', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const floor = String(pkg.engines.vscode).replace(/^[\^~>=\s]+/, '');

    const ci = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf-8'));
    const include: Array<{ vscode?: string }> = ci.jobs.smoke.strategy.matrix.include ?? [];
    const floorVersions = include.map((e) => e.vscode).filter((v): v is string => !!v && v !== 'stable');

    expect(floorVersions).toEqual([floor]);
  });

  it('release publishes the packaged .vsix only with VSCE_PAT, from main, with a pinned vsce', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies['@vscode/vsce'], 'vsce must be a pinned devDependency, not fetched by npx').toBeDefined();

    const release = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf-8'));
    const job = release.jobs.package;
    const steps: Array<{ name?: string; run?: string; if?: string; with?: Record<string, unknown> }> = job.steps;
    expect(steps[0].with?.['fetch-depth']).toBe(0);
    expect(steps.some((s) => s.run?.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main'))).toBe(true);

    const pkgStep = steps.find((s) => s.run?.includes('vsce package'))!;
    const publish = steps.find((s) => s.run?.includes('vsce publish'))!;
    expect(pkgStep.run).toContain('--out "$VSIX_NAME"');
    expect(publish.run).toContain('--packagePath "$VSIX_NAME"');
    expect(publish.run).toContain('--skip-duplicate');
    expect(publish.if).toBe("env.VSCE_PAT != ''");
    expect(job.env.VSCE_PAT).toBe('${{ secrets.VSCE_PAT }}');
    expect(steps.indexOf(publish)).toBeGreaterThan(steps.indexOf(pkgStep));
  });
});
