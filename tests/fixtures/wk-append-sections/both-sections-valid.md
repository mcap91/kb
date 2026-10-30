---
id: "WK-9100"
title: "Fixture: valid Resolutions and Hardening tables"
type: task
status: todo
priority: medium
owner: "fixture"
created: "2026-10-24"
updated: "2026-10-29"
area:
initiative:
tags: []
repo_paths: []
docs: []
depends_on: []
blocks: []
related: []
---

# WK-9100: Fixture: valid Resolutions and Hardening tables

## Objective

Fixture record for WK-0212: both "## Resolutions" and "## Hardening" present, every row
valid against the closed value sets and `#` contiguity check. Lints clean for
RESOLUTIONS_* and HARDENING_*; `readResolutions` / `readHardening` return the parsed
rows.

## Scope

## Checklist

## Acceptance criteria

- [ ] _criterion_

## Notes

## Resolutions

| # | date | seat | question | searched | evidence | options | choice | reason | cold check |
|---|------|------|----------|----------|----------|---------|--------|--------|-------------|
| 1 | 2026-10-24 | orchestrator | Which header spelling? | wiki/issues/WK-0211.md, code/body-table.ts | WK-0211 precedent uses bare names | searched, looked | searched | matches WK-0211 column style | pass |
| 2 | 2026-10-25 | overseer | Is there a prior fixture for this? | wiki/rules, code/fixtures | nothing found | unresolved | unresolved | no evidence found | n/a |

## Hardening

| # | date | check | by | verdict | notes |
|---|------|-------|----|---------|-------|
| 1 | 2026-10-24 | spec-redteam | HO-0103 | pass | |
| 2 | 2026-10-25 | spec-check | HO-0103 | pass | |
| 3 | 2026-10-26 | override | mcap91 | n/a | operator ruling lowers the intake requirement for this WK |
