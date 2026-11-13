# atomic

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The only temp-then-rename implementation in the tree, plus the snapshot cost
limits and the one Windows locked-file message. It owns bytes-to-disk safety
for project files, snapshots and imported assets; it does **not** decide what to
back up (that is `auto-snapshot.md`) or where the store lives (`snapshots.md`).

## Key Paths

- `src/gm/atomic.ts` — the whole module; no dependencies on other `src/gm` files.

## Public API / Key Types

- `SNAPSHOT_MAX_FILE_BYTES` (`8 MiB`), `SNAPSHOT_MAX_FILES` (`20_000`),
  `SNAPSHOT_MAX_BYTES` (`512 MiB`) — `atomic.ts:8-10`; `snapshot.ts:43` re-exports
  them so there is one copy of the numbers.
- `isExcludedFromSnapshot(relPath, size?)` (`:19`) — any dot-prefixed segment
  (`.git`, `.gm-forge`, `.gamemaker-mcp`, our own `.name.tmp-<uuid>`),
  `node_modules`/`dist`, or a file over the per-file cap.
- `exceedsSnapshotLimits` (`:28`), `snapshotLimitDetail` (`:38`) — the message
  the hook and `create_snapshot` both quote.
- `SnapshotTooLargeError` (`:48`) — thrown by an explicit snapshot, caught and
  downgraded to a warning by the automatic path.
- `sha256File(file)` (`:60`) — streaming digest.
- `describeLockedFile(dest, e, action = "replace")` (`:74`) — one EPERM/EACCES
  message for every replace in the tree; returns `null` for other errors so
  callers rethrow the original. Exported for `sprite_frames.ts`, which passes
  `action = "create"`.
- `atomicReplaceWith(dest, writeTemp)` (`:90`) — the primitive: temp file
  `.<basename>.tmp-<uuid>` **in the target's own directory** (`:94`, same volume,
  matches `.gitignore`'s `.*.tmp-*`), `writeTemp` produces the bytes, rename
  replaces `dest`, temp is removed on every failure path (`:99`).
- `atomicWriteFile(dest, string | Buffer)` (`:104`), `atomicWriteJson` (`:116`),
  `atomicCopyFile(source, dest)` (`:122`) — thin wrappers.

## Invariants

- A target is only ever replaced by a rename; it is never truncated in place.
  This is what makes hard-link snapshot dedupe safe — see `snapshots.md`.
- `writeTemp` is a callback because `@bscotch/yy` produces the `.yyp` bytes by
  reconciling key order against the existing file and cannot be expressed as a
  string (`:85-89`).

## Dependencies

- In: Node `fs`/`crypto`/`path` only.
- Out: `write.ts`, `snapshot.ts`, `yyp.ts`, `sprite_frames.ts`, `sounds.ts`,
  `sprites.ts`, and every resource writer that touches a project file.
