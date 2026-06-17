# {{id}} Execution Tracker

<!--
AUTHORING GUIDE — delete this block after filling in the tracker.

This tracker must be self-contained (cold-start principle): a fresh agent with
zero prior context must be able to execute the plan from this document alone.

Required sections (validate-plan checks for these):
  1. How to Use This Tracker — keep the boilerplate below
  2. Project Context         — repo, branch, target files, test command
  3. Gates                   — checkable criteria per phase
  4. Task-to-Phase Mapping   — table with: Task, Phase, Description, parallelizable, user_interaction
  5. How to Dispatch         — Target file, Test command, Worktree isolation, Critical Rules
  6. Phase Status Table      — Phase, Status, Started, Completed, Notes
  7. Completed Log           — date, task ID, summary, follow-up
  8. Failure Log             — date, task ID, what failed, root cause, remediation

user_interaction column values: none | required | recommended
  none        — agent can complete without human input
  required    — must pause for human input before proceeding
  recommended — agent should attempt, but flag for human review

Phase status values: not_started | in_progress | done | blocked

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

- [ ] Phase 1 gate: <!-- describe -->
- [ ] Phase 2 gate: <!-- describe -->

## Task-to-Phase Mapping

| Task | Phase | Description | parallelizable | user_interaction |
|------|-------|-------------|----------------|------------------|
| T1 | P1 | Example task | no | none |

## How to Dispatch

Use this template when dispatching a subagent for a task in this plan.

**Target file:** `<!-- path to the file the subagent should modify -->`
**Test command:** `npm run typecheck && npm test`
**Worktree isolation:** Use `isolation: "worktree"` when dispatching parallel tasks to avoid file conflicts.

### Critical Rules

- All public functions must return Result types — never throw.

## Phase Status Table

| Phase | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| P1 | not_started | | | |

## Completed Log

<!-- Record completed tasks: date, task ID, summary, any follow-up -->

## Failure Log

<!-- Record failures: date, task ID, what failed, root cause, remediation -->
