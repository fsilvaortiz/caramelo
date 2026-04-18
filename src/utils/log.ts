const DEBUG_ENABLED = process.env.CARAMELO_DEBUG === '1' || process.env.CARAMELO_DEBUG === 'true';

const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTH_HEADER_RE = /("?(authorization|x-api-key|api-key|token)"?\s*[:=]\s*"?)[^"\s,}]+/gi;
const URL_CREDENTIALS_RE = /(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi;

function redactString(value: string): string {
  return value
    .replace(BEARER_RE, (_m, scheme) => `${scheme} [REDACTED]`)
    .replace(AUTH_HEADER_RE, (_m, prefix) => `${prefix}[REDACTED]`)
    .replace(URL_CREDENTIALS_RE, '$1[REDACTED]@');
}

function redact(arg: unknown): unknown {
  if (typeof arg === 'string') return redactString(arg);
  if (arg instanceof Error) {
    const copy = new Error(redactString(arg.message));
    copy.name = arg.name;
    copy.stack = arg.stack ? redactString(arg.stack) : undefined;
    return copy;
  }
  if (arg && typeof arg === 'object') {
    try {
      return JSON.parse(redactString(JSON.stringify(arg)));
    } catch {
      return arg;
    }
  }
  return arg;
}

export const log = {
  debug(...args: unknown[]): void {
    if (!DEBUG_ENABLED) return;
    console.log('[Caramelo]', ...args.map(redact));
  },
  info(...args: unknown[]): void {
    console.log('[Caramelo]', ...args.map(redact));
  },
  warn(...args: unknown[]): void {
    console.warn('[Caramelo]', ...args.map(redact));
  },
  error(...args: unknown[]): void {
    console.error('[Caramelo]', ...args.map(redact));
  },
};
