# snapshots

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The `.gm-forge/` backup store and its four operations: create, list/restore,
delete, undo, plus the diff `list_changes` and the auto-snapshot hook use.
Snapshots are plain files, never a git operation. This module does **not**
decide when a tool gets a backup (`auto-snapshot.md`) and does no atomic-write
logic of its own (`atomic.md`).

## Key Paths

- `src/gm/snapshot.ts` — 1180 lines, the largest non-registry module.
- Store layout (`:15-28`): `<project>/.gm-forge/backups/<YYYYMMDD>-<HHmmss>-<hex6>/{manifest.json,files/...}`,
  `lock`, `journal.jsonl`. The walk skips dot directories, so the store can
  never contain itself.

## Public API / Key Types

- `SNAPSHOT_KEEP = 20` (`:42`), `DEDUPE_MODE = "link"` (`:44`).
- `SnapshotManifest` (`:64-84`): `id, schema:1, createdAt, tool, reason,
  projectName, previous, dedupe, files[], touched[], skipped[], fileCount,
  totalBytes, failed, undoneAt`. There is **no** `undoHold` field and no code
  path that reads one.
- `createSnapshot(projectDir, {tool, reason, touched, onOverThreshold})`
  (`:581`): exclusive `mkdir` per snapshot dir (`:626-639`), digest computed
  once per file and reused for store + manifest (`:691-699`). Over the caps:
  `"skip"` returns `snapshotId: null` + a warning, `"throw"` (an explicit
  `create_snapshot`) raises `SnapshotTooLargeError` (`:602-618`).
- `listSnapshots` (`:503`) reports a corrupt manifest inline as
  `{corrupt: true, error}` instead of failing the listing.
- `restoreSnapshot` (`:985`): subset selection is all-or-nothing — an unknown
  path aborts before any write (`:962-983`); every target is containment-checked
  (`:993-997`), stored bytes are sha256-verified (`:998`, `:907`), then the
  project `lock` is taken for the write phase (`:1000-1006`).
- `deleteSnapshot` (`:1026`): refuses the snapshot `undo_last` would restore
  (`:1032-1037`) and any id that does not resolve inside the store.
- The project `lock` (`:367-398`): a restore/undo refuses to start while one
  exists. The message names the absolute lock file, says deletion is safe only
  when no restore is still running, and points at `skipSnapshot: true` as the way
  to run a destructive tool anyway. The lock is never removed automatically.
- `undoLast` (`:1052`): target = newest manifest with `undoneAt === null` and a
  non-empty `touched`; files in `touched` but absent from the snapshot are
  **removed** (the operation created them), the rest are restored; then
  `undoneAt` is set and `skippedNotRestored` names files the snapshot could not
  store (`:1086-1092`).
- `diffAgainstSnapshot(projectDir, manifest, { rehashSinceMs? })` (`:1129`):
  size+mtime fast path, otherwise hash. `rehashSinceMs` forces a hash for files
  modified at/after it — the hook's coarse-timestamp (FAT 2 s) guard.

## Dedupe: `"link"` and the invariant it needs

An unchanged file is hard-linked from the previous snapshot (`:661-673`);
`stored: "link" | "copy"` records what each file got, and `dedupe` records the
mode. This is only safe because every project write replaces the inode
(temp+rename), never truncates it — a shared inode would otherwise be clobbered.
A link failure (`EXDEV`, `EPERM`, `EMLINK`, `EACCES`, `ENOENT`) falls back to a
copy for that file (`:675-687`) and never fails the snapshot. The digest is
skipped only in copy mode with no `previous` (`:648-653`); with link mode it is
always computed.

## Restore failure behaviour

Files already replaced by a restore are remembered with their previous bytes and
rolled back on a later failure (`rollbackRestored`, `:936-958`). The message says
either "rolled back N file(s), project is back to its pre-restore state" or
"rollback also failed … the project tree is MIXED — re-run the restore". There
are **no transactions**: rollback is per-file best effort, and a restore that
fails mid-way can still leave a mixed tree if the rollback also fails.

## Retention

Pruning keeps the newest 20, always protects the just-created id and the current
undo target, and deliberately does not protect `previous` — deleting an old
snapshot only decrements hard-link counts (`:550-578`).

## Dependencies

- In: `atomic.ts` (limits, exclusions, atomic writes).
- Out: `write.ts`, `files.ts`, `included_files.ts` (via `resolveInProject`),
  `index.ts` dispatch cases, `test/verify.ts`.
