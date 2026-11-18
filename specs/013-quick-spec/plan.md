# Implementation Plan: Quick Spec Mode

**Branch**: `013-quick-spec` | **Date**: 2026-11-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-quick-spec/spec.md`

## Summary

Add a **Quick** mode to the New Spec form. One description produces `spec.md`, `plan.md` and `tasks.md` in a single LLM run. The three documents are short and condensed, and the run is grounded by read-only agent tools when the provider supports tool calling. The documents come back in one response, separated by `=== FILE: … ===` blocks. A pure parser validates them, and only then are they written together. One **Approve** marks all three phases approved; **Implement** then runs the existing Run All path unchanged. **Promote to full spec** switches the spec back to the three-gate flow, keeping its content. The mode lives only in `.caramelo-meta.json` (`"mode": "quick"`), so the files stay plain Spec Kit.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 22 (VS Code extension host ≥ 1.95)  
**Primary Dependencies**: VS Code extension API only. LLM access goes through the existing `LLMProvider` adapters (native `fetch`); no new runtime dependency.  
**Storage**: Files under `specs/<feature>/` (`spec.md`, `plan.md`, `tasks.md`) plus `.caramelo-meta.json`  
**Testing**: Vitest unit tests (`src/**/__tests__/`), plus extension-host e2e (`src/test/suite/`) against `MockAnthropicServer` and `MockLLMProvider`  
**Target Platform**: VS Code desktop on Linux, macOS and Windows; also Cursor, Windsurf and VSCodium once Open VSX publishing exists  
**Project Type**: VS Code extension (single project)  
**Performance Goals**: One-sentence bug fix to "tasks running" in < 60 s on a typical cloud model (SC-002); parsing and writing < 50 ms  
**Constraints**: Bundle budget (Constitution: ≤ 250 KB target). No QuickPick/InputBox (Principle II). Read-only tools only during generation (FR-004). Spec Kit compatible files (Principle IV).  
**Scale/Scope**: About 2 new modules, about 6 touched modules, 3 new commands, 1 new setting

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Derived from `.specify/memory/constitution.md` v1.1.0.

- [x] **I. LLM-Agnostic by Adapter Invariants**: PASS. Uses `chat()` / `chatWithTools()` through the existing adapters. No SDKs and no new provider code.
- [x] **II. Inline Visual UX**: PASS. The mode is a toggle inside the existing sidebar form. Approve, Promote and Implement are sidebar buttons and CodeLens. Progress is shown in the status bar. The "too large" outcome is an inline sidebar notice with a button, not a modal.
- [x] **III. Secrets Stay Secret**: PASS. No credentials are involved. Prompts and tool I/O already go through the redacting pipeline (`pipeToOutputChannel`).
- [x] **IV. Spec Kit Compatibility**: PASS. The files are the standard three. The only addition is `mode` (plus `promotedFrom`) in `.caramelo-meta.json`, which Spec Kit ignores. Specs without `mode` are full specs, so existing specs need no migration.
- [x] **V. Tested, Typed, Linted**: PASS (planned). Unit tests cover the parser, prompt builder and state transitions. E2E tests cover the quick flow with zero extra prompts and the non-tool-calling fallback.
- [x] **VI. Extensible Abstraction via Capabilities**: PASS. Grounding branches on `isToolCallingProvider(provider)`, never on provider type. Without the capability, generation falls back to text and says so.
- [x] **VII. Tool Calling as First-Class**: PASS. Reuses `buildReadOnlyToolSet()`. No new tools. Writes and shell commands are impossible during generation.
- [x] **VIII. Recoverable by Default**: PASS. Generation writes only inside the spec folder. Implementation reuses Run All, which takes the git safety stash. Untrusted workspaces are blocked as in `runPhase`.
- [x] **IX. Traceable Generation**: PASS. A prologue, tool calls and the parse result go to the Output channel. Failures name their cause (missing section, too large, provider error).
- [ ] **Development Workflow → Phase gates**: AMENDMENT NEEDED. "Each Spec Kit phase … MUST be explicitly approved before the next unlocks." A quick spec approves three phases in **one** explicit gate. This is recorded in Complexity Tracking, and the constitution will be amended (1.1.0 → 1.2.0) to allow one explicit gate for a quick spec.

## Project Structure

### Documentation (this feature)

```text
specs/013-quick-spec/
├── plan.md              # This file
├── research.md          # Phase 0: decisions
├── data-model.md        # Phase 1: meta schema, states, generation result
├── quickstart.md        # Phase 1: how to try / verify it
├── contracts/
│   ├── llm-output-format.md   # what the model must return, and how it is parsed
│   ├── webview-messages.md    # sidebar ↔ extension messages
│   └── commands-settings.md   # contributed commands and setting
└── tasks.md             # Phase 2 (/speckit.tasks), not created here
```

### Source Code (repository root)

```text
src/
├── specs/
│   ├── quick-spec.ts                 # NEW, pure: prompt builder, output parser, size guard, mode helpers
│   ├── spec.ts                       # + readSpecMode / writeSpecMode (meta "mode", "promotedFrom")
│   └── __tests__/quick-spec.test.ts  # NEW
├── commands/
│   ├── quick-spec.ts                 # NEW: generateQuickSpec, approveQuickSpec, promoteQuickSpec
│   ├── run-phase.ts                  # a quick spec's phases route to generateQuickSpec (regenerate all three)
│   └── __tests__/quick-spec-commands.test.ts  # NEW (vscode mock)
├── views/
│   ├── sidebar/workflow-view.ts      # Full/Quick toggle; quick card: badge, single Approve, Promote, Implement
│   ├── codelens/phase-actions-codelens.ts  # on a quick spec's docs: "Approve quick spec" / "Promote"
│   └── webview/dag-view.ts           # "quick" badge on the feature node
├── constants.ts                      # COMMAND_IDS: generateQuickSpec, approveQuickSpec, promoteQuickSpec
└── extension.ts                      # register the 3 commands

src/test/suite/quick-spec.test.ts     # NEW e2e: real ClaudeProvider + MockAnthropicServer
package.json                          # commands + caramelo.quickSpec.enabled
.specify/memory/constitution.md       # amend Phase gates (1.2.0)
```

**Structure Decision**: single VS Code extension project. Pure logic goes in `src/specs/quick-spec.ts` so it is unit-testable without VS Code. Orchestration, UI and LLM calls go in `src/commands/quick-spec.ts`. This mirrors the existing `converge-core.ts` / `converge.ts` split.

## Implementation Approach

1. **Pure core** (`src/specs/quick-spec.ts`):
   - `buildQuickSpecPrompt({ name, description, constitution, issueContext?, grounded })` returns `{ system, user }`.
   - `parseQuickSpecOutput(text)` returns `{ kind: 'ok', spec, plan, tasks } | { kind: 'too_large', reason } | { kind: 'invalid', problems[] }`. It validates: all three sections present; tasks in Spec Kit checklist format with 1–8 tasks; no placeholder text left.
   - Mode helpers.
2. **Generation** (`generateQuickSpec`):
   - Checks provider, workspace trust and `caramelo.quickSpec.enabled`.
   - Sets all phases to `generating` and shows status bar progress.
   - With a tool-calling provider: runs the agent with the read-only tool set and the shared approval policy (reads only, so it never prompts), then takes `pickTerminalArtifact`. Otherwise it calls `chat()` and logs "grounding not available".
   - Parses the output. On `ok`, writes the three files and sets all phases to `pending-approval`. On `too_large`, resets to `pending` and shows the sidebar notice with **Create full spec instead**. On `invalid`, resets to `pending`, keeps no partial files and reports the problems.
   - Runs the `specify` hooks before and `tasks` hooks after, same as the phases they replace.
3. **Approval** (`approveQuickSpec`): marks all three phases `approved` in one write and refreshes the sidebar and CodeLens. It shows no follow-up "Generate next phase" toast; the card shows **Implement**.
4. **Promote** (`promoteQuickSpec`): sets `mode: "full"` and `promotedFrom: "quick"`. Every phase whose file exists becomes `pending-approval`; the rest become `pending`. The full-flow controls appear.
5. **Routing**:
   - `runPhase` / `regeneratePhase` on a quick spec call `generateQuickSpec`, which regenerates all three documents together (edge case in the spec).
   - CodeLens and the editor menu show quick actions on any of the three documents.
6. **UI**:
   - The form gets a two-option segmented control (Full | Quick, Full by default), hidden when `caramelo.quickSpec.enabled = false`.
   - Creating a quick spec starts generation immediately, with no "Generate Requirements" toast.
   - The card shows a `quick` badge, one Approve, Promote and Implement. The DAG shows a badge.
7. **Constitution**: amend the Phase gates bullet and bump the version to 1.2.0 with a Sync Impact Report.
8. **Docs**: README feature bullet, CHANGELOG `[Unreleased]`, website guide page section.

## Testing Strategy

- **Unit**:
  - Parser: valid output; missing or duplicated section; fenced output; CRLF line endings; 0 or 9 tasks; `TOO_LARGE`; leftover placeholders.
  - Prompt builder: constitution included; grounding instructions only when grounded.
  - Meta: specs without `mode` are full; promote transitions.
  - `approveQuickSpec` writes one meta update.
- **E2E** (`MockAnthropicServer` + real `ClaudeProvider`), each with a dialog recorder that asserts zero modals beyond the existing first-write/shell questions:
  - Create quick, generate (with one `grep` tool call), approve, Run All, converge.
  - `TOO_LARGE`: no files are written and the notice is shown.
  - Promote: phases become individually approvable.
- **E2E (`MockLLMProvider`)**: non-tool-calling path produces the three files and logs the fallback.
- **Compatibility**: a test asserts that a quick spec folder contains only Spec Kit files plus `.caramelo-meta.json`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| One approval gate for three phases (Development Workflow → Phase gates) | Three gates for a ten-line fix is the main reason developers skip spec-driven work (spec Context). The gate stays explicit; it covers three short documents reviewed together. | *Keep three gates for quick specs*: defeats the feature. *Auto-approve quick specs*: removes the explicit human gate entirely, which is worse than one combined gate. |
