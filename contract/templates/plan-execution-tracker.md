# {{id}} Execution Tracker

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

<!-- Checkable criteria that must be met before advancing to the next phase -->

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
