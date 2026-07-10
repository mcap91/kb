---
id: "{{id}}"
title: "{{title}}"
status: draft
owner: "{{owner}}"
created: "{{date}}"
updated: "{{date}}"
window_start: "{{date}}"
window_end: "{{date}}"
base_commit: "unknown"
head_commit: "unknown"
prior_val: none
chain_status: unknown
input_tokens:
output_tokens:
cache_read_tokens:
cache_write_tokens:
total_tokens:
cost_usd:
cost_usd_est:
cost_provenance:
agents: []
span_days:
commits:
files_changed:
net_loc_added:
net_loc_removed:
tests_added:
units_scripts_survives:
units_scripts_wired:
units_scripts_tested:
units_modules_survives:
units_modules_wired:
units_modules_tested:
units_tools_survives:
units_tools_wired:
units_tools_tested:
units_docs_survives:
units_docs_wired:
units_docs_tested:
units_candidates:
churn_loc:
excluded_files:
excluded_loc:
reverted_commits:
wk_created:
wk_closed:
graph_available:
units_attested:
units_valued:
operator_assessment: not_reviewed
operator_notes:
human_days_units:
human_days_loc:
human_days_anchor:
time_saved_days:
speedup:
estimate_basis:
files_read:
papers_read:
items_parsed:
outputs_organized:
tags: []
related: []
---

# {{id}}: {{title}}

<!--
AUTHORING GUIDE — delete this block after filling in the document.

A VAL record answers: "what did agent-assisted work cost this span, and what measurable
output did it produce?" The headline is agent ROI — scraped cost set against a conservative,
falsifiable human-time estimate. The append-only series (one VAL per commit-watermark span) is
the log. NEVER edit a prior VAL: its scrape is point-in-time (session logs rotate) and a mutable
report is a massageable report.

FIELD SOURCES — every field is one of four kinds. Do not blur them.
  [tool]     value-report filled it (git + graph, deterministic, offline). Trust as observed.
  [scraped]  value-usage filled it (ccusage + OpenRouter). Point-in-time; freeze it here.
  [operator] ONLY the human sets it. The agent must never write these.
  [agent]    the conversing agent supplies it (narrative + optional research counts).

Identity / scope:
  status            draft | published                                              [operator]
  window_start/end  span dates (from value-report)                                 [tool]
  base_commit       watermark start SHA; head_commit end SHA                       [tool]
  prior_val         previous VAL id, or `none` for the first report                [tool]
  chain_status      complete | first | gap | overlap | unknown                     [tool]
                    gap/overlap/unknown means the watermark chain is broken — say so in Notes.

Cost — the ROI cost side (leave blank if value-usage returned unavailable; blank beats guessed):
  input/output/cache_read/cache_write/total_tokens                                 [scraped]
  cost_usd          REAL/marginal out-of-pocket $: OpenRouter → authoritative API
                    figure; local → 0; subscription (incl. codex-on-subscription)
                    → blank (flat fee, no marginal charge — never fabricate $)     [scraped]
  cost_usd_est      ccusage (LiteLLM) at-API-rates estimate, populated for EVERY
                    arm incl. subscription + codex — the interpretable "what it
                    would have metered" figure (codex priced by sessionId join)    [scraped]
  cost_provenance   openrouter-api | ccusage-priced | subscription-covered |
                    local-free | unavailable | mixed                               [scraped]
  agents            e.g. [claude, codex]                                           [scraped]
  Per-model token detail goes in the ## Token Detail table below, NOT in frontmatter.

Output — observed (all from value-report):                                         [tool]
  span_days, commits, files_changed, net_loc_added/removed, tests_added
  units_<class>_survives/wired/tested   (classes: scripts, modules, tools, docs)
    survives = present at HEAD (necessary, valued at ZERO alone)
    wired    = import-wired in wiki/.graph.json (py/ts/js only)
    tested   = a surviving test file imports it (py/ts/js only)
  units_candidates  pattern-only units with NO import/test evidence — see ## Candidates
  churn_loc, excluded_files, excluded_loc, reverted_commits, wk_created, wk_closed
  graph_available   false ⇒ wired/tested branches were skipped (note it in estimate_basis)

Operator-filled at authoring:                                                      [operator]
  units_attested    confirmed candidates + any other operator-attested units
  units_valued      wired ∪ tested ∪ attested (deduplicated total)
  operator_assessment  agree | too_high | too_low | unclear | not_reviewed
                       your INDEPENDENT calibration verdict — the standing check on the instrument
  operator_notes    calibration observations

Estimate — value-report computes the anchors; the agent may ONLY adjust DOWNWARD, with a
justification recorded in estimate_basis. Never raise an estimate.                 [tool/agent]
  human_days_units  Σ per-unit min(class_constant, unit_loc / loc_per_day) over valued units
  human_days_loc    net_loc_added / loc_per_day  (the conservative LOC floor)
  human_days_anchor min(human_days_units, human_days_loc)
  time_saved_days   human_days_anchor − span_days   — MAY BE NEGATIVE. Never clamp.
  speedup           human_days_anchor / span_days   — MAY BE < 1. Never clamp.
  estimate_basis    the arithmetic in words (constants, per-unit scaling, graph/chain caveats)

Research — observed, agent-supplied, optional (labeled non-empirical):             [agent]
  files_read, papers_read, items_parsed, outputs_organized

CANDIDATES ARE OPERATOR-GATED. value-report lists pattern-matched units (analysis/**, scripts/**,
notebooks/**, workflows/**, pipelines/**, bin/**, tools/**) that have no import/test evidence.
They are valued at ZERO until the OPERATOR confirms them. The agent must NEVER confirm a candidate
or self-attest a unit — this is the unfakeable gate that keeps value from auto-inflating. R,
bash, notebooks, and pipeline DSLs reach value ONLY through this path (the graph can't wire them).

NULL RESULTS ARE THE POINT. If cost bought little or nothing, say so plainly in ## Agent Value
("cost $X / N tokens; 0 working units this span; value not demonstrated"). Do NOT narrate around
a negative or zero result. A series that can only say "win" is a broken instrument.

ROI LINE (print at the end of ## Agent Value, verbatim shape — keeps the series comparable):
  shipped <units_valued> working units; agents cost $<cost_usd> (est. $<cost_usd_est> at API
  rates) / <total_tokens> tokens; <time_saved_days> human-days vs. baseline (~<speedup>×,
  floor-anchored)
If cost_usd is null (pure subscription-covered), render it as $0 out-of-pocket and let the
at-API-rates estimate carry the interpretable figure. Never invent a real-dollar number.

Do NOT read other VAL files for examples. This template is self-contained.
-->

## Summary

## What Was Figured Out

## Systems Created

## Token Detail

| model | arm | input | output | cache_read | cache_write | total | cost_usd | cost_usd_est |
|-------|-----|-------|--------|------------|-------------|-------|----------|--------------|
|       |     |       |        |            |             |       |          |              |

## Candidates

<!-- value-report lists pattern-only units here. Operator records confirm/reject per unit; a
short evidence note ("produced fig 2") is encouraged. Rejected candidates stay survives-only. -->

## How This Was Calculated

<!-- Glance-readable provenance: every estimate number above must be reproducible from this
section alone. Fill all four parts; pull constants from wiki/.value-config.json and state
overrides explicitly (config precedence: tool args > wiki/.value-config.json > code defaults).

1. Constants in effect: per_unit_days (scripts/modules/tools/docs), loc_per_day, speedup_cap,
   ccusage_version, plus any classification_patterns override that changed unit classes this
   span (e.g. module_patterns).

2. The equations (spec §9), stated plainly:
     unit_value(u)     = min( per_unit_days[class(u)], unit_net_loc(u) / loc_per_day )
     human_days_units  = Σ unit_value(u) over valued units
     human_days_loc    = net_loc_added / loc_per_day        (the conservative LOC floor)
     human_days_anchor = min(human_days_units, human_days_loc)
     time_saved_days   = human_days_anchor − span_days      (may be negative; never clamp)
     speedup           = min(human_days_anchor / span_days, speedup_cap)   (may be < 1)

3. Per-unit breakdown — one row per valued unit (candidates excluded until operator-attested):

| unit | class | net_loc | min(class_const, net_loc/loc_per_day) |
|------|-------|---------|---------------------------------------|
|      |       |         |                                       |

4. Cost side: total tokens and BOTH dollar figures — cost_usd (real/marginal out-of-pocket)
   and cost_usd_est (ccusage at-API-rates, every arm incl. subscription + codex) — with
   cost_provenance and the ccusage version that priced them.
-->

## Agent Value

## Notes
