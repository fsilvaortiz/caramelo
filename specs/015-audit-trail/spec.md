# Feature Specification: Audit Trail

**Feature Branch**: `015-audit-trail`  
**Created**: 2026-11-18  
**Status**: Draft  
**Input**: User description: "Record an auditable trail of what Caramelo's AI did: every LLM request (provider, model, tokens, which spec/task), every tool call and every approval decision (asked/auto-approved and why, by whom). Store it locally as an append-only log, let users export it, and optionally forward it to a company endpoint."

## Context

Constitution Principle IX ("Traceable Generation") requires that users can answer "what exactly did the LLM see, and what did it do?" Today that answer lives in the Output channel, which is lost on reload and is not structured. Enterprises adopting AI coding tools are increasingly asked by security, compliance and regulators for evidence of what the AI changed, who approved it and what data left the machine. With the new auto-approval options (saved shell rules, workspace write approval), a durable record of *what ran without a prompt* becomes essential.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Answer "who approved this change?" (Priority: P1)

A reviewer asks why a file changed during a task. The developer opens **Caramelo: Show Audit Log**, filters by the task, and sees the LLM requests, each tool call with its arguments summary, and the approval decision (prompted → "Apply all" by the developer, or auto-approved by rule `npm test`).

**Why this priority**: This is the core accountability question.

**Independent Test**: Run a task with one prompted and one auto-approved action; the log shows both with the correct decision source.

**Acceptance Scenarios**:

1. **Given** a completed task, **When** the user opens the audit log, **Then** every LLM request, tool call and approval decision of that task appears in order with timestamps.
2. **Given** an auto-approved command, **When** it appears in the log, **Then** the entry states the reason (rule name, read-only, session approval, workspace setting).
3. **Given** a prompted decision, **When** it appears in the log, **Then** it records the chosen button and the local git user identity.

---

### User Story 2 - Export for compliance (Priority: P2)

A team lead exports the audit log of a feature (by spec or date range) as JSON Lines or CSV to attach to a change request.

**Independent Test**: Export by spec name produces a file containing only that spec's entries.

**Acceptance Scenarios**:

1. **Given** audit entries, **When** the user exports with a spec or date filter, **Then** the file contains exactly the matching entries in a documented schema.

---

### User Story 3 - Forward to the company's log platform (Priority: P3)

With an organization policy (feature 014) that sets an audit endpoint, entries are also sent to it in batches.

**Independent Test**: With a mock HTTP endpoint configured, entries arrive in batches; with the endpoint down, entries are kept locally and retried.

**Acceptance Scenarios**:

1. **Given** a configured endpoint, **When** entries are produced, **Then** they are delivered in batches with retry, and local logging never blocks on delivery.

### Edge Cases

- Secrets: prompt and tool content MUST pass through the redacting logger; by default the log stores sizes and hashes of prompts, not full content (full content opt-in).
- Log growth: rotate by size/age with a configurable retention.
- Concurrent writers (parallel `[P]` tasks): entries never interleave or corrupt.
- Untrusted workspaces: nothing runs, but refusals are logged.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Caramelo MUST append a structured entry for each LLM request (provider, model, endpoint host, spec, task, token usage when reported, duration, outcome).
- **FR-002**: Caramelo MUST append an entry for each agent tool call (tool, workspace-relative target, summary of arguments, result status).
- **FR-003**: Caramelo MUST append an entry for each approval decision: prompted (with chosen option) or automatic (with reason), plus the local git user name/email when available.
- **FR-004**: The log MUST be append-only JSON Lines in the workspace's storage (not in the repository), with rotation and retention settings.
- **FR-005**: Content MUST be redacted; full prompt/response bodies MUST be opt-in (`caramelo.audit.includeContent`).
- **FR-006**: Users MUST be able to view and filter the log (by spec, task, type, date) inside VS Code and export it as JSON Lines or CSV.
- **FR-007**: An optional HTTPS endpoint MUST receive batched entries with retry and backpressure; delivery failures MUST NOT affect the user's work.
- **FR-008**: The entry schema MUST be versioned and documented.
- **FR-009**: Auditing MUST be on by default with local-only storage; forwarding is opt-in or set by organization policy.

### Key Entities

- **Audit entry**: `{ schemaVersion, timestamp, sessionId, kind: llm_request | tool_call | approval | policy_refusal, spec?, task?, actor?, details }`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any file changed by a task, the log identifies the tool call and the approval that allowed it.
- **SC-002**: 100% of auto-approved actions appear in the log with their reason.
- **SC-003**: Logging adds < 5 ms per tool call and never blocks the agent loop.
- **SC-004**: No secret from the redaction test corpus appears in any log entry.

## Assumptions

- "Actor" is the local git identity; Caramelo does not authenticate users itself.
- Token counts come from provider responses when available; otherwise estimates are marked as such.
- Supersedes the Output channel only for audit purposes; the channel stays for live viewing.
