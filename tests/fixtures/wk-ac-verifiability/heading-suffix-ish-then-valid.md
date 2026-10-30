---
id: "WK-9118"
title: "Fixture: open WK with a malformed suffixed heading followed by a valid Acceptance criteria section"
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

# WK-9118: Fixture: open WK with a malformed suffixed heading followed by a valid Acceptance criteria section

## Objective

Fixture for HO-0109 F4: "## Acceptance criteria-ish" is a different heading (no
separating whitespace before the suffix) and must not shadow the real
"## Acceptance criteria" section that follows it. This fixture must lint clean.

## Acceptance criteria-ish

Some unrelated prose under a heading that merely starts with the same words.

## Acceptance criteria

- [ ] `npm test` passes

## Notes
