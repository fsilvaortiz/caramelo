---
description: "Release notes for every version of Caramelo, the spec-driven development extension for VS Code."
---

# Changelog

The canonical changelog lives at [`CHANGELOG.md`](https://github.com/fsilvaortiz/caramelo/blob/main/CHANGELOG.md) in the repository — every release tag attaches the same notes plus a packaged `.vsix`.

Browse releases on GitHub: [github.com/fsilvaortiz/caramelo/releases](https://github.com/fsilvaortiz/caramelo/releases).

## Latest

### v0.3.0 — 2026-10-23

**Central constitution.** Connect a project to a constitution kept in a Git repository (from the Constitution editor or by committing `caramelo.constitution.*` in `.vscode/settings.json`). `constitution.md` stays an exact copy; Caramelo checks for changes on startup and before generating, and offers a one-click sync or restore. Uses your existing Git credentials; strict URL validation and no Git in untrusted workspaces.

[Full v0.3.0 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.3.0)

### v0.2.0 — 2026-10-22

**Spec Kit hooks run and Converge inspects the code.** Hooks from `.specify/extensions.yml` now fire around every Caramelo action (mandatory automatically, optional on confirmation, conditions evaluated like Spec Kit), with Enable/Disable in the sidebar. Converge checks the code against spec, plan, tasks and constitution and appends a `Phase N: Convergence`. Fixes: the v0.1.4 hooks panel never showed real hooks, the Jira link was erased on the first phase transition, the spec description was ignored, and local smoke tests could stash your work. CI moves to Node 22 with a VS Code 1.95 floor check; tagged releases can publish to the Marketplace automatically.

[Full v0.2.0 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.2.0)

### v0.1.4 — 2026-10-21

Catch-up with Spec Kit v1.2.2 (upstream crossed 1.0 in August 2026). `/speckit.converge` and `/speckit.taskstoissues` placeholders are now substituted, Spec Kit's `vscode-settings.json` can be merged with **Apply Spec Kit VS Code Settings**, hooks from `.specify/extensions.yml` appear in the sidebar, and a **Converge** action was added to the Tasks phase. The packaged extension shrank from 28.8 MB to 221 KB.

[Full v0.1.4 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.1.4)

### v0.1.3 — 2026-06-10

Bug-hunt release: `isPhaseUnlocked` no longer crashes on unknown phases, VS Code watchers and listeners are disposed instead of leaking, the Jira client reports failures instead of silently showing "0 issues", one failing parallel task no longer aborts its batch, and task context paths are POSIX on Windows.

[Full v0.1.3 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.1.3)

### v0.1.2 — 2026-05-08

Spec Kit template sync had been silently broken since upstream v0.7.5 stopped attaching release assets; templates are now fetched file by file, and a partial or empty download no longer replaces a good cache.

[Full v0.1.2 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.1.2)

## Earlier

### v0.1.1 — 2026-04-28

**Critical fix.** Constitution generator parser failed on any LLM whose JSON output contained an apostrophe (English contractions like `don't` / `users'` butchered the input). Also fixed a UI-stuck condition where the Generate button kept pulsing forever after a retry, by guaranteeing `generateDone` posts via `try/finally` on every code path.

[Full v0.1.1 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.1.1)

### v0.1.0 — 2026-04-28

**Major.** Phase A of the agentic tool-calling architecture. `/start-task`, `/plan`, and `/tasks` now drive a multi-turn agent loop with seven workspace-sandboxed tools (`file_read`, `file_edit`, `file_write`, `list_dir`, `grep`, `glob`, `bash`). Tool-calling capability across all three providers (Claude, OpenAI-compatible, Copilot via `vscode.lm`). Inline clarify panel, centred-modal write approval, workspace-trust gate, OutputChannel redaction, fs.realpathSync sandbox, webview CSP.

[Full v0.1.0 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.1.0)

### Older

See [`CHANGELOG.md`](https://github.com/fsilvaortiz/caramelo/blob/main/CHANGELOG.md) for the full history (v0.0.9, v0.0.10, …).
