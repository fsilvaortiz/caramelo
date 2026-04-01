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
  <a href="#contributing">Contributing</a>
</p>

---

## Why Caramelo?

[Spec Kit](https://github.com/github/spec-kit) brings spec-driven development to AI coding — but it only works through slash commands in chat. [Kiro](https://kiro.dev) offers a visual experience — but locks you into a single LLM.

**Caramelo fills the gap**: a visual UI for spec-driven development that works with **any LLM** — Claude, Ollama, OpenAI, Groq, LM Studio, or any OpenAI-compatible endpoint.

## Features

### Visual Workflow

- **Sidebar with specs, providers, and progress** — see everything at a glance
- **Sequential phase flow** with approval gates: Requirements → Design → Tasks
- **Constitution editor** — define project principles that guide all generation
- **Workflow DAG** — interactive graph showing all specs and their phase statuses

### LLM Agnostic

- **Any provider**: Claude, OpenAI, Ollama, Groq, LM Studio, or any OpenAI-compatible endpoint
- **Multiple providers** configured simultaneously — switch with one click
- **Secure credential storage** via VS Code's native SecretStorage
- **Streaming output** — see documents being written in real time

### Spec Kit Compatible

- **Uses `.specify/specs/`** directory — fully interoperable with Spec Kit CLI
- **Auto-syncs templates** from GitHub Spec Kit releases
- **Generates intermediate artifacts**: research.md, data-model.md, contracts/
- **Offline-first** — bundled fallback templates, no internet required

### Editor Integration

- **CodeLens buttons** — Approve, Regenerate, Next Phase directly in documents
- **Progress bar** — visual phase indicator at the top of every spec document
- **Editor toolbar buttons** — contextual actions based on the open file
- **Task CodeLens** — Run Task / Run All Tasks inline in tasks.md
- **Parallel task execution** — tasks marked `[P]` run concurrently

### Quality Tools

- **Clarify** — LLM identifies ambiguities, presents questions as QuickPick dialogs
- **Analyze** — cross-artifact consistency check with severity-coded findings
- **Checklists** — content-specific quality verification items
- **Stale alerts** — downstream phases flagged when upstream is regenerated

## Installation

### From Source

```bash
git clone https://github.com/fsilvaortiz/caramelo.git
cd caramelo
npm install
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### From VSIX (coming soon)

```bash
npm run package
code --install-extension caramelo-0.0.1.vsix
```

## Quick Start

1. **Add a provider** — Click the `+` in the Providers section. Select Ollama, Claude, OpenAI, or any compatible endpoint.

2. **Set up your constitution** — Click the pencil icon in the Constitution section. Define your project's core principles.

3. **Create a spec** — In the Progress panel, expand "New Spec", enter a name and description, click "Create Spec".

4. **Generate phases** — Click on each phase (Requirements → Design → Tasks) to generate with your LLM. Approve each before moving to the next.

5. **Execute tasks** — Open `tasks.md`, click "Run Task" on individual tasks or "Run All Tasks" to execute everything.

## Providers

Caramelo supports any LLM through two provider types:

| Provider Type | Examples | Auth |
|--------------|---------|------|
| **OpenAI Compatible** | Ollama, LM Studio, Groq, Together, vLLM, OpenAI | Optional API key |
| **Anthropic** | Claude | API key required |

### Adding a provider

Click `+` in the Providers section and select from presets:

- **Ollama** — `http://localhost:11434/v1` (no key needed)
- **Claude** — `https://api.anthropic.com` (key required)
- **OpenAI** — `https://api.openai.com/v1` (key required)
- **Groq** — `https://api.groq.com/openai/v1` (key required)
- **LM Studio** — `http://localhost:1234/v1` (no key needed)
- **Custom** — any OpenAI-compatible endpoint

## Workflow

```
Constitution (project principles)
       │
       ▼
  ┌─────────┐     ┌─────────┐     ┌─────────┐
  │Requirem.│────▶│ Design  │────▶│  Tasks  │
  │ spec.md │     │ plan.md │     │tasks.md │
  └─────────┘     │research │     └─────────┘
                  │data-mod.│           │
                  │contracts│           ▼
                  └─────────┘     Implementation
```

Each phase must be **approved** before the next unlocks. You can:
- **Approve** — mark the phase as complete
- **Regenerate** — re-run with LLM (marks downstream phases as stale)
- **Edit manually** — modify the document before approving

## Configuration

Settings in VS Code (`settings.json`):

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

API keys are stored securely in VS Code's SecretStorage, never in settings files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
