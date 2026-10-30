---
id: "WK-9120"
title: "Fixture: orchestrator-labeled verifiable bullets (HO-0109, real WK corpus + synthetic)"
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

# WK-9120: Fixture: orchestrator-labeled verifiable bullets (HO-0109, real WK corpus + synthetic)

## Objective

Every bullet below is copied verbatim (HO-0109 instruction) from a real, currently open
or closed WK, labeled V (verifiable — must NOT warn) by the orchestrator in HO-0109's
Context, plus the two synthetic V cases from redteam HO-0108. None of these must
produce an AC_UNVERIFIABLE diagnostic.

## Scope

## Checklist

## Acceptance criteria

- [ ] Explicit-opts call path produces byte-identical output to today for the existing fixtures
- [ ] All cancelled WK/IN records carry a note referencing WK-0096
- [ ] Never silently drops effort — either spliced or refused
- [ ] The three metrics are reported per run, unblended; the judge subagent never sees the planner's self-report
- [ ] `merge-delivery` verdict gate unchanged (still refuses changes_requested)
- [ ] No value-* MCP tools registered; no value-* CLI commands
- [ ] No surface still contains a private frontmatter parser
- [ ] The escalation template exists; the planner file references it as the only form for a question to the operator
- [ ] Rules are stated in plain words; no ledger codes (R, RD, F, S, T) appear in either file (RD-32)
- [ ] In a repo with no kb-wiki MCP, the wiki step falls back to `docs/` and no kb-specific tool call is attempted
- [ ] Headless script on a captured transcript returns the expected percentage (golden fixture)
- [ ] Every wiki-mcp and audited dispatch-mcp tool schema is `.strict()`
- [ ] `npm run typecheck && npm test` green
- [ ] A Recently Done line dated 13 days ago flags; 11 days ago does not (test pins the
      boundary)
- [ ] Planted-ambiguity fixture: resolver returns a row citing ≥1 real file:line; cold check passes; row appended; no operator prompt
- [ ] kb's `AGENTS.md`, outside the managed block, carries the kb-specific forms of the reference-system, full-source and need rules (ruling 15)
- [ ] One command runs all scenarios programmatically and writes per-run metrics files (JSON or table)
- [ ] The seed cites each of its four sources in a provenance footer; the ponytail extraction cites the catalog body
- [ ] A session given yesterday's artifact still runs the full gather recipe (observed in the
      transcript) rather than trusting the artifact
- [ ] HTML opens in a browser with no external dependencies (no CDN, no fetch).
- [ ] Output is byte-deterministic across regenerations on unchanged source.
- [ ] Clicking the PLN link navigates to the PLN dashboard (verified via local HTTP server).
- [ ] Git log contains a commit with an unambiguous license-change message
- [ ] The API key never appears in the repo, the registry, logs, or the captured response
- [ ] No regression on normal compaction behavior (proactive compaction still works when the extension is loaded)
- [ ] The instrument can say "no value": zero-valued-units fixture yields negative
      `time_saved_days` and `speedup < 1` with no clamp and no error — encoded as a test
- [ ] A record with nested object frontmatter and native numbers round-trips through
      create → lint → generate → search
- [ ] Warning severity; closed/parked/inbox records exempt
- [ ] Run pytest -q
- [ ] Verify README.md

## Notes
