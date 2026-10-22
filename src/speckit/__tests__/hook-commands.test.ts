import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveHookCommand,
  parseFrontmatter,
  rewriteExtensionPaths,
  rewriteProjectRelativePaths,
  resolveCommandRefs,
  selectScriptVariant,
  renderExtensionCommand,
  HookCommandNotFoundError,
  HookCommandRenderError,
} from '../hook-commands.js';

let root: string;
const write = (rel: string, body = '') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-hookcmd-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const BUG_MANIFEST = `
extension:
  id: bug
provides:
  commands:
    - name: speckit.bug.assess
      file: commands/speckit.bug.assess.md
      aliases: [speckit.bug.triage]
    - name: speckit.bug.evil
      file: ../../../etc/passwd
`;

describe('resolveHookCommand', () => {
  beforeEach(() => write('.specify/extensions/bug/extension.yml', BUG_MANIFEST));

  it('finds the file via provides.commands name', () => {
    const r = resolveHookCommand(root, 'speckit.bug.assess', 'bug');
    expect(r.extensionId).toBe('bug');
    expect(r.filePath).toBe(path.join(root, '.specify/extensions/bug/commands/speckit.bug.assess.md'));
  });

  it('honours aliases', () => {
    expect(resolveHookCommand(root, 'speckit.bug.triage', 'bug').filePath).toMatch(/speckit\.bug\.assess\.md$/);
  });

  it('searches every installed extension when the hook names none', () => {
    write('.specify/extensions/aaa/extension.yml', 'provides:\n  commands: []\n');
    expect(resolveHookCommand(root, 'speckit.bug.assess').extensionId).toBe('bug');
  });

  it('refuses a manifest file path that escapes the extension directory', () => {
    expect(() => resolveHookCommand(root, 'speckit.bug.evil', 'bug')).toThrow(/escapes the extension directory/);
  });

  it('refuses extension ids that are paths', () => {
    expect(() => resolveHookCommand(root, 'speckit.bug.assess', '../bug')).toThrow(HookCommandNotFoundError);
  });

  it('throws a clear error when the command is not installed', () => {
    expect(() => resolveHookCommand(root, 'speckit.jira.sync', 'jira')).toThrow(/not provided by extension "jira"/);
    expect(() => resolveHookCommand(root, 'speckit.nope.x')).toThrow(/any installed extension/);
  });
});

describe('parseFrontmatter', () => {
  it('splits on a line that is exactly --- (not one inside a value)', () => {
    const { frontmatter, body } = parseFrontmatter('---\ndescription: "a --- b"\nscripts:\n  sh: s.sh\n---\n\nBody\n');
    expect(frontmatter).toEqual({ description: 'a --- b', scripts: { sh: 's.sh' } });
    expect(body).toBe('Body');
  });

  it('returns the content untouched when there is no closing delimiter', () => {
    expect(parseFrontmatter('---\nno end\nbody')).toEqual({ frontmatter: {}, body: '---\nno end\nbody' });
  });

  it('treats invalid or non-mapping YAML as empty frontmatter', () => {
    expect(parseFrontmatter('---\nbad: [\n---\nx').frontmatter).toEqual({});
    expect(parseFrontmatter('---\n- a\n---\nx').frontmatter).toEqual({});
  });
});

describe('path rewriting', () => {
  it('rewrite_extension_paths: only existing subdirs, never commands/specs/dot-dirs', () => {
    for (const d of ['agents', 'commands', 'specs', '.cache']) fs.mkdirSync(path.join(root, d));
    const out = rewriteExtensionPaths('see agents/a.md, ./agents/b.md, commands/c.md, specs/s.md, x.agents/y, /agents/abs', 'bug', root);
    expect(out).toBe('see .specify/extensions/bug/agents/a.md, .specify/extensions/bug/agents/b.md, commands/c.md, specs/s.md, x.agents/y, /agents/abs');
  });

  it('rewrite_project_relative_paths: scripts go to the extension, ../../ to project root', () => {
    expect(rewriteProjectRelativePaths('run scripts/a.sh and ./scripts/b.sh', 'bug'))
      .toBe('run .specify/extensions/bug/scripts/a.sh and .specify/extensions/bug/scripts/b.sh');
    expect(rewriteProjectRelativePaths('../../scripts/a.sh ../scripts/b.sh', 'bug')).toBe('.specify/scripts/a.sh ../scripts/b.sh');
    expect(rewriteProjectRelativePaths('templates/t.md memory/m.md .specify/memory/x myscripts/y', 'bug'))
      .toBe('.specify/templates/t.md .specify/memory/m.md .specify/memory/x myscripts/y');
    expect(rewriteProjectRelativePaths('scripts/a.sh')).toBe('.specify/scripts/a.sh');
  });
});

describe('resolveCommandRefs', () => {
  it('maps any __SPECKIT_COMMAND_X_Y__ to /speckit.x.y, keeping hyphens inside segments', () => {
    expect(resolveCommandRefs('__SPECKIT_COMMAND_PLAN__ __SPECKIT_COMMAND_BUG_ASSESS__ __SPECKIT_COMMAND_AGENT-CONTEXT_UPDATE__'))
      .toBe('/speckit.plan /speckit.bug.assess /speckit.agent-context.update');
    expect(resolveCommandRefs('__speckit_command_lower__')).toBe('__speckit_command_lower__');
  });
});

describe('selectScriptVariant', () => {
  const all = { sh: 'a', ps: 'b', py: 'c' };
  it.each([
    [undefined, all, 'darwin', 'sh'],
    [undefined, all, 'win32', 'ps'],
    ['py', all, 'darwin', 'py'],
    ['ps', all, 'linux', 'ps'],
    [undefined, { ps: 'b' }, 'linux', 'ps'],
    ['py', { ps: 'b' }, 'linux', undefined],
    [undefined, { py: 'c' }, 'win32', 'py'],
  ] as const)('requested=%s scripts=%j on %s → %s', (requested, scripts, platform, expected) => {
    expect(selectScriptVariant(requested, scripts as Record<string, string>, platform)).toBe(expected);
  });
});

describe('renderExtensionCommand', () => {
  const ext = () => path.join(root, '.specify/extensions/bug');
  const opts = (platform: NodeJS.Platform = 'linux') => ({ workspaceRoot: root, extensionId: 'bug', extensionDir: ext(), platform });

  it('substitutes {SCRIPT} with the platform variant, rewriting its path; {ARGS} → $ARGUMENTS', () => {
    fs.mkdirSync(ext(), { recursive: true });
    const content = '---\nscripts:\n  sh: scripts/bash/r.sh --json {ARGS}\n  ps: scripts/powershell/r.ps1\n---\nRun `{SCRIPT}` for __AGENT__ then __SPECKIT_COMMAND_BUG_FIX__.\n$ARGUMENTS\n';
    expect(renderExtensionCommand(content, opts('linux')))
      .toBe('Run `.specify/extensions/bug/scripts/bash/r.sh --json $ARGUMENTS` for caramelo then /speckit.bug.fix.\n$ARGUMENTS');
    expect(renderExtensionCommand(content, opts('win32'))).toContain('`.specify/extensions/bug/scripts/powershell/r.ps1`');
  });

  it('honours the script type chosen at `specify init` (.specify/init-options.json)', () => {
    write('.specify/init-options.json', JSON.stringify({ script: 'ps' }));
    fs.mkdirSync(ext(), { recursive: true });
    const content = '---\nscripts:\n  sh: scripts/a.sh\n  ps: scripts/a.ps1\n---\n{SCRIPT}';
    expect(renderExtensionCommand(content, opts('linux'))).toBe('.specify/extensions/bug/scripts/a.ps1');
  });

  it('prefixes py scripts with the project venv interpreter when present', () => {
    write('.specify/init-options.json', JSON.stringify({ script: 'py' }));
    write('.venv/bin/python');
    fs.mkdirSync(ext(), { recursive: true });
    expect(renderExtensionCommand('---\nscripts:\n  py: scripts/a.py\n---\n{SCRIPT}', opts('linux')))
      .toBe('.venv/bin/python .specify/extensions/bug/scripts/a.py');
  });

  it('refuses to render when no script variant can run here (Spec Kit raises ValueError)', () => {
    write('.specify/init-options.json', JSON.stringify({ script: 'py' }));
    expect(() => renderExtensionCommand('---\nscripts:\n  ps: scripts/a.ps1\n---\n{SCRIPT}', opts('linux')))
      .toThrow(HookCommandRenderError);
  });
});
