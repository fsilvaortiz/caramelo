---
title: "I Built a Visual Spec-Driven Development Extension for VS Code That Works With Any LLM"
published: false
description: "Caramelo brings GitHub's Spec Kit workflow to VS Code with a visual UI, approval gates, Jira integration, and support for any LLM — from local Ollama to cloud Claude."
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

### 1. Connect Any LLM

Click `+`, pick your provider, done. No CLI tools required. No configuration files to edit.

Supported out of the box:
- **Local**: Ollama, LM Studio (no API key needed)
- **Cloud**: Claude, OpenAI, Groq (API key)
- **Custom**: any OpenAI-compatible endpoint

Switch between providers with one click. Use a fast local model for drafts, switch to Claude for the final version.

### 2. Visual Workflow with Approval Gates

Instead of remembering which slash command to run next, Caramelo shows your workflow visually:

<!-- [Screenshot: Spec card showing Requirements ✓ → Design ● → Tasks 🔒 with Generate/Approve buttons] -->

Each phase must be **approved** before the next unlocks:
- **Requirements** → generates spec.md
- **Design** → generates plan.md + research.md + data-model.md
- **Tasks** → generates tasks.md

You see the documents streaming in real time as the LLM writes them. Approve when satisfied, or edit manually first.

### 3. Constitution-Driven Generation

Before creating any specs, you define your project's **constitution** — the non-negotiable principles:

<!-- [Screenshot: Constitution editor form with principles, constraints, workflow fields] -->

"All features must include error handling." "TDD mandatory." "No external dependencies without justification."

These principles are automatically included as context in every LLM generation, so your specs align with your team's standards.

### 4. Task Execution from the Editor

Generated tasks aren't just a document — they're actionable:

<!-- [Screenshot: tasks.md with Run Task CodeLens, progress bar, and Output Channel showing LLM streaming] -->

- **Run Task** — click a button, the LLM generates the code
- **Run All Tasks** — execute everything, respecting parallel markers `[P]`
- **Output Channel** — watch the LLM reasoning in real time
- **Progress tracking** — see completion percentage in the sidebar

### 5. Quality Tools

Before moving forward, verify your work:

- **Clarify** — LLM identifies ambiguities in your spec and asks targeted questions via QuickPick dialogs
- **Analyze** — checks consistency across all artifacts (requirements ↔ plan ↔ tasks), reports findings with severity levels
- **Fix Issues** — one-click auto-fix for consistency problems
- **Checklists** — generates content-specific verification items (not generic templates)

### 6. Jira Integration

For teams that plan in Jira:

1. Connect your Jira Cloud board
2. Click "From Jira" when creating a spec
3. Search and select an issue
4. Title, description, acceptance criteria, and comments become your spec's input

The spec card shows a linked Jira badge — click to jump to the issue.

## Architecture: How It Works

The extension is surprisingly simple (~170KB bundle):

- **No LLM SDKs** — native `fetch` with a shared SSE parser handles all streaming
- **No React** — native VS Code APIs (TreeView, CodeLens, WebviewView, QuickPick)
- **No external CLI** — doesn't require `specify` CLI or any tool in PATH
- **Spec Kit compatible** — reads/writes `.specify/specs/`, syncs templates from GitHub releases

```
Provider (any LLM)
    ↓ streaming SSE
Workflow Engine
    ↓ templates + constitution + context
Phase Documents (spec.md → plan.md → tasks.md)
    ↓ CodeLens + sidebar
Visual UI (approve, regenerate, execute)
```

## What I Learned Building This

1. **VS Code's extension API is powerful.** CodeLens, WebviewView, context keys, submenu contributions — you can build rich UI without React or custom frameworks.

2. **SSE streaming is simple.** Two LLM providers (OpenAI-compatible + Anthropic) cover 95% of use cases with ~100 lines of SSE parsing code.

3. **Spec-driven development works.** Using Caramelo to build Caramelo (yes, really) proved the workflow. Each feature went through specify → clarify → plan → tasks → implement.

4. **Constitution matters.** Once I added constitution-as-context, the quality of generated specs improved dramatically. The LLM stopped producing generic output and started aligning with my project's actual principles.

## Try It

- **Install**: Search "Caramelo" in VS Code Extensions, or visit the [Marketplace](https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo)
- **Source**: [github.com/fsilvaortiz/caramelo](https://github.com/fsilvaortiz/caramelo)
- **License**: MIT

Contributions welcome! Check the [Contributing Guide](https://github.com/fsilvaortiz/caramelo/blob/main/CONTRIBUTING.md).

---

*Built with spec-driven development, powered by any LLM you choose.*
