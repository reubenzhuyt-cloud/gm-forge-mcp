# delete & rename

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The two tools that change the project graph: `delete_resource` (removes the
directory, the catalog entry and a room's order node) and `rename_resource`
(rewrites every reference, the resource's own files and the catalog). Both are
auto-snapshotted; both are irreversible without `restore_snapshot`/`undo_last`.

## Key Paths

- `src/gm/delete.ts` (76 lines), `src/gm/rename.ts` (249 lines).
- Resource layout for both: `<category>/<name>/<name>.yy`; categories are
  `rooms, objects, scripts, sprites, shaders, sounds, fonts, notes, tilesets,
  extensions, particles, animcurves` (`delete.ts:7`).

## delete.ts

- `ResourceInUseError` (`:9`) — carries the name and the hits; the message lists
  the first five `file:line` contexts and says `force=true` overrides.
- `deleteResource(projectDir, yyp, category, name, force = false)` (`:26`) —
  validates the name, verifies the `.yy` exists (a permission error is reported
  as such, not as "missing", `:36-43`), refuses when `findReferences` returns
  anything unless `force` (`:45-50`), `fs.rm` the directory, **then** updates the
  catalog (`:52-68`). A failed `rm` can leave the directory partially removed
  while the catalog is untouched — the message says so and points at
  `lint_project`.
- A deleted room also loses its `RoomOrderNodes` entry (`:70-73`).

## rename.ts

- `renameResource(projectDir, yyp, category, oldName, newName)` (`:98`) —
  refuses an identical name, an invalid new name, a catalog collision and an
  existing target directory (`:105-123`).
- Ordered, rollback-protected steps (`:125-225`): 1. rewrite external references;
  2. rewrite the resource's own `.yy`/`.gml` contents; 3. rename its own files
  (`oldName.yy`, `oldName.gml`, event stubs — with a special case for
  `Collision_<ownName>.gml`, whose target is the suffix); 3.5 rename *other*
  objects' `Collision_<oldName>.gml` files; 4. rename the directory. A failure at
  any point rolls those steps back in reverse. Steps 5-6 only touch the in-memory
  `Yyp` (`:227-246`), which the caller writes afterwards.
- `.yy` files are rewritten **structurally** (`renameInJsonTree`, `:49`): only a
  `{name, path}` pair or the root record has its `name`/`%Name` changed; a
  path-shaped string is rewritten by `renamePathLikeValue` (`:33`), which leaves
  free-text labels without `/` or `.` alone.
- `.gml` files get `wholeWordReplace` (`:19`), a best-effort text replace. Its one
  mitigation: a line declaring `var <oldName>` is skipped entirely, because that
  is a shadowing local. It does **not** track that local's later uses — real scope
  analysis would be needed (`:9-18`).

## Known limits

- No GML parser: an unrelated local variable or a string literal containing the
  resource name can be renamed.
- No structural knowledge of sequences/timelines beyond plain text.
- Renaming is not atomic across files: the rollback is best effort.

## Dependencies

- In: `references.ts`, `yyp.ts` (`assertSafeResourceName`,
  `parseGameMakerJson`), `atomic.ts`.
- Out: `index.ts`, `test/verify.ts` (path-traversal and rename coverage).
