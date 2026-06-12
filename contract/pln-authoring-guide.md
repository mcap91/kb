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

- `none` — fully automated, no human input needed
- `approval` — requires human approval before proceeding
- `input` — requires human-provided data (credentials, config, etc.)
- `review` — requires human review of output before continuing

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
