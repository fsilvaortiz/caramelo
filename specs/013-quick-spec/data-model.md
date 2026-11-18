# Data Model: Quick Spec Mode

## Spec metadata (`specs/<feature>/.caramelo-meta.json`)

| Field | Type | Notes |
|---|---|---|
| `phases.requirements` / `phases.design` / `phases.tasks` | `PhaseStatus` | Existing. For a quick spec, the three always move together until promoted. |
| `description` | `string?` | Existing. The one-line description typed in the form. |
| `mode` | `"quick" \| "full"`, optional | **New.** Absent means `full`, so existing specs need no migration. |
| `promotedFrom` | `"quick"`, optional | **New.** Set when a quick spec is promoted. Informational (badges, metrics). |
| `jira` | object, optional | Existing; unchanged. |

`writeMetadata` already preserves unknown fields, so `mode` survives phase status writes.

## State transitions (quick spec)

```text
created ──generate──▶ generating ──ok──▶ pending-approval (×3) ──Approve──▶ approved (×3) ──Implement──▶ tasks run (existing flow)
                         │  └─too_large / invalid / error / cancel──▶ pending (×3), no files written
                         │
any state ──Promote──▶ mode=full, promotedFrom=quick
                       each phase: file exists → pending-approval, else pending
approved (×3) ──Regenerate──▶ generating (all three replaced together)
```

Rules:
- The three phase statuses of a quick spec are written in one `writeMetadata` call, never independently.
- Implement is offered only when all three are `approved`.
- After promotion, normal full-flow rules apply (gates, stale marking).

## Generation result (in memory, `src/specs/quick-spec.ts`)

```ts
type QuickSpecParse =
  | { kind: 'ok'; spec: string; plan: string; tasks: string; taskCount: number }
  | { kind: 'too_large'; reason: string }
  | { kind: 'invalid'; problems: string[] };
```

Validation for `ok`:
- All three `FILE` blocks are present exactly once; other text outside the blocks is ignored.
- Each document is non-empty after trimming. Template placeholders such as `[FEATURE NAME]` or `NEEDS CLARIFICATION` count as problems.
- `tasks.md` has between 1 and 8 lines matching `^- \[ \] T\d{3}\b`.

## Setting

| Key | Type | Default | Scope |
|---|---|---|---|
| `caramelo.quickSpec.enabled` | boolean | `true` | resource (workspace can disable; organization policy 014 can force it off) |
