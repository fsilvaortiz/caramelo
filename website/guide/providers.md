# Configure providers

Every LLM provider Caramelo talks to is a row in the **Providers** sidebar. Add as many as you like — they coexist under distinct aliases — and switch the active one by clicking its dot.

## Presets

| Provider | Type | Endpoint | Auth |
|---|---|---|---|
| Claude | `anthropic` | `https://api.anthropic.com` | API key (`x-api-key`) |
| OpenAI | `openai-compatible` | `https://api.openai.com/v1` | Bearer token |
| Gemini | `openai-compatible` | `https://generativelanguage.googleapis.com/v1beta/openai` | API key |
| Groq | `openai-compatible` | `https://api.groq.com/openai/v1` | Bearer token |
| Ollama | `openai-compatible` | `http://localhost:11434/v1` | none |
| LM Studio | `openai-compatible` | `http://localhost:1234/v1` | none |
| Copilot | `copilot` | (via `vscode.lm`) | GitHub auth |

You can also add a custom OpenAI-compatible endpoint — useful for corporate proxies (Azure API Management, Databricks, etc.). Override the auth header name and prefix at the bottom of the Add Provider form.

## Capability-driven dispatch

Caramelo doesn't branch on provider type at runtime. Each provider declares a `capabilities()` set:

| Capability | Meaning |
|---|---|
| `streaming` | Yields chat output as it arrives. Every provider above supports this. |
| `tool-calling` | Drives the agent loop in `/start-task`, `/plan`, and `/tasks`. Available on Claude (always), OpenAI-compatible (with auth), Copilot (after `authenticate()`). |

When the active provider lacks `tool-calling`, the agent loop falls back to the legacy SEARCH/REPLACE protocol with an explicit notification — no silent drift. You can force the legacy path globally with `caramelo.useAgentLoop = false`.

## Health states

The dot beside each provider:

- **gray** — inactive.
- **amber steady** — active, never tested.
- **amber pulsing** — healthcheck in flight (one-token streaming ping with a 15 s timeout).
- **green** — active, last ping returned tokens.
- **red** — active, last ping failed (auth, model not found, network). Hover for the cause.

A green dot means the model exists, your credentials reach it, and the streaming endpoint accepts a request — the same code path a real generation will exercise.

## Secrets

API keys are stored in VS Code's **SecretStorage**, never in `settings.json`, spec markdown, or `.caramelo-meta.json`. The redacting logger strips bearer/basic tokens, authorisation headers, and URL-embedded credentials before any log line reaches the OutputChannel — including tool-call arguments and results in the agent loop.

Verbose debug logging is gated behind `CARAMELO_DEBUG=1` and disabled by default.

## Multiple instances

Add several providers of the same type — each gets a distinct alias. Common patterns:

- `Claude` (Opus) for `/plan`, `Claude-fast` (Haiku) for `/start-task`.
- `OpenAI` for hosted, `Ollama-local` (`llama3` family) for offline iteration.
- `Corporate-proxy` with a custom `Authorization` prefix for Azure API Management.

Switching the active provider mid-session takes effect on the next phase or task — no reload needed.
