<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.0.0 (no bump — still within initial ratification
window, product not yet released; additions fold into the founding set per
project-owner direction).

Modified principles:
  - I. LLM-Agnostic by Design
      → I. LLM-Agnostic by Adapter Invariants
        (Reframed from "ban vendor SDKs" to four auditable invariants
         every provider adapter MUST satisfy; SDK use emerges as
         forbidden-by-default consequence, not dogma.)

Added principles:
  - VI.  Extensible Abstraction via Capabilities
  - VII. Tool Calling as First-Class
  - VIII. Recoverable by Default
  - IX.  Traceable Generation

Added / expanded sections:
  - Additional Constraints: performance budget (activation / first paint /
    no sync I/O), explicit agent-approval defaults, capability-registry
    rule, workspace-root boundary.
  - Development Workflow & Quality Gates: capability-based branching
    rule, tool-registry review requirement, pre-release checklist.

Removed sections: none.

Templates requiring updates:
  ✅ .specify/memory/constitution.md       — this file.
  ✅ .specify/templates/plan-template.md   — Constitution Check gates
                                              rewritten for I–IX.
  ✅ .specify/templates/spec-template.md   — Reviewed; still feature-
                                              level, no structural change.
  ✅ .specify/templates/tasks-template.md  — Reviewed; Polish phase
                                              covers observability, safety,
                                              docs consistent with new
                                              principles.
  ✅ CONTRIBUTING.md                       — Reviewed; existing guidance
                                              consistent (no hand-edit).
  ✅ README.md                             — Reviewed; no rewording
                                              required.
  ⚠  CLAUDE.md                            — Auto-generated; do not
                                              hand-edit.

Follow-up TODOs: none.
-->

# Caramelo Constitution

## Core Principles

### I. LLM-Agnostic by Adapter Invariants

Every provider adapter (LLM or Jira) MUST preserve these four invariants,
and MUST implement the `LLMProvider` (or equivalent) contract from
`src/providers/types.ts`:

1. **Redacting transport.** Every outbound request and response passes
   through the redacting logger; no provider code may log raw
   `Authorization` / `x-api-key` / `Bearer` / URL-embedded credentials.
2. **Abortable streaming with per-chunk timeout.** Streams MUST honor
   `caramelo.sse.timeoutMs` on a per-chunk basis and MUST surface an
   `AbortSignal` that actually cancels in-flight network traffic.
3. **Custom auth pass-through.** `authHeader` and `authPrefix` from the
   provider config MUST be used verbatim for the request — the adapter
   MUST NOT silently rewrite them (required for corporate proxies such
   as Azure API Manager).
4. **Bundle budget.** The adapter contributes to the compiled-bundle
   ceiling declared in `Additional Constraints`; adding a runtime
   dependency requires an explicit justification in the PR.

Users MUST be able to configure and hot-swap providers (OpenAI-compatible,
Anthropic, Copilot, Gemini, Ollama, LM Studio, Groq, custom endpoints)
without code changes, and multiple providers of the same type MUST coexist
under distinct aliases.

**Consequence (not a separate rule).** Direct imports of vendor SDKs
(`openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, …) are forbidden
by default because no known SDK satisfies invariants (1)–(3) without
wrapping its HTTP layer to the point where the SDK saves nothing. A PR
MAY introduce an SDK **only if** it demonstrates all four invariants still
hold after integration, and justifies why hand-rolled `fetch` is
insufficient.

**Rationale**: The reason Caramelo exists is to break the single-LLM
lock-in imposed by chat-first and vendor-first tools. Stating invariants
— rather than banning SDKs dogmatically — survives future vendors that
may actually satisfy the contract, while keeping the current ban intact
because today none do.

### II. Inline Visual UX (NON-NEGOTIABLE)

Common user actions — provider add/edit/delete, constitution editing,
phase approval, task execution, clarify/analyze/checklist — MUST be
reachable as inline controls in the sidebar webview, CodeLens buttons,
or the Caramelo editor menu. `QuickPick` and `InputBox` MUST NOT be used
for provider management; provider editing is state-driven and re-rendered
inline (`editingState` pattern). Long-running work MUST surface via the
status bar progress indicator (`src/progress.ts`), not modal
notifications. Streaming output MUST be written to the active editor
and/or the Caramelo Output Channel so the user can watch generation in
real time.

**Rationale**: The product is a *visual* spec-driven tool. Hiding flows in
the command palette or blocking modals regresses it to a chat-first tool
and contradicts validated user feedback already recorded in project
memory.

### III. Secrets Stay Secret

API keys, Jira tokens, and any per-provider credential MUST be stored in
VS Code `SecretStorage`. They MUST NOT be written to `settings.json`,
spec markdown, `.caramelo-meta.json`, or any file checked into the repo.
All logging MUST go through the redacting logger, which strips `Bearer` /
`Basic` tokens, `Authorization` headers, and embedded URL credentials.
Verbose debug logging MUST be gated behind the `CARAMELO_DEBUG=1`
environment variable and disabled by default. Tool-call arguments and
results that pass through the agent loop (Principle VII) MUST be
redacted by the same logger before reaching the Output Channel.

**Rationale**: The extension runs inside a shared editor that logs
generously by default; a single leaked token in the extension-host
output is a real incident. Defense-in-depth (secret storage + redaction
+ gated debug) is cheaper than an after-the-fact rotation.

### IV. Spec Kit Compatibility

Caramelo MUST remain interoperable with the GitHub Spec Kit CLI. Specs
live under `specs/` with the Spec Kit layout (`spec.md`, `plan.md`,
`tasks.md`, `research.md`, `data-model.md`, `contracts/`,
`checklists/`). Templates are synced from upstream Spec Kit releases; a
bundled offline fallback MUST ship with the extension so first-run and
air-gapped workflows succeed without network access. Caramelo-specific
state (phase status, stale flags, Jira links, …) belongs in
`.caramelo-meta.json` — never inside Spec Kit documents. On-disk schema
changes MUST be backward-compatible or ship with an automatic migration;
a newer Caramelo MUST still open a repository prepared by an older
Caramelo.

**Rationale**: Users are expected to move between Caramelo and the Spec
Kit CLI on the same repository. Diverging the on-disk format forks the
ecosystem and breaks the "any LLM, any tool" promise.

### V. Tested, Typed, Linted

Non-trivial modules MUST ship with Vitest coverage under
`src/**/__tests__/`. TypeScript strict mode is mandatory; `npx tsc
--noEmit` MUST pass. `npm test && npm run lint` MUST pass before merge;
this is the single required quality gate and is encoded in the project's
`Commands` guidance. Tests MUST NOT be skipped to unblock a merge — if a
test is wrong, fix the test in the same PR. Every public export from
`src/providers/`, `src/agent/`, `src/specs/`, and `src/speckit/` MUST
have declared TypeScript types (no implicit `any` at module boundaries).

**Rationale**: The extension mediates destructive operations (file
edits, bash via the agent loop, credential handling). Silent regressions
here cost user trust directly. Cheap, fast CI-style checks catch the
bulk of them before they reach the Extension Development Host.

### VI. Extensible Abstraction via Capabilities

The `LLMProvider` contract MUST expose a **capability set** that
describes what the underlying model can do — e.g. `streaming`,
`tool-calling`, `reasoning` / extended thinking, `prompt-caching`,
`citations`, `multimodal`, `vision`. Runtime code MUST branch on
**capabilities**, never on provider type strings. Any pattern of the
form `if (provider.type === 'anthropic') { … }` in business logic is a
PR blocker; route the check through a capability flag instead.

When a capability is absent, the feature MUST degrade gracefully:

- The UI affordance is hidden (not broken or no-op).
- The closest equivalent runs (e.g., providers without tool-calling
  fall back to the legacy SEARCH/REPLACE protocol controlled by
  `caramelo.useAgentLoop`).
- Or the request fails with a user-actionable message naming the missing
  capability and how to switch providers.

**Rationale**: The long-term risk of a fetch-only, uniform abstraction is
rigidity — vendors ship exclusive features (reasoning tokens, prompt
caching, file attachments) and the abstraction calcifies. Capabilities
keep the uniform UX while allowing vendor-specific features to surface
without fracturing the code.

### VII. Tool Calling as First-Class

The agent loop (`src/agent/`) is the **default execution model** whenever
the active provider declares the `tool-calling` capability;
`caramelo.useAgentLoop` defaults to `true` and the legacy single-shot
SEARCH/REPLACE protocol is retained only as a fallback for
non-tool-calling providers.

Tool-calling rules:

- Every tool MUST be declared in a typed registry with a JSON schema,
  TypeScript types, and runtime argument validation. Undeclared tools
  MUST be rejected before dispatch.
- The core tool inventory (`file_read`, `file_edit`, `grep`, `bash`,
  … and their successors) is a **stable contract**; adding, removing,
  or reshaping a tool requires a spec, a security review, and a
  migration note in the PR.
- Approval policy is a user-facing setting (`caramelo.agent.approval`),
  with `auto-reads-batched-writes` as the default and `auto-all` strictly
  opt-in. No code path may silently auto-execute `bash`.
- Tool arguments and results MUST pass through the redacting logger
  (Principle III) and be visible in the Output Channel (Principle IX).
- Providers without native tool-calling MUST inform the user (status bar
  / Output Channel) which execution mode is active — no silent drift
  between agent and legacy paths.
- Per-task iteration is bounded by `caramelo.agent.maxIterations`;
  runaway loops MUST terminate cleanly with a summary, not crash.

**Rationale**: SDD at scale means the LLM drives real edits, shell
commands, and searches — not just text generation. Treating tool calling
as a bolt-on produces fragile hacks; treating it as the default
execution path forces the abstraction, safety nets, and observability to
be first-class from day one.

### VIII. Recoverable by Default

Every destructive action the agent or a command performs MUST be
reversible by the user without manual forensics:

- When the workspace is a git repo, destructive operations (`file_edit`,
  multi-file writes, `bash` mutations) MUST be preceded by a git-safety
  stash so a single `git reset` restores clean state.
- When the workspace is **not** a git repo, the user is prompted unless
  `caramelo.tasks.allowWithoutGit` is explicitly enabled.
- Tools MUST NOT escape the workspace root: absolute paths outside the
  workspace, `..` escapes, and home-directory access require an explicit
  allow-list check; violations abort the tool call.
- Untrusted workspaces (per VS Code's workspace-trust API) MUST block
  all LLM execution and agent tool dispatch. Spec browsing MAY remain
  available read-only; no network calls are permitted in untrusted
  mode.
- `auto-all` approval mode assumes the git safety net is in place and
  MUST NOT be made the default under any circumstance.

**Rationale**: A world-class SDD tool writes code on the user's behalf
dozens of times per session. A single unrecoverable action destroys
trust permanently. Making reversibility architectural (not procedural)
lets the user experiment freely and keeps the blast radius of every
turn bounded.

### IX. Traceable Generation

The user MUST be able to answer "what exactly did the LLM see, and what
did it do?" for any phase generation or agent turn, without attaching a
debugger:

- Every LLM request logs (through the redacting logger) the active
  provider, model, capability set, and the composition of the prompt
  (constitution snapshot, prior phases referenced, templates applied).
- Every streamed chunk reaches the editor (for phase documents) or the
  Output Channel (for agent turns) in real time — no hidden generation.
- Every tool call logs its declared name, validated arguments, and
  result (redacted) to the Output Channel.
- Errors MUST surface **user-actionable** messages that name the
  likely cause and remedy (e.g. "401 from Claude — check the API key
  in Providers"; "timeout after 300000 ms — raise
  `caramelo.sse.timeoutMs` for slow local models"; "model `x` not found
  — click the provider dot to re-test"). Raw stack traces belong in
  debug logs only.
- The context assembly path is deterministic: given the same inputs
  (constitution, prior phases, templates, provider/model, approval
  policy), the same prompt is assembled. No hidden state, no
  time-varying context.

**Rationale**: SDD only works if the developer trusts the generation.
Hidden context, silent retries, and opaque failures are trust-destroying
defaults. Every action the agent takes should be as inspectable as
running the command by hand.

## Additional Constraints

- **Native `fetch` only.** No `openai`, `@anthropic-ai/sdk`,
  `@google/generative-ai`, `axios`, or other HTTP / LLM SDK dependencies
  may be added (see Principle I consequence). SSE parsing lives in
  `src/providers/sse.ts` and MUST handle abort + per-chunk timeouts
  (`caramelo.sse.timeoutMs`, minimum 5000 ms).
- **Bundle size.** The published VSIX bundle MUST stay small — target
  ≤ 250 KB compiled JS, with 170 KB as the current baseline to defend.
  Adding a runtime dependency requires a note in the PR explaining why
  it cannot be vendored or implemented inline.
- **Performance budget.** Extension activation ≤ 200 ms on a cold load;
  sidebar webview first paint ≤ 500 ms; no synchronous file I/O on the
  extension-host main thread; no webview operation may block keystrokes
  in the active editor.
- **Offline-first.** Template sync, constitution load, spec browsing,
  and provider configuration MUST work with no network. LLM generation
  is the only flow allowed to hard-fail without connectivity.
- **Agent approval defaults.** `caramelo.agent.approval` defaults to
  `auto-reads-batched-writes`; `caramelo.useAgentLoop` defaults to
  `true`; `caramelo.enableBashTool` defaults to `true` with per-call
  prompts; `caramelo.agent.maxIterations` defaults to 15 with a hard
  ceiling of 50. Changing any default requires an amendment PR.
- **Capability registry.** The authoritative list of provider
  capabilities (and the providers that declare them) lives under
  `src/providers/` and is covered by Vitest. Adding a capability
  requires (a) registry entry, (b) at least one provider supporting it,
  (c) graceful-degradation path for the rest, (d) tests.
- **Workspace-root boundary.** All file-system tools treat the VS Code
  workspace folder as the root. Breaking this boundary requires an
  explicit user-approved tool call and is always logged.

## Development Workflow & Quality Gates

- **Branching.** Feature branches off `main`, named by Spec Kit slug
  (`###-short-name`) when the change corresponds to a spec.
- **Manual verification.** Every PR that touches the extension host
  MUST be exercised via `F5` in an Extension Development Host before
  request-for-review. Type checks + unit tests are necessary but not
  sufficient for UI-affecting changes.
- **Phase gates.** Each Spec Kit phase (Requirements → Design → Tasks
  → Implementation) MUST be explicitly approved before the next
  unlocks; regeneration marks downstream phases stale.
- **Capability-based review.** Any new use of `provider.type ===
  '…'` or equivalent string dispatch in business logic is a PR
  blocker; route through a capability flag (Principle VI).
- **Tool-registry review.** PRs that add, remove, or reshape an agent
  tool MUST include: updated schema, tests in
  `src/agent/__tests__/`, a note on approval implications, and — if the
  tool touches the file system or shell — an explicit security review
  summary in the PR description.
- **Release checklist.** Before cutting a VSIX: `npm test && npm run
  lint` pass, `npx tsc --noEmit` pass, bundle size checked against the
  budget, `CHANGELOG` updated, manifest `version` bumped per SemVer,
  smoke test in Extension Development Host across at least one
  local provider (Ollama / LM Studio) and one hosted provider (Claude
  or OpenAI) with agent-loop on.
- **Commits.** Prefer focused commits; commit messages follow the
  existing repository style (short imperative subject line, scope
  prefix where useful, e.g. `feat:`, `fix:`, `release:`).

## Governance

This constitution supersedes ad-hoc conventions and prior informal
agreements. It does **not** override explicit user instructions in a
session; in-session overrides apply to that session only and MUST be
folded into an amendment if they are to become durable.

**Amendment procedure.** Proposed changes land as a PR that edits
`.specify/memory/constitution.md` together with every affected template
(`plan-template.md`, `spec-template.md`, `tasks-template.md`,
`CONTRIBUTING.md`, command docs). The PR description MUST include the
Sync Impact Report block produced by `/speckit.constitution` and justify
the version bump (or the lack of one, if the change lands during the
initial ratification window).

**Versioning policy.** The constitution uses SemVer independently of
the VSIX package version:

- **MAJOR** — a principle is removed or redefined in a
  backward-incompatible way, or governance rules change.
- **MINOR** — a new principle or section is added, or an existing
  principle is materially expanded.
- **PATCH** — wording, typo, or clarification changes with no semantic
  effect on enforcement.

Until the product ships its first public release (VSIX ≥ 0.1.0),
edits to this file MAY land under the initial ratification version
(1.0.0) rather than bumping, provided the Sync Impact Report makes the
expansion explicit. After first release, amendments MUST bump.

**Compliance review.** PR reviewers MUST verify compliance with the
principles in force on `main` at review time. Complexity that violates a
principle MUST be justified in the plan's `Complexity Tracking` section
or the PR description, with an explicit simpler alternative considered
and rejected. Runtime development guidance lives in `CLAUDE.md` (auto-
generated) and `CONTRIBUTING.md`; both must stay consistent with this
file.

**Version**: 1.0.0 | **Ratified**: 2026-04-23 | **Last Amended**: 2026-04-23
