# Wiki Conventions

This file describes the conventions for wiki records in this repository. It was seeded during `wiki bootstrap` from `contract/bootstrap/conventions.md`.

After bootstrap, this file is consumer-owned. You may customize it for your project. `wiki sync-contract` will report drift but will not overwrite this file.

## Creating Records

Use the `wiki create` command to create new records:

```bash
npm run wiki -- create --dir . --prefix WK --title "My new work item"
npm run wiki -- create --dir . --prefix IN --title "My new initiative"
npm run wiki -- create --dir . --prefix DEC --title "My decision"
npm run wiki -- create --dir . --prefix SRC --title "My source"
npm run wiki -- create --dir . --prefix AREA --title "My area" --slug my-area
```

IDs are automatically allocated for `WK`, `IN`, `DEC`, and `SRC` records.

## Record Lifecycle

### Work Items (WK-*)

Typical lifecycle: `inbox` -> `todo` -> `in_progress` -> `review` -> `done`

### Initiatives (IN-*)

Typical lifecycle: `todo` -> `in_progress` -> `review` -> `done`

### Decisions (DEC-*)

Typical lifecycle: `proposed` -> `accepted` | `rejected`

## Updating Records

Edit the YAML frontmatter directly in the markdown file. Always update the `updated` field when making changes.

## Linting

Run `wiki lint` to validate all records against the schema:

```bash
npm run wiki -- lint --dir .
```

## Generating Views

Run `wiki generate` to regenerate the standard views:

```bash
npm run wiki -- generate --dir .
```

Generated views include: `catalog.md`, `now.md`, `inbox.md`, `backlog.md`, `archive.md`.
