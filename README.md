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

- **Any provider**: GitHub Copilot, Claude, OpenAI, Ollama, Groq, LM Studio, or any OpenAI-compatible endpoint
- **Multiple providers** configured simultaneously — switch with one click
- **Auto-detect models** — available models fetched from provider API after entering credentials
- **Change model anytime** — click the model name in the providers panel to switch
- **Secure credential storage** via VS Code's native SecretStorage
- **Streaming output** — see documents being written in real time in the editor
- **Output Channel** — watch LLM reasoning during task execution

### Spec Kit Compatible

- **Uses `.specify/specs/`** directory — fully interoperable with Spec Kit CLI
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
code --install-extension caramelo-0.0.3.vsix
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

1. **Add a provider** — Expand the Providers section. Click a preset (Ollama, Claude, OpenAI, Groq, LM Studio). Enter credentials if needed — available models are fetched automatically from the API.

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
| **Groq** | `https://api.groq.com/openai/v1` | API key |
| **LM Studio** | `http://localhost:1234/v1` | None |
| **Custom** | Any OpenAI-compatible endpoint | Optional |

### Jira Integration

| Provider | Details | Auth |
|----------|---------|------|
| **Jira Cloud** | Any Atlassian Cloud instance | Email + API token |

Expand the Providers section, click a preset button, enter credentials. Models are fetched automatically from the provider's API. Click a model name anytime to change it.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
