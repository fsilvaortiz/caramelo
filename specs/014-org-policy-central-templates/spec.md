# Feature Specification: Organization Policy & Central Templates

**Feature Branch**: `014-org-policy-central-templates`  
**Created**: 2026-11-18  
**Status**: Draft  
**Input**: User description: "Let an organization govern how Caramelo is used from one place: a policy file in a Git repository (same mechanism as the central constitution) that sets allowed providers/endpoints/models, approval rules the user cannot weaken, required hooks, and company spec/plan/tasks templates."

## Context

Caramelo already follows a **central constitution** kept in a Git repository (`caramelo.constitution.repository/path/ref`). Enterprises need the same for *how* the tool may be used: which LLM endpoints are approved, whether file writes or shell commands may ever run unattended, which Spec Kit hooks are mandatory, and which document templates every team uses. Today every one of those is a local setting any developer can change, which blocks adoption where security and compliance sign off on developer tools.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only approved LLM endpoints are usable (Priority: P1)

A platform team publishes a policy allowing only the company's Azure OpenAI gateway and GitHub Copilot. A developer who tries to add a personal OpenAI key sees that the provider is not allowed by the organization policy, with the policy's contact.

**Why this priority**: Data-exfiltration risk is the first question security asks about any AI tool.

**Independent Test**: With a policy allowing one endpoint, adding or activating a different one is refused with an explanatory message; the allowed one works.

**Acceptance Scenarios**:

1. **Given** a policy with `providers.allow` listing endpoint patterns, **When** a user adds or activates a provider outside the list, **Then** Caramelo refuses and names the policy and its owner contact.
2. **Given** an existing provider that the policy no longer allows, **When** the policy updates, **Then** the provider is marked blocked and no request is sent to it.

---

### User Story 2 - Approval rules cannot be weakened locally (Priority: P1)

The policy requires every shell command to prompt and forbids "Always allow in this workspace" for writes. Those buttons disappear for developers in that organization, and local settings that would weaken the rule are ignored with a visible notice.

**Why this priority**: Unattended execution is the second compliance question.

**Independent Test**: With `agent.shell.allowRules = false`, the Always allow and session buttons are absent and a saved `bashAllowList` is ignored.

**Acceptance Scenarios**:

1. **Given** a policy that disables saved shell rules, **When** the agent runs a command, **Then** only Run / Skip / Abort are offered and existing rules are ignored (logged once).
2. **Given** a policy with a shell deny list (e.g. `curl`, `ssh`, `git push`), **When** the agent requests a matching command, **Then** it is refused without prompting and the agent is told why.
3. **Given** a policy, **When** a user's local setting is stricter, **Then** the stricter value wins (policy is a floor, not a ceiling).

---

### User Story 3 - Company templates and mandatory hooks (Priority: P2)

Every team gets the company's spec/plan/tasks templates and a mandatory `after_tasks` review hook from the same repository, kept in sync like the central constitution.

**Independent Test**: With central templates configured, a new spec uses them instead of the bundled Spec Kit templates; the required hook runs even if the local extensions.yml disables it.

**Acceptance Scenarios**:

1. **Given** central templates, **When** a phase is generated, **Then** the central template is used and the sidebar shows its source and version.
2. **Given** a policy-required hook, **When** a developer disables it in the sidebar, **Then** the toggle is locked with "required by organization policy".

---

### User Story 4 - Developers can see what the policy enforces (Priority: P2)

A "Policy" section in the sidebar lists the active policy (source, version, last sync) and every rule in plain language, so nothing feels arbitrary.

**Independent Test**: The section shows each rule and links to the policy file.

**Acceptance Scenarios**:

1. **Given** an active policy, **When** the user opens the sidebar, **Then** they see source, ref, last sync time and each enforced rule.

### Edge Cases

- Policy repository unreachable (offline/VPN down): use the last synced copy; if none, apply the bundled defaults and show a warning — never silently drop to "no policy" once one was configured.
- Malformed policy: reject it, keep the previous valid copy, report the parse error with line.
- Policy and workspace settings conflict: the policy wins when stricter; the user is told which setting was overridden.
- Untrusted workspace: the policy still applies (it can only restrict).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Caramelo MUST load an organization policy from a Git repository/path/ref configured in user or machine settings, reusing the central-constitution sync mechanism.
- **FR-002**: The policy MUST be able to restrict providers (types, endpoint patterns, models).
- **FR-003**: The policy MUST be able to set a floor for approvals: write approval mode, whether saved shell rules / session approval / read-only auto-approval are permitted, a shell deny list, and the maximum agent iterations.
- **FR-004**: The policy MUST be able to require Spec Kit hooks and lock them on.
- **FR-005**: The policy MUST be able to supply spec/plan/tasks templates (and the constitution, via the existing mechanism).
- **FR-006**: The policy MUST be able to enable/disable features (e.g. Quick Spec from 013, Jira, bash tool).
- **FR-007**: Policy enforcement MUST be "stricter wins": local settings may tighten but never loosen a policy rule.
- **FR-008**: Every refusal due to policy MUST name the rule and the policy owner contact.
- **FR-009**: The last valid policy MUST be cached and used offline; a configured-but-unavailable policy MUST NOT fall back to "unrestricted".
- **FR-010**: The policy format MUST be versioned and validated against a published JSON schema.

### Key Entities

- **Organization policy**: versioned document (schema version, owner contact, providers, approvals, hooks, templates, features).
- **Policy source**: repository URL, path, ref, last synced commit and time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can roll out provider and approval rules to every developer by editing one file, with changes applied on next sync (≤ 1 hour or on window reload).
- **SC-002**: 0 requests are sent to a provider endpoint outside an active allow list (verified by e2e test with the mock LLM server).
- **SC-003**: Every policy-enforced restriction is visible in the sidebar's Policy section.

## Assumptions

- Distribution of the policy *location* to developers is done with the organization's existing VS Code settings management (e.g. machine/user settings pushed by MDM); Caramelo does not ship its own device management.
- The policy is advisory against a determined user editing the extension itself; it targets honest misconfiguration and compliance evidence, not hostile insiders.
- Reuses `src/constitution/git-source.ts` / central sync.
