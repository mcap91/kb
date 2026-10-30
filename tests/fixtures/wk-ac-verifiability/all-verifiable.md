---
id: "WK-9106"
title: "Fixture: open WK whose acceptance criteria are all verifiable"
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

# WK-9106: Fixture: open WK whose acceptance criteria are all verifiable

## Objective

Fixture for AC_UNVERIFIABLE clean pass: every bullet names a verifiable check — inline
code, a repo-relative path, an npm command, a metric, and an observable-behavior verb.

## Scope

## Checklist

## Acceptance criteria

- [ ] `lint()` returns zero AC_MISSING diagnostics for this file
- [ ] packages/wiki-core/src/lint.ts contains the new rule
- [ ] `npm test` passes
- [ ] Lint run time stays under 500ms
- [ ] The CLI prints "0 errors" on a clean run

## Notes
