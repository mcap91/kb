---
id: "WK-9111"
title: "Fixture: open WK whose Acceptance criteria heading carries trailing text"
type: task
status: todo
priority: medium
owner: "fixture"
created: "2026-10-30"
updated: "2026-10-30"
area:
initiative:
tags: []
repo_paths: []
docs: []
depends_on: []
blocks: []
related: []
---

# WK-9111: Fixture: open WK whose Acceptance criteria heading carries trailing text

## Objective

Fixture for the heading-suffix tolerance (WK-0183's own heading shape): the
"## Acceptance criteria" heading carries trailing text, and AC_MISSING must still
read the section instead of treating it as absent. The section has a real checkbox
criterion, so this fixture passes.

## Scope

## Checklist

## Acceptance criteria (4 tiers, operator-ratified 2026-09-29)

- [ ] `npm test` passes

## Notes
