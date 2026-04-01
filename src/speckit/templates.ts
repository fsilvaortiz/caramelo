import * as fs from 'fs';
import * as path from 'path';
import { TEMPLATES_CACHE_DIR } from '../constants.js';

// Bundled fallback templates (embedded via esbuild text loader)
import specTemplate from '../../resources/fallback-templates/spec-template.md';
import planTemplate from '../../resources/fallback-templates/plan-template.md';
import tasksTemplate from '../../resources/fallback-templates/tasks-template.md';

const FALLBACKS: Record<string, string> = {
  spec: specTemplate,
  plan: planTemplate,
  tasks: tasksTemplate,
};

const TEMPLATE_FILES: Record<string, string> = {
  spec: 'spec-template.md',
  plan: 'plan-template.md',
  tasks: 'tasks-template.md',
};

export class TemplateManager {
  private cache = new Map<string, string>();

  getTemplate(phase: 'spec' | 'plan' | 'tasks'): string {
    const cached = this.cache.get(phase);
    if (cached) return cached;

    // Try cache directory first
    const cachePath = path.join(TEMPLATES_CACHE_DIR, TEMPLATE_FILES[phase]);
    if (fs.existsSync(cachePath)) {
      const content = fs.readFileSync(cachePath, 'utf-8');
      this.cache.set(phase, content);
      return content;
    }

    // Fall back to bundled
    const fallback = FALLBACKS[phase];
    if (fallback) {
      this.cache.set(phase, fallback);
      return fallback;
    }

    throw new Error(`Template not found for phase: ${phase}`);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
