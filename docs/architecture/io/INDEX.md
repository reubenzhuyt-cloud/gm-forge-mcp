# io

> Router only. Open the one module doc you need.

| Module | Covers | Doc |
|--------|--------|-----|
| atomic | Temp-then-rename writer, snapshot size limits, locked-file wording | atomic.md |
| snapshots | `.gm-forge/` store: create, dedupe, restore, undo, retention, diff | snapshots.md |
| auto-snapshot | `write.ts` — the dispatch hook and `writeWithSnapshot` | auto-snapshot.md |
| project manifest | `yyp.ts` — parse, project lock, registration, `writeYyp` + `$GM*` restoration | project-manifest.md |
| file tools | `read_file`, `patch_file`, `list_changes` | file-tools.md |
| path safety | Shared single-path-segment validator | path-safety.md |

## Why (subproject specs)

| Spec | Covers |
|------|--------|
| [E-safety-foundation](../specs/E-safety-foundation.md) | snapshots, atomic writes, `read_file`/`patch_file` |
| [C-project-config](../specs/C-project-config.md) | `writeYyp` fidelity, options |
