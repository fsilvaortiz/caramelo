# Spec-driven flow

Every Caramelo feature lives under `specs/<slug>/` and walks through three approval-gated phases plus an implementation step.

## Constitution → spec → plan → tasks → implementation

```
.specify/memory/constitution.md   ← project-wide principles, included in every prompt
specs/006-agentic-tool-calling/
├── spec.md                       ← Requirements   (P1)
├── plan.md                       ← Design         (P2, agent path)
├── research.md                   ← R&D decisions  (text-only follow-up)
├── data-model.md                 ← Data entities  (text-only follow-up)
├── contracts/                    ← Interface contracts (optional)
├── tasks.md                      ← Tasks          (P3, agent path)
└── analysis.md                   ← Cross-artifact consistency report (on demand)
```

Each phase has a CodeLens approval bar at the top of its document. Approving moves the phase to `approved` and unlocks the next; regenerating an approved phase marks downstream phases stale.

## Phase 1 — Requirements (`spec.md`)

A user-story spec built from the project description and your constitution. **Text-only generation** — there's no code to inspect yet, so the agent path is skipped here intentionally.

You can run `/clarify` against an in-progress spec: the LLM identifies ambiguities, and Caramelo presents up to five questions inline in the sidebar. Skipped questions are not written; submitted answers go into a dated `## Clarifications` section.

## Phase 2 — Design (`plan.md` + intermediate artifacts)

The plan is generated through the **agent loop** when the active provider declares the `tool-calling` capability. The model can call `file_read`, `grep`, `glob`, and `list_dir` while writing the plan, so proposed file paths and module references reflect the real codebase rather than hallucinations.

After the plan lands, three structured-output follow-up calls produce `research.md`, `data-model.md`, and (optional) `contracts/` — text-only, since these are narrow JSON-shaped tasks with no exploration benefit.

## Phase 3 — Tasks (`tasks.md`)

A dependency-ordered task list, also generated through the agent loop. Tasks marked `[P]` are independent and run in parallel.

Each task has two CodeLens buttons: **Run Task** (one) and **Run All Tasks** (sweep through pending ones, batching `[P]` groups concurrently). The agent reads the task, scans referenced files, and emits surgical edits — never whole-file overwrites.

## Phase 4 — Analysis (optional)

`/analyze` runs across all phase artifacts and writes `analysis.md` with severity-coded findings (critical / high / medium / low). Each finding has a CodeLens **Fix** button that re-runs the agent against the offending document. **Fix All** sweeps every finding sequentially.

## Approval gates and stale flags

- A phase moves to `pending-approval` when its document is generated.
- Click **Approve** to move it to `approved`. Approving Requirements unlocks Design, etc.
- Regenerating an approved phase marks downstream phases `stale` — they keep their content but the sidebar nudges you to regenerate.
- Tasks have their own checkbox state (`- [ ]` / `- [x]`) toggleable from the inline checklist.

Progress ring on each spec card sums to 100% only when all three phases are approved AND all tasks are complete.

## Git safety

Every task run takes a `git stash push -u -m caramelo-pre-task-<timestamp>` before touching anything. The label is logged so you can `git stash pop` to revert. Workspaces that aren't git repos prompt before proceeding (or set `caramelo.tasks.allowWithoutGit = true` to silence the prompt).

Untrusted workspaces refuse all LLM execution outright — both the agent path and the legacy fallback.
