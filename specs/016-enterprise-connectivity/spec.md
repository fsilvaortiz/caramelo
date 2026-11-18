# Feature Specification: Enterprise LLM Connectivity

**Feature Branch**: `016-enterprise-connectivity`  
**Created**: 2026-11-18  
**Status**: Draft  
**Input**: User description: "Make Caramelo work out of the box with the LLM platforms enterprises actually approve — Azure OpenAI, AWS Bedrock, Google Vertex AI and corporate LLM gateways — and behind corporate networks (HTTP proxies, custom root certificates), with a connection test that explains failures."

## Context

Enterprises rarely allow direct calls to public model APIs; they route through their cloud's managed service (Azure OpenAI, AWS Bedrock, Vertex AI) or an internal gateway, often behind an HTTP proxy with TLS inspection and a private root CA. Caramelo already supports custom auth headers and `apiKeyHelper` (used today for Azure API Management), but each of these platforms needs specific URL shapes or request signing, and network failures behind proxies surface as opaque `fetch failed` errors. Without first-class support, the enterprise pilot dies at "it can't connect".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Use the company's Azure OpenAI deployment (Priority: P1)

A developer picks **Azure OpenAI**, enters resource name, deployment and API version (or uses Entra ID through `apiKeyHelper`), and Caramelo generates specs and runs tasks with tool calling.

**Why this priority**: Azure OpenAI is the most common enterprise-approved path for OpenAI models.

**Independent Test**: Against a mock server that validates Azure's URL shape and `api-key` header, phase generation and an agent task succeed.

**Acceptance Scenarios**:

1. **Given** Azure OpenAI settings, **When** a request is made, **Then** it targets `/openai/deployments/<deployment>/chat/completions?api-version=<v>` with the `api-key` header (or the bearer token from `apiKeyHelper`).
2. **Given** a deployment without tool-calling support, **When** a task runs, **Then** Caramelo uses the text fallback and says so.

---

### User Story 2 - Use Claude or other models through AWS Bedrock (Priority: P1)

A developer with AWS credentials (environment, profile or SSO) selects **AWS Bedrock**, region and model, and uses Caramelo without any API key.

**Why this priority**: Bedrock is how many enterprises consume Claude.

**Independent Test**: Requests are signed (SigV4) correctly — verified against a signing test vector and a mock endpoint; credentials come from the standard AWS chain.

**Acceptance Scenarios**:

1. **Given** valid AWS credentials, **When** a request is made, **Then** it is SigV4-signed and streamed from the Bedrock runtime endpoint.
2. **Given** expired SSO credentials, **When** a request fails, **Then** the message tells the user to run their SSO login and retry.

---

### User Story 3 - Work behind a corporate proxy with a private CA (Priority: P1)

A developer behind a TLS-inspecting proxy configures nothing beyond what VS Code already uses (`http.proxy`, system certificates), and Caramelo connects.

**Why this priority**: Without this, no other enterprise feature matters.

**Independent Test**: In an environment with a local proxy and a self-signed root CA, provider requests, template sync and central constitution/policy sync all succeed.

**Acceptance Scenarios**:

1. **Given** VS Code proxy settings or `HTTPS_PROXY`, **When** Caramelo makes any request, **Then** it goes through the proxy.
2. **Given** a private root CA in the OS store or `NODE_EXTRA_CA_CERTS`, **When** TLS is intercepted, **Then** the connection is trusted.
3. **Given** a connection failure, **When** the user clicks **Test connection**, **Then** Caramelo reports the failing step (DNS, proxy, TLS/certificate, auth, model) in plain language.

---

### User Story 4 - Vertex AI and generic gateways (Priority: P2)

Google Vertex AI (with gcloud credentials) and OpenAI-/Anthropic-compatible gateways (LiteLLM, Portkey, Kong, internal) work with presets.

**Independent Test**: Presets produce the right URL/auth shapes against mock servers.

**Acceptance Scenarios**:

1. **Given** a Vertex preset, **When** a request is made, **Then** it uses the regional endpoint and an access token from the Google credential chain (or `apiKeyHelper` with `gcloud auth print-access-token`).

### Edge Cases

- Model availability differs by region; listing models must handle partial permissions.
- Proxy authentication (NTLM/Kerberos) is handled by VS Code where possible; otherwise documented limitation with a clear error.
- Streaming through proxies that buffer responses: the per-chunk timeout must not misreport buffering as a dead stream without saying so.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Caramelo MUST provide Azure OpenAI, AWS Bedrock and Google Vertex AI provider types with tool calling and streaming.
- **FR-002**: Bedrock requests MUST be SigV4-signed using the standard AWS credential chain without adding an AWS SDK dependency (Constitution: native `fetch` only).
- **FR-003**: Vertex and Azure Entra ID MUST work via their credential chains or `apiKeyHelper`.
- **FR-004**: All Caramelo network traffic (providers, Jira, template/constitution/policy sync) MUST honour VS Code proxy settings and `HTTPS_PROXY`/`NO_PROXY`.
- **FR-005**: TLS MUST trust OS-store and `NODE_EXTRA_CA_CERTS` roots.
- **FR-006**: A **Test connection** action MUST diagnose DNS, proxy, TLS, auth and model access separately and report them in plain language.
- **FR-007**: Presets MUST exist for common gateways (LiteLLM, Portkey, Kong AI Gateway, generic OpenAI/Anthropic-compatible).
- **FR-008**: New providers MUST satisfy the adapter invariants of Constitution Principle I and the retry behaviour of feature 009.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer connects to Azure OpenAI, Bedrock or Vertex in under 3 minutes using only values their platform team provides.
- **SC-002**: Behind a TLS-inspecting proxy with a private CA, all Caramelo network features work in an automated e2e test.
- **SC-003**: 100% of connection failures in the diagnostic test matrix are reported with the failing step named.

## Assumptions

- VS Code's own proxy support for extension-host `fetch` is used where available; this feature verifies and fills gaps rather than reimplementing it.
- Bedrock/Vertex model catalogues are fetched when permissions allow, otherwise typed manually.
