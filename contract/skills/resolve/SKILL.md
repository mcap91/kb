---
name: resolve
description: Before you escalate a question to the operator, resolve it from evidence. Runs the resolution chain (records, rules, code, reference systems, web), makes the call, records it, and keeps working; only the four operator-only cases go to the operator, through the repo's escalation template. Use before you ask the operator a question, and when the user says "/resolve", "resolve it yourself", "you could have figured this out", or "why are you asking me".
---

# Resolve

Before you escalate a question to the operator, resolve it from evidence. Record what you
chose and why, and continue the work.

The operator reviews your choices **after** you make them, by asking questions about your
record — not before, by answering yours. A clear record is the deliverable; a list of
options is not.

## Invocation

```
/resolve [question]
```

With no argument, resolve the question you are about to put to the operator, or the last
question, option list, or "Approve?" you put to them. If there are several, resolve them as one batch:
name and check each one (steps 1–2), search once for the whole batch (step 3), choose each (step 4),
cold-check all the choices in one check (step 5), and record a row per question (step 6).

## Workflow

### 1. Name the question

One sentence. Then one line: what changes in the work depending on the answer.

### 2. Check the operator-only cases first

Decide first whether the question is one of the four cases under "What still goes to the
operator". If it is, or if you cannot tell which it is, stop here: do not choose an answer,
and do not write a Resolutions row whose `choice` is anything but `unresolved`. Search only
to fill the template's "what was searched, and what was found" line. Reply with the
escalation template; its first line is the first line of your reply.

### 3. Search

Search until the answer is clear. The order is your choice; skip what cannot help.

- **Records** — the repo's wiki or tracker (kb-wiki `search` if available), `docs/`,
  decision records, the work item itself.
- **Rules** — the repo's rules file, `AGENTS.md` / `CLAUDE.md`, accepted decisions. A rule
  that answers the question ends the search. When rules leave a tie, the simplest option
  with the smallest blast radius wins.
- **Code** — read it. For a broad sweep, use a read-only explore worker.
- **Reference systems** — any comparable codebase or catalog the repo names as a
  reference. Check what it does for the same problem.
- **Web** — only when the answer depends on external facts (library behavior, versions,
  APIs).

Every claim carries a citation: `file:line`, a record id, or a URL. Each citation names one
file that exists; write two files as two citations. A slash-joined pair such as
`AGENTS.md/CLAUDE.md` and a glob such as `wiki/**/*.md` are not citations.

Workers are read-only. Launch them the way the repo's `AGENTS.md` says; if it says nothing,
launch them as subagents. Worker prompts state the questions, the output fields you need, and
"cite every claim". Budget: at most four search workers per run, shared across a batch.

### 4. Choose

Pick what the evidence supports. If the evidence is split, pick the simplest, most
reversible option and say that is why.

### 5. Cold check

Give one fresh read-only worker only the choices and their evidence — for a batch, all of
them in one check — not your reasoning, and ask it to refute each choice, citing file:line.
Apply its amendments. For each choice it refutes, choose again once and check again; if the
second check also refutes it, that item goes to the operator (below).

### 6. Record

One row per question:

```
| # | date | seat | question | searched | evidence | options | choice | reason | cold check |
|---|---|---|---|---|---|---|---|---|---|
```

Copy the header exactly; kb lint rejects any other spelling.

- `#`: the next integer after the last row (first row is 1). Never renumber or edit old rows.
- `date`: `YYYY-MM-DD`.
- `seat`: your session id, only if it already appears in your context (your prompt or a message from
  the launcher). Do not run a command to find it. If it does not appear, leave the cell empty.
  Never guess a role or seat.
- `searched`: where you searched, with citations.
- `cold check`: `pass`, `amended`, or `fail`. Use `n/a` only when `choice` is `unresolved`
  (no evidence found). A choice that failed two checks is `fail`; say "escalated" in `reason`.
  Write `cold check` values and `unresolved` bare, without backticks.
- A row for an operator-only question has `choice` `unresolved` and says "escalated" in
  `reason`.
- Write a literal `|` inside a cell as `\|`.

If your role may edit the work item, append the row to its `## Resolutions` section. If the
section is absent, add it (heading, header, separator) at the end of the file. Run the repo's
wiki lint if it has one. Otherwise put the row in your reply. Then one line: `Resolved: <choice>. Continuing with <next step>.`
Then continue.

## What still goes to the operator

Only these:

- an action that is irreversible or outward-facing (publish, push, delete, send, spend
  beyond a stated budget);
- a change to the approved spec's objective, scope, or acceptance criteria;
- what the operator wants (intent, priority, taste) when no record states it;
- a choice that failed two cold checks.

For each, write the statement in `wiki/templates/escalation.md`, the only form for a
question to the operator. Its first line opens `Operator action needed: yes`, and it is the
first line of your reply. Write the line as plain text, with no markdown emphasis (`**`,
`_`), heading, backticks, or quote marker around it or any part of it, and put no text
before it (no preamble, no heading, no summary). Do not add a Resolutions row that decides
the question.

Resolve everything else in the same turn and keep working.

## Do not

- Present options for a question you can resolve.
- Write or change rules. You record resolutions; humans write rules.
- Hide a resolution. Every choice made under this skill is recorded.
