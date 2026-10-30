---
id: "WK-9114"
title: "Fixture: open WK whose only verifiable detail is on an unindented continuation line"
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

# WK-9114: Fixture: open WK whose only verifiable detail is on an unindented continuation line

## Objective

Fixture for HO-0109 (CommonMark lazy continuation): the checkbox's first line alone
names no verifiable check, but its continuation line does, and that continuation line
is NOT indented. The two must still be read together as one criterion, so no
AC_UNVERIFIABLE should fire.

## Scope

## Checklist

## Acceptance criteria

- [ ] The report is generated
at `out/report.json`

## Notes
