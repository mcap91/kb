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
work_days:
work_hours:
hours_per_work_day:
cocomo_kloc:
cocomo_pm_nominal:
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
replication_days:
saved_floor_days:
leverage:
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

A VAL record answers: "what did agent-assisted work cost this span, and what would its
surviving output cost the operator to REPLICATE by hand?" The append-only series (one VAL per
commit-watermark span) is the log. NEVER edit a prior VAL: its scrape is point-in-time (session
logs rotate) and a mutable report is a massageable report.

FIELD SOURCES — every field is one of four kinds. Do not blur them.
  [tool]     value-report filled it (git + graph, deterministic, offline). Trust as observed.
  [scraped]  value-usage filled it (ccusage + OpenRouter). Point-in-time; freeze it here.
  [operator] ONLY the human sets it. The agent must never write these.
  [agent]    the conversing agent supplies it (narrative + per-unit proposals).

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
                    arm incl. subscription + codex (codex priced by sessionId join) [scraped]
  cost_provenance   openrouter-api | ccusage-priced | subscription-covered |
                    local-free | unavailable | mixed                               [scraped]
  agents            e.g. [claude, codex]                                           [scraped]
  Per-model token detail goes in the ## Token Detail table below, NOT in frontmatter.

Output — observed (all from value-report):                                         [tool]
  span_days         calendar span (inclusive). Secondary context only.
  work_days         count of distinct calendar dates carrying ≥1 in-span commit (git author
                    dates). THE leverage denominator — the same instrument the 260 rate was
                    calibrated with, so numerator and denominator share one unit
                    (operator-active-days) and git-invisible time cancels in the ratio.
  work_hours        Σ per-day (last − first author-commit timestamp), 0.5h/day floor.
                    Printed CONTEXT ONLY — an elapsed wall-clock envelope, a different measure
                    from effort (PF038: 79.6 h envelope vs 38 h billable). NEVER enters the
                    leverage arithmetic.
  hours_per_work_day  Frozen constant = 8. Context for reading work_hours only.
  cocomo_kloc, cocomo_pm_nominal  COCOMO II nominal ceiling (frozen constants, Boehm 2000).
                    Display-only external reference (DEC-0003) — NEVER enters any estimate
                    arithmetic; printed as the ceiling reference line after the ROI line.
  Git-proxy limits (state these, do not paper over):
    • Misses work before the day's first commit and after its last.
    • Squash-merges collapse multi-day work onto one author date — understates work_days,
      inflates leverage. Name it if suspected.
    • All in-span commits count regardless of author (single-operator assumption).
      Multi-committer repos conflate contributors.
  commits, files_changed, net_loc_added/removed, tests_added
  units_<class>_survives/wired/tested   (classes: scripts, modules, tools, docs)
    survives = present at HEAD (necessary, valued at ZERO alone)
    wired    = import-wired in wiki/.graph.json (py/ts/js only)
    tested   = a surviving test file imports it (py/ts/js only)
  units_candidates  pattern-only units with NO import/test/wiki evidence — see ## Candidates
  churn_loc, excluded_files, excluded_loc, reverted_commits, wk_created, wk_closed
  graph_available   false ⇒ wired/tested/linked branches were skipped (note it in estimate_basis)

Widened surface (WK-0059) — no committed file is silently dropped:
  data_traces       data assets — priced 0, detection/traceability only; NOT floor rows. Every
                    data file is priced 0 and its in-repo generator (counted once as the code it
                    is) carries the value — no fixture↔generator ownership is inferred. orphan_data
                    (operator-ruled curated data, no in-repo generator) and vendored/external
                    data stay unpriced; an operator note is documentation only, never a floor number.
  unclassified      unknown committed types (unknown extension / extensionless-no-shebang) surface
                    as candidates, NEVER a silent null. Operator rules each ext+path group
                    code | data | doc → persisted to wiki/.value-config.json (agent proposes,
                    operator ratifies — the agent can never promote a type to countable). Valued 0
                    until ruled code.
  rate_flag         per review row: test-code | fixture-generator | workflow-dsl | shell-wrapper —
                    classes where the 260 rate transfers unevenly (error direction NOT uniformly
                    conservative). Narrate flagged rows as ratification candidates; narration only,
                    never changes arithmetic. Common flagging ⇒ the surface changed enough to
                    re-validate (WK-0056 Rung 4).
  resolved_config / config_hash   freeze into the published VAL so its figures reproduce under a
                    later wiki/.value-config.json edit (re-render passes the frozen config back).
  (Rendering the data/orphan/unclassified rows into the VAL body is WK-0058.)

Operator-filled at authoring:                                                      [operator]
  units_attested    confirmed candidates + any other operator-attested units
  units_valued      ratified row count in ## How This Was Calculated
  operator_assessment  agree | too_high | too_low | unclear | not_reviewed
  operator_notes    calibration observations; MANDATORY reconciliation note when
                    leverage < 1 or saved_floor_days < 0 (see RECONCILIATION)

Estimate — replication cost, operator-gated (DEC-0003).                    [agent/operator]
The estimand: what the span's surviving units would cost the operator to REPLICATE by hand,
in operator-active-days. It is NOT "what would have happened without AI" — that counterfactual
is not estimable and VAL does not claim it.
  replication_days  Σ operator-ratified rows. Each row's proposed_days = net_loc / 260
                    (= the tool's loc_reference; SRC-0002 corpus rate — 129,447 net LOC /
                    498 active-days of the operator's pre-AI work, leave-one-section-out
                    median 0.92, all sections within 2×). Agent adjustments downward-only
                    with justification; the operator may adjust either way. Docs-class rows
                    have no calibrated rate — operator hand-sets them (WK-0052 owns the doc
                    anchor).
  saved_floor_days  replication_days − work_days   — MAY BE NEGATIVE. Never clamp.
  leverage          replication_days / work_days   — UNCAPPED. MAY BE < 1. Never clamp.
  estimate_basis    ratification notes, tripwire explanations, graph/chain caveats, and any
                    git-proxy caveats (squash-merge, multi-committer) if relevant

TRIPWIRE. Any ratified row diverging >3× from its proposed_days (either direction) must state
why (atypical density, boilerplate, prose, design overhead git can't see). Silence on a >3×
divergence is invalid.

RECONCILIATION. leverage < 1 or saved_floor_days < 0 ⇒ MANDATORY operator note in
operator_notes before publishing. Two cases: instrument misfit → name what to revise; span
dominated by non-authoring work (running pipelines, analysis) → expected under floor
semantics, state the composition. The result is never clamped.

CUMULATIVE LINE. The chain number that absorbs per-span noise: over all published flat-formula
VALs (records carrying replication_days) plus this one,
  cum_leverage = Σ replication_days / Σ work_days
computed at authoring from prior VAL frontmatter; printed in ## Agent Value (body-only — no
frontmatter field). The first flat-formula VAL may seed the chain by restating prior tiered
spans at net_loc/260 in its Notes (prior records are never edited).

NULL RESULTS ARE THE POINT. If cost bought little or nothing, say so plainly in ## Agent Value
("cost $X / N tokens; 0 working units this span; value not demonstrated"). Do NOT narrate
around a negative or zero result. A series that can only say "win" is a broken instrument.

ROI LINE (print at the end of ## Agent Value, verbatim shape — keeps the series comparable):
  shipped <units_valued> working units; agents cost $<cost_usd> (est. $<cost_usd_est> at API
  rates) / <total_tokens> tokens; replication value <replication_days> operator-days vs
  <work_days> days worked → leverage <leverage>× (floor); chain <cum_leverage>×
If cost_usd is null (pure subscription-covered), render it as $0 out-of-pocket and let the
at-API-rates estimate carry the interpretable figure. Never invent a real-dollar number.

CEILING REFERENCE LINE (print immediately after the ROI line — display-only, never enters any
arithmetic):
  reference ceiling: COCOMO II nominal ≈ <cocomo_pm_nominal> person-months for <cocomo_kloc> KSLOC (frozen nominal constants, Boehm 2000)

Research — observed, agent-supplied, optional (labeled non-empirical):             [agent]
  files_read, papers_read, items_parsed, outputs_organized

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

<!-- value-report lists pattern-only units here (tier = candidate). Operator records
confirm/reject per unit; a short evidence note ("produced fig 2") is encouraged.
Rejected candidates stay survives-only and are excluded from the estimate.
Confirmed candidates are included in the estimate table below.
WK-0059: candidates with unitClass = unclassified are unknown committed types — rule each
code | data | doc and persist the ruling to wiki/.value-config.json (only code rulings become
priced floor units; data is priced 0; a data glob with no in-repo generator may be ruled
orphan_data, note-only). -->

## How This Was Calculated

<!-- Reproducible from this section alone. Four parts.

1. Rate in effect: 260 LOC/operator-active-day (SRC-0002; LOSO median 0.92, all sections
   within 2×; Rung 1: project-level within ~1.25× at ≥2 KLOC). Docs-class rows: operator
   hand-set (no calibrated rate; WK-0052).

2. Per-unit rows — one per ratified unit (candidates excluded until confirmed):

   | unit | evidence tier | net_loc | proposed_days (= net_loc/260) | ratified_days | note |
   |------|---------------|---------|-------------------------------|---------------|------|
   |      |               |         |                               |               |      |

   Rows diverging >3× from proposed_days MUST explain why; upward explanations state
   replication reasoning, not agent toil.

3. Arithmetic:
     replication_days = Σ ratified_days
     saved_floor_days = replication_days − work_days     (may be negative; never clamp)
     leverage         = replication_days / work_days     (uncapped; may be < 1)
     cum_leverage     = Σ replication_days / Σ work_days over published flat-formula VALs + this
   Denominator is work_days (distinct in-span commit dates — the calibration instrument).
   work_hours / span_days are printed context only and never enter the arithmetic.

4. Cost side: total tokens and BOTH dollar figures — cost_usd (real/marginal out-of-pocket)
   and cost_usd_est (ccusage at-API-rates, every arm incl. subscription + codex) — with
   cost_provenance and the ccusage version that priced them.
-->

## Agent Value

## Methods

One number prices this span's output; one measures its time; their ratio is the headline.

- **Replication cost (claimed):** what the span's surviving units would take the operator to
  reproduce by hand, estimated as net LOC ÷ 260 — the operator's own rate measured over
  129,447 net LOC / 498 active-days of pre-AI hand-written work, operator-ratified per unit. It
  prices reconstruction of the artifact, as insurance prices rebuilding a house — it does not
  claim the operator would have built the same thing without AI; that counterfactual is not
  estimable and is not claimed.
- **Days worked (measured):** distinct commit dates (work_days) — the same instrument the rate
  was calibrated with. Design/reading time invisible to git is missing from both sides equally
  and cancels in the ratio.
- **Floor semantics:** non-authoring work (running pipelines, analysis, operating tools)
  counts in days worked but not in replication cost, so leverage is a floor given such work
  would take no less time by hand. Likewise a split-attention day (other repos or a day job
  sharing the date) counts fully in this repo's days worked — splitting deepens the floor,
  never inflates it. Spans dominated by either may honestly print < 1× — that states the
  span's composition, not a loss.
- **Disclosed residuals:** AI-era code density and cross-language transfer (the rate is
  R-calibrated) are unsigned and controlled by per-unit ratification, not modeled.
- **Ceiling (reference only, never claimed):** what the same delivered code would cost as a
  traditional organizational software project — COCOMO II nominal (frozen constants, Boehm
  2000; it embeds ~15–25 LOC/day because it prices requirements, reviews, integration, and
  management, not just writing code). It never enters the arithmetic. The gap between it and
  the replication floor is the expected distance between solo marginal effort and fully-loaded
  organizational delivery — the citable external bracket.

## Notes
