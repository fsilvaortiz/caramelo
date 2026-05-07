# Agent loop & tools

Caramelo's `/start-task`, `/plan`, and `/tasks` run through a **multi-turn tool-calling agent**. The LLM doesn't write a code edit and hope it lands — it reads files, greps the codebase, then emits surgical SEARCH/REPLACE blocks against the real content.

## The seven tools

| Tool | Read-only | What it does |
|---|---|---|
| `file_read` | ✅ | Read a workspace file (UTF-8, capped at 50 KB; line-range slice optional). |
| `list_dir` | ✅ | Single-level directory listing; subdirectories get a trailing `/`. |
| `grep` | ✅ | Regex search. Returns up to 100 `path:line:text` rows. Skips `node_modules`, `.git`, `dist`, etc. |
| `glob` | ✅ | File-path glob (`**/*.ts`, brace alternation, etc.). Returns sorted matches. |
| `file_edit` | ❌ | Atomic SEARCH/REPLACE. Refuses on zero or multiple matches. |
| `file_write` | ❌ | Create new files. Refuses to overwrite unless `overwrite=true`. |
| `bash` | ❌ | Shell command via `/bin/sh -c`. **Always per-call approval** with the literal command. SIGKILL on 30 s timeout (120 s hard max). |

Every filesystem tool is sandboxed to the workspace root via `resolveInsideWorkspace` + `fs.realpathSync`. Symlinks pointing outside the workspace are refused; absolute paths and `..` traversal too.

## Approval policies

Set via `caramelo.agent.approval`:

| Mode | Reads | Writes | Bash |
|---|---|---|---|
| `auto-reads-batched-writes` *(default)* | auto-allowed | one batched modal per turn | per-call modal |
| `per-call` | auto-allowed | one modal per write | per-call modal |
| `auto-all` | auto-allowed | auto-allowed | **still per-call** |

Bash is hard-coded to always prompt — even `auto-all` shows the literal command. Approving "Don't ask again this session" upgrades **writes only** to auto-apply for the rest of the window; bash always prompts.

The approval modal is centred — never a top-bar QuickPick. Same shape as VS Code's native modals.

## Iteration cap

`caramelo.agent.maxIterations` defaults to 15 (range 3–50). When the cap is hit, the loop terminates cleanly with a warning instead of crashing. Common pattern: a task that requires more turns than usual triggers the cap; raise the setting or break the task into smaller pieces.

Cancellation propagates from the status-bar abort all the way down to in-flight HTTP / `vscode.lm` requests. The git safety stash is always preserved so you can revert.

## Output trace

Every agent run starts with a one-line prologue in the **Caramelo** OutputChannel:

```
▶ agent start  provider=Claude  model=claude-opus-4-7  capabilities=[streaming,tool-calling]  tools=7  approval=auto-reads-batched-writes  bash=on  maxIter=15
```

Each tool call streams as it arrives:

```
→ file_read path="src/agent/runtime.ts"
  ✓ file_read src/agent/runtime.ts (4523 B, 145 lines)
→ grep pattern="parseSSEEvents" path="src/providers"
  ✓ grep /parseSSEEvents/ → 3 matches
→ file_edit path="src/agent/runtime.ts" search="..." replace="..."
  ⚠ denied: user declined this tool call.
```

Every line passes through the redacting logger before reaching the channel. Bearer tokens, authorisation headers, and URL-embedded credentials are replaced with `[REDACTED]` — even if a tool result happens to contain them.

## When the agent isn't available

If the active provider doesn't declare `tool-calling`, Caramelo falls back to a single-shot SEARCH/REPLACE protocol with an explicit notification:

```
↪ provider "Ollama-local" does not advertise the 'tool-calling' capability
  (capabilities: [streaming]). Falling back to the legacy SEARCH/REPLACE
  protocol. To silence this message, set caramelo.useAgentLoop=false.
```

You can also force the legacy path globally with `caramelo.useAgentLoop = false` — useful when comparing behaviours during the dogfooding window.
