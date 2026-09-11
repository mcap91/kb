# PLN Authoring Guide

## Cold-Start Principle

A PLN execution tracker must be executable by an agent that never saw the conversation that produced it.

Every tracker must contain enough context — repo, branch, target files, test command, dispatch
template, task-phase mapping with interaction flags — that a fresh agent session can pick it up
and execute without asking clarifying questions.

## Required Tracker Sections

`validate-plan` checks that `execution/tracker.md` contains these sections (level-2 headings):

| Section | Purpose |
|---------|---------|
| How to Use This Tracker | Orientation for the executing agent |
| Project Context | Repo, branch, target files, test command |
| Gates | Checkable phase-boundary criteria |
| Task-to-Phase Mapping | Table with `parallelizable` and `user_interaction` columns |
| How to Dispatch | Copy-pasteable subagent prompt with target file, test command, worktree-isolation note, and critical rules |
| Phase Status Table | Per-phase status tracking |
| Completed Log | Record of completed tasks |
| Failure Log | Record of failures and remediation |

## Task-to-Phase Mapping Table

The table must include a `user_interaction` column with a value for every task row. Valid values:

- `none` — agent can complete without human input
- `required` — must pause for human input before proceeding
- `recommended` — agent should attempt, but flag for human review

## Tracker Body Format Contract (WK-0082)

The Phase Status Table, Gates, Task-to-Phase Mapping, Completed Log, and Failure Log follow a
body-format contract (`wiki/issues/WK-0082.md`) so trackers are dashboard-parseable by default.

### Column names

The Phase Status Table and Task-to-Phase Mapping table key on the same column. `Slice` is the
default name emitted by the template. `Phase` and `Slice (phase)` are accepted aliases. All
three are treated as the same column by tooling. Pick one per tracker and use it consistently.

### Slice/task ID grammar

- **Slice IDs:** `[SP]\d+` — e.g. `S0`, `S1`, `S2`, `P1`, `P2`. Pick one prefix per plan.
  No letters, no `pre-`, no `+` suffixes.
- **Task IDs:** `T\d+` — e.g. `T1`, `T2`, `T3`.

### Phase Status Table status vocabulary

Uses the **WK (issue) status enum** from `contract/manifest.json` — not a separate vocabulary.
Common values and their dashboard lane mapping:

| Value | Dashboard lane | Meaning |
|-------|---------------|---------|
| `done` | done | Slice complete and gate passed |
| `in_progress` | in_progress | Slice actively being worked |
| `blocked` | blocked | Slice blocked by a dependency or issue |
| `todo` | queued | Slice not yet begun |
| `parked` | queued | Slice paused (not blocked, just deprioritized) |

`complete` and `not_started` are NOT valid — use `done` and `todo`.

### Gate heading grammar

Each line under `## Gates` follows:

`- [ ] **<ID> gate (<label>):** <description>`

`<ID>` is a slice ID (`[SP]\d+`). The `(<label>)` parenthetical is lifted as the human-readable
slice label downstream (dashboard pipeline spine).

### Completed Log formats

Two accepted formats — table is preferred for new trackers.

Table:

| Date | Task | Summary |
|------|------|---------|
| 2026-09-06 | T1 | Description |

Bullet list:

- 2026-09-06 — WK-NNNN: summary
- 2026-09-07 — T1: summary

### Failure Log structure

Subsections under `## Failure Log` use `###` headings: `### YYYY-MM-DD — <failure title>`.

HTML comments (`<!-- ... -->`) are NOT failure entries and are ignored by tooling. A failure is
resolved when its body contains resolution text (e.g. `RESOLUTION:`, `**resolved**`) or a dated
resolution subsection, or is superseded by a later entry.

## How to Dispatch

The dispatch template must include:

- **Target file:** — the file the subagent should modify
- **Test command:** — the validation command to run after changes
- **Worktree isolation:** — note about using `isolation: "worktree"` for parallel tasks
- At least one **critical rule** (under a `### Critical Rules` subsection)

## Creating a PLN

```bash
npm run wiki -- create --dir <path> --prefix PLN --title "My plan"
```

This stamps the full execution tracker template from `contract/templates/plan-execution-tracker.md`.
Fill in the placeholders before dispatching agents.

## Validation

```bash
npm run wiki -- validate-plan --dir <path> --plan PLN-0001
```

Content checks are warning-severity — they flag issues without blocking validation. Structural
checks (missing record, bad paths, schema violations) remain error-severity and fail validation.
