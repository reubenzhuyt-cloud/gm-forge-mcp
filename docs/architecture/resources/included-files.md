# included files

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The `.yyp`'s `IncludedFiles` list — the files GameMaker ships as data — plus the
optional copy into `datafiles/<targetName>/`. It owns the entry key set and the
delete-decided-before-write rule; it does not own the asset tree (`Folders`),
because included files are not resources.

## Key Paths

- `src/gm/included_files.ts` (420 lines).
- Entry shape captured verbatim from `261103GJ/261103GJ.yyp` (GameMaker
  2026.0.0.16): `INCLUDED_FILE_KEYS` (`:18-26`) = `$GMIncludedFile`, `%Name`,
  `CopyToMask`, `filePath`, `name`, `resourceType`, `resourceVersion`;
  `INCLUDED_FILE_RESOURCE_VERSION = "2.0"` (`:32`); `CopyToMask: -1` = every
  platform.

## Public API / Key Types

- `IncludedFileSummary` (`:39`), `ListIncludedFilesResult` (`:48`).
- `listIncludedFiles(projectDir)` (`:154`) — `.yyp` order; flags an entry whose
  `filePath/name` is missing on disk (`existsOnDisk`, plus `size` when present).
- `addIncludedFile(projectDir, {sourcePath, targetName?, copy?, overwrite?})`
  (`:190`) — `copy` defaults to true: the source is copied to
  `datafiles/<targetName>/<basename>` with `atomicCopyFile` and that directory
  becomes `filePath`. `copy: false` only registers a file that must already live
  inside the project, and refuses a project-root path (no captured `filePath`
  spelling for that shape, `:237`). Refuses a duplicate name and an occupied
  destination unless `overwrite: true` (`:257`, `:278`); `overwrite` with a
  changed `filePath` is refused because it would move the entry and orphan the
  old copy. The replaced entry's unmodelled keys are carried over via
  `loadRawYyp`.
- `removeIncludedFile(projectDir, {name, deleteFile?})` (`:307`) — exact
  spelling first, then a unique case-insensitive match; an ambiguous match is
  refused rather than guessed (`:335-341`). The file stays on disk unless
  `deleteFile: true`. Every way the delete can fail is decided **before** the
  `.yyp` is written (`:357-373`), and the result reports `fileDeletionSkipped`
  instead of throwing after the manifest changed (`:381-398`).
- `AddIncludedFileResult` / `RemoveIncludedFileResult` (`:62`, `:74`) — the latter
  carries `removed`, `fileDeleted`, `fileDeletionSkipped?`.

## Contracts

- `assertSafeSegment` (`:100`) is a two-line delegate to
  `assertSafePathSegment` (`path-safety.md`), passing its three message fragments
  as `SegmentRules`, so every existing error string is unchanged.
- `AddIncludedFileOptions` deliberately has no `skipSnapshot`: the dispatch hook
  owns the opt-out (`:52-54`). `add_included_file` and `remove_included_file` are
  on `AUTO_SNAPSHOT_TOOLS` because they rewrite the `.yyp`.
- Unregistering must never silently delete user data — that is the default.

## Dependencies

- In: `atomic.ts`, `path_safety.ts`, `snapshot.ts` (`resolveInProject`),
  `yyp.ts` (`loadYyp`, `loadRawYyp`, `writeYyp`).
- Out: `index.ts`, `test/verify.ts`.
