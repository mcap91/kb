---
id: "{{id}}"
title: "{{title}}"
type: task
status: inbox
priority: medium
owner: "{{owner}}"
created: "{{date}}"
updated: "{{date}}"
area:
initiative:
tags: []
repo_paths: []
docs: []
depends_on: []
blocks: []
related: []
write_scope: []
---

# {{id}}: {{title}}

<!--
AUTHORING GUIDE — delete this block after filling in the document.

Frontmatter enums:
  type:     bug | feature | task | investigation | chore | docs | infra | migration
  status:   inbox | todo | in_progress | blocked | review | done | parked | cancelled | deprecated | duplicate | superseded | wont_do
  priority: critical | high | medium | low

write_scope: [path, ...]   — files this work touches. Already in the block above (default []);
                              fill it in rather than leaving it empty.

Optional frontmatter (add as needed):
  area: AREA-slug           — owning area
  initiative: IN-NNNN       — parent initiative
  severity: ...             — for bugs
  depends_on: [WK-NNNN]     — blocks this item
  blocks: [WK-NNNN]         — this item blocks
  related: [WK-NNNN]        — related records (any prefix)
  assignees: [name]          — human assignees
  agents: [name]             — agent assignees
  reviewers: [name]          — reviewers
  target: YYYY-MM-DD        — target completion date

Body sections:
  Objective   — 1-2 sentences: what this work accomplishes and why.
  Scope       — boundaries, approach, what's explicitly out of scope.
  Checklist   — add items as work progresses; not required at creation.
  Acceptance  — testable criteria that define "done."
  Notes       — context, links, discussion. Optional.
  Slices      — optional body table of merge units; see the commented example below
                Notes. Add it only if this WK's work naturally splits into separately
                written, separately reviewed units.
  Resolutions — optional append-only body table of in-run decisions; see the commented
                example below Notes. Rows are added as the work proceeds, never edited
                or deleted.
  Hardening   — optional append-only body table of spec-redteam / spec-check self-records;
                see the commented example below Notes. Rows are added as checks run,
                never edited or deleted.

Do NOT read other WK files for examples. This template is self-contained.
-->

## Objective

## Scope

## Checklist

## Acceptance criteria

- [ ] _criterion_

## Notes

<!--
Optional "## Slices" body table (WK-0211). Uncomment and fill in only if this WK's
work naturally splits into separately written, separately reviewed units. Header is
fixed. `write_scope` and `depends_on` are comma-separated; `depends_on` holds row ids
from this same table. `status` reuses the WK status enum and is written by
merge-delivery, never by hand. Free text per slice may follow under "### Slice <id>".

## Slices

| id | title | write_scope | depends_on | validation | status |
|----|-------|-------------|------------|------------|--------|
| s1 | _first slice_ | path/to/file.ts | | npm test | todo |
| s2 | _second slice_ | path/to/other.ts | s1 | npm test | todo |

### Slice s1

_free text about this slice_
-->

<!--
Optional "## Resolutions" body table (WK-0212). Append-only: add a row per decision,
never edit or delete an existing row. Header is fixed. Column guidance:
  seat       — who filled this row in (interactive orchestrator or overseer)
  question   — what needed deciding
  searched   — where the seat searched (wiki/rules/code/web), with citations
  evidence   — what was found
  options    — the choices considered
  choice     — what was decided; "unresolved" when no evidence was found
  reason     — why; also where an escalation is recorded, never inferred from a cold
               check failure
  cold check — pass | amended | fail | n/a; `n/a` only when choice is "unresolved"
The `#` column runs 1..n with no gaps or duplicates.

## Resolutions

| # | date | seat | question | searched | evidence | options | choice | reason | cold check |
|---|------|------|----------|----------|----------|---------|--------|--------|-------------|
| 1 | {{date}} | orchestrator | _question_ | _where searched, with citations_ | _evidence found_ | _options considered_ | _choice made_ | _reason_ | pass |
-->

<!--
Optional "## Hardening" body table (WK-0212). Append-only: add a row per check, never
edit or delete an existing row. Header is fixed. Column guidance:
  check  — spec-redteam | spec-check | code-redteam | override
  by     — HO id or session that ran the check (or made the override)
  verdict — pass | fail, or n/a on an override row only
  notes  — required (non-empty) on an override row: the reason the check was overridden
The `#` column runs 1..n with no gaps or duplicates.

## Hardening

| # | date | check | by | verdict | notes |
|---|------|-------|----|---------|-------|
| 1 | {{date}} | spec-check | HO-0000 | pass | |
-->
