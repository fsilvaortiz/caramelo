# Feature Specification: Modular Views & Declarative Command Registration

**Feature Branch**: `011-modular-views-commands`  
**Created**: 2026-11-13  
**Status**: Draft  
**Input**: User description: "Split the monolithic sidebar webviews (providers-view ~1280 lines, workflow-view ~1150) and large command modules (edit-constitution ~840, start-task ~650) into testable state/render/asset pieces, register commands from a declarative table with a test that keeps it in sync with package.json, and update CONTRIBUTING.md to the real project structure. No user-visible behavior change."

## Context

The two sidebar views mix state, message handling, HTML templates, CSS and client script in one file, so most of their logic is untested (see feature 010) and every change risks side effects. `extension.ts` registers 28 commands by hand while `package.json` declares 35, with nothing ensuring they match. CONTRIBUTING.md describes a structure that predates `agent/`, `constitution/` and `utils/`. This is a pure refactor: users must not notice any difference.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Contributor changes a sidebar view safely (Priority: P1)

A contributor fixing a Providers or Workflow sidebar bug finds state logic, message handling and rendering in separate, small modules, and can cover the fix with a unit test without launching VS Code.

**Why this priority**: These are the largest, most-edited and least-tested files.

**Independent Test**: After the split, write a unit test for a Providers-view state transition (e.g. start/cancel inline rename) without the HTML renderer or VS Code.

**Acceptance Scenarios**:

1. **Given** the refactored views, **When** a contributor opens any view module, **Then** no module exceeds ~400 lines and each has a single responsibility (state, messages, render, static assets).
2. **Given** the view's state module, **When** unit tests run, **Then** state transitions and message handling are tested without a webview.
3. **Given** the refactor, **When** a user uses every sidebar feature, **Then** behavior and appearance are identical to before.

---

### User Story 2 - Commands cannot drift from the manifest (Priority: P2)

A contributor adding a command declares it in one table; a test fails if a command in `package.json` has no handler, or a handler has no manifest entry (unless explicitly internal).

**Why this priority**: Drift produces "command not found" errors for users.

**Independent Test**: Add a command to `package.json` without a handler; the test fails naming it.

**Acceptance Scenarios**:

1. **Given** the command table, **When** tests run, **Then** every contributed command has exactly one handler and vice versa (minus an explicit internal allow-list).
2. **Given** activation, **When** the extension starts, **Then** all commands are registered from the table and disposed on deactivation.

---

### User Story 3 - Large commands are split into core and UI (Priority: P3)

Constitution editing and task execution keep their pure logic (prompt building, parsing, file updates) in `*-core` modules like the existing converge-core, tested in isolation.

**Why this priority**: Improves testability; lower urgency than the views.

**Independent Test**: Unit tests exercise task-execution core logic with a fake provider and no VS Code.

**Acceptance Scenarios**:

1. **Given** the split, **When** tests run, **Then** constitution and start-task core logic each have dedicated tests.

---

### User Story 4 - CONTRIBUTING reflects reality (Priority: P3)

A new contributor reads CONTRIBUTING.md and finds the current directory layout, the test commands (unit + smoke) and where to add a view, command, provider or agent tool.

**Independent Test**: Every top-level `src/` directory is described in CONTRIBUTING.md.

**Acceptance Scenarios**:

1. **Given** CONTRIBUTING.md, **When** compared with `src/`, **Then** every directory is listed with its purpose.

### Edge Cases

- Webview static assets moved to files must still load offline and under the strict policy from feature 007.
- Views with `retainContextWhenHidden` must keep their state across hide/show after the split.
- Commands registered conditionally (e.g. depending on workspace trust) must be represented in the table.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each sidebar webview MUST be split into state, message handling, HTML rendering and static assets (CSS/JS files loaded from extension resources).
- **FR-002**: No resulting module in `views/` SHOULD exceed ~400 lines.
- **FR-003**: State and message handling MUST be unit-testable without a webview and MUST have tests.
- **FR-004**: Commands MUST be registered from a single declarative table.
- **FR-005**: A test MUST assert the table and `package.json` contributed commands match, with an explicit allow-list for internal commands.
- **FR-006**: Constitution editing and task execution MUST have their pure logic extracted into core modules with tests.
- **FR-007**: CONTRIBUTING.md MUST describe the current structure and test workflow.
- **FR-008**: There MUST be no user-visible behavior or appearance change; smoke tests MUST pass unchanged.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Largest file under `src/views/` drops from ~1280 lines to ≤ 400.
- **SC-002**: 0 mismatches between contributed and registered commands, enforced by test.
- **SC-003**: Existing smoke and unit suites pass with no test modified except for import paths.
- **SC-004**: Unit coverage of `src/views/` rises from near zero to at least 60% lines.

## Assumptions

- Depends on feature 007 (shared webview builder) and benefits from 010 (coverage reporting); should be sequenced after them.
- No UI framework is introduced; rendering stays template-string based to respect the bundle budget.
