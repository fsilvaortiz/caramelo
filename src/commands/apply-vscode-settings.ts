import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TEMPLATES_CACHE_DIR, VSCODE_SETTINGS_FILE } from '../constants.js';
import { isObject, safeJsonParse } from '../utils/safe-json.js';
import { log } from '../utils/log.js';

/**
 * Outcome of merging the upstream Spec Kit vscode-settings.json into a
 * workspace's existing `.vscode/settings.json`.
 *
 * - `added` names the top-level keys we introduced (not previously in
 *   the user's file).
 * - `conflicts` names keys that exist with a different value — the user
 *   decides whether to overwrite.
 * - `merged` is the combined object with the user's values winning on
 *   conflicts (we only overwrite after explicit consent at the call
 *   site).
 */
export interface MergeResult {
  readonly merged: Record<string, unknown>;
  readonly added: readonly string[];
  readonly conflicts: ReadonlyArray<{ key: string; currentValue: unknown; newValue: unknown }>;
}

/**
 * Pure merge: top-level JSON keys only. We intentionally do NOT descend
 * into object values — the upstream file uses the dotted-key form
 * (`"chat.promptFilesRecommendations": {...}`) which VS Code resolves
 * as a leaf setting, and a user with their own version of that key
 * deserves a conflict notice rather than a surprise auto-merge of nested
 * fields they can't see.
 *
 * Values are compared by `JSON.stringify` so object-vs-object equality
 * doesn't false-positive on reference identity. Primitives compare
 * trivially.
 *
 * Exported so tests can assert the invariants without a VS Code runtime.
 */
export function computeSettingsMerge(
  current: Record<string, unknown>,
  upstream: Record<string, unknown>,
): MergeResult {
  const merged: Record<string, unknown> = { ...current };
  const added: string[] = [];
  const conflicts: Array<{ key: string; currentValue: unknown; newValue: unknown }> = [];

  for (const [key, newValue] of Object.entries(upstream)) {
    if (!(key in current)) {
      merged[key] = newValue;
      added.push(key);
      continue;
    }
    const currentValue = current[key];
    if (JSON.stringify(currentValue) === JSON.stringify(newValue)) continue;
    conflicts.push({ key, currentValue, newValue });
  }

  return { merged, added, conflicts };
}

/**
 * Apply the overwrites a user has approved. Separate from
 * `computeSettingsMerge` so the modal-interaction step is testable
 * independently from the pure merge, and so the "cancel" branch is a
 * one-liner at the call site (just skip this function).
 */
export function applyApprovedOverwrites(
  base: Record<string, unknown>,
  upstream: Record<string, unknown>,
  approvedKeys: readonly string[],
): Record<string, unknown> {
  const out = { ...base };
  for (const key of approvedKeys) {
    if (key in upstream) out[key] = upstream[key];
  }
  return out;
}

/**
 * Atomic write via temp + rename, mirroring `src/speckit/sync.ts`'s
 * approach so a crash mid-write never leaves a half-written settings
 * file on disk.
 */
function atomicWriteJson(target: string, content: Record<string, unknown>): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export async function applyVsCodeSettings(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    await vscode.window.showWarningMessage(
      'Caramelo: open a workspace folder before applying VS Code settings.',
    );
    return;
  }

  // Multi-root workspaces: operate on the first folder, matching the
  // behaviour of every other Caramelo command (specs/, .caramelo-meta
  // live there too).
  const root = folders[0].uri.fsPath;
  const cachedPath = path.join(TEMPLATES_CACHE_DIR, VSCODE_SETTINGS_FILE);

  if (!fs.existsSync(cachedPath)) {
    await vscode.window.showErrorMessage(
      'Caramelo: Spec Kit VS Code settings template not cached yet. Run "Caramelo: Sync Spec Kit Templates" first.',
    );
    return;
  }

  const upstreamRaw = fs.readFileSync(cachedPath, 'utf-8');
  const upstream = safeJsonParse<Record<string, unknown>>(
    upstreamRaw,
    (v): v is Record<string, unknown> => isObject(v),
  );
  if (!upstream) {
    log.warn('[apply-vscode-settings] cached vscode-settings.json is not a valid JSON object');
    await vscode.window.showErrorMessage(
      'Caramelo: cached Spec Kit VS Code settings are corrupt. Re-run the template sync.',
    );
    return;
  }

  const settingsDir = path.join(root, '.vscode');
  const settingsPath = path.join(settingsDir, 'settings.json');

  let current: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = safeJsonParse<Record<string, unknown>>(
      raw,
      (v): v is Record<string, unknown> => isObject(v),
    );
    if (!parsed) {
      await vscode.window.showErrorMessage(
        'Caramelo: workspace .vscode/settings.json is not a valid JSON object. Fix it manually before applying Spec Kit settings.',
      );
      return;
    }
    current = parsed;
  }

  const { merged, added, conflicts } = computeSettingsMerge(current, upstream);

  if (added.length === 0 && conflicts.length === 0) {
    await vscode.window.showInformationMessage(
      'Caramelo: Spec Kit VS Code settings already applied — nothing to do.',
    );
    return;
  }

  let finalSettings = merged;
  if (conflicts.length > 0) {
    const keyList = conflicts.map((c) => `  • ${c.key}`).join('\n');
    const choice = await vscode.window.showWarningMessage(
      `Caramelo: ${conflicts.length} setting${conflicts.length === 1 ? '' : 's'} in .vscode/settings.json differ from the Spec Kit defaults:\n\n${keyList}\n\nOverwrite with the Spec Kit values?`,
      { modal: true },
      'Overwrite',
      'Add new only',
    );
    if (choice === undefined) return; // cancelled
    if (choice === 'Overwrite') {
      finalSettings = applyApprovedOverwrites(merged, upstream, conflicts.map((c) => c.key));
    }
    // "Add new only" → keep `merged` which already has added keys + user's existing values preserved.
  }

  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });
  atomicWriteJson(settingsPath, finalSettings);

  const addedSummary = added.length > 0 ? `${added.length} added` : '';
  const overwriteSummary =
    conflicts.length > 0 && finalSettings !== merged ? `${conflicts.length} overwritten` : '';
  const parts = [addedSummary, overwriteSummary].filter(Boolean);
  await vscode.window.showInformationMessage(
    `Caramelo: Spec Kit VS Code settings applied (${parts.join(', ') || 'no changes'}).`,
  );
}
