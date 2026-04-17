import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { META_FILE_NAME, PHASE_FILES } from '../../constants.js';
import {
  buildSpec,
  getNextPhase,
  getPhaseStatus,
  isPhaseUnlocked,
  markDownstreamStale,
  parseMetadata,
  setPhaseStatus,
  writeMetadata,
  findSpecForFile,
} from '../spec.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-spec-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseMetadata', () => {
  it('returns defaults when file does not exist', () => {
    const result = parseMetadata(path.join(tmpDir, 'missing.json'));
    expect(result).toEqual({ requirements: 'pending', design: 'pending', tasks: 'pending' });
  });

  it('returns defaults when file contains invalid JSON', () => {
    const metaPath = path.join(tmpDir, META_FILE_NAME);
    fs.writeFileSync(metaPath, '{not json');
    const result = parseMetadata(metaPath);
    expect(result).toEqual({ requirements: 'pending', design: 'pending', tasks: 'pending' });
  });

  it('merges persisted phases over defaults', () => {
    const metaPath = path.join(tmpDir, META_FILE_NAME);
    fs.writeFileSync(metaPath, JSON.stringify({ phases: { requirements: 'approved' } }));
    const result = parseMetadata(metaPath);
    expect(result).toEqual({ requirements: 'approved', design: 'pending', tasks: 'pending' });
  });
});

describe('writeMetadata', () => {
  it('creates the target directory if missing', () => {
    const metaPath = path.join(tmpDir, 'nested', 'dir', META_FILE_NAME);
    writeMetadata(metaPath, { requirements: 'approved', design: 'pending', tasks: 'pending' });
    expect(fs.existsSync(metaPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(saved.phases.requirements).toBe('approved');
  });
});

describe('buildSpec', () => {
  it('uses pending statuses when no files exist', () => {
    const spec = buildSpec('feature-a', tmpDir);
    expect(spec.name).toBe('feature-a');
    expect(spec.phases.map((p) => p.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('upgrades pending phases to pending-approval when the file has content', () => {
    fs.writeFileSync(path.join(tmpDir, PHASE_FILES.requirements), '# Spec content');
    const spec = buildSpec('feature-a', tmpDir);
    expect(getPhaseStatus(spec, 'requirements')).toBe('pending-approval');
  });

  it('keeps pending when the phase file is empty', () => {
    fs.writeFileSync(path.join(tmpDir, PHASE_FILES.requirements), '   \n  ');
    const spec = buildSpec('feature-a', tmpDir);
    expect(getPhaseStatus(spec, 'requirements')).toBe('pending');
  });

  it('respects approved statuses persisted in metadata', () => {
    writeMetadata(path.join(tmpDir, META_FILE_NAME), {
      requirements: 'approved',
      design: 'pending',
      tasks: 'pending',
    });
    const spec = buildSpec('feature-a', tmpDir);
    expect(getPhaseStatus(spec, 'requirements')).toBe('approved');
  });
});

describe('setPhaseStatus', () => {
  it('updates both the in-memory spec and the metadata file', () => {
    const spec = buildSpec('feature-a', tmpDir);
    setPhaseStatus(spec, 'requirements', 'approved');
    expect(getPhaseStatus(spec, 'requirements')).toBe('approved');
    const persisted = parseMetadata(path.join(tmpDir, META_FILE_NAME));
    expect(persisted.requirements).toBe('approved');
  });
});

describe('markDownstreamStale', () => {
  it('marks approved downstream phases as stale', () => {
    writeMetadata(path.join(tmpDir, META_FILE_NAME), {
      requirements: 'approved',
      design: 'approved',
      tasks: 'approved',
    });
    const spec = buildSpec('feature-a', tmpDir);
    markDownstreamStale(spec, 'requirements');
    expect(getPhaseStatus(spec, 'design')).toBe('stale');
    expect(getPhaseStatus(spec, 'tasks')).toBe('stale');
    expect(getPhaseStatus(spec, 'requirements')).toBe('approved');
  });

  it('does not touch pending downstream phases', () => {
    writeMetadata(path.join(tmpDir, META_FILE_NAME), {
      requirements: 'approved',
      design: 'pending',
      tasks: 'pending',
    });
    const spec = buildSpec('feature-a', tmpDir);
    markDownstreamStale(spec, 'requirements');
    expect(getPhaseStatus(spec, 'design')).toBe('pending');
  });
});

describe('getNextPhase', () => {
  it('returns the first non-approved phase', () => {
    writeMetadata(path.join(tmpDir, META_FILE_NAME), {
      requirements: 'approved',
      design: 'pending',
      tasks: 'pending',
    });
    const spec = buildSpec('feature-a', tmpDir);
    expect(getNextPhase(spec)).toBe('design');
  });

  it('returns null when all phases are approved', () => {
    writeMetadata(path.join(tmpDir, META_FILE_NAME), {
      requirements: 'approved',
      design: 'approved',
      tasks: 'approved',
    });
    const spec = buildSpec('feature-a', tmpDir);
    expect(getNextPhase(spec)).toBeNull();
  });
});

describe('isPhaseUnlocked', () => {
  it('always unlocks the first phase', () => {
    const spec = buildSpec('feature-a', tmpDir);
    expect(isPhaseUnlocked(spec, 'requirements')).toBe(true);
  });

  it('unlocks downstream phase only when the previous is approved', () => {
    writeMetadata(path.join(tmpDir, META_FILE_NAME), {
      requirements: 'pending-approval',
      design: 'pending',
      tasks: 'pending',
    });
    let spec = buildSpec('feature-a', tmpDir);
    expect(isPhaseUnlocked(spec, 'design')).toBe(false);

    setPhaseStatus(spec, 'requirements', 'approved');
    spec = buildSpec('feature-a', tmpDir);
    expect(isPhaseUnlocked(spec, 'design')).toBe(true);
  });
});

describe('findSpecForFile', () => {
  it('resolves the spec name and phase type for a known phase file', () => {
    const specsRoot = path.join(tmpDir, 'specs');
    const filePath = path.join(specsRoot, 'feature-a', PHASE_FILES.design);
    const result = findSpecForFile(filePath, specsRoot);
    expect(result).toEqual({ specName: 'feature-a', phaseType: 'design' });
  });

  it('returns null for files outside the specs root', () => {
    const specsRoot = path.join(tmpDir, 'specs');
    const filePath = path.join(tmpDir, 'unrelated.md');
    expect(findSpecForFile(filePath, specsRoot)).toBeNull();
  });

  it('returns null for unknown phase files', () => {
    const specsRoot = path.join(tmpDir, 'specs');
    const filePath = path.join(specsRoot, 'feature-a', 'notes.md');
    expect(findSpecForFile(filePath, specsRoot)).toBeNull();
  });
});
