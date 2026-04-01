# Changelog

## [0.0.4] - 2026-04-01

### Added

- **LLM Provider System**: Connect to any LLM — Ollama, Claude, OpenAI, Groq, LM Studio, or any OpenAI-compatible endpoint
- **Jira Integration**: Import Jira Cloud issues as specs with dynamic search, issue preview, and linked badges
- **Visual Spec Management**: Unified sidebar with providers, constitution, specs, progress, and task checklist
- **Constitution Editor**: Visual form to define project principles; mandatory before creating specs
- **Sequential Workflow**: Requirements → Design → Tasks with approval gates between phases
- **Streaming Generation**: Watch documents being written in real time by the LLM
- **Intermediate Artifacts**: Design phase generates research.md, data-model.md, and contracts/
- **Constitution as Context**: Project principles automatically included in every LLM generation
- **CodeLens Actions**: Persistent Approve, Regenerate, and Next Phase buttons in spec documents
- **Caramelo Editor Menu**: Grouped contextual actions under a single icon in the editor toolbar
- **Task Execution**: Run individual tasks or all tasks with parallel support for `[P]` markers
- **LLM Output Channel**: Watch LLM reasoning in real time during task execution
- **Progress Ring**: Overall completion percentage (phases 50% + tasks 50%), 100% only when all tasks done
- **Workflow DAG**: Interactive graph showing constitution, features, and phase statuses
- **Clarify Command**: LLM identifies ambiguities, presents questions as QuickPick dialogs
- **Analyze Command**: Cross-artifact consistency check with severity levels and auto-fix (Fix This / Fix All)
- **Checklist Generation**: Content-specific quality verification items per phase
- **Stale Phase Alerts**: Downstream phases flagged when upstream is regenerated
- **Inline Task Checklist**: Toggle tasks directly in the sidebar with immediate file sync
- **Template Auto-Sync**: Automatically downloads latest Spec Kit templates from GitHub releases
- **Offline Support**: Bundled fallback templates for offline-first usage
- **Non-intrusive Progress**: Status bar spinner instead of notification popups for long operations
- **Truncation-tolerant Parser**: File block parser handles incomplete LLM output gracefully
- **Dark/Light Theme Support**: Editor menu icon adapts to VS Code theme
- **AI Constitution Generation**: Describe your project, LLM suggests principles, constraints, and workflow with streaming visible
- **Auto-detect Models**: Provider API queried for available models after entering credentials
- **Change Model on Click**: Click model name in providers panel to switch models anytime
- **Providers WebviewView**: Inline preset buttons, credential entry, and model selection in the sidebar
- **Robust JSON Parser**: Handles LLM output with comments, trailing commas, single quotes, and prose fallback
- **SSE Parser Improvements**: 5-min per-chunk timeout, flexible newline handling for Ollama compatibility
- **Implement Button**: Tasks phase shows "Implement" button to run all tasks directly from sidebar
- **Auxiliary Files Display**: research.md, data-model.md, analysis.md, checklists shown under each phase in sidebar
- **GitHub Copilot Provider**: Use Copilot's LLM models (GPT-4o, Claude Sonnet, Gemini, etc.) via vscode.lm API — no API key needed, uses existing Copilot subscription
