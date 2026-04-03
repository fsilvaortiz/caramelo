# Subreddits

## r/vscode

**Title**: I made a VS Code extension for visual spec-driven development that works with any LLM (Copilot, Ollama, Claude, corporate proxies)

**Body**:

I built **Caramelo**, an open-source extension that brings GitHub Spec Kit's spec-driven workflow to VS Code with a full visual UI.

**Problem**: Spec Kit works through slash commands (no visual UI). Kiro offers a visual experience but locks you into one LLM.

**What Caramelo does**:
- Visual sidebar with specs, progress rings, task checklists
- Sequential workflow: Requirements → Design → Tasks (with approval gates)
- Works with ANY LLM — GitHub Copilot (no API key!), Ollama, Claude, OpenAI, Groq, LM Studio
- Corporate proxy support — custom auth headers (Azure API Manager, etc.)
- Constitution editor with AI generation
- Jira Cloud integration — import issues as specs
- Task execution with parallel support and live LLM output
- Clarify ambiguities + Analyze consistency + auto-fix
- Model validation with visual status indicator
- All provider management inline in the sidebar (no QuickPick popups)

No external CLI needed. ~170KB bundle. MIT licensed.

Marketplace: https://marketplace.visualstudio.com/items?itemName=fsilvaortiz.caramelo
GitHub: https://github.com/fsilvaortiz/caramelo

Feedback welcome!

---

## r/programming

**Title**: Caramelo: Open-source VS Code extension for spec-driven development — visual UI, any LLM, Jira integration, corporate proxy support

**Body**: (same as above)

---

## r/artificial

**Title**: Built a VS Code extension that uses any LLM (Copilot, Ollama, Claude, corporate APIs) for spec-driven development — visual workflow from requirements to implementation

**Body**: (same as above, emphasize the LLM-agnostic + corporate proxy angle)

---

## r/ExperiencedDevs

**Title**: I built a VS Code extension for spec-driven development that connects to any LLM, including corporate API proxies

**Body**:

After using GitHub's Spec Kit for spec-driven development, I wanted a visual UI that didn't lock me into one LLM — especially since my company exposes LLMs through Azure API Manager with custom auth headers.

I built **Caramelo** (open source, MIT):

**The workflow**: Constitution (project principles) → Requirements → Design (with research.md, data-model.md) → Tasks → Implementation

**Enterprise-friendly**:
- Custom auth headers per provider (header name + value prefix)
- Multiple providers of the same type with aliases ("Claude Prod", "Claude Dev")
- Model validation on change — red indicator if it doesn't connect
- GitHub Copilot as a provider (uses existing subscription, no API key)
- Jira Cloud integration with board search (scales to 2000+ boards)

**Developer experience**:
- All provider config is inline in the sidebar — no QuickPick popups
- LLM output streams in real time (both in editor and Output Channel)
- Stale phase alerts when upstream specs change
- Cross-artifact consistency analysis with one-click auto-fix

170KB bundle, no SDK dependencies, reads/writes standard `specs/` directory (compatible with Spec Kit CLI).

https://github.com/fsilvaortiz/caramelo
