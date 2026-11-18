---
description: "Task list for 013 Quick Spec Mode"
---

# Tasks: Quick Spec Mode

**Input**: Design documents from `/specs/013-quick-spec/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. The spec requires an end-to-end test (SC-003), and Constitution Principle V requires Vitest coverage for non-trivial modules. Within each story, write the test tasks first and confirm they fail before implementing.

**Organization**: Tasks are grouped by user story (spec.md) so each story can be implemented and tested independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: User story the task belongs to (US1–US4)

## Path Conventions

Single VS Code extension project:
- Source in `src/`, unit tests in `src/**/__tests__/` (Vitest).
- Extension-host e2e tests in `src/test/suite/` (`npm run test:smoke`; `xvfb-run -a` on headless Linux).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Register the new commands and setting.

- [ ] T001 Add `caramelo.generateQuickSpec`, `caramelo.approveQuickSpec` and `caramelo.promoteQuickSpec` to `contributes.commands`, and the `caramelo.quickSpec.enabled` setting (boolean, default `true`, scope `resource`, description from `specs/013-quick-spec/contracts/commands-settings.md`) to `contributes.configuration` in `package.json`
- [ ] T002 [P] Add `generateQuickSpec`, `approveQuickSpec` and `promoteQuickSpec` entries to `COMMAND_IDS` in `src/constants.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Pure, VS Code-free core shared by every story — parser, prompt builder and mode metadata.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 [P] Write failing Vitest tests for `parseQuickSpecOutput` covering every row of the parser table in `specs/013-quick-spec/contracts/llm-output-format.md`, in `src/specs/__tests__/quick-spec.test.ts`. Rows: ok; TOO_LARGE wins over FILE blocks; missing block; duplicated block; whole answer fenced; CRLF; 0 tasks; 9 tasks; leftover `[FEATURE NAME]` / `NEEDS CLARIFICATION` / `$ARGUMENTS`; preamble before the first block; text after `=== END ===`.
- [ ] T004 Implement `parseQuickSpecOutput(text): QuickSpecParse` and the `QuickSpecParse` type (`ok | too_large | invalid`, as in `specs/013-quick-spec/data-model.md`) in a new `src/specs/quick-spec.ts`, so that the tests from T003 pass
- [ ] T005 [P] Add `readSpecMode(dirPath): 'quick' | 'full'` (absent field means `full`), `writeSpecMode(dirPath, mode, promotedFrom?)` and `setAllPhaseStatuses(spec, status)` (one `writeMetadata` call that keeps other meta fields) to `src/specs/spec.ts`, with tests in `src/specs/__tests__/spec.test.ts`
- [ ] T006 Implement `buildQuickSpecPrompt({ name, description, constitution, issueContext?, grounded }): { system, user }` in `src/specs/quick-spec.ts`. It uses the condensed sections from `specs/013-quick-spec/research.md` §3, the exact output format from `contracts/llm-output-format.md`, the TOO_LARGE rule (> 8 tasks or several independent features), and read-only exploration instructions only when `grounded` is true. Add tests to `src/specs/__tests__/quick-spec.test.ts`: the constitution is included, grounding text appears only when grounded, and the format markers are present.

**Checkpoint**: The core parses and prompts correctly; `npx vitest run src/specs` is green.

---

## Phase 3: User Story 1 - Fix a bug from one sentence (Priority: P1) 🎯 MVP

**Goal**: Quick mode in the New Spec form. One generation produces spec.md, plan.md and tasks.md, one Approve approves all three, and Implement runs the existing Run All.

**Independent Test**: Create a quick spec from one sentence. The three Spec Kit files exist, one Approve unlocks Implement, and Run All completes the tasks with no prompt beyond the first-time write and shell questions.

### Tests for User Story 1

- [ ] T007 [P] [US1] Write Vitest tests for `generateQuickSpec` (text path) and `approveQuickSpec` in `src/commands/__tests__/quick-spec-commands.test.ts`, using the `vscode` mock and a fake `LLMProvider` whose `chat()` yields canned output. Cover:
  - ok writes all three files and leaves all phases `pending-approval`;
  - too_large writes nothing and resets the phases to `pending`;
  - invalid writes nothing and reports the problems;
  - a provider error resets to `pending`;
  - an untrusted workspace or `caramelo.quickSpec.enabled = false` refuses;
  - approve sets all three phases `approved` in one meta write.
- [ ] T008 [P] [US1] Write the e2e test `src/test/suite/quick-spec.test.ts`. Use the real `ClaudeProvider` against `MockAnthropicServer` (`src/test/suite/helpers/mock-llm-server.ts`) and the dialog-recorder pattern from `src/test/suite/sdd-flow.test.ts`. Flow: create quick → generate → approve → `runAllTasks` → `convergeTasks`. Assert there are no modals beyond the first write/shell questions and no per-task toasts. Add a second case where TOO_LARGE writes no files. Save and restore the fixture's workspace settings in suite setup and teardown. Skip on win32 (spec 008).

### Implementation for User Story 1

- [ ] T009 [US1] Implement `generateQuickSpec(specName, deps): Promise<'ok' | 'too_large' | 'invalid' | 'aborted'>` in a new `src/commands/quick-spec.ts`. Text path via `provider.chat()`. Steps, in order:
  1. Guard: active provider, workspace trust and `caramelo.quickSpec.enabled`.
  2. Run the `before_specify` hooks via `beginActionHooks('specify', …)` from `src/speckit/hook-runner-vscode.ts`.
  3. Set all phases to `generating` and show a cancellable status bar progress (`src/progress.ts`).
  4. Build the prompt (T006), call the provider and parse (T004).
  5. On ok, write the three files, set all phases to `pending-approval`, run the `after_tasks` hooks and open `spec.md`.
  6. Otherwise reset to `pending`, write nothing, and store the outcome for the sidebar notice.
  7. Log the prologue, the parse result and errors to the Caramelo output channel.
- [ ] T010 [US1] Implement `approveQuickSpec(specName, deps)` in `src/commands/quick-spec.ts`. It sets all three phases `approved` with `setAllPhaseStatuses`, refreshes the sidebar and CodeLens, and shows no "Generate next phase" toast.
- [ ] T011 [US1] Register the three commands in `src/extension.ts`. Route quick specs to the quick-spec functions:
  - `runPhase` → `generateQuickSpec`, in `src/commands/run-phase.ts`, checked with `readSpecMode`; this also covers `regeneratePhase`, which calls `runPhase`;
  - `approvePhase` → `approveQuickSpec`, in `src/commands/approve-phase.ts`.
- [ ] T012 [US1] Add a Full | Quick segmented control to `renderNewSpecForm` in `src/views/sidebar/workflow-view.ts`, with Full as the default. Add the optional `mode` field to the `createSpec` message and validate it in `parseMessage`.
  - `handleCreateSpec` writes `mode: "quick"` and calls `caramelo.generateQuickSpec` directly, without the "Generate Requirements" toast.
  - Quick requires a non-empty description: show an inline red border, as for the name field.
- [ ] T013 [US1] Render the quick spec card in `src/views/sidebar/workflow-view.ts`:
  - a "Generating quick spec…" state;
  - a single **Approve** button when all phases are `pending-approval`;
  - **Implement** (existing `runAllTasks` message) when all are approved;
  - an inline notice for the too_large and invalid outcomes, carrying the reason and a **Create full spec instead** button (`createFullInstead` message, contract in `contracts/webview-messages.md`).
  Escape all text.
- [ ] T014 [P] [US1] In `src/views/codelens/phase-actions-codelens.ts`, show **Approve quick spec** on `spec.md`, `plan.md` and `tasks.md` of a quick spec, instead of the per-phase Approve / Next Phase lenses.

**Checkpoint**: US1 is fully functional with any provider. T007 and T008 pass.

---

## Phase 4: User Story 2 - The agent grounds the quick spec in the real code (Priority: P1)

**Goal**: With a tool-calling provider, generation explores the codebase using read-only tools, so the plan names real files.

**Independent Test**: In a repository with a known bug location, the generated plan names that file. The request offers only read-only tools, and no dialog appears.

### Tests for User Story 2

- [ ] T015 [P] [US2] Add Vitest tests to `src/commands/__tests__/quick-spec-commands.test.ts`:
  - for a tool-calling fake provider, `generateQuickSpec` runs the agent with exactly the tools from `buildReadOnlyToolSet()` and writes the terminal artifact (`pickTerminalArtifact`);
  - for a non-tool-calling provider, it uses `chat()` and logs that grounding was unavailable;
  - cancellation and max-iterations leave nothing written.
- [ ] T016 [US2] Extend `src/test/suite/quick-spec.test.ts`: the mock server answers the first request with a `grep` tool_use and the second with the three FILE blocks naming the grepped path. Assert:
  - the request's `tools` contain only `file_read`, `list_dir`, `grep` and `glob`;
  - no modal is shown;
  - `plan.md` contains the path.

### Implementation for User Story 2

- [ ] T017 [US2] Add the agent path to `generateQuickSpec` in `src/commands/quick-spec.ts`. When `isToolCallingProvider(provider)` is true, run `AgentRuntime` with:
  - `buildReadOnlyToolSet()` and `readOnlyAutoBatchedWritesPolicy()`;
  - `pipeToOutputChannel` and a `formatPrologue` prologue;
  - `caramelo.agent.maxIterations`;
  - `buildQuickSpecPrompt({ grounded: true })`.
  Take the result with `pickTerminalArtifact` from `src/specs/workflow.ts`, and handle `cancelled`, `error` and `max_iterations` like `generatePhaseViaAgent`.
- [ ] T018 [US2] For providers without tool calling, log `↪ provider "<name>" has no tool calling — quick spec generated without exploring the codebase` and show the same hint in the card's generating state, in `src/commands/quick-spec.ts` and `src/views/sidebar/workflow-view.ts`.

**Checkpoint**: US1 and US2 both work. Grounded plans name real paths.

---

## Phase 5: User Story 3 - Promote a quick spec when it grows (Priority: P2)

**Goal**: **Promote to full spec** switches to the three-gate flow and keeps the content.

**Independent Test**: Promote a quick spec. Phases become individually approvable and regenerable, and the files are unchanged.

### Tests for User Story 3

- [ ] T019 [P] [US3] Add Vitest tests for `promoteQuickSpec` to `src/commands/__tests__/quick-spec-commands.test.ts`:
  - the meta becomes `mode: "full"`, `promotedFrom: "quick"`;
  - each phase whose file exists becomes `pending-approval`, the others `pending`;
  - file contents are unchanged;
  - `createFullInstead` promotes and then runs the requirements phase.

### Implementation for User Story 3

- [ ] T020 [US3] Implement `promoteQuickSpec(specName, deps)` in `src/commands/quick-spec.ts`, using `writeSpecMode` and per-phase status rules from `specs/013-quick-spec/data-model.md`
- [ ] T021 [US3] Add a **Promote to full spec** button to the quick card, and handle the `promoteQuickSpec` and `createFullInstead` messages (promote, then `caramelo.runPhase` requirements), in `src/views/sidebar/workflow-view.ts`
- [ ] T022 [P] [US3] Add a **Promote to full spec** CodeLens on quick spec documents in `src/views/codelens/phase-actions-codelens.ts`
- [ ] T023 [US3] Extend `src/test/suite/quick-spec.test.ts` with a promote case: after promotion, `approvePhase(requirements)` approves only requirements, and `runPhase(design)` is allowed.

**Checkpoint**: US1–US3 work independently.

---

## Phase 6: User Story 4 - Teams see which specs were quick (Priority: P3)

**Goal**: Quick specs are visibly marked, and a team can turn Quick off.

**Independent Test**: The badge shows in the sidebar and the Workflow Map. With `caramelo.quickSpec.enabled = false`, the Quick option is absent and a `createSpec` message with `mode: "quick"` is refused.

- [ ] T024 [US4] Add a `quick` badge to the spec card, with CSS for both themes, in `src/views/sidebar/workflow-view.ts`. Hide the Full | Quick control when `caramelo.quickSpec.enabled` is false, and refuse `mode: "quick"` in `handleCreateSpec` in that case. Add tests in `src/views/sidebar/__tests__/workflow-view.test.ts`.
- [ ] T025 [P] [US4] Show a `quick` badge on quick specs' feature node in `src/views/webview/dag-view.ts`. Add `mode` to `DagData` and keep `buildDagHtml` escaping. Add tests in `src/views/webview/__tests__/dag-view.test.ts`.

**Checkpoint**: All user stories are complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T026 Amend the "Phase gates" rule in `.specify/memory/constitution.md` to allow one explicit approval for a quick spec's three documents. Bump the version 1.1.0 → 1.2.0, update Last Amended, and add a Sync Impact Report entry.
- [ ] T027 Add a Spec Kit compatibility test to `src/specs/__tests__/quick-spec.test.ts`: a generated quick spec folder contains only `spec.md`, `plan.md`, `tasks.md` and `.caramelo-meta.json`, and the meta keeps the `phases` keys Spec Kit tooling expects (SC-004).
- [ ] T028 [P] Document Quick Spec:
  - README feature bullet (Visual Workflow section) in `README.md`;
  - `[Unreleased] → Added` entry in `CHANGELOG.md`;
  - a "Quick Spec" section in `website/guide/workflow.md`.
- [ ] T029 Run the quickstart validation: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build` and `xvfb-run -a npm run test:smoke`. All must be green, and `specs/013-quick-spec/quickstart.md` steps must be verified in the Extension Development Host.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** has no dependencies.
- **Foundational (Phase 2)** depends on Setup and blocks all stories.
- **US1 (Phase 3)** depends on Foundational. This is the MVP.
- **US2 (Phase 4)** depends on US1: it extends `generateQuickSpec`.
- **US3 (Phase 5)** depends on Foundational and T009–T011. It can run in parallel with US2.
- **US4 (Phase 6)** depends on Foundational and T012–T013. It can run in parallel with US2 and US3.
- **Polish (Phase 7)** depends on all desired stories.

### Within Each User Story

- Write the tests first and see them fail.
- Core (`src/specs/quick-spec.ts`) before commands (`src/commands/quick-spec.ts`), and commands before UI (sidebar, CodeLens, DAG).
- Tasks touching the same file run sequentially. `src/views/sidebar/workflow-view.ts` is touched by T012, T013, T018, T021 and T024, so those run in that order.

### Parallel Opportunities

- T001 ∥ T002.
- T003 ∥ T005, then T004 and T006 in sequence (both touch `src/specs/quick-spec.ts`).
- T007 ∥ T008 (different files), and T014 ∥ T012/T013.
- After US1: US2 (T015–T018) ∥ US3 (T019–T022), except that sidebar edits are serialized. T025 ∥ anything not touching `dag-view.ts`.
- T028 ∥ T027.

---

## Parallel Example: User Story 1

```bash
# Tests first, in parallel:
Task: "T007 [P] [US1] Vitest tests for generateQuickSpec/approveQuickSpec in src/commands/__tests__/quick-spec-commands.test.ts"
Task: "T008 [P] [US1] E2E create→generate→approve→Run All→converge in src/test/suite/quick-spec.test.ts"

# Then the CodeLens work alongside the sidebar work:
Task: "T014 [P] [US1] Approve quick spec CodeLens in src/views/codelens/phase-actions-codelens.ts"
Task: "T012 [US1] Full | Quick control in src/views/sidebar/workflow-view.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1).
2. **Stop and validate**: T007 and T008 are green, and the quickstart steps work with any provider.
3. Shippable on its own as "Quick Spec (beta)". Grounding arrives with US2.

### Incremental Delivery

1. MVP (US1): quick specs exist, with a single approval.
2. US2: grounded plans with tool-calling providers. This is the quality jump.
3. US3: promote when a change grows.
4. US4: badges and the team switch.
5. Polish: constitution 1.2.0, docs and the full validation run.

---

## Notes

- Keep every LLM-facing format exactly as in `contracts/llm-output-format.md`; the parser and prompt share it.
- Never write partial files: write the three documents only after the parse is `ok`.
- Use no QuickPick or InputBox (Principle II). All new UI lives in the sidebar, CodeLens and status bar.
- Commit after each task or logical group.
