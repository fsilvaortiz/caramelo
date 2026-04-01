# Caramelo — Visual VS Code Extension for Spec Kit, LLM-Agnostic

Hey everyone! I've been using Spec Kit and loving the spec-driven development workflow, but I wanted a **visual experience inside VS Code** without being locked into a single LLM. So I built **Caramelo**.

## What is it?

A VS Code extension that gives you a full visual UI for the Spec Kit workflow — sidebar with specs, progress tracking, phase approval gates, task execution — all compatible with your existing `.specify/specs/` directory.

## Why not just use slash commands?

Slash commands work great, but I kept running into friction:
- Forgetting which command to run next
- Losing track of which phases were approved
- Copy-pasting issue details from Jira manually
- No visual progress indicator

Caramelo solves all of that with a visual workflow panel.

## Key differentiator: any LLM

Unlike Kiro (locked to Claude) or Copilot-only integrations, Caramelo works with **any LLM**:
- Ollama (local, free)
- Claude, OpenAI, Groq (cloud)
- LM Studio, vLLM, or any OpenAI-compatible endpoint

Switch providers with one click. Configure multiple simultaneously.

## Features

- **Visual sidebar** — constitution, specs, progress rings, task checklists in one panel
- **Sequential workflow** — Requirements → Design → Tasks with approval gates
- **Intermediate artifacts** — auto-generates research.md, data-model.md, contracts/
- **Constitution as context** — your project principles guide every generation
- **Clarify & Analyze** — find ambiguities and cross-artifact inconsistencies
- **Task execution** — run tasks inline with parallel support, see LLM output streaming
- **Jira integration** — import issues directly as specs
- **Stale alerts** — regenerating a phase flags downstream as outdated
- **Fully compatible** — reads and writes `.specify/specs/`, works alongside Spec Kit CLI

## Links

- **VS Code Marketplace**: [Caramelo](https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo)
- **GitHub**: [github.com/fsilvaortiz/caramelo](https://github.com/fsilvaortiz/caramelo)
- **License**: MIT

Would love feedback from the Spec Kit community! What features would you want to see next?
