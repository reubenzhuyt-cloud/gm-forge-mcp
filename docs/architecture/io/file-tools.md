# file tools

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The generic text-file surface: `read_file` (paged, line-numbered), `patch_file`
(literal replacement with one automatic backup) and `list_changes` (project vs
newest snapshot). It owns no resource semantics — `patch_file` does not validate
JSON afterwards, by design.

## Key Paths

- `src/gm/files.ts` — 315 lines.
- Limits (`:7-10`): `READ_MAX_BYTES` / `PATCH_MAX_BYTES` = 2 MiB,
  `READ_DEFAULT_LIMIT` = 2000 lines, `READ_MAX_LIMIT` = 5000.

## Public API / Key Types

- `readFile(projectDir, requested, { offset?, limit? })` (`:97`) — resolves the
  path with `resolveInProject` (realpath-based containment from
  `snapshot.ts:258`), refuses directories (`:110`), files over 2 MiB (`:113`,
  offset/limit page lines, not bytes), and NUL bytes in the first 8 KiB
  (`assertNotBinary`, `:75`) so UTF-16 is reported instead of shown as mojibake.
  A leading BOM is dropped from the rendered view only (`:122-124`); output is
  `N: line` joined by `\n`, with `totalLines/from/to/truncated/bytes`.
- `patchFile(projectDir, requested, { find, replace, count, skipSnapshot? })`
  (`:206`) — exact-string matching only; `find` must be non-empty and
  NUL-free; `count` is `"exact"` (default, exactly one occurrence) or `"all"`.
  Occurrence count and line numbers are reported on refusal (`:251-263`).
  `replace` is normalised to the file's own EOL (`:267-268`); everything else is
  a byte slice of the decoded text (`:276-282`), so BOM, line endings and a
  trailing newline survive. Refuses the `.gm-forge` store (`:195-204`) and any
  path outside the project; never creates a file (`:232`).
- `listChanges(projectDir)` (`:299`) — newest snapshot vs disk via
  `diffAgainstSnapshot`; no snapshot → empty diff with `snapshotId: null`.
- Aliases `readProjectFile` / `patchProjectFile` (`:314-315`).
- Result types `ReadFileResult` (`:20`), `PatchFileResult` (`:37`),
  `ListChangesResult` (`:47`); `FileChange = SnapshotChange`.

## Backup behaviour

`patch_file` is **not** on `AUTO_SNAPSHOT_TOOLS`; it calls `writeWithSnapshot`
itself (`:284-288`) and returns `snapshotId` or `snapshotSkippedReason`, so a
call takes exactly one backup and the result can say when it took none.

## Dependencies

- In: `snapshot.ts` (`resolveInProject`, `storeDir`, `latestSnapshot`,
  `diffAgainstSnapshot`), `write.ts`, `atomic.ts` (indirectly).
- Out: `index.ts` dispatch cases; `test/verify.ts` (line-numbering,
  containment and patch branches).
