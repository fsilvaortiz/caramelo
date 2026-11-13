# Feature Specification: Provider Retry & Error Resilience

**Feature Branch**: `003-provider-retry-resilience`  
**Created**: 2026-11-13  
**Status**: Draft  
**Input**: User description: "LLM providers fail immediately on rate limits (429) and transient server errors (5xx, network resets). Add automatic, bounded retries with backoff that respect Retry-After and cancellation, shared by all providers, and show actionable error messages when retries are exhausted."

## Context

Claude, OpenAI-compatible (OpenAI, Groq, Gemini, Ollama, LM Studio, custom) and Copilot adapters each throw on the first non-OK response. A single 429 or 503 during a long phase generation or a multi-step agent run aborts the whole operation and the user must start over. Retries must be added without breaking Constitution Principle I invariants (abortable streaming, per-chunk timeout, verbatim auth headers) or Principle IX (traceable, actionable errors).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Generation survives a transient rate limit (Priority: P1)

A developer generates a Design phase on a provider that briefly returns 429. Caramelo waits and retries automatically; the document is generated without the user doing anything.

**Why this priority**: Rate limits are the most common failure on free/cheap tiers (Groq, Gemini) and today waste the user's whole run.

**Independent Test**: Point a provider at a mock server that returns 429 with `Retry-After: 2` once, then succeeds; run a phase; it completes.

**Acceptance Scenarios**:

1. **Given** a 429 with `Retry-After`, **When** the request is made, **Then** Caramelo waits the indicated time (within the maximum) and retries.
2. **Given** a 503 or connection reset before any streamed content, **When** the request is made, **Then** it is retried with increasing delay.
3. **Given** retries are in progress, **When** the status bar is visible, **Then** it shows that Caramelo is retrying and the attempt number.

---

### User Story 2 - Cancellation and non-retryable errors are respected (Priority: P1)

A developer cancels a generation while Caramelo is waiting to retry; it stops immediately. Authentication failures and invalid requests are never retried.

**Why this priority**: Retrying must never make Caramelo feel stuck or hammer an API with bad credentials.

**Independent Test**: Cancel during a backoff wait; confirm no further request is sent. Return 400/401 from the mock; confirm exactly one request.

**Acceptance Scenarios**:

1. **Given** a backoff wait, **When** the user cancels, **Then** the wait ends at once and no further request is sent.
2. **Given** a 400, 401, 403 or 404 response, **When** the request fails, **Then** it is not retried (401/403 keep the existing `apiKeyHelper` refresh-once behavior).
3. **Given** a stream that already delivered content and then fails, **When** the error occurs, **Then** it is not silently retried (to avoid duplicate output) and the user is told how to resume.

---

### User Story 3 - Exhausted retries produce an actionable message (Priority: P2)

When retries run out, the user sees which provider failed, the last status, how many attempts were made and a suggested next step (wait, switch provider, check quota).

**Why this priority**: Turns an opaque failure into a decision the user can make.

**Independent Test**: Mock always returns 429; the final error names the provider, attempt count and suggests switching provider.

**Acceptance Scenarios**:

1. **Given** all attempts fail, **When** the operation ends, **Then** the message names provider, status, attempts and next step, and the details are in the Output channel with secrets redacted.

### Edge Cases

- `Retry-After` given as an HTTP date, or larger than the maximum wait: cap it and say so.
- Retries inside the agent loop must not count as agent iterations.
- Model-validation test requests should fail fast (no or minimal retry) so the provider indicator updates quickly.
- Concurrent `[P]` tasks hitting the same rate limit should not all retry in lockstep (jitter).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All LLM provider adapters MUST use one shared retry policy.
- **FR-002**: Retryable conditions MUST be: HTTP 408, 429, 500, 502, 503, 504, and network errors occurring before any response body content is consumed.
- **FR-003**: The policy MUST honor `Retry-After` (seconds or HTTP date) when present, otherwise use exponential backoff with jitter.
- **FR-004**: Defaults MUST be 3 retries (4 attempts) and a maximum single wait of 30 s; both MUST be user-configurable, and setting retries to 0 MUST disable the feature.
- **FR-005**: Cancellation MUST interrupt any wait immediately and prevent further attempts.
- **FR-006**: Non-retryable statuses (400, 401, 403, 404, 422) MUST fail on the first attempt, preserving the existing `apiKeyHelper` 401/403 refresh behavior.
- **FR-007**: Streams that have already emitted content MUST NOT be retried automatically.
- **FR-008**: Retry progress MUST be shown via the status bar (not notifications) and each attempt logged through the redacting logger.
- **FR-009**: Final errors MUST be user-actionable: provider name, last status, attempt count, suggested next step.
- **FR-010**: Auth headers and per-chunk stream timeout behavior MUST be unchanged on every attempt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With a mock that fails transiently once (429 or 503), 100% of phase generations and agent runs complete without user action.
- **SC-002**: Cancelling during a retry wait stops all activity within 1 second.
- **SC-003**: Non-retryable errors produce exactly one request.
- **SC-004**: Unit tests cover every retryable/non-retryable status, `Retry-After` parsing and cancellation for each adapter.

## Assumptions

- Jira requests are out of scope for this feature (separate client, different failure patterns).
- No new runtime dependency is added (Constitution: native `fetch` only).
- Copilot (VS Code Language Model API) errors are mapped to the same retryable categories where the API exposes them; otherwise left unchanged.
