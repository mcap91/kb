# {{id}} Execution Tracker

<!--
AUTHORING GUIDE — delete this block after filling in the tracker.

This tracker must be self-contained (cold-start principle): a fresh agent with
zero prior context must be able to execute the plan from this document alone.

Required sections (validate-plan checks for these):
  1. How to Use This Tracker — keep the boilerplate below
  2. Project Context         — repo, branch, target files, test command
  3. Gates                   — checkable criteria per slice; heading grammar below
  4. Task-to-Phase Mapping   — table with: Task, Slice, Description, parallelizable, user_interaction
                                (alias: Phase — WK-0082)
  5. How to Dispatch         — Target file, Test command, Worktree isolation, Critical Rules
  6. Phase Status Table      — Slice, Status, Started, Completed, Notes
                                (alias: Phase — WK-0082)
  7. Completed Log           — table (preferred) or bullet list; see format examples below
  8. Failure Log             — ### YYYY-MM-DD subsections; see format example below

user_interaction column values: none | required | recommended
  none        — agent can complete without human input
  required    — must pause for human input before proceeding
  recommended — agent should attempt, but flag for human review

Slice status values: uses the WK (issue) status enum from contract/manifest.json.
  Common values: todo | in_progress | done | blocked | parked
  (`complete` and `not_started` are NOT valid — use `done` and `todo`)

Slice/task ID grammar:
  Slice IDs: [SP]\d+ — e.g. S0, S1, S2, P1, P2. Pick one prefix per plan.
  Task IDs:  T\d+    — e.g. T1, T2, T3.
  No letters, no `pre-`, no `+` suffixes.

Gate heading grammar (## Gates section), one line per gate:
  - [ ] **<ID> gate (<label>):** <description>
  <ID> is a slice ID ([SP]\d+). The (<label>) parenthetical is lifted as the
  human-readable slice label downstream.

Do NOT read other PLN tracker files for examples. This template is self-contained.
-->

## How to Use This Tracker

This tracker is the single source of truth for executing {{id}}. An agent picking
up this plan with zero prior conversation context must be able to execute it from
this document alone — the **cold-start principle**.

Update the Phase Status Table as work progresses. Log completed and failed tasks
in the respective logs at the bottom.

## Project Context

- **Repo:** <!-- e.g. org/repo-name -->
- **Branch:** <!-- e.g. feat/my-feature -->
- **Target files:** <!-- key files this plan touches -->
- **Test command:** `npm run typecheck && npm test`

## Gates

- [ ] **S1 gate (skeleton):** <!-- describe -->
- [ ] **S2 gate (<label>):** <!-- describe -->

## Task-to-Phase Mapping

| Task | Slice | Description | parallelizable | user_interaction |
|------|-------|-------------|----------------|------------------|
| T1 | S1 | Example task | no | none |

## How to Dispatch

Use this template when dispatching a subagent for a task in this plan.

**Target file:** `<!-- path to the file the subagent should modify -->`
**Test command:** `npm run typecheck && npm test`
**Worktree isolation:** Use `isolation: "worktree"` when dispatching parallel tasks to avoid file conflicts.

### Critical Rules

- All public functions must return Result types — never throw.

## Phase Status Table

| Slice | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| S1 | todo | | | |

## Completed Log

<!--
Record completed tasks here. Two accepted formats — table is preferred for new trackers.

Table (preferred):
| Date | Task | Summary |
|------|------|---------|
| 2026-09-06 | T1 | Description |

Bullet list (also accepted):
- 2026-09-06 — WK-NNNN: summary
- 2026-09-07 — T1: summary
-->

## Failure Log

<!--
Record failures as ### subsections — HTML comments (like this one) are NOT failure
entries and must be ignored by tooling.

### YYYY-MM-DD — <failure title>
What failed, root cause, remediation. A failure is resolved when its body contains
resolution text (e.g. `RESOLUTION:`, `**resolved**`) or is superseded by a later entry.
-->
