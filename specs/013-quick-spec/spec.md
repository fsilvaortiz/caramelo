# Feature Specification: Quick Spec Mode

**Feature Branch**: `013-quick-spec`  
**Created**: 2026-11-18  
**Status**: Draft  
**Input**: User description: "Add a Quick Spec mode for small changes (bug fixes, small features, refactors): one description produces a short spec, plan and task list in a single step with a single approval, then implement. The full Requirements → Design → Tasks flow stays for large features. Quick specs must remain Spec Kit compatible and be promotable to the full flow."

## Context

The three-gate flow (Requirements → approve → Design → approve → Tasks → approve) is right for new features but too heavy for the changes developers make most often — a bug fix, a small enhancement, a refactor. Facing five clicks and three generated documents for a ten-line fix, developers skip spec-driven development entirely, so the tool is absent from most of their day. Quick Spec keeps the discipline (a written intent, a plan, verifiable tasks) at a cost proportional to the change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fix a bug from one sentence (Priority: P1)

A developer types "Login fails when the email has uppercase letters" in the New Spec form, chooses **Quick**, and gets one short document with the problem, the intended change, affected files and 1–5 tasks. They approve once and click Implement.

**Why this priority**: This is the everyday case that today drives developers away from the tool.

**Independent Test**: Create a quick spec from one sentence; confirm the three Spec Kit files exist, one approval unlocks implementation, and Run All completes the tasks.

**Acceptance Scenarios**:

1. **Given** the New Spec form, **When** the user enters a description and picks Quick, **Then** spec.md, plan.md and tasks.md are generated in a single LLM run and shown together for review.
2. **Given** a generated quick spec, **When** the user clicks Approve once, **Then** all three phases are approved and Implement becomes available.
3. **Given** an approved quick spec, **When** the user clicks Implement, **Then** tasks run exactly as in the full flow (approvals, safety stash, summary).

---

### User Story 2 - The agent grounds the quick spec in the real code (Priority: P1)

The quick spec names the actual files and functions involved, because the agent inspects the codebase (read-only) while writing it.

**Why this priority**: A quick spec that guesses file paths produces wrong tasks; grounding is what makes it trustworthy.

**Independent Test**: In a repository with a known bug location, the generated plan names that file.

**Acceptance Scenarios**:

1. **Given** a tool-calling provider, **When** a quick spec is generated, **Then** the agent may use read-only tools only (no writes, no shell) and the plan lists real paths.
2. **Given** a provider without tool calling, **When** a quick spec is generated, **Then** it is produced from the description plus the constitution, and the user is told grounding was not available.

---

### User Story 3 - Promote a quick spec when it grows (Priority: P2)

Halfway through, the developer realises the change is bigger than expected and clicks **Promote to full spec**; the quick spec becomes the starting point of the normal three-phase flow.

**Why this priority**: Prevents users from being trapped in the wrong mode.

**Independent Test**: Promote a quick spec; the phases become editable and regenerable individually and the existing content is kept.

**Acceptance Scenarios**:

1. **Given** a quick spec, **When** the user promotes it, **Then** its content is kept, phases are set to pending-approval individually, and the full-flow controls appear.

---

### User Story 4 - Teams see which specs were quick (Priority: P3)

The sidebar and Workflow Map mark quick specs with a badge, and a setting lets a team require the full flow (disable Quick) — e.g. through the organization policy of feature 014.

**Independent Test**: The badge is visible; with Quick disabled by setting, the option is absent.

**Acceptance Scenarios**:

1. **Given** `caramelo.quickSpec.enabled = false`, **When** the user opens the New Spec form, **Then** the Quick option is not offered.

### Edge Cases

- The description is clearly large ("build a billing system"): the generator says so and suggests the full flow instead of producing an oversized quick spec (soft limit: > 8 tasks).
- Quick spec created from a Jira or GitHub issue.
- Regenerating a quick spec replaces all three documents together.
- Spec Kit CLI users open a quick spec: files and metadata must be readable with no Caramelo-only fields required.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The New Spec form MUST offer Quick and Full modes; Full stays the default unless the user or team setting chooses otherwise.
- **FR-002**: A quick spec MUST produce spec.md, plan.md and tasks.md (Spec Kit compatible) in one generation run.
- **FR-003**: Quick spec documents MUST be concise: spec ≤ ~30 lines, plan ≤ ~30 lines, 1–8 tasks.
- **FR-004**: Generation MUST use read-only agent tools when the provider supports tool calling; it MUST NOT write files or run shell commands.
- **FR-005**: One approval MUST approve all three phases; Implement MUST then behave exactly as in the full flow.
- **FR-006**: Users MUST be able to promote a quick spec to the full flow without losing content.
- **FR-007**: The metadata MUST record the mode (`"mode": "quick"`) without breaking Spec Kit compatibility.
- **FR-008**: Quick mode MUST be disableable per workspace/organization (`caramelo.quickSpec.enabled`).
- **FR-009**: When the request looks too large, the generator MUST recommend the full flow instead of silently producing a large quick spec.
- **FR-010**: The constitution MUST still be included as generation context.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From description to implementable tasks in one generation and one approval (vs. three generations and three approvals today).
- **SC-002**: A one-sentence bug fix reaches "tasks running" in under 60 seconds with a typical cloud model.
- **SC-003**: An end-to-end test (mock LLM server) covers create quick → approve → Run All → converge with zero extra prompts.
- **SC-004**: Spec Kit CLI reads quick-spec folders without errors.

## Assumptions

- Quick mode reuses the existing templates in a condensed form; no new Spec Kit template is required upstream.
- The constitution's approval-gate principle is satisfied by the single explicit approval; a constitution amendment clarifies that quick specs approve three phases in one gate.
- Depends on nothing new; benefits from features 009 (retries) and 014 (team policy to enable/disable).
