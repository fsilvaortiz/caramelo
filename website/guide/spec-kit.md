---
description: "How Caramelo works with GitHub Spec Kit: the shared specs/ layout, templates synced from Spec Kit releases, extension hooks and recommended settings."
---

# Spec Kit integration

Caramelo speaks [GitHub Spec Kit](https://github.com/github/spec-kit)'s file layout and conventions, so a project can move between Caramelo and the `specify` CLI (or any agent Spec Kit supports) without conversion. This page covers what Caramelo reads from Spec Kit and how it behaves.

## Templates

On activation Caramelo checks the latest Spec Kit release and, when the tag changed, downloads the templates into `~/.caramelo/spec-kit/templates/`:

| File | Required | Used for |
|---|---|---|
| `spec-template.md` | yes | Requirements phase |
| `plan-template.md` | yes | Design phase |
| `tasks-template.md` | yes | Tasks phase |
| `constitution-template.md` | no | Constitution editor |
| `checklist-template.md` | no | Checklists |
| `vscode-settings.json` | no | **Caramelo: Apply Spec Kit VS Code Settings** |

If any required template fails to download, the previous cache is kept; with no cache at all, Caramelo uses the copies bundled in the extension. **Caramelo: Sync Spec Kit Templates** forces a refresh.

Slash-command placeholders in templates (`__SPECKIT_COMMAND_PLAN__`, `__SPECKIT_COMMAND_CONVERGE__`, …) are rewritten to their `/speckit.<name>` form.

## Recommended VS Code settings

Spec Kit ships a `vscode-settings.json` with its recommended chat settings. **Caramelo: Apply Spec Kit VS Code Settings** merges it into the workspace's `.vscode/settings.json`:

- keys you don't have are added;
- keys with the same value are left alone;
- keys with a different value are listed in a dialog: **Overwrite**, **Add new only**, or cancel.

Only top-level keys are compared — Caramelo never edits inside an object value you already have.

## Extension hooks

Spec Kit extensions can register commands that run before or after a core command. They are listed in `.specify/extensions.yml`, which `specify extension add` maintains:

```yaml
hooks:
  after_tasks:
    - extension: jira
      command: speckit.jira.specstoissues
      optional: true
      prompt: "Create Jira issues from tasks?"
  before_implement:
    - extension: lint
      command: speckit.lint.check
      optional: false
      condition: "env.CI is set"
```

### When hooks run

Caramelo fires `before_<command>` / `after_<command>` around the action that corresponds to each Spec Kit command:

| Caramelo action | Spec Kit command / events |
|---|---|
| Save constitution | `constitution` |
| Generate requirements | `specify` |
| Clarify | `clarify` |
| Generate design | `plan` |
| Generate tasks | `tasks` |
| Checklist | `checklist` |
| Analyze | `analyze` |
| Converge | `converge` |
| Run all tasks | `implement` |

- **Before** hooks run after the action's own checks pass and **before** it reads any file, so a hook can prepare artifacts the action then uses.
- **After** hooks run only when the action succeeded.
- Hooks for an event run in `priority` order (lower first, default 10).

### Mandatory and optional

- **Mandatory** (`optional: false`) hooks run automatically. If a mandatory **before** hook fails, Caramelo asks whether to continue; choosing not to cancels the action.
- **Optional** hooks (the default) ask first, showing the hook's `prompt` and `description`.
- Failures of optional hooks and of any **after** hook are reported in the Caramelo output channel and never block.

### Conditions

A hook with a `condition` runs only when it holds. Caramelo evaluates exactly the forms Spec Kit supports — anything else is treated as not met:

| Condition | Meaning |
|---|---|
| `config.connection.url is set` | the key exists in the extension's config |
| `config.sync.mode == 'fast'` / `!=` | compares the extension config value |
| `env.CI is set` | the environment variable exists |
| `env.STAGE == 'prod'` / `!=` | compares the environment variable |

Extension config is layered like Spec Kit's: defaults from the extension manifest, then `.specify/extensions/<id>/<id>-config.yml`, then `local-config.yml`, then `SPECKIT_<ID>_<KEY>` environment variables.

### How a hook executes

Caramelo locates the command through the extension's manifest (`.specify/extensions/<id>/extension.yml`), renders it the way Spec Kit registers it for an agent (script paths for your platform, `{SCRIPT}`, command references), and runs it with the active provider:

- **Tool-calling providers** run it as an agent with the same tools as task execution. **Every `bash` call asks for your approval, and file writes are shown for approval before they're applied.**
- Other providers receive it as a text prompt; the answer appears in the output channel.

Progress is shown in a cancellable notification and the full transcript in the **Caramelo** output channel.

### The sidebar panel

When `.specify/extensions.yml` has hooks, the sidebar shows a **Spec Kit Hooks** panel grouped by event:

- `⚙` mandatory, `◯` optional; hover for the extension, description, prompt and priority;
- a ✓ / ✗ chip shows whether each condition currently holds;
- **Enable** / **Disable** writes `enabled: true|false` for that hook in `extensions.yml`, keeping your comments and formatting.

### Turning hooks off

Set `caramelo.hooks.run` to `false` to stop Caramelo from running hooks (the panel then shows **not running**). Hooks never run in untrusted workspaces.
