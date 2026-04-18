<p align="center">
  <img src="resources/icons/caramelo-logo.png" alt="Caramelo" width="200" />
</p>

<h1 align="center">Caramelo</h1>

<p align="center">
  Visual spec-driven development for VS Code. LLM-agnostic. Compatible with <a href="https://github.com/github/spec-kit">GitHub Spec Kit</a>.
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#installation">Installation</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#providers">Providers</a> &bull;
  <a href="#jira-integration">Jira</a> &bull;
  <a href="#contributing">Contributing</a>
</p>

---

## Why Caramelo?

[Spec Kit](https://github.com/github/spec-kit) brings spec-driven development to AI coding — but it only works through slash commands in chat. [Kiro](https://kiro.dev) offers a visual experience — but locks you into a single LLM.

**Caramelo fills the gap**: a visual UI for spec-driven development that works with **any LLM** — Claude, Ollama, OpenAI, Groq, LM Studio, or any OpenAI-compatible endpoint.

## Features

### Visual Workflow

- **Unified sidebar** — providers, constitution, specs, progress, and task checklist in one panel
- **Sequential phase flow** with approval gates: Requirements → Design → Tasks
- **Constitution editor** — visual form with AI generation (describe your project, LLM suggests principles)
- **Workflow DAG** — interactive graph showing all specs and their phase statuses
- **Progress ring** — overall completion percentage (phases 50% + tasks 50%), 100% only when all tasks done
- **Stale alerts** — downstream phases flagged when upstream is regenerated
- **Inline task checklist** — toggle tasks directly in the sidebar with immediate file sync

### LLM Agnostic

- **Any provider**: GitHub Copilot, Claude, OpenAI, Gemini, Ollama, Groq, LM Studio, or any OpenAI-compatible endpoint
- **Multiple providers** configured simultaneously — switch by clicking the dot indicator
- **Auto-detect models** — available models fetched from provider API, or enter manually
- **Inline editing** — click provider name, model, or auth settings to edit directly in the sidebar
- **Custom auth headers** — configurable header name and prefix for corporate proxies (e.g. Azure API Manager)
- **Model validation** — test request on model change, red indicator on failure
- **Multiple instances** — add several providers of the same type with custom aliases
- **Secure credential storage** via VS Code's native SecretStorage
- **Streaming output** — see documents being written in real time in the editor
- **Output Channel** — watch LLM reasoning during task execution

### Spec Kit Compatible

- **Uses `specs/`** directory — fully interoperable with Spec Kit CLI
- **Auto-syncs templates** from GitHub Spec Kit releases
- **Generates intermediate artifacts**: research.md, data-model.md, contracts/
- **Constitution as LLM context** — project principles included in every generation
- **Offline-first** — bundled fallback templates, no internet required

### Editor Integration

- **CodeLens buttons** — Approve, Regenerate, Next Phase persistent in documents
- **Phase progress bar** — visual step indicator at the top of every spec document
- **Caramelo editor menu** — grouped contextual actions under a single cat icon (adapts to dark/light themes)
- **Task CodeLens** — Run Task / Run All Tasks inline in tasks.md
- **Parallel task execution** — tasks marked `[P]` run concurrently
- **Non-intrusive progress** — status bar spinner instead of notification popups
- **Auxiliary files** — research.md, data-model.md, analysis.md, checklists shown under each phase

### Quality Tools

- **Clarify** — LLM identifies ambiguities, presents questions as QuickPick dialogs
- **Analyze** — cross-artifact consistency check with severity-coded findings
- **Auto-fix** — CodeLens buttons on analysis.md to fix individual or all findings with LLM
- **Checklists** — content-specific quality verification items per phase

### Jira Integration

- **Import issues as specs** — create specs directly from Jira Cloud issues
- **Issue picker** — QuickPick with dynamic search and issue preview
- **Jira badge** — spec cards show linked issue key with click-to-open
- **Full context** — issue title, description, acceptance criteria, and comments used for generation

## Installation

### From VS Code Marketplace

Search for **"Caramelo"** in the Extensions panel, or install from the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo).

### From VSIX

```bash
code --install-extension caramelo-0.0.8.vsix
```

### From Source

```bash
git clone https://github.com/fsilvaortiz/caramelo.git
cd caramelo
npm install
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host.

## Quick Start

1. **Add a provider** — Expand the Providers section. Click a preset (Ollama, Claude, OpenAI, Gemini, Groq, LM Studio, Copilot, Jira). Enter credentials if needed — models are fetched from the API or entered manually. For corporate proxies, expand "Custom auth header" to set the header name and prefix.

2. **Set up your constitution** — Click the Constitution bar in the Workflow panel. Describe your project and click "Generate with AI" to let the LLM suggest principles, or fill in manually.

3. **Create a spec** — Expand "New Spec" in the Workflow panel, enter a name and description, click "Create". Or click "From Jira" to import an issue.

4. **Generate phases** — Click "Generate" on each phase (Requirements → Design → Tasks). Watch the document stream in real time. Review and approve each before the next unlocks.

5. **Execute tasks** — Click "Implement" on the Tasks phase, or open `tasks.md` and use "Run Task" / "Run All Tasks" buttons. Watch LLM reasoning in the Output Channel.

6. **Quality checks** — Use the Caramelo menu (cat icon in editor toolbar) to Clarify ambiguities, Analyze consistency, Fix issues, or Generate checklists.

## Providers

### LLM Providers

| Provider | Endpoint | Auth |
|----------|----------|------|
| **GitHub Copilot** | Via VS Code API | Copilot subscription |
| **Ollama** | `http://localhost:11434/v1` | None |
| **Claude** | `https://api.anthropic.com` | API key |
| **OpenAI** | `https://api.openai.com/v1` | API key |
| **Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | API key |
| **Groq** | `https://api.groq.com/openai/v1` | API key |
| **LM Studio** | `http://localhost:1234/v1` | None |
| **Custom** | Any OpenAI-compatible endpoint | Optional |

### Jira Integration

| Provider | Details | Auth |
|----------|---------|------|
| **Jira Cloud** | Any Atlassian Cloud instance | Email + API token |

Expand the Providers section, click a preset button, enter credentials. Models are fetched automatically from the provider's API when available, or enter the model name manually. All editing (name, model, auth headers) is done inline in the sidebar — click any field to edit it.

## Workflow

```
Constitution (project principles)
       │
       ├──→ [Feature 1]
       │     ├── Requirements (spec.md)
       │     ├── Design (plan.md + research.md + data-model.md + contracts/)
       │     ├── Tasks (tasks.md)
       │     └── Implementation (task execution)
       │
       └──→ [Feature 2]
             └── ...
```

Each phase must be **approved** before the next unlocks:
- **Generate** — LLM creates the document using templates + constitution + prior phases
- **Approve** — mark as complete, unlock the next phase
- **Regenerate** — re-run (marks downstream phases as stale)
- **Edit manually** — modify before approving

### Auxiliary Files

| File | Phase | Description |
|------|-------|-------------|
| research.md | Design | Technical decisions with rationale |
| data-model.md | Design | Entities, attributes, relationships |
| contracts/ | Design | Interface definitions |
| analysis.md | Tasks | Consistency check findings |
| checklists/*.md | Any | Quality verification items |
| jira-context.md | Requirements | Imported Jira issue content |

## Configuration

VS Code settings (`settings.json`):

```json
{
  "caramelo.providers": [
    {
      "id": "ollama",
      "name": "Ollama",
      "type": "openai-compatible",
      "endpoint": "http://localhost:11434/v1",
      "model": "llama3"
    }
  ],
  "caramelo.activeProvider": "ollama"
}
```

API keys and Jira tokens are stored securely in VS Code's SecretStorage, never in settings files.

### Advanced settings

| Setting | Default | Description |
|---------|---------|-------------|
| `caramelo.sse.timeoutMs` | `300000` | Max time (ms) to wait for a chunk of streaming output before giving up. Increase for slow local models. Minimum 5000. |
| `authHeader` (per provider) | `Authorization` / `x-api-key` | HTTP header used to send the API key. Letters, digits, hyphens only. |
| `authPrefix` (per provider) | `Bearer` / empty | Prefix prepended to the key. Letters, digits, hyphens only. Leave empty to send the raw key. |

Invalid values for `authHeader` / `authPrefix` (e.g. containing spaces, colons, or CR/LF) are rejected at runtime and the default is used instead.

## Troubleshooting

### The LLM request hangs or times out

Caramelo aborts a streaming request if no data arrives for `caramelo.sse.timeoutMs` milliseconds (5 min by default). If you run large local models (Ollama, LM Studio) and hit this, raise the setting:

```json
{ "caramelo.sse.timeoutMs": 900000 }
```

Setting it below 5000 ms is ignored — the default is used.

### "401" / "403" on generate

The provider rejected your API key. Open the Providers panel, click the auth field next to the provider, and paste a fresh key. Keys are stored in VS Code SecretStorage, not `settings.json`. For corporate proxies, also verify `authHeader` / `authPrefix` match what your gateway expects.

### "Connection error" or "Auth failed" when adding a Jira provider

Caramelo now pings `/rest/api/3/myself` both when you click **Test** and when you click **Add Jira Provider**, so adding will fail cleanly if the email, URL, or API token are wrong. Generate a token at <https://id.atlassian.com/manage-profile/security/api-tokens> and use the full `https://<tenant>.atlassian.net` URL.

### A phase is stuck on "pending" even though the file exists

Opening the workflow sidebar should now auto-upgrade phases whose markdown has content to `pending-approval` and persist that change to `.caramelo-meta.json`. If it does not, delete the stale `.caramelo-meta.json` inside that spec directory — it will be rebuilt.

### Seeing leaked tokens in DevTools / extension host output

You shouldn't — the extension logs through a redacting logger that strips `Bearer`/`Basic` tokens, `Authorization` headers, and credentials embedded in URLs. Debug logs are only emitted when `CARAMELO_DEBUG=1` is set in the environment that launches VS Code.

If you still see a leak, please open an issue with the redacted payload.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
