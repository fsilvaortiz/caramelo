# Caramelo — Visual VS Code Extension for Spec Kit, LLM-Agnostic

Hey everyone! I've been using Spec Kit and loving the spec-driven development workflow, but I wanted a **visual experience inside VS Code** without being locked into a single LLM. So I built **Caramelo**.

## What is it?

A VS Code extension that gives you a full visual UI for the Spec Kit workflow — sidebar with specs, progress tracking, phase approval gates, task execution — all compatible with your existing `specs/` directory.

## Why not just use slash commands?

Slash commands work great, but I kept running into friction:
- Forgetting which command to run next
- Losing track of which phases were approved
- Copy-pasting issue details from Jira manually
- No visual progress indicator

Caramelo solves all of that with a visual workflow panel.

## Key differentiator: any LLM

Unlike Kiro (locked to one LLM) or Copilot-only integrations, Caramelo works with **any LLM**:
- **GitHub Copilot** — uses your existing subscription, no API key
- **Ollama, LM Studio** — local, free
- **Claude, OpenAI, Gemini, Groq** — cloud
- **Corporate proxies** — custom auth headers for Azure API Manager, etc.

Multiple providers simultaneously. Switch with one click. Custom aliases for each.

## Features

- **Visual sidebar** — constitution, specs, progress rings, task checklists in one panel
- **Sequential workflow** — Requirements → Design → Tasks with approval gates
- **Constitution with AI** — describe your project, LLM suggests principles
- **Intermediate artifacts** — auto-generates research.md, data-model.md, contracts/
- **Jira integration** — import issues as specs with board search and key lookup
- **Task execution** — run tasks inline with parallel support, see LLM output streaming
- **Clarify & Analyze** — find ambiguities and cross-artifact inconsistencies with auto-fix
- **Stale alerts** — regenerating a phase flags downstream as outdated
- **Inline editing** — click any provider field to edit directly in the sidebar
- **Model validation** — test request on model change with visual feedback
- **Fully compatible** — reads and writes `specs/`, works alongside Spec Kit CLI

## Links

- **VS Code Marketplace**: [Caramelo](https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo)
- **GitHub**: [github.com/fsilvaortiz/caramelo](https://github.com/fsilvaortiz/caramelo)
- **License**: MIT

Would love feedback from the Spec Kit community! What features would you want to see next?
