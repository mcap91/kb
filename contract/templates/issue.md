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
