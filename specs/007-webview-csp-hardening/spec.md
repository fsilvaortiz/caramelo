# Feature Specification: Webview Content Security Hardening

**Feature Branch**: `007-webview-csp-hardening`  
**Created**: 2026-11-13  
**Status**: Draft  
**Input**: User description: "Apply a strict Content Security Policy to every Caramelo webview (Providers sidebar, Workflow DAG, Constitution editor) and remove inline event handlers so that no injected markup can execute script, especially in the view that handles API keys."

## Context

Only two of Caramelo's webviews (Workflow sidebar, Central constitution editor) declare a Content Security Policy today. The Providers sidebar — which displays and edits provider names, endpoints, model ids, auth header settings and the `apiKeyHelper` command — the Workflow DAG panel and the Constitution editor declare none, and the Providers sidebar wires interactions through inline `onclick`/`onkeydown` attributes that interpolate identifiers into script strings. A single escaping mistake in any of these views would let workspace- or provider-controlled text run script with access to the extension message channel. This feature closes that class of defect (Constitution Principle III, "Secrets Stay Secret").

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Providers view cannot execute injected content (Priority: P1)

A developer configures a provider whose display name, model list or endpoint (for example, model names returned by a third-party OpenAI-compatible server) contains HTML or script fragments. The Providers sidebar renders those values as plain text and no script from them ever runs.

**Why this priority**: This view handles credentials and the command that produces API keys; it has the highest impact if compromised.

**Independent Test**: Configure a provider with a name and model id containing `<img src=x onerror=...>` and `'); alert(1); ('` payloads; open the sidebar and every inline editor; confirm nothing executes and the text is shown literally.

**Acceptance Scenarios**:

1. **Given** a provider whose name contains markup, **When** the Providers view renders, **Then** the markup is displayed as text and no script executes.
2. **Given** the Providers view is open, **When** any script not shipped by Caramelo attempts to run (inline or injected), **Then** the webview's policy blocks it.
3. **Given** the Providers view after hardening, **When** the user renames a provider, changes a model, edits endpoint/auth settings or switches the active provider, **Then** each interaction behaves exactly as before.

---

### User Story 2 - All other webviews share the same protection (Priority: P2)

The Workflow DAG panel and the Constitution editor apply the same strict policy, so spec names, task text and constitution content cannot execute script.

**Why this priority**: These views render workspace content (spec names, constitution text), which may come from untrusted repositories.

**Independent Test**: Open a workspace whose spec folder name and constitution text contain script payloads; open the DAG and Constitution editor; confirm nothing executes and all interactions still work.

**Acceptance Scenarios**:

1. **Given** a spec whose title contains markup, **When** the DAG panel opens, **Then** the title renders as text and the graph remains interactive.
2. **Given** the Constitution editor is open, **When** the user edits, saves or asks the AI to generate principles, **Then** it works as before with the strict policy in force.

---

### User Story 3 - Regressions are caught automatically (Priority: P3)

A contributor adding a new webview, or editing an existing one, gets an automated test failure if the view lacks the strict policy or reintroduces inline handlers.

**Why this priority**: Keeps the guarantee from eroding over time.

**Independent Test**: Remove the policy from one view in a scratch branch; the test suite fails naming that view.

**Acceptance Scenarios**:

1. **Given** any Caramelo webview HTML, **When** the test suite runs, **Then** it asserts a policy with no default source, scripts restricted to a per-render nonce, and no inline event-handler attributes.

### Edge Cases

- Webview re-renders (state change, theme change) must produce a fresh nonce each time and keep working.
- Views restored after VS Code reload (`retainContextWhenHidden` or deserialization) must still carry the policy.
- Styles that depend on inline `style` attributes must keep rendering (style policy may allow inline styles; script policy may not).
- Theme icons/fonts loaded from the extension's own resources must still load.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every Caramelo webview MUST declare a Content Security Policy that denies everything by default.
- **FR-002**: Scripts in every webview MUST only run when they carry a nonce generated freshly for that render; inline script without the nonce MUST be blocked.
- **FR-003**: Webview markup MUST NOT contain inline event-handler attributes (`onclick`, `onkeydown`, etc.); interactions MUST be dispatched by a single delegated listener reading declarative data attributes.
- **FR-004**: All user-, workspace- or provider-supplied values MUST be escaped for the HTML context (text or attribute) in which they appear, through one shared escaping utility.
- **FR-005**: Webview HTML construction MUST go through one shared builder that inserts the policy and nonce, so new views get them by default.
- **FR-006**: Messages received from a webview MUST be validated (known command, expected field types) before the extension acts on them; unknown messages MUST be ignored and logged at debug level.
- **FR-007**: Existing behavior of every view (all buttons, inline editors, keyboard shortcuts Enter/Escape) MUST be preserved.
- **FR-008**: The test suite MUST verify FR-001 to FR-003 for every webview.

### Key Entities

- **Webview document**: HTML rendered into a VS Code webview; carries a policy, a nonce and declarative action attributes.
- **Webview message**: `{ command, ...payload }` sent from the webview to the extension; validated against an allow-list per view.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of Caramelo webviews (currently 5) declare the strict policy.
- **SC-002**: 0 inline event-handler attributes remain in any webview markup.
- **SC-003**: A suite of injection payloads placed in provider names, model ids, endpoints, spec titles and constitution text produces 0 script executions.
- **SC-004**: All existing interactions in the five webviews pass manual verification in the Extension Development Host with no behavior change reported.

## Assumptions

- Inline `style` attributes remain allowed (style policy may include `'unsafe-inline'`); only script execution is restricted.
- No webview needs network access; all resources load from the extension's own resource roots.
- The existing escaping in Workflow and Central-editor views is reused or replaced by the shared utility, not duplicated.
