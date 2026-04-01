# Changelog

## [0.0.1] - 2026-04-01

### Added

- **LLM Provider System**: Connect to any LLM — Ollama, Claude, OpenAI, Groq, LM Studio, or any OpenAI-compatible endpoint
- **Visual Spec Management**: Sidebar with spec listing, phase status tracking, and progress indicators
- **Constitution Editor**: Visual form to define project principles that guide spec generation
- **Sequential Workflow**: Requirements → Design → Tasks with approval gates between phases
- **Streaming Generation**: Watch documents being written in real time by the LLM
- **Intermediate Artifacts**: Design phase generates research.md, data-model.md, and contracts/
- **CodeLens Actions**: Persistent Approve, Regenerate, and Next Phase buttons in spec documents
- **Editor Toolbar Buttons**: Context-aware actions based on the open file
- **Task Execution**: Run individual tasks or all tasks from CodeLens in tasks.md
- **Parallel Task Support**: Tasks marked `[P]` execute concurrently
- **Progress Dashboard**: Visual progress rings and phase dots in the sidebar
- **Workflow DAG**: Interactive graph showing all specs and their phase statuses
- **Clarify Command**: LLM identifies ambiguities, presents questions as QuickPick dialogs
- **Analyze Command**: Cross-artifact consistency check generating analysis.md with severity levels
- **Checklist Generation**: Content-specific quality verification items
- **Stale Phase Alerts**: Downstream phases flagged when upstream is regenerated
- **Inline Task Checklist**: Toggle tasks directly in the sidebar progress panel
- **Template Auto-Sync**: Automatically downloads latest Spec Kit templates from GitHub releases
- **Offline Support**: Bundled fallback templates for offline-first usage
