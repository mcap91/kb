---
id: "{{id}}"
title: "{{title}}"
status: draft
owner: "{{owner}}"
created: "{{date}}"
updated: "{{date}}"
summary:
area:
tags: []
source_tool:
bundle_path: "{{bundle_path}}"
design_entry: "{{design_entry}}"
execution_entry: "{{execution_entry}}"
related: []
work_items: []
---

# {{id}}: {{title}}

<!--
AUTHORING GUIDE — delete this block after filling in the document.

Frontmatter enums:
  status: draft | approved | packaged | active | paused | done | cancelled | superseded

Optional frontmatter (add as needed):
  summary: "..."              — one-line summary
  area: AREA-slug             — owning area
  tags: [string]              — categorization tags
  source_tool: string         — tool that generated this plan (e.g. "plan-me-this")
  related: [ID]               — related records (any prefix)
  work_items: [WK-NNNN]      — work items spawned by this plan

Auto-populated by wiki create (do not fill manually):
  bundle_path, design_entry, execution_entry — paths into the PLN-NNNN/ bundle directory

Bundle structure (created automatically):
  wiki/plans/PLN-NNNN/
    design/spec.md             — the design spec
    execution/tracker.md       — the execution tracker (see its own authoring guide)
    source/raw/                — raw inputs
    bundle.json                — machine manifest

Body sections:
  Summary      — what this plan accomplishes and why. 2-3 sentences.
  Scope        — what's in and out of scope for this plan.
  Bundle       — link to the design spec and execution tracker.
  Emergent Work — link WK-NNNN records that emerge during execution.
  Notes        — context, links, discussion. Optional.

Do NOT read other PLN files for examples. This template is self-contained.
-->

## Summary

## Scope

## Bundle

## Emergent Work

## Notes

