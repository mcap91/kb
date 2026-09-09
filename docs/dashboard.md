# Dashboard

Deterministic HTML dashboard generator for PLN, IN, and WK-set records.
Pipeline is a pure function: source files → parsers → JSON → one frozen static
template. No agent, no network, no wall-clock at render time. Identical input →
byte-identical output.

## Usage

```bash
npm run dashboard -- <ID> [--dir <path>]
```

### Modes

| Input | What it renders |
|-------|----------------|
| `PLN-0004` | Plan: pipeline spine, task×phase matrix, triage lanes |
| `IN-0004` | Initiative: member WK rollup, dependency DAG, triage lanes |
| `WK-0070..WK-0077` | WK range: dependency DAG, triage lanes |
| `WK-0070 WK-0072` | WK list (variadic): same as range |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--dir <path>` | `cwd` | Repo root to read wiki records from |

### Output

Single self-contained HTML file written to `wiki/dashboard/<id>.html`.
No external dependencies — embedded CSS + vanilla JS, no CDN, no fetch.

- PLN: `PLN-0004.html`
- IN: `IN-0004.html`
- WK-set: `from-WK-0070.html` (named by first record, stable across range changes)

Output is gitignored (`wiki/dashboard/`). Regenerate anytime.

## Layout

### PLN dashboards
- **Pipeline spine** — clickable slice nodes, lane-colored, gradient connector
- **Task × phase matrix** — dot-plot below the spine; dots for active work, thin
  carry-forward lines with arrows for tasks spanning phases
- **Queued strip** — collapsed by default, between pipeline and status board
- **Status board** — triage lanes (in progress / blocked / done)
- **Blockers & failures** — from tracker Failure Log
- **Recent activity** — from tracker Completed Log

### IN / WK-set dashboards
- **Dependency DAG** — dagre-computed layout (left-to-right, elbowed edges).
  Nodes colored by lane; edge routing handled at generation time, not in the HTML
- **Queued strip** — collapsed by default
- **Status board** — triage lanes with WK cards. Each card has:
  - Lane-colored ID, priority badge, status badge
  - "depends on" section showing all deps with per-status colors
    (green=done, blue=in_progress, red=blocked, white=queued)
  - Expandable `detail` with record body text (WK refs highlighted)

## IN membership

An initiative dashboard's WK set is the union of three sources — a WK needs to match
only one to be included:

1. **Declared** — the WK's own frontmatter has `initiative: <IN id>` (scanned across
   all of `wiki/issues/*.md`; quoted or unquoted, CRLF-tolerant).
2. **Referenced** — the WK id appears in the IN's own frontmatter arrays (`related`,
   `depends_on`, `blocks`).
3. **Linked** — the WK id appears as a markdown link (`[WK-NNNN](...)`) in the IN body.

Plain-text or backticked mentions with no markdown link (e.g. a cross-repo prose
reference like "bioinfo `WK-0050`") are **not** members — this keeps incidental or
cross-repo mentions out of the graph. A WK that only declares `initiative:` and is
never mentioned in the IN body is still a member, and appears in the dependency DAG
as a node (WK-0078).

## Lane logic

`laneOf(status, hasUnmetDeps)` — single source of truth:

| Status | Unmet deps? | Lane |
|--------|-------------|------|
| `done`, `cancelled`, `superseded`, etc. | any | done |
| `in_progress`, `active`, `review` | no | in_progress |
| `in_progress`, `active`, `review` | yes | blocked |
| `blocked` | any | blocked |
| anything else (`inbox`, `open`, etc.) | any | queued |

Explicit statuses are authoritative. Passive statuses never get promoted to
blocked — unmet deps on an inbox item don't make it blocked, just queued.

## Dependencies

- **dagre** — directed graph layout, used at generation time only. Not shipped
  in the HTML output.

