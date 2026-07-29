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
  [agent]    the conversing agent supplies it (narrative + anchor-pinned estimate proposals).

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
  span_days         calendar span (inclusive: first→last in-span commit date).
                    SECONDARY context field — not the leverage denominator. Keep for cadence/chain.
  work_days         count of distinct calendar dates carrying ≥1 in-span commit (git author dates).
                    PRIMARY denominator for leverage. Excludes idle days entirely.
                    Deliberate unit-mixing: numerator = human-equivalent days (anchor-table day);
                    denominator = operator-active days. The asymmetry IS the leverage definition
                    ("output in human-days per day of operator engagement") — not a bug to fix.
  work_hours        Σ per-day (last − first author-commit timestamp, in hours); per-active-day
                    floor of 0.5h (applied when span = 0 including single-commit days).
                    Finer proxy than work_days; its errors INFLATE leverage, so it never leads.
                    Alternative denominator: work_hours / hours_per_work_day.
  hours_per_work_day  Frozen constant = 8. The anchor table's nominal day (not the operator's
                    session length). Keeps the work_hours-derived alternative denominator
                    unit-consistent with the human-day numerator.
  Git-proxy limits (state these, do not paper over):
    • Misses work before the day's first commit and after its last.
    • Single-commit day collapses to the 0.5h floor.
    • A large intra-day idle gap over-counts work_hours.
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

Operator-filled at authoring:                                                      [operator]
  units_attested    confirmed candidates + any other operator-attested units
  units_valued      ratified row count (= number of rows the operator approved in ## How This Was Calculated)
  operator_assessment  agree | too_high | too_low | unclear | not_reviewed
                       your INDEPENDENT calibration verdict — the standing check on the instrument
  operator_notes    calibration observations

Estimate — agent-proposed via anchor table, operator-ratified in one pass. Agent adjusts
downward only, with justification in estimate_basis. NOTHING unratified reaches published
frontmatter. The operator's baseline: "what this would have taken a competent human in my
seat, working solo" — same yardstick every span for series comparability.    [agent/operator]
  human_days_units  Σ operator-ratified rows; each row's proposed_days = net_loc / its tier rate
                    (150 structured / 300 script-analysis; 260 fallback). Operator ratifies.
  human_days_loc    net_loc_added / 150  (LOC floor at the slowest/structured tier — the aggregate
                    conservatism guard; binds only if a row is estimated below structured throughput)
  human_days_anchor min(human_days_units, human_days_loc)  (= human_days_units in practice, since
                    every tier rate ≥ 150)
  time_saved_days   human_days_anchor − work_days   — MAY BE NEGATIVE. Never clamp.
                    (Finer alternative: human_days_anchor − work_hours / hours_per_work_day;
                    print alongside, never leading — its errors inflate leverage.)
  speedup           min(human_days_anchor / work_days, 10)   — MAY BE < 1. Never clamp.
                    Keep span_days in Notes as secondary cadence context.
  estimate_basis    anchor citations, LOC-reference tripwire notes, graph/chain caveats,
                    and any git-proxy caveats (squash-merge, multi-committer, etc.) if relevant

Research — observed, agent-supplied, optional (labeled non-empirical):             [agent]
  files_read, papers_read, items_parsed, outputs_organized

ANCHOR TABLE — corpus-calibrated per-class LOC/day floor rates (SRC-0002). Universal: classify
the unit, estimate = net_loc / its tier rate. Two tiers only — the operator's git-dated R corpus
(661 units, 2022-12-01→2026-06-24) clusters into exactly two throughput bands (a clean gap at
~200 LOC/active-day); finer per-class rates sit inside the confound noise, so freezing more than
two is false precision. These are FLOORS: git active-days lower-bound real effort, so real human
time ≥ the estimate (conservative). Ratified rows in past VALs remain citable anchors.

  | class                 | tier            | LOC/day |
  |-----------------------|-----------------|---------|
  | module                | structured      | 150 |
  | function              | structured      | 150 |
  | tool                  | structured      | 150 |
  | ad hoc method test    | structured      | 150 |
  | analysis script       | script/analysis | 300 |
  | processing script     | script/analysis | 300 |
  | data wrangling script | script/analysis | 300 |
  | production script     | script/analysis | 300 |

  structured (150) = reusable / tested / carefully designed — more human-time per line, higher value.
  script/analysis (300) = write-once, run-it work — fewer human-days per line.
  Unclassified or genuinely mixed unit → fall back to the global 260 LOC/day (the corpus-wide rate).
  Language-independent (R / Python / TypeScript / bash — a line is a line).

CITATION RULE. Every estimate row must name the unit's class + tier rate, and its proposed_days
must equal net_loc / tier_rate. A row whose proposed_days deviates from net_loc / tier_rate must
state why (atypical density, boilerplate, genuine design overhead git can't see, etc.). A row with
no class citation is invalid and must not appear in published frontmatter.

LOC-REFERENCE TRIPWIRE. The tool prints loc_reference (net_loc / loc_per_day, default 260 — the
corpus-wide rate) per unit in review_units[]. Any estimate diverging more than 3× from
loc_reference — in either direction — must state explicitly why (class-rate vs corpus-average
mismatch, atypical density, boilerplate, etc.). Silence on a >3× divergence is invalid.

NO-CLOSE-ANCHOR FLOW. When a unit fits neither tier cleanly, flag it `no-close-anchor` and use
the global 260 LOC/day fallback, explaining the call. The operator overrides with their
counterfactual. The ratified row becomes a citable anchor for future spans (by path + VAL id).

NULL RESULTS ARE THE POINT. If cost bought little or nothing, say so plainly in ## Agent Value
("cost $X / N tokens; 0 working units this span; value not demonstrated"). Do NOT narrate around
a negative or zero result. A series that can only say "win" is a broken instrument.

RECONCILIATION RULE. Negative or sub-1× result (time_saved_days < 0 or speedup < 1) ⇒
MANDATORY operator reconciliation note in operator_notes before publishing. Two cases:
  instrument misfit → identify which anchors to revise for future spans;
  true loss → state it plainly. The result is never clamped.

ROI LINE (print at the end of ## Agent Value, verbatim shape — keeps the series comparable):
  shipped <units_valued> working units; agents cost $<cost_usd> (est. $<cost_usd_est> at API
  rates) / <total_tokens> tokens; <time_saved_days> human-days vs. baseline (~<speedup>×,
  floor-anchored)
If cost_usd is null (pure subscription-covered), render it as $0 out-of-pocket and let the
at-API-rates estimate carry the interpretable figure. Never invent a real-dollar number.

CEILING REFERENCE LINE (print immediately after the ROI line — display-only, never enters headline arithmetic):
  reference ceiling: COCOMO II nominal ≈ <pm> person-months for <kloc> KSLOC (frozen nominal constants, Boehm 2000)
(where <pm> = cocomo_pm_nominal, <kloc> = cocomo_kloc — both emitted by value-report.)

FLOOR / CEILING GUIDANCE — why the large gap (~30×) is expected, not an error:
  • COCOMO prices *organizational delivery* (requirements, reviews, integration, PM — embedded productivity
    ~15–25 LOC/day), while the floor's tier rates (150–300 LOC/day, calibrated from the operator's own
    corpus, SRC-0002) reflect measured solo throughput; nominal multipliers model an average team member,
    not the "competent human in my seat" baseline.
  • The E>1 exponent prices team coordination a solo developer never pays.
  • Physical net-LOC ≠ COCOMO logical SLOC.
  • Floor = solo-expert marginal effort. Ceiling = fully-loaded organizational delivery. Both answer real VP
    questions ("vs. my time" / "vs. contracting it out"). The gap is the story, not a calibration error.

  Why one ceiling (killed alternatives): COCOMO II nominal is the only reference model passing all four
  requirements: deterministic-from-git, citable frozen constants, free, zero per-span input. FPA,
  SLIM/Putnam, SEER-SEM, story-points, Wideband Delphi, analogy/ANGEL were each rejected — a menu of
  disagreeing models invites "which number is real?" (See WK-0041 for the full rationale.)

  cocomo_kloc counts classifier-recognized source units (scripts/modules/tools) + test files; config, data, and unclassified text are not SLOC (per the COCOMO II / SEI SLOC definition).

  External framing sentence (use verbatim when summarizing the estimate):
  rubric-anchored estimate, operator-ratified downward-only, min-floored, ~N× under the citable industry parametric model.

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
Confirmed candidates are included in the review_units[] estimate table below. -->

## How This Was Calculated

<!-- Glance-readable provenance: every estimate number above must be reproducible from this
section alone — ratified rows + stated arithmetic. Fill all four parts.

1. Anchor table in effect — corpus-calibrated tier rates (SRC-0002), plus any ratified past-VAL
   rows cited this span:

   | class                 | tier            | LOC/day |
   |-----------------------|-----------------|---------|
   | module / function / tool / ad hoc method test | structured | 150 |
   | analysis / processing / data-wrangling / production script | script/analysis | 300 |
   | unclassified or mixed                          | fallback   | 260 |
   | <any ratified past-VAL row cited this span — add below>            |            |     |

2. Per-unit estimate rows — one row per ratified unit (candidates excluded until confirmed).
   Each row names its class + tier rate; proposed_days = net_loc / tier_rate. Rows deviating from
   net_loc / tier_rate, or diverging >3× from loc_reference, MUST explain why.

   | unit | evidence tier | net_loc | loc_reference | class | tier_rate | proposed_days | ratified_days |
   |------|---------------|---------|---------------|-------|-----------|---------------|---------------|
   |      |               |         |               |       |           |               |               |

3. Estimate arithmetic:
     human_days_units  = Σ ratified_days above  (each = net_loc / tier_rate: 150 structured / 300 script-analysis / 260 fallback)
     human_days_loc    = net_loc_added / 150    (LOC floor at the slowest/structured tier; conservatism guard, rarely binds)
     human_days_anchor = min(human_days_units, human_days_loc)
     time_saved_days   = human_days_anchor − work_days      (may be negative; never clamp)
     speedup           = min(human_days_anchor / work_days, 10)   (may be < 1; never clamp)

   Denominator is work_days (git-derived active calendar days; excludes idle days).
   Finer alternative: work_hours / hours_per_work_day — print alongside, never leading
   (its errors inflate leverage). span_days is the secondary calendar context field.

   Deliberate unit-mixing: numerator = human-equivalent days (anchor-table day, 8h/day);
   denominator = operator-active days (git-derived). The asymmetry IS the leverage definition
   ("output in human-days per day of operator engagement") — do not resolve it into matching units.

   Git-proxy caveats to state in estimate_basis when relevant: squash-merges understate
   work_days (inflates leverage); multi-committer repos conflate contributors.

   Note: human_days_anchor takes the floor of units_sum and loc_floor as a deterministic
   conservatism guard for tiny-LOC spans. Both sides are printed above so the choice is auditable.

4. Cost side: total tokens and BOTH dollar figures — cost_usd (real/marginal out-of-pocket)
   and cost_usd_est (ccusage at-API-rates, every arm incl. subscription + codex) — with
   cost_provenance and the ccusage version that priced them.
-->

## Agent Value

## Methods

Two numbers bracket this report's value estimate. They answer different questions and are
never averaged.

- **Floor (claimed):** what this span's surviving output would have taken one competent
  human working alone with full context of this repo. Estimated per unit as net_loc ÷ a
  per-class tier rate (150 structured / 300 script-analysis) calibrated from the operator's own
  git-dated, hand-written R corpus (SRC-0002; 661 units over 3.5 yr), cross-validated
  leave-one-section-out to within 2× (median 0.92) and biased conservative — git active-days
  lower-bound real effort. Operator-ratified; floored by a LOC conservatism guard. Every headline
  figure uses this number.
- **Ceiling (reference only):** what the same delivered code would cost as a traditional
  organizational software project, per COCOMO II (nominal constants, Boehm 2000). It
  embeds ~15–25 LOC/day because it prices requirements, reviews, integration, and
  management — not just writing code. It never enters the headline arithmetic.

The large gap between floor and ceiling is expected: it is the distance between a solo
expert's marginal effort and fully-loaded organizational delivery. We claim the floor and
display the ceiling — even the most conservative accounting sits far below the citable
industry model.

Why precision does not decide the conclusion: agent cost for a span is dollars to a few
hundred dollars (see cost fields), while either end of the bracket prices the equivalent
human work orders of magnitude higher. The estimate can be off severalfold without
changing the cost-to-value verdict. The instrument reports losses when they occur —
negative results are never clamped (see the series).

## Notes
