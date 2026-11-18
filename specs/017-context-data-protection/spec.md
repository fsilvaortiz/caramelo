# Feature Specification: Context Data Protection

**Feature Branch**: `017-context-data-protection`  
**Created**: 2026-11-18  
**Status**: Draft  
**Input**: User description: "Control what source code and data Caramelo sends to the LLM: an ignore file for paths that must never leave the machine, automatic redaction of secrets in prompts, and a preview of exactly what context will be sent."

## Context

Caramelo builds LLM context from specs, the constitution and workspace files, and its agent can read files with `file_read`, `grep` and `glob`. Today the only boundary is the workspace root. Companies need to keep certain paths (credentials, customer data fixtures, licensed or export-controlled code) out of any prompt, and to be sure secrets accidentally present in code are not sent. The redacting logger already protects *logs*; this feature applies the same care to *prompts*.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Paths that never reach the LLM (Priority: P1)

A team adds `.carameloignore` with `secrets/`, `*.pem`, `data/customers/**`. No phase generation, task context or agent tool can read those files; the agent is told the path is excluded by policy.

**Why this priority**: It is the simplest control security teams ask for, and familiar from `.gitignore`/`.cursorignore`.

**Independent Test**: With an ignored file containing a marker string, run phases and tasks against the mock LLM server; the marker never appears in any request body.

**Acceptance Scenarios**:

1. **Given** an ignored path, **When** the agent calls `file_read`, `grep` or `glob` on it, **Then** the tool refuses or omits it and returns "excluded by .carameloignore".
2. **Given** an ignored path, **When** task context is assembled, **Then** the file is never included even if referenced in the plan.
3. **Given** an organization policy (014), **When** it lists ignore patterns, **Then** they apply in addition to the workspace file and cannot be removed locally.

---

### User Story 2 - Secrets are redacted before sending (Priority: P1)

A config file in context contains an AWS key; Caramelo replaces it with `[REDACTED:aws-access-key]` before the request is sent and notes the redaction in the Output channel and audit log (015).

**Why this priority**: Secrets in code are common; sending them to a third party is a reportable incident in many companies.

**Independent Test**: A corpus of secret formats placed in context files never appears in mock-server request bodies; each is replaced by a typed placeholder.

**Acceptance Scenarios**:

1. **Given** a known secret format (cloud keys, tokens, private keys, connection strings), **When** it appears in context or a tool result, **Then** it is replaced before sending.
2. **Given** a redaction, **When** the agent later writes code, **Then** it does not write the placeholder back over the real value (edits touching redacted regions are refused with an explanation).

---

### User Story 3 - See what will be sent (Priority: P2)

Before generating, a developer can open **Preview context** and see the list of files, their sizes, what was excluded and why, and the redactions that will be applied.

**Independent Test**: The preview lists exactly the files that the next request includes.

**Acceptance Scenarios**:

1. **Given** a phase or task, **When** the user opens Preview context, **Then** it shows included files, excluded files (with the matching rule) and redaction counts.

### Edge Cases

- Ignore patterns that match the spec folder itself: the spec's own documents are always allowed (with a warning).
- Binary and very large files: never sent; reported in the preview.
- `bash` output: the shell tool can read ignored files (`cat secrets/x`); commands touching ignored paths must prompt even when a rule would auto-approve them, and their output is redacted.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Caramelo MUST support a `.carameloignore` file (gitignore syntax) at the workspace root, plus patterns from organization policy (014).
- **FR-002**: Ignored paths MUST be excluded from context building and from all agent file tools.
- **FR-003**: Shell commands referencing ignored paths MUST always prompt, and shell output MUST be redacted.
- **FR-004**: Prompts and tool results MUST pass through secret redaction before being sent, using a maintained rule set with typed placeholders.
- **FR-005**: Agent edits MUST NOT overwrite real values with redaction placeholders.
- **FR-006**: Users MUST be able to preview the context of the next request.
- **FR-007**: Every exclusion and redaction MUST be logged (Output channel; audit log when 015 exists).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 occurrences of ignored-file markers or corpus secrets in any request captured by the mock LLM server across the full SDD e2e flow.
- **SC-002**: Redaction adds < 20 ms to a typical request.
- **SC-003**: Context preview matches the actual request content in 100% of tested cases.

## Assumptions

- Redaction is best-effort pattern matching; it reduces risk but is not a DLP guarantee — documented as such.
- Reuses the existing redaction utilities in `src/utils/log.ts` as a starting point.
