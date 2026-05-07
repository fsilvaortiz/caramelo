# Getting started

Install Caramelo, point it at an LLM provider, and run your first spec.

## Install

From the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo) — search **Caramelo** in the Extensions sidebar and click **Install**.

Or from the command line:

```bash
code --install-extension fsilvaortiz.caramelo
```

You'll see a 🐱 icon in the activity bar — that's the Caramelo sidebar.

## First run

1. **Open the Caramelo sidebar.** It has two panels: **Providers** (collapsed by default) and **Workflow** (visible).
2. **Configure a provider.** Expand Providers, pick a preset (Claude, OpenAI, Ollama, Copilot, …), enter your API key if needed, and click **Save**. The provider dot turns green when a one-token healthcheck succeeds.
3. **Set up the constitution.** From the Workflow panel, click **Set up Constitution to begin**. Either fill in principles by hand or use **Generate with AI** — describe your project in a sentence and the LLM proposes a starting set.
4. **Create a spec.** Click **+ New Spec**, give it a name like `user-auth`, and a one-line description.
5. **Run the phases.** Each phase has a **Generate** button: Requirements → Design → Tasks. Approve each one to unlock the next. Documents stream into the editor as the LLM produces them.
6. **Run the tasks.** From the generated `tasks.md`, click **Run Task** on any line, or **Run All Tasks** from the editor's title bar. Tasks marked `[P]` run in parallel.

That's the full loop. The rest of this guide covers the things you can tune.

## What you'll need

- VS Code 1.95 or later.
- An LLM provider — any of:
  - **Cloud**: Claude (Anthropic), OpenAI, Gemini, Groq, GitHub Copilot.
  - **Local**: Ollama or LM Studio.
  - **Custom**: any OpenAI-compatible endpoint (corporate proxies, self-hosted gateways).
- A workspace folder. Caramelo refuses to run agent tasks in untrusted workspaces.

## Next

- [Configure providers](/guide/providers) for the details of each preset, including custom auth headers for corporate proxies.
- [Spec-driven flow](/guide/workflow) walks through the four-phase ritual with screenshots.
- [Agent loop & tools](/guide/agent) documents how `/start-task` actually edits your code.
