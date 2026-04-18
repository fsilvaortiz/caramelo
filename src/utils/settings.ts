import * as vscode from 'vscode';

const SSE_TIMEOUT_SETTING = 'caramelo.sse.timeoutMs';
const DEFAULT_SSE_TIMEOUT_MS = 300_000;

export function getSseTimeoutMs(): number {
  const raw = vscode.workspace.getConfiguration().get<number>(SSE_TIMEOUT_SETTING);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 5_000) {
    return DEFAULT_SSE_TIMEOUT_MS;
  }
  return raw;
}
