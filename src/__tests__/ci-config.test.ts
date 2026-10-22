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
});
