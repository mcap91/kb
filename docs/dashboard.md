# Dashboard

HTML pages for the operator, built by code from the wiki records and `wiki/dashboard/chain.md`.

## Built-in pages (`wiki generate`)

When the planning layer is active, `wiki generate` writes the dashboard pages in the same run as
the five standard views. A repo with the wiki layer only gets the five views and no page.

| Page | What it shows |
|------|---------------|
| `wiki/dashboard/generated/index.html` | Every initiative, one line each, in three boxes: in progress, to do, done. A color legend and links to the critical path, `chain.md` and the work item page |
| `wiki/dashboard/generated/critical-path.html` | Each critical path in `chain.md`: its stages in build order, an open count and gate per stage, a card per work item. Written only when `chain.md` has a critical path |
| `wiki/dashboard/generated/IN-XXXX/chain.html` | One initiative: the Next box, the Done strip, its chain of stages from `chain.md`, the open work items no stage names, and the Parked strip |
| `wiki/dashboard/generated/wk.html` | Type a work item id or number to see it with its initiative and its neighbors: depends on, blocks, related, and the nearest open ids of the same initiative |
| `wiki/dashboard/generated/records/<ID>.html` | One page per work item and initiative: status, priority, type, initiative, relations, and the record body rendered as HTML |

Open `index.html` in a browser or in an editor preview. Every page links to the others with relative
links, has a light/dark button, and loads nothing from the network.

### The folder is owned by `generate`

`wiki/dashboard/generated/` is rebuilt on every run. A run writes every page, deletes every file it did
not write, and removes empty directories. Never edit a page there: the next run overwrites it. Keep
hand-made pages elsewhere in `wiki/dashboard/`; `generate` never reads, lists or writes them.

If `wiki/dashboard` or `wiki/dashboard/generated` exists and is not a real directory, `generate` fails
with `GENERATE_ERROR` and writes no page. Two runs on unchanged inputs write byte-identical pages: no
clock time and no absolute path reaches a page. A date on a page is a record's `updated` date or the
`updated` date of `chain.md`.

The pages are a derived view. When a page and a record disagree, the record wins: fix the record or
`chain.md`, then run `generate` again.

## `chain.md`: the build order

Records hold status. `wiki/dashboard/chain.md` holds order, which records do not. The overseer keeps it,
or any agent on request, from the template `wiki/templates/chain-doc.md` that ships with the planning
layer.

Code reads four things in it. Every other line is free text for agents.

1. `updated:` in the frontmatter, as `YYYY-MM-DD`.
2. A `## Critical path ...` section: a build order across initiatives. Optional; there can be more than
   one.
3. One `## IN-XXXX ...` section per initiative: that initiative's build order.
4. Inside a critical path or an initiative section:
   - each `###` heading is a stage, in build order;
   - a `Gate:` line under a stage says what must be true to leave it (optional, one per stage);
   - each list line that starts with a work item id puts that work item in the stage, in build order.

```markdown
---
updated: 2026-11-18
---

## IN-XXXX — Faster imports

### M1 parser rewrite
Gate: the import benchmark runs under 2 s
- WK-XXXX new tokenizer
- WK-XXXX streaming reader

### M2 rollout
- WK-XXXX switch the CLI to the new parser
```

Code reads only the id on a work item line. The title, status, color and priority come from the record,
so do not group work items by status in `chain.md`. A done work item stays in its stage and shows green.

What the pages do with it:

- **Chain page.** The stages are drawn in file order, with arrows between them and a gate box under a
  stage that has a `Gate:` line. Code never judges whether a gate is met. Open work items of the
  initiative that no stage names are listed under "Not on the chain", so they can be placed.
- **Next box.** The first seven open work items along the chain. With no stage line for the initiative,
  code picks them instead: in progress, review or blocked first, then critical and high priority. The
  box says which source it used.
- **Stale mark.** When a record on the chain page was updated after `chain.md`, or `chain.md` has no
  valid date, the Next box says so.
- **No section.** An initiative with no section, or a section with no work item line, is drawn in bands:
  one per milestone tag `m1` to `m9` when its work items carry them, else In progress, To do and Inbox.

`wiki lint` checks the parts code reads, with the rule `CHAIN_DOC_SHAPE` (see `contract/lint.md`).

## Record pages

Each work item and initiative gets `records/<ID>.html`. The record body is converted to HTML by a small
built-in converter, with no extra dependency. It renders:

- headings, paragraphs, and nested `-`, `*` and `1.` lists;
- task items `- [ ]` and `- [x]` as checkboxes;
- fenced code blocks, inline code and `**bold**`;
- links `[text](target)` where the target is `http:`, `https:`, a `#` anchor or a relative path.
  A relative path is rewritten so it opens the same file from the page;
- `[[ID]]` as a link: a work item or initiative to its record page, any other record to its file. An id
  with no record shows as plain text.

Everything else shows as text and is never dropped: tables (in a monospace block, so the columns stay
readable), block quotes, raw HTML, HTML comments and horizontal rules. No text from a record is passed
through as HTML, and a link with any other target, such as `javascript:`, shows as text.

## Changing the pages

The code lives in `packages/wiki-core/src/dashboard/`:

| To change | Edit |
|---|---|
| Colors, fonts, sizes, spacing | `style.ts` |
| What a page shows, or its layout | `pages.ts` (one builder per page) |
| How a record body renders | `markdown.ts` |
| What code reads from `chain.md` | `chain-doc.ts`, with the template, the lint rule docs and the overseer role text |

Tests in `tests/wiki-dashboard.test.ts` read the `data-` attributes and the text of the pages, never CSS
or class names, so a change of look needs no test change. After a change, run
`npm run wiki -- generate --dir <repo>` and reload the page.
