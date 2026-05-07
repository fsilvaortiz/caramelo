---
layout: home

hero:
  name: Caramelo
  text: Visual spec-driven development for VS Code
  tagline: LLM-agnostic. Compatible with GitHub Spec Kit. Agent loop built in.
  image:
    src: /caramelo-logo.png
    alt: Caramelo
  actions:
    - theme: brand
      text: Install from Marketplace
      link: https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo
    - theme: alt
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/fsilvaortiz/caramelo

features:
  - icon: 🧠
    title: Any LLM — really
    details: Claude, OpenAI, Gemini, Groq, GitHub Copilot, Ollama, LM Studio, or any OpenAI-compatible endpoint. Multiple providers configured side-by-side; switch with a click. Streaming output and capability-based dispatch built in.
  - icon: 🪄
    title: Tool-calling agent
    details: /start-task, /plan, and /tasks drive a multi-turn agent that reads your codebase via grep, file_read, glob, and edits with surgical SEARCH/REPLACE — never the legacy whole-file overwrite. Workspace-sandboxed and recoverable.
  - icon: 📐
    title: Spec Kit native
    details: Lives in your existing specs/ directory. Templates synced from the upstream Spec Kit release. Generates research.md, data-model.md, and contracts/ during the design phase.
  - icon: 🛡️
    title: Recoverable by default
    details: Git stash before every task. Workspace-trust gate blocks LLM execution in untrusted folders. OutputChannel redaction strips bearer tokens and authorisation headers before any log line lands on disk.
  - icon: 🎛️
    title: Visual sidebar
    details: Constitution, providers, specs, phase progress, and an inline task checklist live in one webview. No top-bar QuickPicks for daily flows — every common action is an inline button.
  - icon: 🔌
    title: Jira import
    details: Pull issues straight from Jira Cloud as starter specs — title and description map to the requirements phase.
---

## Why Caramelo

[Spec Kit](https://github.com/github/spec-kit) brings spec-driven development to AI coding — but it lives entirely in chat slash commands. [Kiro](https://kiro.dev) ships a beautiful visual experience — but locks you to a single LLM.

**Caramelo fills the gap.** A visual UI for spec-driven development that runs against whichever LLM you trust, on whichever endpoint reaches it.

## Status

Caramelo is in active development. The current released version is documented under [Changelog](/reference/changelog) — Phase A of the agentic tool-calling architecture (`v0.1.0`+) is shipped; Phase D (legacy SEARCH/REPLACE removal) is gated on a dogfooding window.

Issues, ideas, and PRs welcome at [github.com/fsilvaortiz/caramelo](https://github.com/fsilvaortiz/caramelo).
