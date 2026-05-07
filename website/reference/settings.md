# Settings

Every Caramelo setting, what it does, and what it defaults to.

## Providers

| Setting | Type | Default | Notes |
|---|---|---|---|
| `caramelo.providers` | array | `[]` | Configured providers (id, name, type, endpoint, model, optional `authHeader` / `authPrefix`). Edited inline through the Providers sidebar — direct JSON edits work too. |
| `caramelo.activeProvider` | string | `""` | ID of the active provider. Click the dot beside a provider to switch. |
| `caramelo.sse.timeoutMs` | number | `300000` | Maximum wait for a single streaming chunk before aborting. Raise for slow local models. Minimum 5000. |

## Tasks

| Setting | Type | Default | Notes |
|---|---|---|---|
| `caramelo.tasks.allowWithoutGit` | boolean | `false` | Skip the "no backup available" confirmation when running tasks in non-git workspaces. Leave off for safety. |
| `caramelo.autoApplyEdits` | boolean | `false` | Apply task edits without a diff preview. Only flip if you have a reliable git safety net. |

## Agent

| Setting | Type | Default | Notes |
|---|---|---|---|
| `caramelo.useAgentLoop` | boolean | `true` | Run tasks through the tool-calling agent when the active provider supports it. When `false`, falls back to the legacy SEARCH/REPLACE protocol — useful for debugging regressions. |
| `caramelo.enableBashTool` | boolean | `true` | Expose the `bash` tool to the agent. Every call still requires explicit per-call approval. Disable to remove `bash` entirely from the tool list advertised to the LLM. |
| `caramelo.agent.maxIterations` | number | `15` | Maximum agent turns per task. Range 3–50. The agent stops cleanly when this is hit. |
| `caramelo.agent.approval` | enum | `"auto-reads-batched-writes"` | How write/bash calls are gated. See [Agent loop & tools](/guide/agent#approval-policies). Values: `auto-reads-batched-writes`, `per-call`, `auto-all`. |

## Debugging

| Variable | Notes |
|---|---|
| `CARAMELO_DEBUG=1` (env) | Enables verbose debug logging. The redacting logger still strips credentials. Disabled by default to keep the OutputChannel quiet. |

## Where settings live

- **User settings** — global to all workspaces. Open with `⌘,` (macOS) / `Ctrl+,` and search for `caramelo`.
- **Workspace settings** — `.vscode/settings.json` in the workspace root. Per-workspace override of any setting above.
- **Provider list & active provider** — written to **Global** scope by default, so opening another folder doesn't wipe them. Per-workspace override still works.

A one-shot migration runs at activation if it finds `caramelo.providers` / `caramelo.activeProvider` only in the workspace scope; it lifts them to Global once and leaves Global values intact afterwards.
