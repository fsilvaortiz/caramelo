# Contract: LLM output for a quick spec

The model's **final** message (no tool calls) must be exactly one of the following.

## Success

```text
=== FILE: spec.md ===
# Feature Specification: <title>

## Problem
<1–3 sentences>

## Intended change
<1–5 bullets>

## Acceptance
- **FR-001**: <testable requirement>
...

## Out of scope
- <bullets, or "None">
=== FILE: plan.md ===
# Implementation Plan: <title>

## Approach
<short paragraph>

## Files to change
- `<real/workspace/path>` — <what changes>

## Risks
- <bullets, or "None">

## Test strategy
- <how the change is verified>
=== FILE: tasks.md ===
# Tasks: <title>

- [ ] T001 <task, naming the file>
- [ ] T002 [P] <task>
=== END ===
```

## Too large

```text
=== TOO_LARGE ===
<one or two sentences: why this needs the full Requirements → Design → Tasks flow>
```

## Parser rules (`parseQuickSpecOutput`)

| Input | Result |
|---|---|
| All three `FILE` blocks once, valid tasks | `ok` |
| A `TOO_LARGE` marker anywhere | `too_large` (wins over any FILE blocks) |
| Missing or duplicated block | `invalid` naming the block |
| Whole answer wrapped in a code fence | Fence stripped, then parsed |
| CRLF line endings | Normalised to LF |
| 0 or > 8 `- [ ] Txxx` lines in tasks | `invalid` ("expected 1–8 tasks, got N") |
| Leftover template placeholders (`[FEATURE NAME]`, `NEEDS CLARIFICATION`, `$ARGUMENTS`) | `invalid` |
| Text before the first block or after `=== END ===` | Ignored (models often add a preamble) |

Nothing is written to disk unless the result is `ok`.
