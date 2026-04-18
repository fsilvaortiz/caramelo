const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_PREFIX_RE = /^[A-Za-z0-9-]{0,16}$/;

export function sanitizeHeaderName(value: string | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return HEADER_NAME_RE.test(trimmed) ? trimmed : fallback;
}

export function sanitizeHeaderPrefix(value: string | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return HEADER_PREFIX_RE.test(trimmed) ? trimmed : fallback;
}
