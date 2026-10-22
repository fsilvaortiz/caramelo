import * as fs from 'fs';
import * as path from 'path';
import { isObject } from '../utils/safe-json.js';

/**
 * Pure parts of `/speckit.converge`, following the Spec Kit v1.2.2 command
 * template (templates/commands/converge.md): the model assesses the code and
 * reports findings; Caramelo — not the model — appends them to tasks.md as
 * `## Phase N: Convergence` with continuing task IDs, so existing content can
 * never be rewritten.
 */

export const GAP_TYPES = ['missing', 'partial', 'contradicts', 'unrequested'] as const;
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type GapType = (typeof GAP_TYPES)[number];
export type Severity = (typeof SEVERITIES)[number];

export interface ConvergeFinding {
  gapType: GapType;
  severity: Severity;
  /** What the gap traces to: `FR-003`, `US1/AC2`, `plan: storage decision`, `Constitution II`. */
  sourceRef: string;
  /** File/area observed. */
  evidence: string;
  /** Imperative description of the remaining work. */
  task: string;
}

export const CONVERGE_SYSTEM_PROMPT = `You are Caramelo executing Spec Kit's /speckit.converge for one feature.

Goal: close the gap between what spec.md, plan.md and tasks.md call for and what the codebase currently implements. Those three artifacts are the sole source of intent; the constitution (if provided) is a non-negotiable constraint.

Rules:
- Assess the PRESENT state of the code. Not a diff tool: no git, no history.
- Include every existing task regardless of its checkbox — completion claims are not evidence. Verify behaviour in the code.
- Bound the assessment to the files and concepts the artifacts name; do not infer scope beyond them.
- Do NOT modify any file. You only report findings; Caramelo appends the tasks.
- Little or no code yet → report the specified scope as \`missing\`.

For each requirement (FR-###, buildable SC-###, user-story acceptance scenarios like US1/AC2, edge cases), plan decision and constitution MUST principle, report a finding only where there is a gap:
- gapType: "missing" (absent), "partial" (exists, not fully satisfying), "contradicts" (conflicts with intent or a constitution MUST), "unrequested" (work not called for — converge never deletes code, it only adds a task to review/justify or remove it)
- severity: "CRITICAL" (violates a constitution MUST, or a missing/contradicts gap blocking a P1 story), "HIGH" (missing/partial on a core requirement or acceptance criterion), "MEDIUM" (partial on a secondary requirement, or unrequested with unclear justification), "LOW" (polish, low-risk unrequested)
- sourceRef: what it traces to, e.g. "FR-003", "SC-002", "US1/AC2", "plan: storage decision", "Constitution II"
- evidence: the file/area you observed
- task: one imperative sentence describing the remaining work

Final answer: ONLY a JSON object in a \`\`\`json fence, nothing else:
{"findings": [{"gapType": "...", "severity": "...", "sourceRef": "...", "evidence": "...", "task": "..."}]}
If the implementation satisfies everything, answer {"findings": []}.`;

export interface ConvergeInputs {
  specMd: string;
  planMd: string;
  tasksMd: string;
  constitutionMd?: string;
  /** Contents of files referenced by plan/tasks, for providers without tool calling. */
  referencedFiles?: ReadonlyArray<{ path: string; content: string }>;
}

export function buildConvergeUserPrompt(inputs: ConvergeInputs, canUseTools: boolean): string {
  const parts = [
    canUseTools
      ? 'Inspect the codebase with your tools (file_read, grep, glob, list_dir) and report the findings.'
      : 'You cannot browse the workspace. Assess using the file contents included below; where a file the artifacts require is not included, treat it as missing only if nothing below implements it.',
    `--- SPEC: spec.md ---\n${inputs.specMd}`,
    `--- PLAN: plan.md ---\n${inputs.planMd}`,
    `--- TASKS: tasks.md ---\n${inputs.tasksMd}`,
  ];
  if (inputs.constitutionMd && !inputs.constitutionMd.includes('[PRINCIPLE_1_NAME]')) {
    parts.push(`--- CONSTITUTION ---\n${inputs.constitutionMd}`);
  }
  for (const f of inputs.referencedFiles ?? []) {
    parts.push(`--- CODE: ${f.path} ---\n${f.content}`);
  }
  return parts.join('\n\n');
}

/** Extract the findings JSON. Returns null when the answer is not a valid findings object. */
export function parseConvergeFindings(raw: string): ConvergeFinding[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [fenced?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)];
  for (const text of candidates) {
    if (!text || !text.trim()) continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObject(data) || !Array.isArray(data.findings)) continue;
    const out: ConvergeFinding[] = [];
    for (const f of data.findings) {
      if (!isObject(f)) continue;
      const gapType = String(f.gapType ?? '').toLowerCase() as GapType;
      const severity = String(f.severity ?? '').toUpperCase() as Severity;
      const task = typeof f.task === 'string' ? f.task.replace(/\s+/g, ' ').trim() : '';
      if (!GAP_TYPES.includes(gapType) || !SEVERITIES.includes(severity) || !task) continue;
      out.push({
        gapType,
        severity,
        sourceRef: typeof f.sourceRef === 'string' && f.sourceRef.trim() ? f.sourceRef.replace(/\s+/g, ' ').trim() : 'unspecified',
        evidence: typeof f.evidence === 'string' ? f.evidence.replace(/\s+/g, ' ').trim() : '',
        task,
      });
    }
    return out;
  }
  return null;
}

/** Constitution findings first, then CRITICAL → LOW, keeping the model's order within a level. */
export function orderFindings(findings: readonly ConvergeFinding[]): ConvergeFinding[] {
  const rank = (f: ConvergeFinding) =>
    (/^constitution\b/i.test(f.sourceRef) ? 0 : 1) * 10 + SEVERITIES.indexOf(f.severity);
  return findings.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(({ f }) => f);
}

/** Highest existing task number (`T042` → 42) and phase number in tasks.md. */
export function taskNumbering(tasksMd: string): { maxTaskId: number; maxPhase: number } {
  let maxTaskId = 0;
  for (const m of tasksMd.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+T(\d+)\b/gm)) maxTaskId = Math.max(maxTaskId, Number(m[1]));
  let maxPhase = 0;
  for (const m of tasksMd.matchAll(/^#{1,6}\s+Phase\s+(\d+)\b/gim)) maxPhase = Math.max(maxPhase, Number(m[1]));
  return { maxTaskId, maxPhase };
}

/**
 * Append `## Phase N: Convergence` with one task per finding. The original
 * text is always a byte-for-byte prefix of the result; with no findings the
 * input is returned unchanged.
 */
export function appendConvergencePhase(tasksMd: string, findings: readonly ConvergeFinding[]): string {
  if (findings.length === 0) return tasksMd;
  const { maxTaskId, maxPhase } = taskNumbering(tasksMd);
  const lines = orderFindings(findings).map((f, i) => {
    const id = `T${String(maxTaskId + i + 1).padStart(3, '0')}`;
    const label = f.severity === 'CRITICAL' ? 'CRITICAL: ' : '';
    return `- [ ] ${id} ${label}${f.task} per ${f.sourceRef} (${f.gapType})`;
  });
  const base = tasksMd.endsWith('\n') ? tasksMd : `${tasksMd}\n`;
  return `${base}\n## Phase ${maxPhase + 1}: Convergence\n\n${lines.join('\n')}\n`;
}

export function formatFindingsTable(findings: readonly ConvergeFinding[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const rows = orderFindings(findings).map((f, i) =>
    `| F${i + 1} | ${f.gapType} | ${f.severity} | ${cell(f.sourceRef)} | ${cell(f.evidence)} | ${cell(f.task)} |`);
  return ['| ID | Gap Type | Severity | Source | Evidence | Remaining Work |', '|----|----------|----------|--------|----------|----------------|', ...rows].join('\n');
}

const MAX_REFERENCED_FILES = 40;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

/**
 * Files named in plan.md / tasks.md that exist in the workspace, with their
 * contents, for providers that cannot browse. Paths stay inside the root.
 */
export function collectReferencedFiles(
  workspaceRoot: string,
  texts: readonly string[],
): Array<{ path: string; content: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const text of texts) {
    for (const m of text.matchAll(/(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'")\],:;])/gm)) {
      const rel = m[1].replace(/^\.\//, '');
      if (seen.has(rel)) continue;
      seen.add(rel);
      const abs = path.resolve(workspaceRoot, rel);
      const back = path.relative(workspaceRoot, abs);
      if (back.startsWith('..') || path.isAbsolute(back)) continue;
      const posix = back.split(path.sep).join('/');
      if (posix.startsWith('specs/') || posix.startsWith('.specify/')) continue;
      let content: string;
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) continue;
        content = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      total += content.length;
      out.push({ path: posix, content });
      if (out.length >= MAX_REFERENCED_FILES) return out;
    }
  }
  return out;
}
