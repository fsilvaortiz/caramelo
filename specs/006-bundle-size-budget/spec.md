# Feature Specification: Bundle Size & Activation Budget

**Feature Branch**: `006-bundle-size-budget`  
**Created**: 2026-11-13  
**Status**: Draft  
**Input**: User description: "The compiled extension bundle is ~740 KB unminified while the constitution targets ≤ 250 KB. Minify production builds, enforce a size budget in CI, measure activation time, and lazy-load heavy subsystems so Caramelo starts fast."

## Context

The constitution's Additional Constraints set a bundle target of ≤ 250 KB compiled JS (170 KB baseline) and an activation budget of ≤ 200 ms cold, ≤ 500 ms sidebar first paint. The current production build (`dist/extension.js`) is ~740 KB and unminified, and nothing in CI measures size or activation time, so the budget is silently exceeded. Users pay for this on every VS Code start in workspaces containing `.specify`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Published extension meets the size budget (Priority: P1)

A user installs Caramelo from the Marketplace and downloads/loads a bundle within the constitution's budget.

**Why this priority**: It is an explicit constitutional constraint currently violated.

**Independent Test**: Build the release package; the main bundle is ≤ 250 KB.

**Acceptance Scenarios**:

1. **Given** a release build, **When** it is packaged, **Then** the main JS bundle is minified and ≤ 250 KB.
2. **Given** a minified build, **When** an error occurs, **Then** stack traces can still be mapped to source by maintainers (source maps produced but not shipped).

---

### User Story 2 - CI prevents size regressions (Priority: P1)

A contributor whose PR grows the bundle beyond the budget sees CI fail with the before/after size and the budget.

**Why this priority**: Without enforcement the budget erodes again.

**Independent Test**: Add a large dependency in a scratch PR; CI fails with a size report.

**Acceptance Scenarios**:

1. **Given** a PR, **When** CI builds, **Then** the bundle size and delta vs `main` are reported in the job summary.
2. **Given** size > budget, **When** CI runs, **Then** the job fails naming the budget and actual size.

---

### User Story 3 - Fast activation (Priority: P2)

A developer opens a workspace with `.specify`; Caramelo activates within budget and the sidebar paints quickly; heavy subsystems (template sync, Jira, DAG, agent tools) load only when first used.

**Why this priority**: Directly felt on every startup, but needs measurement first.

**Independent Test**: Measure activation time in the smoke-test harness on a cold start; it is ≤ 200 ms on CI Linux.

**Acceptance Scenarios**:

1. **Given** a cold start, **When** the extension activates, **Then** activation completes within 200 ms on the reference runner.
2. **Given** activation, **When** no Jira command has been used, **Then** the Jira subsystem has not been loaded.
3. **Given** template sync, **When** the extension activates, **Then** sync runs after activation without blocking the sidebar.

### Edge Cases

- Lazy-loaded modules must still work offline (bundled, not fetched).
- Smoke tests on the VS Code floor version (1.95) must still pass with the minified bundle.
- Activation measurements on slow CI runners: use a tolerance and report trends rather than flake.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Production builds MUST be minified; development builds MUST remain unminified with inline-friendly source maps.
- **FR-002**: Source maps MUST be generated for release builds but excluded from the published package.
- **FR-003**: CI MUST report bundle size and delta vs the base branch on every PR and fail above the budget (default 250 KB, configurable in one place).
- **FR-004**: Subsystems not needed at startup (Jira, DAG view, template sync network path, agent tools) MUST be loaded on first use.
- **FR-005**: Activation MUST NOT perform synchronous file I/O on the extension-host thread.
- **FR-006**: The smoke suite MUST record activation time and report it; it MUST fail if it exceeds the budget by more than a documented tolerance.
- **FR-007**: The package size and activation numbers MUST be noted in the CHANGELOG of the release that ships this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Main bundle ≤ 250 KB (from ~740 KB).
- **SC-002**: Cold activation ≤ 200 ms on the CI Linux reference runner.
- **SC-003**: Sidebar first paint ≤ 500 ms after activation.
- **SC-004**: 100% of PRs show size reporting after adoption.

## Assumptions

- If minification plus lazy loading cannot reach 250 KB, the gap and its causes are documented and a constitution amendment is proposed rather than silently raising the budget.
- Build tooling stays esbuild; no new bundler is introduced.
