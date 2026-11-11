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

export function formatAuthValue(prefix: string, value: string): string {
  return prefix ? `${prefix} ${value}` : value;
}

/**
 * Where the apiKeyHelper output is sent.
 *
 * - `null` (no `apiKeyHelperHeader`, or the same header as `authHeader`):
 *   the helper output replaces the stored key in `authHeader`/`authPrefix`.
 * - otherwise both headers are sent: the stored key in `authHeader` (e.g. an
 *   Azure APIM `Ocp-Apim-Subscription-Key`) and the helper output in this
 *   header (e.g. `Authorization: Bearer <token>`).
 */
export interface HelperHeaderTarget {
  header: string;
  prefix: string;
}

export function resolveHelperHeaderTarget(
  config: { apiKeyHelperHeader?: string; apiKeyHelperPrefix?: string },
  authHeader: string,
): HelperHeaderTarget | null {
  const raw = typeof config.apiKeyHelperHeader === 'string' ? config.apiKeyHelperHeader.trim() : '';
  if (!raw) return null;
  const header = sanitizeHeaderName(raw, '');
  if (!header || header.toLowerCase() === authHeader.toLowerCase()) return null;
  const defaultPrefix = header.toLowerCase() === 'authorization' ? 'Bearer' : '';
  const prefix = config.apiKeyHelperPrefix === undefined
    ? defaultPrefix
    : sanitizeHeaderPrefix(config.apiKeyHelperPrefix, defaultPrefix);
  return { header, prefix };
}

/**
 * Build the auth headers for a request from the stored key and/or the
 * apiKeyHelper output, following the routing described above.
 */
export function buildAuthHeaders(opts: {
  authHeader: string;
  authPrefix: string;
  helperTarget: HelperHeaderTarget | null;
  storedKey: string | null | undefined;
  helperToken: string | null | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  const { authHeader, authPrefix, helperTarget, storedKey, helperToken } = opts;
  if (helperToken && !helperTarget) {
    headers[authHeader] = formatAuthValue(authPrefix, helperToken);
    return headers;
  }
  if (storedKey) headers[authHeader] = formatAuthValue(authPrefix, storedKey);
  if (helperToken && helperTarget) {
    headers[helperTarget.header] = formatAuthValue(helperTarget.prefix, helperToken);
  }
  return headers;
}
