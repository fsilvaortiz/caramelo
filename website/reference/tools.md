# Tool reference

Every tool the agent can call. Inputs are validated against a JSON Schema (draft-07 subset) before dispatch — invalid arguments produce an `is_error` tool result the model can recover from.

## `file_read`

Read a UTF-8 file relative to the workspace root.

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | ✅ | Workspace-relative. Refused if it escapes the workspace via `..`, absolute paths, or symlinks resolving outside the root. |
| `start_line` | integer ≥ 1 | | First line to return (1-indexed, inclusive). |
| `end_line` | integer ≥ 1 | | Last line to return (1-indexed, inclusive). |

Output is capped at 50 KB. If the file is larger, the tail is truncated and a `truncated: true` marker appears in the header.

## `list_dir`

Single-level directory listing.

| Field | Type | Required |
|---|---|---|
| `path` | string | (default: workspace root) |

Subdirectories get a trailing `/`. Use `glob` for recursive discovery.

## `grep`

Regex search over the workspace.

| Field | Type | Required | Notes |
|---|---|---|---|
| `pattern` | string | ✅ | JavaScript RegExp source. |
| `path` | string | | Limit search to a workspace-relative subdirectory. |
| `case_sensitive` | boolean | | Default `false`. |
| `max_matches` | integer | | Cap, 1–500. Default 100. |

Output: up to `max_matches` rows of `path:line:text`. Files larger than 256 KB are skipped. Skips `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `.gradle`, `.next`, `.cache`, `coverage`, `__pycache__`, `.venv`, etc.

## `glob`

File-path glob.

| Field | Type | Required | Notes |
|---|---|---|---|
| `pattern` | string | ✅ | Supports `**`, `*`, `?`, `{a,b}` brace alternation. |
| `max_results` | integer | | Cap, 1–2000. Default 200. |

Returns matching paths sorted lexicographically. The workspace index never contains `..` components, so a pattern like `../*.ts` structurally cannot escape.

## `file_edit`

Atomic SEARCH/REPLACE.

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | ✅ | Must already exist — use `file_write` for new files. |
| `search` | string | ✅ | Exact text. Must match byte-for-byte and exactly once. |
| `replace` | string | ✅ | Replacement text. |

Zero matches → `is_error: true` with the "did not match" detail. Multiple matches → `is_error: true` with a "must be unique — include more context" hint. Single match → atomic write. Line endings are normalised; the file's dominant EOL is preserved.

## `file_write`

Create a new file (or overwrite if explicitly allowed).

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | ✅ | Workspace-relative. Parent directories are created automatically. |
| `content` | string | ✅ | Full file body. |
| `overwrite` | boolean | | Default `false`. When `false`, an existing file produces `is_error: true` with a "use file_edit instead" hint. |

## `bash`

Run a shell command via `/bin/sh -c`. **Always** prompts for per-call approval with the literal command, regardless of the configured approval policy.

| Field | Type | Required | Notes |
|---|---|---|---|
| `command` | string | ✅ | Passed to `/bin/sh -c`. |
| `cwd` | string | | Workspace-relative. Default workspace root. |
| `timeout_ms` | integer | | 100–120 000. Default 30 000. SIGKILL on timeout. |

Output: `exit_code`, `stdout` (truncated to 10 KB), `stderr` (10 KB). Aborts if the run's `AbortSignal` fires.

## How tools are exposed to the model

Each provider translates the tool registry into its own tool-calling shape:

- **Anthropic Claude** — `tool_use` content blocks with `input_schema` (the JSON Schema literally).
- **OpenAI-compatible** — `tools: [{ type: 'function', function: { name, description, parameters } }]` with index-keyed delta reassembly.
- **GitHub Copilot (`vscode.lm`)** — `LanguageModelChatTool[]` passed per-request to `model.sendRequest`. Caramelo does **not** call `vscode.lm.registerTool` (that registers extension-wide; we want per-request scope).

The same JSON Schema shape works across all three vendors — no per-provider translation layer.
