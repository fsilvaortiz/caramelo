# Changelog

The canonical changelog lives at [`CHANGELOG.md`](https://github.com/fsilvaortiz/caramelo/blob/main/CHANGELOG.md) in the repository — every release tag attaches the same notes plus a packaged `.vsix`.

Browse releases on GitHub: [github.com/fsilvaortiz/caramelo/releases](https://github.com/fsilvaortiz/caramelo/releases).

## Latest

### v0.1.1 — 2026-04-28

**Critical fix.** Constitution generator parser failed on any LLM whose JSON output contained an apostrophe (English contractions like `don't` / `users'` butchered the input). Also fixed a UI-stuck condition where the Generate button kept pulsing forever after a retry, by guaranteeing `generateDone` posts via `try/finally` on every code path.

[Full v0.1.1 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.1.1)

### v0.1.0 — 2026-04-28

**Major.** Phase A of the agentic tool-calling architecture. `/start-task`, `/plan`, and `/tasks` now drive a multi-turn agent loop with seven workspace-sandboxed tools (`file_read`, `file_edit`, `file_write`, `list_dir`, `grep`, `glob`, `bash`). Tool-calling capability across all three providers (Claude, OpenAI-compatible, Copilot via `vscode.lm`). Inline clarify panel, centred-modal write approval, workspace-trust gate, OutputChannel redaction, fs.realpathSync sandbox, webview CSP.

[Full v0.1.0 notes](https://github.com/fsilvaortiz/caramelo/releases/tag/v0.1.0)

## Earlier

See [`CHANGELOG.md`](https://github.com/fsilvaortiz/caramelo/blob/main/CHANGELOG.md) for the full history (v0.0.9, v0.0.10, …).
