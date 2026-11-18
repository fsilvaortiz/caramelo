/**
 * Pure logic deciding whether an agent `bash` call can skip the approval
 * prompt. No VS Code imports — the prompt and persistence live in
 * `approval.ts`.
 *
 * A command is auto-approved only when EVERY segment of it (split on
 * unquoted `&&`, `||`, `;`, `|`, `&`) is either a known read-only
 * command or matches a rule the user saved with "Always allow". Anything
 * we cannot reason about safely — command substitution, process
 * substitution, file redirection, multi-line scripts — is never
 * auto-approved and never offered as a rule.
 */

export interface ParsedCommand {
  /** Trimmed segments between control operators. */
  segments: string[];
  /** False when the command uses constructs we refuse to auto-approve. */
  safe: boolean;
}

/** Redirections that only discard or merge output; they never write files. */
const HARMLESS_REDIRECTS = /\s*(?:[12]?>\s*\/dev\/null|2>&1|1>&2|>&2)/g;

export function parseCommand(command: string): ParsedCommand {
  const cmd = command.replace(HARMLESS_REDIRECTS, '');
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let safe = true;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];

    if (quote) {
      // Command substitution still runs inside double quotes.
      if (quote === '"' && (ch === '`' || (ch === '$' && next === '('))) safe = false;
      if (ch === '\\' && quote === '"') { current += ch + (next ?? ''); i++; continue; }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === '\\') { current += ch + (next ?? ''); i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '`' || ch === '\n' || ch === '\r') { safe = false; current += ch; continue; }
    if (ch === '$' && next === '(') { safe = false; current += ch; continue; }
    if ((ch === '<' || ch === '>') && next === '(') { safe = false; current += ch; continue; }
    if (ch === '>' || ch === '<') { safe = false; current += ch; continue; }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      segments.push(current); current = ''; i++; continue;
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      segments.push(current); current = ''; continue;
    }
    current += ch;
  }
  if (quote) safe = false;
  segments.push(current);

  return { segments: segments.map((s) => s.trim()).filter((s) => s.length > 0), safe };
}

function tokens(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

/** Commands that only read state. Flags that write are excluded below. */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'echo', 'which',
  'file', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'cut', 'diff',
  'find', 'git',
]);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame']);
const FIND_WRITE_FLAGS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

/**
 * Read-only commands still must not read outside the workspace (the
 * agent's file tools are workspace-confined, and auto-approving
 * `cat ~/.ssh/id_rsa` would bypass that). Absolute paths, `~`, `..` and
 * variable expansion all disqualify a segment.
 */
function staysInWorkspace(args: string[]): boolean {
  return args.every((raw) => {
    const arg = raw.replace(/^['"]|['"]$/g, '').replace(/^-[^=]*=/, '');
    return !arg.startsWith('/') && !arg.startsWith('~') && !arg.includes('$') &&
      !/(^|[/\\])\.\.([/\\]|$)/.test(arg) && !/^[a-zA-Z]:[\\/]/.test(arg);
  });
}

export function isReadOnlySegment(segment: string): boolean {
  const t = tokens(segment);
  const cmd = t[0];
  if (!cmd || !READ_ONLY_COMMANDS.has(cmd)) return false;
  if (!staysInWorkspace(t.slice(1))) return false;
  if (cmd === 'find') return !t.some((x) => FIND_WRITE_FLAGS.test(x));
  if (cmd === 'git') {
    const sub = t[1];
    return !!sub && READ_ONLY_GIT.has(sub) && !t.some((x) => x.startsWith('--output'));
  }
  return true;
}

/** Tools whose second (or third) word selects what runs. */
const RUNNERS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'node', 'python', 'python3',
  'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go', 'make', 'dotnet', 'mvn',
  'gradle', './gradlew', './mvnw', 'git', 'tsc', 'vitest', 'jest', 'pytest',
  'docker', 'composer', 'bundle', 'rake', 'mix',
]);
/** For these, `<tool> run <script>` is the unit: allowing "npm run" alone would allow every script. */
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno', 'uv', 'poetry', 'cargo', 'go', 'dotnet']);
const SCRIPT_VERBS = new Set(['run', 'run-script', 'exec', 'x']);
const WORD = /^[\w@][\w:.@/+-]*$/;

/**
 * The rule "Always allow" would save for this command, or null when the
 * command must not become a rule (compound or unsafe constructs).
 *
 * Known runners get a prefix rule (`npm test`, `npm run build`,
 * `npx vitest`); anything else is saved as the exact command, so
 * allowing `rm -rf dist` never allows `rm -rf /`.
 */
export function suggestRule(command: string): string | null {
  const parsed = parseCommand(command);
  if (!parsed.safe || parsed.segments.length !== 1) return null;
  const segment = parsed.segments[0];
  const t = tokens(segment);
  const [cmd, a, b] = t;
  if (!cmd) return null;

  if (RUNNERS.has(cmd) && a && WORD.test(a) && !a.startsWith('-')) {
    if (SCRIPT_RUNNERS.has(cmd) && SCRIPT_VERBS.has(a)) {
      return b && WORD.test(b) && !b.startsWith('-') ? `${cmd} ${a} ${b}` : segment;
    }
    return `${cmd} ${a}`;
  }
  return t.join(' ');
}

function matchesRule(segment: string, rule: string): boolean {
  const s = tokens(segment).join(' ');
  const r = tokens(rule).join(' ');
  return r.length > 0 && (s === r || s.startsWith(`${r} `));
}

export type AutoApproval =
  | { approved: true; reason: string }
  | { approved: false };

/**
 * Whether `command` can run without a prompt given the saved rules.
 * `reason` names the rule(s) or "read-only" for the Output channel.
 */
export function checkAutoApproval(
  command: string,
  opts: { rules: readonly string[]; allowReadOnly: boolean },
): AutoApproval {
  const parsed = parseCommand(command);
  if (!parsed.safe || parsed.segments.length === 0) return { approved: false };

  const reasons: string[] = [];
  for (const segment of parsed.segments) {
    const rule = opts.rules.find((r) => matchesRule(segment, r));
    if (rule) { reasons.push(`rule "${rule}"`); continue; }
    if (opts.allowReadOnly && isReadOnlySegment(segment)) { reasons.push('read-only'); continue; }
    return { approved: false };
  }
  return { approved: true, reason: [...new Set(reasons)].join(', ') };
}
