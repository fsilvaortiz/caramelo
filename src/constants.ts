import * as path from 'path';
import * as os from 'os';

export const EXTENSION_ID = 'caramelo';

export const VIEW_IDS = {
  providers: 'caramelo.providers',
  workflow: 'caramelo.workflow',
} as const;

export const COMMAND_IDS = {
  newSpec: 'caramelo.newSpec',
  selectProvider: 'caramelo.selectProvider',
  startTask: 'caramelo.startTask',
  runPhase: 'caramelo.runPhase',
  approvePhase: 'caramelo.approvePhase',
  regeneratePhase: 'caramelo.regeneratePhase',
  editConstitution: 'caramelo.editConstitution',
  syncTemplates: 'caramelo.syncTemplates',
  viewChanges: 'caramelo.viewChanges',
  previewSpec: 'caramelo.previewSpec',
} as const;

export const SETTINGS_KEYS = {
  providers: 'caramelo.providers',
  activeProvider: 'caramelo.activeProvider',
} as const;

export const CACHE_DIR = path.join(os.homedir(), '.caramelo', 'spec-kit');
export const TEMPLATES_CACHE_DIR = path.join(CACHE_DIR, 'templates');
export const VERSION_FILE = path.join(CACHE_DIR, 'version.json');

export const SPEC_KIT_API_URL = 'https://api.github.com/repos/github/spec-kit/releases/latest';

export const SPECS_DIR_NAME = 'specs';
export const META_FILE_NAME = '.caramelo-meta.json';

export const PHASE_FILES: Record<string, string> = {
  requirements: 'spec.md',
  design: 'plan.md',
  tasks: 'tasks.md',
};

export type ProviderType = 'openai-compatible' | 'anthropic' | 'copilot' | 'jira';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  endpoint: string;
  model: string;
  // Jira-specific fields
  instanceUrl?: string;
  boardId?: string;
  boardName?: string;
  email?: string;
}
