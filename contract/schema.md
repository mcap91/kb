# Frontmatter Schema Reference

This document defines the frontmatter schema for all manifest-driven wiki record types. These schemas are enforced by `wiki lint` and validated by Zod schemas in `wiki-core`.

> **Note:** `HO-*` handoff records are **dispatch-owned** and are not covered by this schema reference. Handoff frontmatter is defined and validated by `dispatch-core`. See `contract/templates/handoff.md` for the handoff template.

## WK-* Work Items

Directory: `wiki/issues/`
ID strategy: allocated (sequential numeric)
Filename: `WK-NNNN.md`

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier, e.g. `WK-0001` |
| `title` | string | Short descriptive title |
| `type` | enum | One of: `bug`, `feature`, `task`, `investigation`, `chore`, `docs`, `infra`, `migration` |
| `status` | enum | One of: `inbox`, `todo`, `in_progress`, `blocked`, `review`, `done`, `parked`, `cancelled`, `deprecated`, `duplicate`, `superseded`, `wont_do` |
| `priority` | enum | One of: `critical`, `high`, `medium`, `low` |
| `owner` | string | Primary owner |
| `created` | string | ISO 8601 date |
| `updated` | string | ISO 8601 date |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `resolution` | string | Resolution notes |
| `severity` | string | Severity level |
| `area` | string | Area slug reference |
| `initiative` | string | Initiative ID reference |
| `tags` | string[] | Classification tags |
| `origin` | object | Origin metadata |
| `migration` | object | Migration metadata |
| `repo_paths` | string[] | Repo-relative file paths |
| `docs` | string[] | Related doc paths |
| `external_links` | string[] | External URLs |
| `links` | string[] | General link references |
| `depends_on` | string[] | IDs this item depends on |
| `blocks` | string[] | IDs this item blocks |
| `related` | string[] | Related record IDs |
| `write_scope` | string[] | Paths agents may write to |
| `assignees` | string[] | Assigned people |
| `agents` | string[] | Assigned agents |
| `reviewers` | string[] | Assigned reviewers |
| `target` | string | Target date |
| `completed` | string | Completion date |
| `started` | string | Start date |
| `superseded_by` | string | ID of superseding item |
| `duplicate_of` | string | ID of duplicate item |
| `deprecated_by` | string | ID of deprecating item |

## IN-* Initiatives

Directory: `wiki/initiatives/`
ID strategy: allocated (sequential numeric)
Filename: `IN-NNNN.md`

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier, e.g. `IN-0001` |
| `title` | string | Short descriptive title |
| `status` | enum | One of: `todo`, `in_progress`, `blocked`, `review`, `done`, `parked`, `cancelled`, `deprecated` |
| `priority` | enum | One of: `critical`, `high`, `medium`, `low` |
| `owner` | string | Primary owner |
| `created` | string | ISO 8601 date |
| `updated` | string | ISO 8601 date |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `summary` | string | Brief summary |
| `area` | string | Area slug reference |
| `tags` | string[] | Classification tags |
| `docs` | string[] | Related doc paths |
| `depends_on` | string[] | IDs this initiative depends on |
| `blocks` | string[] | IDs this initiative blocks |
| `related` | string[] | Related record IDs |
| `write_scope` | string[] | Paths agents may write to |
| `assignees` | string[] | Assigned people |
| `agents` | string[] | Assigned agents |
| `reviewers` | string[] | Assigned reviewers |
| `target` | string | Target date |
| `started` | string | Start date |
| `completed` | string | Completion date |

## DEC-* Decisions

Directory: `wiki/decisions/`
ID strategy: allocated (sequential numeric)
Filename: `DEC-NNNN.md`

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier, e.g. `DEC-0001` |
| `title` | string | Short descriptive title |
| `status` | enum | One of: `proposed`, `accepted`, `rejected`, `superseded`, `deprecated` |
| `date` | string | Decision date |
| `owners` | string[] | Decision owners |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `area` | string | Area slug reference |
| `docs` | string[] | Related doc paths |
| `related` | string[] | Related record IDs |
| `supersedes` | string | ID of superseded decision |
| `superseded_by` | string | ID of superseding decision |

## SRC-* Sources

Directory: `wiki/sources/`
ID strategy: allocated (sequential numeric)
Filename: `SRC-NNNN.md`

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier, e.g. `SRC-0001` |
| `title` | string | Short descriptive title |
| `kind` | string | Source kind (e.g. paper, article, repo) |
| `captured` | string | Capture date |
| `updated` | string | Last update date |
| `source_uri` | string | URI of the source |
| `authority` | string | Authority level |
| `immutable_hint` | boolean | Whether the source is immutable |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `related_docs` | string[] | Related doc paths |
| `related_work` | string[] | Related work item IDs |
| `anchors` | string[] | Anchor references |

## AREA Records

Directory: `wiki/areas/`
ID strategy: slug (human-readable)
Filename: `<slug>.md`

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Slug identifier, e.g. `tooling` |
| `title` | string | Human-readable title |
| `owners` | string[] | Area owners |
| `updated` | string | Last update date |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `docs` | string[] | Related doc paths |
| `initiatives` | string[] | Related initiative IDs |
| `sources` | string[] | Related source IDs |
| `decisions` | string[] | Related decision IDs |
| `related` | string[] | Related area slugs |
