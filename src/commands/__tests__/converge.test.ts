import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendConvergencePhase,
  buildConvergeUserPrompt,
  collectReferencedFiles,
  formatFindingsTable,
  orderFindings,
  parseConvergeFindings,
  taskNumbering,
  CONVERGE_SYSTEM_PROMPT,
  type ConvergeFinding,
} from '../converge-core.js';

const f = (over: Partial<ConvergeFinding> & Pick<ConvergeFinding, 'task'>): ConvergeFinding => ({
  gapType: 'missing', severity: 'HIGH', sourceRef: 'FR-001', evidence: 'src/a.ts', ...over,
});

const TASKS = `# Tasks: Login

## Phase 1: Setup

- [x] T001 Create project structure
- [ ] T002 [P] Configure linting

## Phase 2: User Story 1

- [ ] T003 [US1] Implement login form in src/login.ts
- [X] T010 [US1] Add session store
`;

describe('parseConvergeFindings', () => {
  it('reads the fenced JSON object and normalises casing/whitespace', () => {
    const raw = 'Here you go:\n```json\n{"findings":[{"gapType":"Partial","severity":"high","sourceRef":" FR-003 ","evidence":"src/x.ts","task":"Validate   email\\n format"}]}\n```\nDone.';
    expect(parseConvergeFindings(raw)).toEqual([
      { gapType: 'partial', severity: 'HIGH', sourceRef: 'FR-003', evidence: 'src/x.ts', task: 'Validate email format' },
    ]);
  });

  it('accepts an unfenced object and an empty findings list (converged)', () => {
    expect(parseConvergeFindings('{"findings": []}')).toEqual([]);
    expect(parseConvergeFindings('result {"findings":[]} end')).toEqual([]);
  });

  it('drops entries with unknown gap types, severities or no task; defaults a missing sourceRef', () => {
    const raw = JSON.stringify({ findings: [
      { gapType: 'nope', severity: 'HIGH', task: 'x' },
      { gapType: 'missing', severity: 'URGENT', task: 'x' },
      { gapType: 'missing', severity: 'LOW', task: '  ' },
      { gapType: 'unrequested', severity: 'LOW', task: 'Review the debug endpoint' },
      'not an object',
    ] });
    expect(parseConvergeFindings(raw)).toEqual([
      { gapType: 'unrequested', severity: 'LOW', sourceRef: 'unspecified', evidence: '', task: 'Review the debug endpoint' },
    ]);
  });

  it('returns null (do not write) for prose, malformed JSON, or the wrong shape', () => {
    expect(parseConvergeFindings('- [ ] some markdown task')).toBeNull();
    expect(parseConvergeFindings('```json\n{"findings": [\n```')).toBeNull();
    expect(parseConvergeFindings('{"tasks": []}')).toBeNull();
    expect(parseConvergeFindings('')).toBeNull();
  });
});

describe('orderFindings', () => {
  it('puts constitution findings first, then CRITICAL → LOW, stable within a level', () => {
    const ordered = orderFindings([
      f({ task: 'low', severity: 'LOW' }),
      f({ task: 'high-1' }),
      f({ task: 'const', severity: 'HIGH', sourceRef: 'Constitution II', gapType: 'contradicts' }),
      f({ task: 'crit', severity: 'CRITICAL' }),
      f({ task: 'high-2' }),
    ]);
    expect(ordered.map((x) => x.task)).toEqual(['const', 'crit', 'high-1', 'high-2', 'low']);
  });
});

describe('taskNumbering', () => {
  it('finds the highest task id (checked or not) and phase number', () => {
    expect(taskNumbering(TASKS)).toEqual({ maxTaskId: 10, maxPhase: 2 });
  });

  it('ignores ids outside checklist items and handles an empty file', () => {
    expect(taskNumbering('See T999 in prose.\n- [ ] T004 real\n')).toEqual({ maxTaskId: 4, maxPhase: 0 });
    expect(taskNumbering('')).toEqual({ maxTaskId: 0, maxPhase: 0 });
  });
});

describe('appendConvergencePhase', () => {
  it('leaves tasks.md byte-for-byte unchanged when there are no findings', () => {
    expect(appendConvergencePhase(TASKS, [])).toBe(TASKS);
  });

  it('appends "## Phase N: Convergence" with continuing zero-padded ids, per <source> (<gap>)', () => {
    const out = appendConvergencePhase(TASKS, [
      f({ task: 'Add rate limiting to login', sourceRef: 'FR-004', gapType: 'missing', severity: 'HIGH' }),
      f({ task: 'Encrypt the session cookie', sourceRef: 'Constitution I', gapType: 'contradicts', severity: 'CRITICAL' }),
    ]);
    expect(out.startsWith(TASKS)).toBe(true);
    expect(out.slice(TASKS.length)).toBe(
      '\n## Phase 3: Convergence\n\n' +
      '- [ ] T011 CRITICAL: Encrypt the session cookie per Constitution I (contradicts)\n' +
      '- [ ] T012 Add rate limiting to login per FR-004 (missing)\n',
    );
  });

  it('a second run adds a new phase below the previous Convergence phase without touching it', () => {
    const first = appendConvergencePhase(TASKS, [f({ task: 'One' })]);
    const second = appendConvergencePhase(first, [f({ task: 'Two' })]);
    expect(second.startsWith(first)).toBe(true);
    expect(second).toContain('## Phase 3: Convergence\n\n- [ ] T011 One per FR-001 (missing)');
    expect(second).toContain('## Phase 4: Convergence\n\n- [ ] T012 Two per FR-001 (missing)');
  });

  it('works on a tasks.md without ids or phases and without a trailing newline', () => {
    const base = '# Tasks\n\n- [ ] Existing';
    const out = appendConvergencePhase(base, [f({ task: 'New' })]);
    expect(out).toBe('# Tasks\n\n- [ ] Existing\n\n## Phase 1: Convergence\n\n- [ ] T001 New per FR-001 (missing)\n');
  });
});

describe('prompts', () => {
  it('system prompt forbids writes and asks for the JSON findings contract', () => {
    expect(CONVERGE_SYSTEM_PROMPT).toMatch(/Do NOT modify any file/);
    expect(CONVERGE_SYSTEM_PROMPT).toMatch(/completion claims are not evidence/);
    expect(CONVERGE_SYSTEM_PROMPT).toContain('{"findings": []}');
  });

  it('user prompt includes artifacts, skips a template constitution, and inlines code when tools are unavailable', () => {
    const withTools = buildConvergeUserPrompt({ specMd: 'S', planMd: 'P', tasksMd: 'T', constitutionMd: '# [PRINCIPLE_1_NAME]' }, true);
    expect(withTools).toContain('Inspect the codebase with your tools');
    expect(withTools).toContain('--- SPEC: spec.md ---\nS');
    expect(withTools).not.toContain('CONSTITUTION');

    const noTools = buildConvergeUserPrompt(
      { specMd: 'S', planMd: 'P', tasksMd: 'T', constitutionMd: '# Real', referencedFiles: [{ path: 'src/a.ts', content: 'code' }] },
      false,
    );
    expect(noTools).toContain('You cannot browse the workspace');
    expect(noTools).toContain('--- CONSTITUTION ---\n# Real');
    expect(noTools).toContain('--- CODE: src/a.ts ---\ncode');
  });

  it('findings table escapes pipes', () => {
    expect(formatFindingsTable([f({ task: 'a | b' })])).toContain('| F1 | missing | HIGH | FR-001 | src/a.ts | a \\| b |');
  });
});

describe('collectReferencedFiles', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-conv-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'specs', 'f'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'login.ts'), 'export const login = 1;');
    fs.writeFileSync(path.join(root, 'specs', 'f', 'plan.md'), 'plan');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('includes existing files the artifacts name, once, skipping missing, spec artifacts and paths outside the root', () => {
    const text = 'Edit `src/login.ts` and src/login.ts, create src/new.ts, see specs/f/plan.md and ../../etc/passwd.';
    expect(collectReferencedFiles(root, [text])).toEqual([{ path: 'src/login.ts', content: 'export const login = 1;' }]);
  });
});
