# Changelog

## [0.1.1] - 2026-04-28

### Fixed (critical)

- **AI-generated constitution failed for any provider whose JSON output contained an apostrophe**. The JSON cleanup in `tryParseJSON` did `replace(/'/g, '"')`, which turned `{"description": "Don't break things"}` into `{"description": "Don"t break things"}` — invalid JSON. The strategy 2 outermost-brace fallback failed against the same broken text, and the prose fallback regex was line-bound so multi-line markdown headings produced "Could not parse LLM response. Try a more capable model" toasts even when the model returned a perfectly valid response. Reported on Opus 4.7 with English prose containing contractions like `don't` / `users'`.
- **Constitution generation UI got stuck pulsing after a retry**. When the user clicked Generate, hit a parse failure, switched models, and clicked Generate again, the second attempt's stream completed in the OutputChannel but the button kept pulsing forever. Root cause: `generateWithAI` had at least one return path (no active provider) that didn't post `generateDone` to the webview, plus any unexpected throw between "Generation complete" and the parse step would also skip the post. Every exit path now goes through a `postDone()` helper guarded by a `donePosted` flag, wrapped in `try/finally` so the webview button is structurally guaranteed to reset even if the inner code throws.

### Changed

- `tryParseJSON` no longer touches apostrophes inside string values. Line-comment removal is now anchored to the start of a line (was global) so `https://…` URLs inside string values are preserved.
- Strategy 2 walks brace depth and respects string-quoted braces and escapes, returning the first balanced `{ … }` substring instead of greedily matching from the first `{` to the last `}` in the document.
- The prose fallback now recognises Markdown-heading constitutions (`### N. Name` followed by multi-paragraph descriptions) and stops at the next heading, capturing entire sections — including `## Constraints` and `## Development Workflow`. The single-line shorthand still works for older models that emit `1. **Test-First**: …`; separator restricted to `:` so hyphenated names like `Test-First` are no longer truncated to `Test`.
- LLM call uses `temperature: 0` for the constitution-generation request — structured-output task, no creativity benefit, only parser-fragility risk.
- On parse failure, the OutputChannel now logs the first 500 B of the raw response (redacted) so the failure mode is no longer invisible.
- The system prompt is more emphatic about output rules and includes an explicit reminder that apostrophes in JSON string values do NOT need escaping (so the model doesn't try to "help" by emitting them as `\'` and breaking the parser).
- The constitution OutputChannel is a singleton — earlier code re-created the channel on every generation, leaking handles for the lifetime of the extension host.
- A module-scoped `generationInFlight` lock refuses re-entry while a generation is running and resets the new caller's UI immediately, so a second `editConstitution` panel (or a programmatic command) can't race the first.

### Tests

- 21 new unit tests in `commands/__tests__/edit-constitution.test.ts` covering: the apostrophe regression, possessive apostrophes, URL preservation, trailing-comma cleanup, balanced-brace extraction with nested braces and string-quoted braces, escaped quotes inside strings, ```json fenced output, bare JSON with surrounding chat preamble, markdown-heading fallback with constraints/workflow sections, single-line shorthand fallback with hyphenated names, line-comment-prefixed JSON, multi-paragraph descriptions, and HTML-comment stripping.

### Notes

- This is a parser fix; no behaviour change for users whose model already emitted clean JSON. Upgrade is safe.

## [0.1.0] - 2026-04-28

### Added (major)

- **Agentic tool-calling loop for `/start-task`, `/plan`, and `/tasks`**. Replaces the legacy single-shot SEARCH/REPLACE protocol with a multi-turn agent that calls `file_read` / `file_edit` / `file_write` / `grep` / `glob` / `list_dir` / `bash` until it terminates with no tool calls. Each tool is workspace-sandboxed; bounded iteration count protects against runaway loops; cancellation propagates from the status-bar abort all the way down to in-flight HTTP / `vscode.lm` requests.
- **Tool-calling capability across all three providers**: Anthropic Claude (`tool_use` content blocks + `tool_result`), OpenAI-compatible (function-calling with index-keyed tool_call delta reassembly — works for OpenAI, Ollama, LM Studio, Groq, Gemini OpenAI shim, custom endpoints), and GitHub Copilot (`vscode.lm` `LanguageModelChatTool` + `LanguageModelToolCallPart`).
- **Capability registry on `LLMProvider`**: typed `capabilities()` set (`'streaming' | 'tool-calling' | 'reasoning' | 'prompt-caching' | 'citations' | 'multimodal' | 'vision'`). Runtime code branches on capabilities, never on provider type strings — adding a new vendor no longer requires teaching every call site about it. Type-string dispatch in business logic is now a build break.
- **Inline clarify panel** in the Workflow sidebar replaces the prior sequential top-bar QuickPicks. Each ambiguity renders as a card with selectable option buttons (★ marks the LLM's recommendation), per-question Skip, batch Submit / Cancel. Submit writes a dated session under `## Clarifications` (HH:MM differentiator avoids duplicate same-day blocks); cancel discards without touching the file.
- **Centered modal for batched write approval** (replaces the prior top-bar QuickPick). Lists every proposed write in the modal's detail field; same shape as the existing bash-approval modal so the three approval surfaces are visually consistent.

### Security

- **Workspace-trust gate**: `/start-task` and phase generation refuse in untrusted workspaces — both the agent path AND the legacy fallback. The check sits before the safety stash so the user is never asked to "proceed without backup" only to be refused after.
- **Output Channel redaction**: every tool argument, tool-result summary, text delta, denial reason, and error string passes through `redactString` before reaching the channel. Bearer / Authorization / URL-embedded credentials are stripped — even when a tool result or file read echoes them back.
- **`bash` is always per-call**: regardless of the approval policy. The `auto-all` mode exists for read+write convenience but bash is hard-coded to always prompt with the literal command and a 30s default / 120s hard-max timeout. SIGKILL on timeout/abort.
- **Workspace-root sandbox via `fs.realpathSync`**: every filesystem tool resolves the existing path prefix through realpath and re-checks containment, so a symlink inside the workspace pointing at `~/.ssh` is refused even though the lexical path passes.
- **Webview Content-Security-Policy** + `escHtml` hardened to also escape `'` so attribute-context interpolation is safe in single-quoted attrs.

### Changed

- **Status bar click + `caramelo.addProvider` route to the Providers sidebar** instead of opening top-bar wizards.
- **Phase generation** for `design` and `tasks` runs through the agent loop when the active provider supports tool-calling — the LLM inspects the codebase while writing the artifact, so proposed file paths and module references are real, not hallucinated.
- **Run prologue**: every agent run starts with a one-line summary in the Output Channel — `▶ agent start  provider=…  model=…  capabilities=[…]  tools=N  approval=…  bash=on/off  maxIter=…` — so "what did the LLM see?" is answerable from the channel alone, no debugger required.
- **`AgentMessage` is a role-discriminated union**: illegal combinations (e.g. `toolCalls` on a user message) are unrepresentable rather than caught by JSDoc.
- **`TaskOutcome` is a discriminated union**: `markComplete: true` is only representable on `kind: 'success'` — a regression that marks `max_iterations` or `error` as complete now fails at the type level.

### Settings

- `caramelo.useAgentLoop` (boolean, default `true`) — kill switch to fall back to legacy SEARCH/REPLACE path while dogfooding.
- `caramelo.enableBashTool` (boolean, default `true`) — exposes bash to the agent. When `false`, bash isn't even in the tool list sent to the LLM.
- `caramelo.agent.maxIterations` (number, default 15, range [3,50]) — cap per agent run; runaway loops terminate cleanly with a summary.
- `caramelo.agent.approval` (enum: `"auto-reads-batched-writes"` | `"per-call"` | `"auto-all"`, default `"auto-reads-batched-writes"`) — reads auto-allow, bash always prompts, writes batched into a single per-turn modal.

### Tests

286 passing across 28 files (140 new since 0.0.10). Replay-style transcripts cover Claude / OpenAI / Copilot tool-calling translation, fragmented argument JSON, malformed-JSON regression guards, and provider abort classification. Multi-turn agent runtime tests cover cancellation, approval denial, abort propagation, max-iterations clamping, and the synthetic-tool_result invariant. Sandbox tests prove path-escape refusal, file-edit ambiguity rejection, and `bash` timeout/abort SIGKILL semantics. Webview tests cover the typed `WebviewMsg` protocol, every postMessage rejection path, and the clarify session lifecycle (start, skip, cancel, submit, write-failure toast, re-entry prompt with picks vs no prompt with skips-only).

### Internal / refactors

- New subsystem at `src/agent/` (types, runtime, tool-registry with hand-rolled JSON Schema draft-07 validator, approval policies, OutputChannel formatter, 7 tools sharing a `FileIO` abstraction lifted from `task-edits/apply.ts`).
- `src/providers/sse.ts` gains `parseSSEEvents` (yields parsed JSON events; sibling to the existing `parseSSEStream` text extractor).
- Dead code removal: `src/commands/new-spec.ts` (orphaned since the workflow webview gained its inline form).
- `redactString` exported from `utils/log.ts` so the agent's events formatter can apply the same redactor that protects `log.info`/`log.warn`.

### Notes

- The legacy SEARCH/REPLACE path is preserved as a fallback (`caramelo.useAgentLoop=false`) for the duration of a dogfooding window. Removal is targeted for a later release once two consecutive weeks of A+B+C deployment show zero regressions vs the legacy path.
- Bundle size: 230 KB compiled JS (Constitution ceiling 250 KB). 60 KB headroom remains for the next feature drop.

## [0.0.10] - 2026-04-18

### Fixed (critical)

- **Provider dot now reflects real connectivity, not "I clicked it"**. Up to v0.0.9, clicking a provider only called `setActive(id)` and the dot turned green regardless of whether the endpoint, model or credentials worked. Activating a provider now runs a one-token streaming `chat()` ping inside `vscode.window.withProgress`; the dot only goes green if tokens come back. On failure the provider is left inactive, the dot turns red, and a warning notification surfaces the cause (auth, model not found, timeout, network).
- **`isAvailable()` actually exercises chat()**. Before, Claude treated HTTP 400 as "valid" (so a wrong model lit the dot green) and OpenAI-compatible only hit `GET /models` (Ollama returns 200 even when the model isn't pulled, and corporate proxies often expose `/models` without exposing `/chat/completions`). Both providers now use a 1-token streaming generation as the health check, capped by `AbortSignal.timeout(15s)`.
- **Provider list survives opening a new window**. `caramelo.providers` and `caramelo.activeProvider` were written to `ConfigurationTarget.Workspace` from 13 call sites, so opening a different folder wiped the list. They are now stored in `Global` scope. A one-shot migration runs on startup that lifts existing Workspace values to Global only when Global is empty (never overwrites a populated Global), then clears the Workspace entry. Per-workspace overrides via `.vscode/settings.json` still work — VS Code's normal scope precedence applies.

### Added

- **Three-state health on the provider dot** with a pulsing amber while a healthcheck is in flight: gray (inactive), amber steady (active but never tested), amber pulsing (checking…), green (active + last ping ok), red (active + last ping failed or setup error). Hover tooltip explains each state.
- **`HealthStatus` / `HealthState`** plus `getHealth(id)`, `recordHealth(id, status, error?)` and `onDidChangeHealth` event on `ProviderRegistry`. `handleSetModel` now records into the same channel as `activateWithHealthcheck` so the validation it already does shows up on the dot.
- **`utils/migrate-providers.ts`** + 9 new tests (5 for the registry health surface, 4 for the migration). Total Vitest suite now 102 passing across 13 files.

### Changed

- README troubleshooting section: new "The provider dot is green but generations fail" entry with a colour legend, and "My providers disappeared when I opened a different folder" explaining the Global-scope move.

## [0.0.9] - 2026-04-18

### Fixed (critical)

- **Tasks no longer overwrite files**. Before 0.0.9 the task system prompt asked the LLM to emit whole-file bodies (`=== FILE: path === <content> === END FILE ===`) and `applyChanges` wrote that output straight over the existing file with a single `fs.writeFileSync`, so anything the LLM forgot to repeat was silently deleted. The new protocol only accepts:
  - `=== FILE: path === <<<<<<< SEARCH / ======= / >>>>>>> REPLACE === END FILE ===` for edits, applied only when the SEARCH text matches exactly **one** place in the file (0 or >1 matches → aborted, file untouched).
  - `=== CREATE: path === … === END CREATE ===` for brand-new files; refused if the path already exists.
- **Task runs see the real file contents**. `loadSpecContext` used to only include `spec.md` and `plan.md`; the model had to reconstruct code from memory. `buildTaskContext` now attaches every workspace-relative file path mentioned in the spec / plan / tasks / task description as a `--- CURRENT FILE: … ---` block (configurable caps: 50 KB per file, 200 KB total).
- **Pre-task safety stash**. When the workspace is a git repo and the working tree is dirty, Caramelo runs `git stash push -u -m caramelo-pre-task-<timestamp>` before touching anything and logs the exact command to restore it. When it is not a git repo, the user is prompted to confirm before Caramelo proceeds without a backup.
- **Diff preview before writing**. By default each task opens a QuickPick with *Apply all / Review file-by-file / Cancel*; file-by-file opens a `vscode.diff` for every change and asks per-file. Power users can set `caramelo.autoApplyEdits: true` to skip the review.
- **Legacy output is refused, not silently applied**. If the LLM emits the old whole-file format, the parser throws a `LegacyFormatError` and nothing is written; the user sees an explicit error in the Caramelo output channel.
- **Parallel `[P]` tasks are safe with the new write pipeline**. `Run All Tasks` fans out `[P]`-marked tasks via `Promise.all`; with 0.0.9's new interactive steps this would have raced `git stash push` on `.git/index.lock`, stacked ambiguous QuickPicks, and let two edits against the same file shift each other's SEARCH context. An `AsyncMutex` inside `startTask` now serializes the stash/review/apply phases while still running the LLM stream outside the lock so parallel throughput is preserved. QuickPick and diff titles are tagged with the task text so users can tell which prompt belongs to which task.

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
