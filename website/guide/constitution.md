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

## Central constitution from a Git repository

Organisations with many projects can keep one constitution in a Git repository and have every project follow it. When a project is connected, `.specify/memory/constitution.md` becomes an **exact copy** of the file in that repository: Spec Kit, other agents and every Caramelo prompt keep reading the usual path, and the constitution is changed only through the repository (for example, by pull requests reviewed by your architecture leads).

### Connect a project

Open the Constitution editor and expand **🔗 Use a central constitution from a Git repository**:

| Field | Example | Notes |
|---|---|---|
| Repository | `https://github.com/acme/engineering-standards.git`, `git@github.com:acme/standards.git` | `https://`, `ssh://`, `git@host:path`, `git://` and `file://` are accepted. |
| File in the repository | `constitution.md`, `docs/constitution.md` | Defaults to `constitution.md`. |
| Branch or tag | `main`, `v2` | Empty follows the default branch. A tag pins the project to a reviewed version until you change it. |

**Connect** checks the repository and fetches the file before changing anything. If the project already has its own constitution, Caramelo asks before replacing it and saves the old one as `.specify/memory/constitution.local-backup.md`.

The choice is stored in the workspace settings, so committing `.vscode/settings.json` connects the whole team:

```json
{
  "caramelo.constitution.repository": "git@github.com:acme/engineering-standards.git",
  "caramelo.constitution.path": "constitution.md",
  "caramelo.constitution.ref": "v2"
}
```

Caramelo uses the Git credentials already on the machine — SSH keys or a credential helper — and never prompts for a password.

### Staying up to date

- **On startup** Caramelo checks the repository in the background. If the project has never been synced, or the file changed, a notification offers **Sync**.
- **Before generating a phase or running Converge** it checks again (at most every 5 minutes) and asks:
  - when there's a newer version: **Sync and continue** or **Continue with current**;
  - when `constitution.md` was edited by hand: **Restore central and continue** or **Keep my edits**.

  Closing the question cancels the generation. Choosing to continue is remembered for the rest of the session for that version or those edits.
- Commits to the repository that don't change the constitution file are ignored.
- If the repository can't be reached, generation uses the last synced copy without asking.

The sidebar's Constitution row shows the state — the synced commit and when, *update available*, *edited locally*, or an error — with a one-click **Sync**, **Restore** or **Retry**. **Caramelo: Sync Central Constitution** does the same from the command palette.

What was synced (repository, file, branch/tag, commit, content hash, time) is recorded in `.specify/memory/constitution-source.json`.

### Disconnect

**Disconnect…** in the editor stops following the repository. `constitution.md` keeps its current content and becomes a normal, editable file again.

### Safety

Repository settings can be committed by anyone, so Caramelo only accepts the URL forms above (never Git's `<transport>::` helpers), validates the file path and branch, runs Git without a shell and without prompts, and never contacts the repository in an untrusted workspace.
