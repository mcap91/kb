# Wiki Schema

This file describes the frontmatter schema for wiki records in this repository. It was seeded during `wiki bootstrap` from `contract/bootstrap/schema.md`.

After bootstrap, this file is consumer-owned. You may customize it for your project. `wiki sync-contract` will report drift but will not overwrite this file.

## Record Types

| Prefix | Type | Directory | ID Strategy |
|--------|------|-----------|-------------|
| `WK` | Work item | `wiki/issues/` | Allocated sequential |
| `IN` | Initiative | `wiki/initiatives/` | Allocated sequential |
| `DEC` | Decision | `wiki/decisions/` | Allocated sequential |
| `SRC` | Source | `wiki/sources/` | Allocated sequential |
| `AREA` | Area | `wiki/areas/` | Slug-based |
| `PLN` | Plan | `wiki/plans/` | Allocated sequential |
| `VAL` | Value report | `wiki/value-reports/` | Allocated sequential |

## Frontmatter Reference

For the full schema specification, see the contract schema at `contract/schema.md` in the `kb` repository.

### Common Fields

All record types require at minimum:

- `id` — unique identifier
- `title` — human-readable title

### Dates

All dates use ISO 8601 format (`YYYY-MM-DD`).

### References

Cross-record references use the target record's `id` value (e.g. `WK-0001`, `IN-0002`).

### Arrays

Array fields (like `tags`, `depends_on`, `related`) use YAML list syntax:

```yaml
depends_on:
  - WK-0001
  - WK-0002
```

## Dispatch-Owned Records

`HO-*` handoff records are managed by `dispatch-core` and are not part of the manifest-driven wiki schema. See `wiki/handoffs/` for handoff files and the handoff template for the expected format.
