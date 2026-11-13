# auto-snapshot

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The single cross-cutting backup wrapper. Every MCP tool call passes through
`callTool` → `withProjectLock` → `withAutoSnapshot` → `dispatchTool`, so no
handler body contains snapshot code. It owns *when* a backup is taken and *how
its outcome is reported*; the store itself is `snapshots.md`.

## Key Paths

- `src/gm/write.ts` — `AUTO_SNAPSHOT_TOOLS`, `writeWithSnapshot`,
  `withAutoSnapshot`, `appendWarnings`.

## Membership rule (`:41-77`)

A tool is on the hook iff the call can overwrite or remove content **already in
a project file** (`.yy`, `.gml`, `.vsh`/`.fsh`, the `.yyp`), as opposed to only
appending a brand-new resource. 26 members: every `edit_*`; `rename_resource` /
`delete_resource`; the room layer/tile writers; `add_room_layer`,
`add_room_instance`, `add_object_event`; the five sprite-frame writers;
`add_included_file` / `remove_included_file` (they rewrite the `.yyp`);
`reorder_room` / `move_room_relative` (they rewrite `RoomOrderNodes`).

The spec's table also listed a `remove_resource` tool; no such tool exists —
deleting a resource is `delete_resource`, which is on the list (`write.ts:39-40`).

## Deliberate asymmetry: self-snapshotting tools stay off the hook

`patch_file` (`files.ts:284`), `set_project_option` (`options.ts:535`) and
`set_macro` (`macros.ts`, via `writeWithSnapshot`) call `writeWithSnapshot`
themselves because they must report `snapshotId` / `snapshotSkippedReason` for
their own write. Listing them on the hook would take a second project copy per
call and burn two of the 20 retention slots (`:33-40`). The comment at `:73-74`
also records why `reorder_room`'s no-op discard matters: an unchanged order
retains no backup.

## `withAutoSnapshot` flow (`:266-344`)

1. Not a member → `fn()`.
2. Registered schema rejects the args → `fn()` (dispatch throws its own error; a
   full project copy retained as `failed: true` per typo would let 20 typos prune
   the undo points).
3. `prevalidate(args)` returns a message → `fn()`. The disk-free checks in
   `index.ts:224-243` (negative/non-integer frame index, repeated `order` entry,
   inverted `trim` range) are the same case.
4. `skipSnapshot: true` → run and append the `⚠ snapshot skipped on request`
   warning.
5. `projectDir` missing/not a directory, or holding ≠ 1 `.yyp` → `fn()`.
6. `createSnapshot(..., onOverThreshold: "skip")` inside the project lock.
7. Handler throws → `failed: true` is recorded on the manifest, error rethrown
   untouched.
8. Otherwise diff against the snapshot with
   `rehashSinceMs = createdAt - 2000 ms`; no files changed → discard the snapshot
   (digest-verified, never size+mtime alone); else record `touched`.

## `writeWithSnapshot` flow (`:134-190`)

Refuses `.gm-forge/**` (`:149`), lexically **and** by realpath refuses a target
whose parent resolves outside the project (`assertInsideProject`, `:106-126`),
then: `skipSnapshot` → write, no backup; excluded path → write with a reason;
snapshot first, then write — a failed backup aborts the write, a failed write
leaves the backup behind.

## Response convention

Warnings are a **second content part** `⚠ …` (`appendWarnings`, `:206-213`), never
merged into `content[0]`: four wrapped tools return pure JSON there, and a
snapshot line appended to `content[0]` would change nine tools' contracts.

## Dependencies

- In: `atomic.ts`, `snapshot.ts`.
- Out: `index.ts` (`callTool`), `files.ts`, `options.ts`, `macros.ts`.
