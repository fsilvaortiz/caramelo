# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]  
**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]  
**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]  
**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]  
**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]
**Project Type**: [e.g., library/cli/web-service/mobile-app/compiler/desktop-app or NEEDS CLARIFICATION]  
**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]  
**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]  
**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Derived from `.specify/memory/constitution.md` v1.0.0. Mark each gate
PASS / FAIL / N/A with a one-line justification. Any FAIL must be
resolved in design or recorded in `Complexity Tracking` below with a
rejected simpler alternative.

- [ ] **I. LLM-Agnostic by Adapter Invariants** — No new vendor SDK
      dependency; any new provider-facing code routes through
      `LLMProvider` (`src/providers/types.ts`) and preserves the four
      invariants (redacting transport, abortable per-chunk-timeout
      streaming, `authHeader` / `authPrefix` pass-through, bundle
      budget).
- [ ] **II. Inline Visual UX** — User-facing actions surface inline
      (sidebar webview, CodeLens, editor menu); no new `QuickPick` or
      `InputBox` for provider management; long-running work reports via
      status bar progress, not modal notifications.
- [ ] **III. Secrets Stay Secret** — Any new credential is stored in
      `SecretStorage`; no secrets written to settings, specs,
      `.caramelo-meta.json`, or logs; every new log site goes through
      the redacting logger; tool-call I/O is redacted before hitting
      the Output Channel.
- [ ] **IV. Spec Kit Compatibility** — On-disk layout under `specs/`
      follows Spec Kit (`spec.md`, `plan.md`, `tasks.md`, …); Caramelo-
      only state stays in `.caramelo-meta.json`; bundled offline
      fallback still works; schema changes are backward-compatible or
      ship a migration.
- [ ] **V. Tested, Typed, Linted** — Non-trivial modules have Vitest
      coverage under `src/**/__tests__/`; `npm test && npm run lint`
      and `npx tsc --noEmit` are expected to pass in CI; public
      exports at package boundaries are fully typed.
- [ ] **VI. Extensible Abstraction via Capabilities** — New vendor
      features are exposed through the capability set; no new
      `provider.type === '…'` dispatch in business logic; absent
      capabilities degrade gracefully (affordance hidden, fallback
      taken, or user-actionable failure).
- [ ] **VII. Tool Calling as First-Class** — New agent tools are
      declared in the typed registry with JSON schema, runtime
      validation, and Vitest coverage; approval policy respects
      `caramelo.agent.approval`; non-tool-calling providers degrade to
      the legacy protocol with explicit user feedback.
- [ ] **VIII. Recoverable by Default** — Destructive operations go
      through the git-safety stash when the workspace is a git repo;
      non-git workspaces prompt unless
      `caramelo.tasks.allowWithoutGit`; tool calls respect the
      workspace-root boundary; untrusted workspaces block LLM
      execution.
- [ ] **IX. Traceable Generation** — Prompt composition, streamed
      output, and tool-call I/O are observable in the Output Channel;
      errors surface user-actionable messages naming cause and
      remedy; context assembly is deterministic given the same inputs.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
