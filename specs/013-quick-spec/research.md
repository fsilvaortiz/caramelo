# Research: Quick Spec Mode

All Technical Context items were known from the codebase; there were no open NEEDS CLARIFICATION items. These are the design decisions.

## 1. How one LLM run returns three documents

- **Decision**: One markdown response with three blocks:
  `=== FILE: spec.md ===` … `=== FILE: plan.md ===` … `=== FILE: tasks.md ===` … `=== END ===`.
  An oversized request answers `=== TOO_LARGE ===` followed by the reason.
- **Rationale**: Caramelo already parses delimiter blocks reliably for task edits (`=== CREATE: … ===` in `src/commands/task-edits/parser.ts`), and models follow this format well. Markdown stays unescaped.
- **Alternatives considered**:
  - *JSON with three string fields*: escaping of newlines and quotes is a known failure mode (see the constitution generator's JSON-repair code in `src/commands/edit-constitution.ts`).
  - *Three sequential calls*: triples latency and breaks FR-002 (single run).
  - *Tool call `write_quick_spec(spec, plan, tasks)`*: would require a write-capable tool during generation, conflicting with FR-004, and it is unavailable on non-tool-calling providers.

## 2. Grounding in the real code

- **Decision**: With a tool-calling provider, run `AgentRuntime` with `buildReadOnlyToolSet()` (`file_read`, `list_dir`, `grep`, `glob`) and take the terminal assistant message via the existing `pickTerminalArtifact`. Without tool calling, use `chat()` with description plus constitution, and log that grounding was unavailable.
- **Rationale**: Same mechanism as agent phase generation and Converge, so it is already tested. Read-only tools need no approval, so no prompt can appear.
- **Alternatives considered**: *Pre-computing a repo map in the prompt*: costs tokens on every run and is less precise than targeted `grep`.

## 3. Templates

- **Decision**: Condensed section lists are built into the prompt and derived from the Spec Kit templates' headings:
  - **spec**: Problem, Intended change, Acceptance (FR-xxx), Out of scope.
  - **plan**: Approach, Files to change (real paths), Risks, Test strategy.
  - **tasks**: standard Spec Kit checklist (`- [ ] T001 …`, `[P]` allowed), 1–8 tasks.
- **Rationale**: Keeps output short (FR-003) and needs no new upstream Spec Kit template. Organization templates (feature 014) can override these later.
- **Alternatives considered**: *Feeding the full templates with "be brief"*: the full templates are hundreds of lines, so models fill every section and the output stops being "quick".

## 4. Where the mode lives

- **Decision**: `.caramelo-meta.json` gets `"mode": "quick" | "full"` (absent means full) and `"promotedFrom": "quick"` after promotion.
- **Rationale**: Principle IV keeps Caramelo-only state in the meta file. An absent field means existing specs need no migration.
- **Alternatives considered**: *A front-matter flag in spec.md*: pollutes a Spec Kit file.

## 5. The approval gate

- **Decision**: One explicit **Approve** sets all three phases to `approved`. The constitution's Phase gates rule is amended (1.2.0) to allow a single explicit gate for quick specs.
- **Rationale**: Keeps a human decision before any code changes while removing two of three clicks.
- **Alternatives considered**: See plan.md, Complexity Tracking.

## 6. Size guard

- **Decision**: The prompt instructs the model to answer `TOO_LARGE` when the change needs more than 8 tasks or several independent features. The parser also rejects more than 8 tasks.
- **Rationale**: Two layers. The model's judgement catches scope; the parser enforces the hard limit.
- **Alternatives considered**: *Truncating to 8 tasks*: silently drops work.

## 7. Hooks

- **Decision**: Run `before_specify` before generation and `after_tasks` after a successful parse.
- **Rationale**: These are the boundaries of the documents a quick spec replaces; teams relying on these hooks keep them. Skipping plan hooks avoids running three hook rounds for one generation.
- **Alternatives considered**: *Running all six hook events*: noisy and slow for the "quick" promise.

## 8. Jira / GitHub issues

- **Decision**: Out of scope for this iteration. The prompt builder accepts an optional `issueContext`, so "Quick from issue" is a small follow-up.
- **Rationale**: The current "From Jira" flow creates a full spec; changing it needs UI that must avoid QuickPick (Principle II).
