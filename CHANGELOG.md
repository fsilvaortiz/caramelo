# Changelog

## [0.0.5] - 2026-04-01

### Added

- **LLM Provider System**: Connect to any LLM — GitHub Copilot, Ollama, Claude, OpenAI, Groq, LM Studio, or any OpenAI-compatible endpoint
- **GitHub Copilot Provider**: Use Copilot's LLM models (GPT-4o, Claude Sonnet, Gemini, etc.) via vscode.lm API — no API key needed
- **Jira Integration**: Import Jira Cloud issues as specs with board search, issue key lookup, and linked badges
- **Visual Spec Management**: Unified sidebar with providers, constitution, specs, progress, and task checklist
- **Constitution Editor**: Visual form with AI generation — describe your project, LLM suggests principles
- **Sequential Workflow**: Requirements → Design → Tasks with approval gates between phases
- **Streaming Generation**: Watch documents being written in real time by the LLM
- **Intermediate Artifacts**: Design phase generates research.md, data-model.md, and contracts/
- **Constitution as Context**: Project principles automatically included in every LLM generation
- **CodeLens Actions**: Persistent Approve, Regenerate, and Next Phase buttons in spec documents
- **Caramelo Editor Menu**: Grouped contextual actions under a single cat icon (dark/light theme support)
- **Task Execution**: Run individual tasks or all tasks with parallel support for `[P]` markers
- **LLM Output Channel**: Watch LLM reasoning in real time during task execution
- **Progress Ring**: Overall completion percentage (phases 50% + tasks 50%), 100% only when all tasks done
- **Workflow DAG**: Interactive graph showing constitution, features, and phase statuses
- **Clarify Command**: LLM identifies ambiguities, presents questions as QuickPick dialogs
- **Analyze Command**: Cross-artifact consistency check with severity levels and auto-fix (Fix This / Fix All)
- **Checklist Generation**: Content-specific quality verification items per phase
- **Stale Phase Alerts**: Downstream phases flagged when upstream is regenerated
- **Inline Task Checklist**: Toggle tasks directly in the sidebar with immediate file sync
- **Auto-detect Models**: Provider API queried for available models after entering credentials
- **Change Model on Click**: Click model name in providers panel to switch models anytime
- **Providers WebviewView**: Inline preset buttons, credential entry, and model selection — all in sidebar
- **Jira Board Search**: Search boards by name instead of loading all (scales to 2000+ boards)
- **Jira Issue Key Lookup**: Type an issue key directly (e.g. PROJ-123) to find issues not in the board view
- **Template Auto-Sync**: Automatically downloads latest Spec Kit templates from GitHub releases
- **Offline Support**: Bundled fallback templates for offline-first usage
- **Non-intrusive Progress**: Status bar spinner instead of notification popups
- **Auxiliary Files Display**: research.md, data-model.md, analysis.md, checklists shown under each phase

### Fixed

- Specs directory now uses `specs/` (Spec Kit default) instead of `.specify/specs/`
- Jira board search via API name filter instead of loading all boards (fixes timeout on large orgs)
- Jira issue search uses Agile API instead of JQL (fixes 410 Gone on Jira Cloud)
- Jira issue content extraction uses API v2 for plain text descriptions
- Jira context (jira-context.md) included as LLM input when generating Requirements
- Task completion marking with 3 fallback strategies (fixes parallel execution miscount)
- Truncation-tolerant file block parser handles incomplete LLM output
- SSE parser with 5-min per-chunk timeout and flexible newline handling for Ollama
- Robust JSON parser handles LLM output with comments, trailing commas, single quotes
- Dynamic import replaced with static import (fixes esbuild bundle compatibility)
- ESLint migrated to flat config (v9 compatible)
