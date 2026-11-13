# Feature Specification: Test Coverage Gate

**Feature Branch**: `004-test-coverage-gate`  
**Created**: 2026-11-13  
**Status**: Draft  
**Input**: User description: "Measure unit-test coverage in CI, prevent it from dropping, and add tests for the non-trivial modules that currently have none (analyze, select-provider, create-spec-from-jira, run/approve phase, task-edits diff preview and prompt, codelens providers, specs workspace, templates, jira provider, openai-compatible provider)."

## Context

The suite is healthy (594 Vitest tests, all passing, plus VS Code smoke tests on three OSes), but coverage is not measured, and Constitution Principle V requires non-trivial modules to ship with Vitest coverage. Roughly 40 source modules have no dedicated test file; some are covered indirectly, others (e.g. `analyze`, `select-provider`, CodeLens providers) not at all.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Maintainers see coverage on every PR (Priority: P1)

A maintainer opening a pull request sees the overall and per-directory coverage in the CI summary, and CI fails if overall coverage drops below the agreed floor.

**Why this priority**: Without measurement, the other stories cannot be verified and regressions go unnoticed.

**Independent Test**: Open a PR deleting a test file; CI reports lower coverage and fails the gate.

**Acceptance Scenarios**:

1. **Given** a PR, **When** CI runs unit tests, **Then** a coverage summary (lines, branches, functions; overall and per top-level directory) is published in the job summary.
2. **Given** coverage below the floor, **When** CI runs, **Then** the unit job fails with a message stating current vs required coverage.
3. **Given** a local run, **When** a contributor runs the coverage script, **Then** they get the same report and an HTML report locally.

---

### User Story 2 - Risky untested modules gain tests (Priority: P2)

The modules that parse LLM output, compute CodeLens ranges, choose providers or import Jira issues get dedicated tests, so refactors (feature 005) can proceed safely.

**Why this priority**: These modules hold the logic most likely to regress silently.

**Independent Test**: Each listed module has a test file under its `__tests__/` directory exercising its main paths and error paths.

**Acceptance Scenarios**:

1. **Given** an analysis document with findings of each severity, **When** the analysis CodeLens provider runs, **Then** it emits one fix action per finding plus "fix all", at the correct lines.
2. **Given** a tasks document with completed, pending and `[P]` tasks, **When** the tasks CodeLens provider runs, **Then** it emits Run Task / Run All actions only where applicable.
3. **Given** a Jira issue with description, acceptance criteria and comments, **When** a spec is created from it, **Then** the generated input contains all of them and the spec is linked to the issue key.
4. **Given** malformed or partial LLM output, **When** analyze parses it, **Then** it reports a clear error instead of crashing.

---

### User Story 3 - Floor rises over time (Priority: P3)

The coverage floor is raised as tests are added, so gains are locked in.

**Why this priority**: Prevents backsliding after the push.

**Independent Test**: After story 2 merges, the floor in configuration is higher than the initial baseline.

**Acceptance Scenarios**:

1. **Given** story 2 is complete, **When** the floor is updated, **Then** it equals the new measured coverage rounded down to the nearest whole percent.

### Edge Cases

- Files that cannot be unit-tested without a real VS Code (pure glue, `extension.ts`) are excluded explicitly and documented, not silently.
- Coverage must not be collected from tests, mocks, fixtures or the smoke-test suite.
- Coverage collection must not make the unit job noticeably slower on Windows/macOS runners.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: CI MUST collect line, branch and function coverage for unit tests and publish a summary on every PR.
- **FR-002**: CI MUST fail when overall line coverage falls below a configured floor; the initial floor MUST equal the measured baseline at the time of adoption (rounded down).
- **FR-003**: Contributors MUST be able to produce the same report locally with one documented command.
- **FR-004**: Exclusions MUST be listed in configuration with a reason for each.
- **FR-005**: Dedicated unit tests MUST be added for: analyze, select-provider, create-spec-from-jira, run-phase, approve-phase, generate-checklist, task-edits diff-preview and prompt, the three CodeLens providers, specs workspace, speckit templates, jira provider, and the OpenAI-compatible provider's streaming/non-tool paths.
- **FR-006**: New tests MUST use the existing `vscode` mock and MUST NOT require network access.
- **FR-007**: CONTRIBUTING.md MUST document the coverage command and floor policy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Coverage is reported on 100% of PRs after adoption.
- **SC-002**: Every module listed in FR-005 has a dedicated test file.
- **SC-003**: Overall line coverage increases by at least 10 percentage points over the baseline after story 2.
- **SC-004**: Unit test wall time stays under 15 s locally.

## Assumptions

- Coverage tooling is a dev dependency only; it does not affect the shipped bundle.
- Smoke tests (VS Code Electron) are not included in coverage.
