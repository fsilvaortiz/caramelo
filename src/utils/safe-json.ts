export function safeJsonParse<T = unknown>(
  raw: string,
  guard?: (value: unknown) => value is T
): T | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (guard && !guard(value)) return null;
  return value as T;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
