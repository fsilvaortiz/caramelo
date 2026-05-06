# Constitution

The project constitution lives at `.specify/memory/constitution.md`. It's the highest-priority context Caramelo passes to every LLM generation — principles, constraints, and workflow rules that shape spec, plan, and task output.

## Edit it visually

From the Workflow sidebar, click **Constitution** at the top. The webview has:

- **Project name** — short, 1–3 words.
- **Core principles** — a list of `name + description` cards, addable / removable. Star ★ marks AI-suggested recommendations when you use the generator.
- **Constraints** — free-form (technology stack, performance budgets, compliance).
- **Workflow** — free-form (review process, testing gates, deployment).

Save writes the markdown back to `.specify/memory/constitution.md` with the right Spec Kit shape.

## Generate with AI

Click **🤖 Generate with AI**, describe your project (one sentence is enough), and the LLM proposes principles, constraints, and workflow rules. Output runs at `temperature: 0` to stabilise structured generation.

If parsing fails for any reason — malformed JSON, prose-only response, etc. — Caramelo logs the first 500 bytes of the raw response (redacted) to the OutputChannel and toasts a retry hint, rather than swallowing the error.

## Why it matters

The constitution feeds two things:

1. **Spec generation** — before the LLM produces `spec.md`, `plan.md`, or `tasks.md`, Caramelo prepends the constitution to the system prompt. Generated documents respect your principles without you having to repeat them.
2. **Phase approval** — the Workflow sidebar refuses to generate phases until a constitution exists. This is intentional: spec-driven development without principles is just LLM autocomplete.

The bundled template includes example principles you can use as a starting point. A constitution containing template placeholders (`[PRINCIPLE_1_NAME]`) is treated as empty.
