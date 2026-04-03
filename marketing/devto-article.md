---
title: "I Built a Visual Spec-Driven Development Extension for VS Code That Works With Any LLM"
published: false
description: "Caramelo brings GitHub's Spec Kit workflow to VS Code with a visual UI, approval gates, Jira integration, and support for any LLM — from local Ollama to GitHub Copilot to corporate proxies."
tags: vscode, ai, opensource, productivity
cover_image:
---

# I Built a Visual Spec-Driven Development Extension for VS Code That Works With Any LLM

## The Problem

If you've tried [GitHub's Spec Kit](https://github.com/github/spec-kit), you know the value of spec-driven development: define requirements before coding, let AI generate structured specs, plans, and tasks. It's a great workflow.

But there's a gap.

**Spec Kit** works through slash commands in chat. No visual UI, no progress tracking, no approval workflow. You type `/speckit.specify`, read the output, type `/speckit.plan`, and so on. It works, but it's not visual.

**Kiro** (Amazon's VS Code fork) offers a visual experience — but locks you into their specific LLM and requires leaving VS Code for a custom fork.

I wanted both: a **visual workflow inside VS Code** that works with **any LLM I choose**.

So I built **Caramelo**.

## What Caramelo Does

Caramelo is a VS Code extension that gives you a complete visual UI for spec-driven development:

<!-- [Screenshot: Caramelo sidebar showing workflow panel with constitution, specs, progress rings, and task checklist] -->

### 1. Connect Any LLM — Including Your Corporate Proxy

Click a preset, enter credentials, done. No CLI tools required.

Supported out of the box:
- **GitHub Copilot** — uses your existing subscription, no API key needed
- **Local**: Ollama, LM Studio (no API key needed)
- **Cloud**: Claude, OpenAI, Groq (API key)
- **Custom**: any OpenAI-compatible endpoint
- **Corporate proxies**: custom auth headers for Azure API Manager, AWS API Gateway, etc.

You can have **multiple providers of the same type** — "Claude Personal" with your own API key and "Claude Empresa" through your company's proxy, each with different endpoints and auth settings. Switch between them by clicking the dot indicator. Models are fetched from the API when available, or entered manually with automatic validation.

### 2. Visual Workflow with Approval Gates

Instead of remembering which slash command to run next, Caramelo shows your workflow visually:

<!-- [Screenshot: Spec card showing Requirements ✓ → Design ● → Tasks 🔒 with Generate/Approve buttons] -->

Each phase must be **approved** before the next unlocks:
- **Requirements** → generates spec.md
- **Design** → generates plan.md + research.md + data-model.md
- **Tasks** → generates tasks.md

You see the documents streaming in real time as the LLM writes them. Approve when satisfied, or edit manually first. If you regenerate an earlier phase, downstream phases are flagged as stale.

### 3. Constitution-Driven Generation

Before creating any specs, you define your project's **constitution** — the non-negotiable principles:

<!-- [Screenshot: Constitution editor form with AI generation] -->

"All features must include error handling." "TDD mandatory." "No external dependencies without justification."

You can write them manually or click **"Generate with AI"** — describe your project, and the LLM suggests principles. These are automatically included as context in every generation.

### 4. Import Specs from Jira

For teams that plan in Jira:

1. Connect your Jira Cloud board (search by name for orgs with 2000+ boards)
2. Click "From Jira" when creating a spec
3. Search issues or type a key directly (e.g., PROJ-123)
4. Title, description, acceptance criteria, and comments become your spec's input

The spec card shows a linked Jira badge — click to jump to the issue.

### 5. Task Execution from the Editor

Generated tasks aren't just a document — they're actionable:

<!-- [Screenshot: tasks.md with Run Task CodeLens, progress bar, and Output Channel showing LLM streaming] -->

- **Run Task** — click a button, the LLM generates the code
- **Run All Tasks** — execute everything, respecting parallel markers `[P]`
- **Output Channel** — watch the LLM reasoning in real time
- **Progress tracking** — completion percentage in the sidebar (100% only when all tasks done)
- **Inline checklist** — toggle tasks directly in the sidebar

### 6. Quality Tools

Before moving forward, verify your work:

- **Clarify** — LLM identifies ambiguities, presents questions as QuickPick dialogs
- **Analyze** — checks consistency across all artifacts, reports findings with severity levels
- **Fix Issues** — one-click auto-fix from the analysis report
- **Checklists** — generates content-specific verification items

All accessible from the **Caramelo menu** (cat icon in the editor toolbar) — a single grouped dropdown that keeps your toolbar clean.

## Architecture: How It Works

The extension is surprisingly simple (~170KB bundle):

- **No LLM SDKs** — native `fetch` with a shared SSE parser, plus `vscode.lm` for Copilot
- **No React** — native VS Code APIs (WebviewView, CodeLens, QuickPick)
- **No external CLI** — doesn't require `specify` CLI or any tool in PATH
- **Spec Kit compatible** — reads/writes `specs/`, syncs templates from GitHub releases
- **State-driven UI** — all inline editing uses re-render pattern, no fragile DOM manipulation

## What I Learned Building This

1. **VS Code's WebviewView API is powerful.** A single webview panel replaced 3 separate TreeViews and gave us forms, progress rings, task checklists, and inline editing — all with plain HTML/CSS.

2. **SSE streaming is simple.** Two LLM provider types (OpenAI-compatible + Anthropic) plus Copilot's `vscode.lm` API cover 95% of use cases with ~150 lines of streaming code.

3. **Corporate LLM access is messy.** Different API managers use different auth header names and prefixes. Making these configurable per-provider was essential for enterprise adoption.

4. **State-driven re-renders beat DOM manipulation.** Early attempts to inject form elements via `postMessage` broke because `refresh()` destroyed event listeners. Storing `editingState` and re-rendering the full HTML with editors baked in was the reliable solution.

5. **Spec-driven development works.** Using Caramelo to build Caramelo proved the workflow. Each feature went through specify → clarify → plan → tasks → implement.

## Try It

- **Install**: Search "Caramelo" in VS Code Extensions, or visit the [Marketplace](https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo)
- **Source**: [github.com/fsilvaortiz/caramelo](https://github.com/fsilvaortiz/caramelo)
- **License**: MIT

Contributions welcome! Check the [Contributing Guide](https://github.com/fsilvaortiz/caramelo/blob/main/CONTRIBUTING.md).

---

*Built with spec-driven development, powered by any LLM you choose.*
