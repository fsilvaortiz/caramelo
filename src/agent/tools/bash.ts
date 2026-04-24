import { spawn } from 'child_process';
import type { Tool } from '../types.js';
import { resolveInsideWorkspace } from './io.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1024;

export const bashTool: Tool<{
  command: string;
  cwd?: string;
  timeout_ms?: number;
}> = {
  name: 'bash',
  description:
    'Run a shell command via /bin/sh -c. The command is ALWAYS gated by a user ' +
    'approval prompt showing the literal text. Runs with the workspace root as ' +
    'CWD unless `cwd` (workspace-relative) is provided. Times out after 30 s by ' +
    'default, hard max 120 s. stdout/stderr are each truncated to 10 KB and ' +
    'returned with the exit code. Prefer file_read / file_edit / grep / glob ' +
    'for filesystem operations — bash is only for running build/test commands ' +
    'or inspecting environment that tools cannot reach.',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run under /bin/sh -c.' },
      cwd: { type: 'string', description: 'Workspace-relative working directory. Default: workspace root.' },
      timeout_ms: {
        type: 'integer',
        minimum: 100,
        maximum: MAX_TIMEOUT_MS,
        description: 'Kill the process after this many ms. Default 30000.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cwdRel = input.cwd ?? '.';
    const cwdAbs = resolveInsideWorkspace(cwdRel, ctx.workspaceRoot);
    if (!cwdAbs) {
      return {
        summary: `bash refused: cwd outside workspace — ${cwdRel}`,
        content: `error: cwd "${cwdRel}" is outside the workspace and was refused.`,
        isError: true,
      };
    }
    const timeoutMs = Math.min(
      Math.max(100, input.timeout_ms ?? DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );

    return await new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', input.command], {
        cwd: cwdAbs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      // `settled` dedups the four competing termination paths (child exit,
      // child error, timeout, external abort). The first one to fire wins;
      // later ones short-circuit so the Promise never resolves twice.
      let settled = false;

      const finish = (result: { exitCode: number | null; reason: 'exit' | 'timeout' | 'aborted' | 'error'; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const tail = [
          `$ ${input.command}`,
          `cwd: ${cwdRel}`,
          `reason: ${result.reason}`,
          `exit_code: ${result.exitCode ?? '(signal)'}`,
          result.error ? `error: ${result.error}` : null,
          `--- stdout (${stdout.length} B${stdoutTruncated ? ', truncated' : ''}) ---`,
          stdout,
          `--- stderr (${stderr.length} B${stderrTruncated ? ', truncated' : ''}) ---`,
          stderr,
        ]
          .filter((l): l is string => l !== null)
          .join('\n');
        const summaryPrefix = result.reason === 'exit'
          ? `bash ${result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`}`
          : `bash ${result.reason}`;
        resolve({
          summary: `${summaryPrefix}: ${input.command.slice(0, 50)}${input.command.length > 50 ? '…' : ''}`,
          content: tail,
          isError: result.reason !== 'exit' || (result.exitCode !== null && result.exitCode !== 0),
        });
      };

      const appendBounded = (current: string, chunk: string, onTrunc: () => void): string => {
        if (current.length >= MAX_OUTPUT_BYTES) return current;
        const remaining = MAX_OUTPUT_BYTES - current.length;
        if (chunk.length <= remaining) return current + chunk;
        onTrunc();
        return current + chunk.slice(0, remaining);
      };

      child.stdout!.on('data', (buf: Buffer) => {
        stdout = appendBounded(stdout, buf.toString('utf-8'), () => {
          stdoutTruncated = true;
        });
      });
      child.stderr!.on('data', (buf: Buffer) => {
        stderr = appendBounded(stderr, buf.toString('utf-8'), () => {
          stderrTruncated = true;
        });
      });
      child.on('error', (err) => {
        finish({ exitCode: null, reason: 'error', error: err.message });
      });
      child.on('exit', (code) => {
        finish({ exitCode: code, reason: 'exit' });
      });

      // SIGKILL on timeout/abort. If kill itself fails (EPERM on a
      // process we no longer own, ESRCH if the child has already died)
      // surface the error in the result rather than silently resolving
      // — an orphaned child process is a real concern.
      const killChild = (): string | undefined => {
        try {
          child.kill('SIGKILL');
          return undefined;
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          return `kill failed: ${e.code ?? 'EUNKNOWN'} ${e.message ?? String(err)}`;
        }
      };

      const timer = setTimeout(() => {
        const killErr = killChild();
        finish({ exitCode: null, reason: 'timeout', error: killErr });
      }, timeoutMs);

      const onAbort = () => {
        const killErr = killChild();
        finish({ exitCode: null, reason: 'aborted', error: killErr });
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
  },
};
