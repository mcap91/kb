---
updated: {{date}}
---

# Chain

The agents' build-order doc. The overseer keeps it, or any agent on request. After every edit, run
`generate`: code builds the dashboard pages in `wiki/dashboard/generated/` from the records and this
file. Never edit a generated page.

Code reads four things here. Every other line is free text for agents.

1. `updated:` above. Bump it on every edit.
2. A `## Critical path ...` section: a build order across initiatives. It is optional, and there can be
   more than one. The index links to it.
3. One `## IN-XXXX ...` section per initiative: that initiative's build order. Its chain page draws it.
4. Inside a critical path or an initiative section:
   - each `###` heading is a stage, and stages are in build order;
   - a `Gate:` line under a stage says what must be true to leave it (optional, at most one);
   - each list line that starts with a work item id puts that work item in the stage, in build order.

Code reads only the id on a work item line. Its title, status and color come from the record. Status
lives in the records: do not group work items by status here. A done work item stays in its stage and
shows green. Place every open work item of the initiative in a stage; the chain page lists the ones you
missed.

## Critical path <what it leads to>

<1–2 sentences: why this order.>

### <stage name>
Gate: <what must be true to leave this stage>
- WK-XXXX <short title>

## IN-XXXX — <initiative title>

<3–4 sentences: what the initiative is, the goal state, its current center of gravity, and what
unblocks it next.>

### <first stage, e.g. M1 and its goal>
Gate: <what must be true to leave this stage>
- WK-XXXX <short title> — <1–2 sentences: where it stands>.
- WK-XXXX <short title> — <1–2 sentences>.

### <next stage>
- WK-XXXX <short title> — <1–2 sentences>.
