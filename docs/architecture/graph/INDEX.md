# graph

> Router only. Open the one module doc you need.

| Module | Covers | Doc |
|--------|--------|-----|
| references | `references.ts`: whole-word project-wide reference scan | references.md |
| delete & rename | `delete.ts` + `rename.ts`: the two catalog-destructive tools | delete-rename.md |
| introspect | `introspect.ts`: the twelve `get_*_info` readers | introspect.md |

## Why

`find_references` is the safety check behind both destructive tools; read those
two together. Nothing in this area parses GML — see the documented limits.
