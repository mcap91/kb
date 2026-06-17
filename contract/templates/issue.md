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
---

# {{id}}: {{title}}

<!--
AUTHORING GUIDE — delete this block after filling in the document.

Frontmatter enums:
  type:     bug | feature | task | investigation | chore | docs | infra | migration
  status:   inbox | todo | in_progress | blocked | review | done | parked | cancelled | deprecated | duplicate | superseded | wont_do
  priority: critical | high | medium | low

Optional frontmatter (add as needed):
  area: AREA-slug           — owning area
  initiative: IN-NNNN       — parent initiative
  severity: ...             — for bugs
  depends_on: [WK-NNNN]     — blocks this item
  blocks: [WK-NNNN]         — this item blocks
  related: [WK-NNNN]        — related records (any prefix)
  write_scope: [path/glob]  — files this work touches
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

Do NOT read other WK files for examples. This template is self-contained.
-->

## Objective

## Scope

## Checklist

## Acceptance criteria

- [ ] _criterion_

## Notes

