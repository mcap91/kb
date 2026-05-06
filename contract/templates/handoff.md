---
schema_version: 1
id: "{{id}}"
title: "{{title}}"
subject: ""
allowed_agents:
  - fake-agent
mode: implement
status: draft
created: "{{date}}"
updated: "{{date}}"
depends_on: []
area:
initiative:
work_item:
write_scope: []
---

# {{id}}: {{title}}

> **Dispatch-owned template.** This template is synced as a shared template surface by `wiki bootstrap` and `wiki sync-contract`. `HO-*` handoff records are **dispatch-owned** and are **not** manifest-driven wiki record types. `HO-*` is **not** a valid target for `wiki create`. Create them with `dispatch create-handoff` or author them manually in `wiki/handoffs/`. Review and launch are handled by `dispatch-core`.

## Read First

<!-- Optional: list repo-relative paths the agent should read before starting -->
<!-- - path/to/relevant/file.ts -->
<!-- - docs/relevant-doc.md -->

## Objective

<!-- Describe what the agent should accomplish -->

## Constraints

<!-- List any constraints on the agent's behavior -->

## Expected Output

<!-- Describe what the agent should produce -->

## Context

<!-- Additional context for the agent -->
