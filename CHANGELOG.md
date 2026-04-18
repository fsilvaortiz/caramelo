# Changelog

## [0.0.9] - 2026-04-18

### Security

- **XSS hardening**: replaced `innerHTML` with DOM APIs in three sinks fed by untrusted data (model list from provider APIs, Jira board list, LLM-generated constitution principles) — no more markup injection from arbitrary OpenAI-compatible endpoints or LLM output.
- **Redacting logger** (`utils/log`): strips `Bearer`/`Basic` tokens, `Authorization` / `x-api-key` / `token` values, and `user:pass@` credentials from URLs before writing to the output channel. Debug logs are now gated behind `CARAMELO_DEBUG=1` so they are silent in production.
- **Header injection guard**: `authHeader` and `authPrefix` are now constrained by a pattern in the settings schema and re-validated at runtime, so a hand-edited `settings.json` cannot smuggle CR/LF into outbound HTTP requests.
- **Jira credential validation at save time**: adding a Jira provider now pings `/rest/api/3/myself` before persisting, closing a gap where a stale token could be stored if the user skipped the Test button.

### Fixed

- **SSE `[DONE]` marker correctly terminates the stream**: `processSSEPart`'s inner `return` only stopped the inner generator, so frames arriving after `[DONE]` were still yielded and could corrupt generated specs or delay completion until the 5 min timeout fired. Refactored to return `{ contents, done }` so the outer loop stops reading immediately.
- **SSE timeout handles no longer leak**: the per-read `setTimeout` is now cleared on every loop iteration and in a `finally` block.
- **AbortController lifecycle** in Claude and OpenAI-compatible providers: a new `chat()` aborts any in-flight request before starting, and the controller reference is nulled in a `finally` block instead of lingering after the stream completes.
- **Phase auto-detection is now persisted**: when `buildSpec` finds an existing phase file on disk while metadata still says `pending`, it upgrades to `pending-approval` and writes the change back to `.caramelo-meta.json` — the UI and the filesystem no longer disagree.
- **Safer JSON parsing** in spec metadata readers (`spec.ts`, `progress-view`, `dag-view`, `workflow-view`) and the template sync version file via a shared `safeJsonParse` + `isObject` guard.

### Added

- **New setting `caramelo.sse.timeoutMs`** (default 300000, min 5000) — raise it for slow local models like Ollama on CPU.
- **Typed error hierarchy** (`CarameloError`, `TimeoutError`, `NetworkError`, `AuthError`, `ProviderError`) so callers can distinguish transport failures, auth failures (401/403), and server-side provider errors.
- **Test suite**: first automated tests (52 across Vitest), wired into CI. Covers spec metadata, SSE parsing, log redaction, safe JSON, error hierarchy, and header sanitising.
- **Advanced Settings and Troubleshooting sections** in the README.

### Changed

- **Production bundle is now minified**: esbuild runs with `treeShaking`, strips legal comments, and a new `vscode:prepublish` hook ensures `vsce package` always uses `--production`. Bundle size: **229 KB → 159 KB** (−30 %).
- **Silent `.catch(() => {})`** in extension activation replaced with logged warnings through the redacting logger.
- `@typescript-eslint/no-explicit-any` promoted from `warn` to `error`; removed six `as never` casts and one inline `as import(...)` cast by narrowing parameter types to `{ refresh(): void }` where appropriate.

## [0.0.8] - 2026-04-03

### Added

- **LLM Provider System**: Connect to any LLM — GitHub Copilot, Ollama, Claude, OpenAI, Groq, LM Studio, or any OpenAI-compatible endpoint
- **GitHub Copilot Provider**: Use Copilot's LLM models (GPT-4o, Claude Sonnet, Gemini, etc.) via vscode.lm API — no API key needed
- **Jira Integration**: Import Jira Cloud issues as specs with board search, issue key lookup, and linked badges
- **Visual Spec Management**: Unified sidebar with providers, constitution, specs, progress, and task checklist
- **Constitution Editor**: Visual form with AI generation — describe your project, LLM suggests principles
- **Sequential Workflow**: Requirements → Design → Tasks with approval gates between phases
- **Streaming Generation**: Watch documents being written in real time by the LLM
- **Intermediate Artifacts**: Design phase generates research.md, data-model.md, and contracts/
- **Constitution as Context**: Project principles automatically included in every LLM generation
- **CodeLens Actions**: Persistent Approve, Regenerate, and Next Phase buttons in spec documents
- **Caramelo Editor Menu**: Grouped contextual actions under a single cat icon (dark/light theme support)
- **Task Execution**: Run individual tasks or all tasks with parallel support for `[P]` markers
- **LLM Output Channel**: Watch LLM reasoning in real time during task execution
- **Progress Ring**: Overall completion percentage (phases 50% + tasks 50%), 100% only when all tasks done
- **Workflow DAG**: Interactive graph showing constitution, features, and phase statuses
- **Clarify Command**: LLM identifies ambiguities, presents questions as QuickPick dialogs
- **Analyze Command**: Cross-artifact consistency check with severity levels and auto-fix (Fix This / Fix All)
- **Checklist Generation**: Content-specific quality verification items per phase
- **Stale Phase Alerts**: Downstream phases flagged when upstream is regenerated
- **Inline Task Checklist**: Toggle tasks directly in the sidebar with immediate file sync
- **Auto-detect Models**: Provider API queried for available models after entering credentials
- **Change Model on Click**: Click model name in providers panel to switch models anytime
- **Providers WebviewView**: Inline preset buttons, credential entry, and model selection — all in sidebar
- **Jira Board Search**: Search boards by name instead of loading all (scales to 2000+ boards)
- **Jira Issue Key Lookup**: Type an issue key directly (e.g. PROJ-123) to find issues not in the board view
- **Template Auto-Sync**: Automatically downloads latest Spec Kit templates from GitHub releases
- **Offline Support**: Bundled fallback templates for offline-first usage
- **Non-intrusive Progress**: Status bar spinner instead of notification popups
- **Auxiliary Files Display**: research.md, data-model.md, analysis.md, checklists shown under each phase

### Fixed

- Specs directory now uses `specs/` (Spec Kit default) instead of `.specify/specs/`
- Jira board search via API name filter instead of loading all boards (fixes timeout on large orgs)
- Jira issue search uses Agile API instead of JQL (fixes 410 Gone on Jira Cloud)
- Jira issue content extraction uses API v2 for plain text descriptions
- Jira context (jira-context.md) included as LLM input when generating Requirements
- Task completion marking with 3 fallback strategies (fixes parallel execution miscount)
- Truncation-tolerant file block parser handles incomplete LLM output
- SSE parser with 5-min per-chunk timeout and flexible newline handling for Ollama
- Robust JSON parser handles LLM output with comments, trailing commas, single quotes
- Dynamic import replaced with static import (fixes esbuild bundle compatibility)
- ESLint migrated to flat config (v9 compatible)
- Custom auth headers: configurable header name and prefix for corporate API proxies
- Inline provider editing: state-driven re-render for model, auth, and Jira settings
- Model validation with red error indicator on failure, provider not activated until valid
- Model dropdown fetched from API in background, manual input as fallback
- Jira provider editing: click name/board to edit inline with Save/Cancel
- Multiple providers of same type with unique IDs (claude, claude-2, etc.)
- Direct Jira issue key lookup in issue picker (type PROJ-123 to find any issue)
- Google Gemini as preset provider via OpenAI-compatible endpoint
- Workflow sidebar watches specs/ directory for real-time updates
- Explicit refresh after task execution for immediate progress updates
