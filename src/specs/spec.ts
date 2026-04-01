import * as fs from 'fs';
import * as path from 'path';
import { META_FILE_NAME, PHASE_FILES } from '../constants.js';

export type PhaseType = 'requirements' | 'design' | 'tasks';
export type PhaseStatus = 'pending' | 'generating' | 'pending-approval' | 'approved' | 'stale';

export interface SpecPhase {
  type: PhaseType;
  status: PhaseStatus;
  fileName: string;
}

export interface Spec {
  name: string;
  dirPath: string;
  phases: SpecPhase[];
  createdAt: string;
}

interface PhaseStatuses {
  requirements: PhaseStatus;
  design: PhaseStatus;
  tasks: PhaseStatus;
}

const DEFAULT_STATUSES: PhaseStatuses = {
  requirements: 'pending',
  design: 'pending',
  tasks: 'pending',
};

export function parseMetadata(metaPath: string): PhaseStatuses {
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const data = JSON.parse(raw);
    return { ...DEFAULT_STATUSES, ...data.phases };
  } catch {
    return { ...DEFAULT_STATUSES };
  }
}

export function writeMetadata(metaPath: string, statuses: PhaseStatuses): void {
  const dir = path.dirname(metaPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({ phases: statuses }, null, 2));
}

export function getPhaseStatus(spec: Spec, phaseType: PhaseType): PhaseStatus {
  return spec.phases.find((p) => p.type === phaseType)?.status ?? 'pending';
}

export function setPhaseStatus(spec: Spec, phaseType: PhaseType, status: PhaseStatus): void {
  const phase = spec.phases.find((p) => p.type === phaseType);
  if (phase) phase.status = status;

  const metaPath = path.join(spec.dirPath, META_FILE_NAME);
  const statuses = parseMetadata(metaPath);
  statuses[phaseType] = status;
  writeMetadata(metaPath, statuses);
}

export function buildSpec(name: string, dirPath: string): Spec {
  const metaPath = path.join(dirPath, META_FILE_NAME);
  const statuses = parseMetadata(metaPath);

  const phases: SpecPhase[] = [
    { type: 'requirements', status: statuses.requirements, fileName: PHASE_FILES.requirements },
    { type: 'design', status: statuses.design, fileName: PHASE_FILES.design },
    { type: 'tasks', status: statuses.tasks, fileName: PHASE_FILES.tasks },
  ];

  // If file exists but status is pending, upgrade to pending-approval
  for (const phase of phases) {
    const filePath = path.join(dirPath, phase.fileName);
    if (phase.status === 'pending' && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content.length > 0) {
        phase.status = 'pending-approval';
        statuses[phase.type] = 'pending-approval';
      }
    }
  }

  return { name, dirPath, phases, createdAt: new Date().toISOString() };
}

export const PHASE_ORDER: PhaseType[] = ['requirements', 'design', 'tasks'];

export function markDownstreamStale(spec: Spec, fromPhase: PhaseType): void {
  const fromIndex = PHASE_ORDER.indexOf(fromPhase);
  const metaPath = path.join(spec.dirPath, META_FILE_NAME);
  const statuses = parseMetadata(metaPath);

  for (let i = fromIndex + 1; i < PHASE_ORDER.length; i++) {
    const phaseType = PHASE_ORDER[i];
    if (statuses[phaseType] === 'approved' || statuses[phaseType] === 'pending-approval') {
      statuses[phaseType] = 'stale';
    }
  }
  writeMetadata(metaPath, statuses);

  // Update in-memory spec
  for (const phase of spec.phases) {
    const idx = PHASE_ORDER.indexOf(phase.type);
    if (idx > fromIndex && (phase.status === 'approved' || phase.status === 'pending-approval')) {
      phase.status = 'stale';
    }
  }
}

export function getNextPhase(spec: Spec): PhaseType | null {
  for (const phase of spec.phases) {
    if (phase.status !== 'approved') return phase.type;
  }
  return null;
}

export function getPhaseLabel(type: PhaseType): string {
  switch (type) {
    case 'requirements': return 'Requirements';
    case 'design': return 'Design';
    case 'tasks': return 'Tasks';
  }
}

export function isPhaseUnlocked(spec: Spec, phaseType: PhaseType): boolean {
  const phaseIndex = PHASE_ORDER.indexOf(phaseType);
  if (phaseIndex === 0) return true;
  const prevPhase = spec.phases[phaseIndex - 1];
  return prevPhase.status === 'approved';
}

export function findSpecForFile(filePath: string, specsRoot: string): { specName: string; phaseType: PhaseType } | null {
  const relative = path.relative(specsRoot, filePath);
  const parts = relative.split(path.sep);
  if (parts.length < 2) return null;
  const specName = parts[0];
  const fileName = parts[parts.length - 1];
  for (const [type, file] of Object.entries(PHASE_FILES)) {
    if (fileName === file) return { specName, phaseType: type as PhaseType };
  }
  return null;
}
