# Spec E — Safety foundation

Status: shipped (wave 2 integrated; corrections recorded in "Shipped (wave 2)" at the end) · Scope: subproject E · Repo: `gm-forge-mcp`

## Goal

Subproject A closed the authoring gaps; it did not make writing safe. Today the
server can destroy work it cannot get back:

1. **Writes are not atomic, except two.** Only `writeYyp` (`src/gm/yyp.ts:208-223`)
   and `writeRoomYy` (`src/gm/room_layers.ts:47-70`) write a temp file and
   `fs.rename` over the target. The other 32 call sites across 15 modules call
   `fs.writeFile` straight onto the real path (34 matches, 2 of which are the
   temp half of an atomic write), so a crash, a full disk or a killed process
   truncates the file in place.
2. **There is no backup, snapshot, transaction or undo anywhere.** `rename_resource`
   (`src/gm/rename.ts:172,194,201-215`) is the only code with anything like
   rollback, and it is best-effort, in-memory, and scoped to a single call.
3. **A previous third-party MCP left `.gamemaker-mcp/` backup trees inside user
   projects.** `src/gm/references.ts:15` documents why that is toxic (rename and
   delete recursively rewrite the copies), and `find_references` now skips dotted
   directories — our patch, and the only existing precedent for how tool state
   inside a project must behave.
4. **GML source cannot be read or edited at all.** No `read_file`, no
   `patch_file`, no event-code editor: object event code is written once, at
   creation time, by `add_object_event` (`src/gm/objects.ts:185-209`). Any real
   fix to a `.gml` file has to go through an editor outside the server.

Deliver eight new MCP tools plus one cross-cutting auto-snapshot hook so that
every destructive operation is reversible, every project file is readable, and
every write lands atomically or not at all.

## Non-goals

- No git integration (no staging, no commits, no `git checkout` of project
  files); snapshots are plain files and git is left entirely alone.
- No cross-project snapshots, no remote/off-machine storage, no compression
  archive format.
- No diff viewer, no merge, no three-way reconcile.
- No file watching or live sync — `list_changes` is a pull, not a subscription.
- No regex patching, no fuzzy matching, no AST rewriting. `patch_file` is
  literal string replacement or nothing.
- No writing files outside the project directory, ever — not even temp files.
- No undo for GameMaker-internal state (open editor tabs, undo history inside
  the IDE, compile caches, `.gitignore` edits, user `.yy` diffs made by hand).
- No change to any existing tool's arguments, output or error text beyond the
  optional `skipSnapshot` flag and the appended snapshot warning.

## Format facts (verified, do not re-derive)

- `src/index.ts` is still the sole registry: zod schemas, `TOOL_DEFS`, the
  `dispatchTool` switch, and the catch that renders `Error: <msg>`. It opens a
  stdio transport only when it is the entry point, so the suite imports it and
  asserts the real schemas and tool list.
- Exactly **53 tools** are registered (`test/verify.ts:1956-1960` pins the count
  in three places: `TOOL_DEFS.length`, the text-declared entries, and the
  uncommented `case` labels).
- `withProjectLock` lives in `src/gm/yyp.ts:59-65` (an in-process promise queue
  keyed by lowercased `path.resolve(projectDir)` on win32). The single call site
  that wraps every dispatch is `src/index.ts:1026`:
  `withProjectLock(projectDir, () => dispatchTool(name, args))`. That one line is
  the only place a cross-cutting wrapper can be installed.
- Handlers throw; the central catch renders `Error: <msg>`. Therefore any
  warning a tool wants to surface must be appended to its normal success text,
  not thrown.
- Atomic writes: `writeYyp` (`src/gm/yyp.ts:208-223`, temp name
  `.<name>.tmp-<uuid>`) and `writeRoomYy` (`src/gm/room_layers.ts:47-70`, same
  pattern, plus the EPERM/EACCES message that names the IDE holding the file —
  `src/gm/room_layers.ts:59-64`). The repo `.gitignore` carries `.*.tmp-*` so an
  interrupted write is not untracked noise.
- `.yyp` goes through `@bscotch/yy`; `.yy` through `parseGameMakerJson` +
  `JSON.stringify(v, null, 2)`. Both patterns must be preserved: a snapshot is a
  byte copy, never a re-serialise.
- Tests are one hand-rolled script, `test/verify.ts`, run by `tsx`, with `ok()`,
  `expectThrows()` and `keysMatchRef()`. 415 assertions today, append-only
  convention; `test/_wip_*.ts` files are throwaway and must not survive a wave.
- `tsconfig.json` is `strict: true`; no ESLint; no test framework, so there is no
  mocking library and no `afterEach` — every test must clean up after itself.

## Store layout

Everything the server owns lives in one dotted directory inside the project:

```
<project>/.gm-forge/
  backups/
    20261113-142501-a3f9c1/
      manifest.json
      files/                    # mirror of project-relative paths
        objects/obj_player/obj_player.yy
        rooms/rm_lv1/rm_lv1.yy
  lock                          # present only while a restore is running
  journal.jsonl                 # append-only audit log, one JSON object per line
```

`manifest.json`:

```json
{ "id": "20261113-142501-a3f9c1",
  "schema": 1,
  "createdAt": "2026-11-13T14:25:01.412Z",
  "tool": "remove_resource",
  "reason": "auto: remove_resource object obj_enemy",
  "projectName": "261103GJ",
  "previous": "20261113-141033-77bd20",
  "files": [{ "path": "rooms/rm_lv1/rm_lv1.yy", "size": 18422,
              "sha256": "…", "mtimeMs": 1763043901123, "stored": "link" }],
  "touched": ["rooms/rm_lv1/rm_lv1.yy"],
  "skipped": [{ "path": "sprites/spr_boss/tex.png", "reason": "size" }],
  "fileCount": 412, "totalBytes": 18344021,
  "failed": false, "undoneAt": null }
```

- **`files`** is everything that was backed up. **`touched`** is the subset the
  operation was allowed to change; `undo_last` restores `touched`, never `files`.
- **`stored`** is `"link"` when the entry hard-links the previous snapshot's copy
  and `"copy"` when it is a fresh copy. The manifest carries the snapshot-wide
  `dedupe: "link" | "copy"` as well (shipped: `"link"`).
- **`previous`** chains snapshots for dedupe and for retention decisions.
- Snapshot ids: `<YYYYMMDD>-<HHmmss>-<6 hex>`, local time, with the random
  suffix so two calls in the same second cannot collide. Ids are validated
  against `/^\d{8}-\d{6}-[a-f0-9]{6}$/` and resolved by `path.join` inside
  `backups/` — never by string interpolation into a glob.
- Snapshots are immutable. Nothing ever writes into an existing snapshot
  directory. That is what makes hard-link dedupe safe: every write replaces the
  inode (`writeFile(temp)` + `rename`) instead of truncating the shared one, so
  a link can never observe a mutation. Shipped state: every project-file write
  goes through that path (`atomicWriteFile`, `atomicCopyFile`,
  `atomicReplaceWith`), so `DEDUPE_MODE = "link"`; a regression test writes
  atomically over a linked file and restores it to prove the copy survived.

## Tool contracts

Common shape: `projectDir` is the first argument, names are `snake_case`, each
schema is `ProjectSchema.extend({...})`. None of the eight takes a path outside
the project; all of them resolve paths through one helper, `resolveInProject`
below.

### 1. `create_snapshot`

```ts
{ reason?: string }   // ≤ 500 chars, free text, never interpreted
```

→ `{ snapshotId, path, fileCount, totalBytes, copied, linked, skipped, pruned }`

- Writes a full project snapshot under
  `<project>/.gm-forge/backups/<timestamp>-<shortid>/`.
- **Incremental by content hash.** Walk the project once, hash each included file
  (`sha256`), and for every file whose hash matches the same path in the
  `previous` snapshot, hard-link that snapshot's copy (`fs.link`) instead of
  copying bytes. Fall back to a copy on `EPERM`, `EXDEV`, `EMLINK` (different
  volume, exFAT/FAT32, antivirus) — never fail a snapshot because linking is
  unavailable.
- **Excluded** (documented, asserted by a test): any directory whose name starts
  with `.` (`.git`, `.gm-forge` itself, `.gamemaker-mcp`, `.opencode`) and
  `node_modules`, `dist`; any file matching `.*.tmp-*`; any file larger than
  `SNAPSHOT_MAX_FILE_BYTES` (these are listed under `skipped` with
  `reason: "size"`, so the user can see what a restore would not bring back).
- **Retention:** keep the newest `SNAPSHOT_KEEP = 20` snapshots, prune older
  ones after the new one is written and its manifest flushed. Never prune the
  snapshot just written, **and never prune the snapshot `undo_last` would
  currently pick** (shipped: `previous` is *not* protected — see "Shipped
  (wave 2)", because protecting the chain stalls retention). Pruned ids are
  returned in `pruned`.
- **Cost bound:** a snapshot performs exactly one tree walk (`readdir` + `stat`,
  no reads) plus reads of files whose hash is not already known. It must not
  read a file twice. With link mode on a 4,000-file project the walk dominates
  and the byte cost is the changed files only.
- **Over threshold:** if the included file count or total exceeds
  `SNAPSHOT_MAX_FILES = 20_000` / `SNAPSHOT_MAX_BYTES = 512 MiB`, an explicit
  `create_snapshot` call **throws** with both numbers and both limits in the
  message. It does not silently produce a partial backup.
- Refuses when `.gm-forge/lock` exists (a restore is in progress).

### 2. `list_snapshots`

```ts
{}
```

→ `{ snapshots: [{ snapshotId, createdAt, tool, reason, fileCount, totalBytes,
     failed, undoneAt }], totalBytes, keep: 20 }`, newest first.

- Reads manifests only — no tree walk, no hashing. A corrupt manifest is
  reported inline as `{ snapshotId, corrupt: true, error }` rather than failing
  the whole listing.
- `totalBytes` is the sum of `totalBytes` across manifests and is labelled as
  logical size, since linked snapshots share bytes on disk.

### 3. `restore_snapshot`

```ts
{ snapshotId: string, files?: string[] }
```

→ `{ snapshotId, restored: string[], missingFromSnapshot: string[],
     removed: string[], bytes, lockCleared: true }`

- No `files` = restore the whole snapshot: every entry under `files` is copied
  back over the project path, and every project file recorded in the manifest
  but absent from `files` (i.e. changed to nothing?) is left alone — a restore
  is not a mirror, it never deletes a file the snapshot does not mention.
- With `files`, each entry must appear in the manifest; unknown entries are an
  error listing them all at once (no partial restore). Paths are validated by
  `resolveInProject` against the manifest entry, not by trusting the string.
- **Refuses while `<project>/.gm-forge/lock` exists.** The error names the file,
  its age and pid, and says to delete it only if no other server instance is
  running. It never auto-deletes a lock.
- On success it creates the lock (pid + `startedAt`), restores each file with
  `atomicWriteFile` (temp in the target's own directory + rename, never
  `fs.writeFile` onto the target), and removes the lock in `finally`.
- **GameMaker must be closed.** Both the precheck and the EPERM/EACCES branch
  say so, reusing the `writeRoomYy` wording
  (`src/gm/room_layers.ts:59-64`): the IDE holds `.yy` files open on Windows and
  will happily save over a restore it never noticed.
- Appends one line to `.gm-forge/journal.jsonl`; a journal write failure is
  swallowed (the journal is an audit aid, never a correctness dependency).
- Does not create a snapshot of the pre-restore state: the snapshot being
  restored *is* the pre-restore state at the granularity anyone asked for. A
  user who wants a redo point must call `create_snapshot` first — documented in
  the tool description.

### 4. `delete_snapshot`

```ts
{ snapshotId: string }
```

→ `{ snapshotId, deleted: true, freedBytes }` (logical bytes; linked bytes may
not be freed).

- Refuses the snapshot that `undo_last` would currently pick, unless the caller
  passes nothing else — no force flag exists. The error says to create a newer
  snapshot first. Refuses while a restore holds the lock. Refuses `..`, ids of
  the wrong shape, and any id that does not resolve inside `backups/`.
- Deletion is `fs.rm(dir, { recursive: true, force: false })` on the snapshot
  directory only; a hard link count dropping to zero is the only side effect on
  other snapshots.

### 5. `read_file`

```ts
{ path: string, offset?: number, limit?: number }
```

→ `{ path, totalLines, from, to, truncated, bytes, text }`

- `path` is **project-relative** (`.yy`, `.yyp`, `.gml`, `.json`, `.txt`, anything
  text). Absolute paths and drive letters are rejected outright, as is a leading
  separator.
- **Containment is realpath-based, not string-based.** Resolve
  `path.resolve(projectRoot, requested)`, then `fs.realpath` it, then
  `fs.realpath` the project root, and require the target to equal the root or
  start with `root + path.sep` (case-insensitively on win32). `..` stripping is
  not used and must not be added: a symlink *inside* the project that points
  outside it passes every lexical check and fails this one. The same helper,
  `resolveInProject`, is used by `patch_file`, `restore_snapshot` and the
  snapshot walk.
- Refuses a path that does not exist (`ENOENT` → "no such file in project",
  naming the resolved absolute path), a directory, and a binary file. Binary
  detection: read the first 8 KiB and reject on any NUL byte, reporting the
  offset. UTF-16 files therefore fail loudly rather than rendering as garbage;
  the message says so.
- Size cap: `READ_MAX_BYTES = 2 MiB`. Over it, the error reports the size and
  tells the caller to use `offset`/`limit`. (`offset`/`limit` page *lines*, not
  bytes, so they are not a workaround for the cap — the cap is on the file.)
- `offset` is 1-based, defaults to 1; `limit` defaults to `2000`, capped at
  `5000`. `text` returns each line prefixed with its 1-based number and `": "`
  (`12: var hp = 3;`), newline-joined, with `truncated: true` when `to <
  totalLines`. Numbering is part of the contract so a model can name a line in a
  follow-up; callers that want raw bytes strip `/^\d+: /`.
- Reads inside `.gm-forge/` are allowed (manifests are useful for debugging);
  writes there are refused (see `patch_file`).

### 6. `patch_file`

```ts
{ path: string, find: string, replace: string, count?: "exact" | "all" }
```

→ `{ path, replacements, linesChanged, snapshotId }`

- **Exact-string replacement. No regex, ever** — `find` is passed to
  `indexOf`, not to `new RegExp`. A `find` containing regex metacharacters is
  matched literally; a test asserts `"."` does not match every character.
- `count` defaults to `"exact"`: the call succeeds only when `find` occurs
  **exactly once**. Zero matches → error. More than one → error listing the
  match count and up to 20 of the 1-based line numbers, plus `and N more`. Both
  errors are pre-write: nothing is touched.
- `count: "all"` replaces every non-overlapping occurrence, still errors on
  zero, and reports the total.
- `find` must be non-empty; `replace` may be empty (deletion). Both must be
  valid UTF-8 and must not contain a lone NUL.
- EOL: detect the file's dominant style from its first newline; any `\n` in
  `replace` is normalised to it. A UTF-8 BOM, if present, is preserved. The
  trailing-newline state is preserved.
- Size cap `PATCH_MAX_BYTES = 2 MiB` (same reason as `read_file`), and
  `resolveInProject` containment applies — including the symlink case.
- Refuses paths inside `.gm-forge/` (writing into the store would corrupt
  snapshots) and refuses a directory.
- **Creates a snapshot first**, unconditionally, via `writeWithSnapshot`
  (reason `patch_file: <path>`), before the temp file is even created. If the
  snapshot fails, the patch does not happen. `skipSnapshot: true` is honoured
  here too.
- Writes with `atomicWriteFile`, and reuses the `writeRoomYy` EPERM/EACCES text
  when the IDE holds the file open (`src/gm/room_layers.ts:59-64`) — patch the
  same wording rather than inventing a second message for the same failure.
- `linesChanged` counts distinct lines whose content changed (the line numbers
  touched by every applied replacement, deduplicated), not the byte or
  character delta.
- `.yy`/`.yyp` are legal targets — this is the deliberate escape hatch for a
  field no tool exposes. The tool does not validate JSON afterwards and says so
  in its description; `lint_project` is the way to check the result.

### 7. `list_changes`

```ts
{}
```

→ `{ snapshotId: string | null, createdAt, files: [{ path, status, sizeDelta? }],
     unchangedCount, untrackedCount }`

- Compares the project tree (same walk and exclusions as `create_snapshot`)
  against the newest snapshot's manifest: `status` is `"modified"` (hash
  differs), `"added"` (not in the manifest), or `"deleted"` (in the manifest,
  absent on disk).
- Fast path: if `size` and `mtimeMs` both match the manifest entry, the file is
  unchanged and is not read. Anything else is hashed; the hash, not the mtime,
  decides. (Rationale: antivirus and IDE saves churn mtimes; a false
  "modified" would be noise, a false "unchanged" would be a lie.)
- `untrackedCount` counts files the next snapshot would skip for size — visible
  so a user is not surprised that a huge file is not covered.
- No snapshots → `{ snapshotId: null, files: [] }`, not an error.
- Read-only: takes no lock past the normal dispatch one, writes nothing.

### 8. `undo_last`

```ts
{}
```

→ `{ snapshotId, restored: string[], removed: string[], undoneAt }`

- Restores the `touched` files of the most recent snapshot whose `touched` is
  non-empty and whose `undoneAt` is `null`. Walks back through snapshots in
  `createdAt` order, so calling it repeatedly peels one operation at a time.
- A file the operation *created* (present in `touched`, absent from `files`) is
  deleted on undo, not restored to emptiness. That deletion is listed in
  `removed`.
- Sets `undoneAt` in the manifest (a manifest rewrite, done atomically; the
  `files/` tree is never touched). So `undo_last` is idempotent per snapshot: a
  second call moves to the previous snapshot instead of replaying the first.
- Takes the lock for its duration, for the same reason `restore_snapshot` does,
  and refuses while the lock is held.
- Creates no snapshot (it has the data it needs) and holds up `delete_snapshot`
  only in the sense that the newest non-undone snapshot is protected.
- Nothing to undo → `Error: nothing to undo in <project> -- no snapshot records
  touched files`. Not a silent success.

## Cross-cutting: the auto-snapshot hook

### Where the hook lives

One wrapper, one call site. `withAutoSnapshot(name, projectDir, args, fn)` in
`src/gm/write.ts`, installed at `src/index.ts:1026`:

```ts
withProjectLock(projectDir, () => withAutoSnapshot(name, projectDir, args, () => dispatchTool(name, args)))
```

No tool handler contains snapshot code. `projectDir` is taken from the already
validated `args` before dispatch; if it is missing or not a string, the wrapper
is a pass-through (the handler will throw its own schema error). Every snapshot
therefore happens **inside** the project lock, so it cannot interleave with
another write, and **after** schema validation, so a typo'd directory never
creates a store.

### Which tools snapshot

| Tool | Snapshot | Opt-out |
|------|----------|---------|
| `rename_resource` | auto | `skipSnapshot` |
| `delete_resource` | auto | `skipSnapshot` |
| `remove_room_layer` | auto | `skipSnapshot` |
| `set_room_tiles` | auto | `skipSnapshot` |
| `fill_room_tiles` | auto | `skipSnapshot` |
| `edit_object` | auto | `skipSnapshot` |
| `edit_room` | auto | `skipSnapshot` |
| `edit_script` | auto | `skipSnapshot` |
| `edit_sprite` | auto | `skipSnapshot` |
| `edit_shader` | auto | `skipSnapshot` |
| `edit_sound` | auto | `skipSnapshot` |
| `edit_font` | auto | `skipSnapshot` |
| `edit_tileset` | auto | `skipSnapshot` |
| `set_room_layer` | auto | `skipSnapshot` |
| `add_room_layer` | auto | `skipSnapshot` |
| `add_room_instance` | auto | `skipSnapshot` |
| `add_object_event` | auto | `skipSnapshot` |
| `patch_file` | self-managed (inside the handler, via `writeWithSnapshot`) | `skipSnapshot` |
| every other tool, including `create_project`, the remaining `add_*` creators, `reorder_room`, `move_room_relative`, `create_snapshot`, `list_snapshots`, `restore_snapshot`, `delete_snapshot`, `list_changes`, `undo_last`, `read_file` | none | n/a |

- The seventeen wrapper-driven tools are declared in one exported
  `AUTO_SNAPSHOT_TOOLS: ReadonlySet<string>` in `src/gm/write.ts` — the list is
  data, not seventeen `if` statements. The rule for membership: the call can
  overwrite or remove content that already exists in a resource file. Pure
  creators (`add_script`, `add_object`, `add_sprite_from_images`, `add_room`,
  `add_note`, …) only append a new resource to the catalog, and
  `reorder_room`/`move_room_relative` only permute `RoomOrderNodes`.
  (`remove_resource` was listed in the first draft of this table but no such tool
  is registered; `delete_resource` is the delete tool and it is a member.)
- `skipSnapshot?: boolean` is added to exactly those seventeen schemas plus
  `patch_file`. When set, the response gains a second content part reading
  `⚠ snapshot skipped on request` and the write proceeds; this is the only
  supported way to write without a backup, and it exists for CI and for users on
  a slow disk.
- `patch_file` and `undo_last` are **not** in `AUTO_SNAPSHOT_TOOLS`, so
  double-snapshotting is impossible by construction.

### What the wrapper does

1. If `name` is not in `AUTO_SNAPSHOT_TOOLS`, call `fn()` unchanged.
2. If the call does not parse against the tool's own registered schema
   (`TOOL_DEFS.find(d => d.name === name)?.schema`, passed in by the one call
   site so `write.ts` never imports `index.ts`), call `fn()` — dispatch throws
   the caller's original schema error and no project copy is spent.
3. If `args.skipSnapshot === true`, call `fn()` and add the opt-out warning.
4. If `projectDir` holds no `.yyp` of its own, call `fn()` — there is nothing to
   back up and the handler's own "No .yyp found" error is preserved.
5. Otherwise `createSnapshot(projectDir, { tool: name, reason:
   "auto: " + name })`.
6. Call `fn()`.
7. After success, compute `touched` by diffing the project against the snapshot
   just written (one walk, `size`+`mtimeMs` fast path, and every file modified
   from two seconds before the snapshot onward re-hashed so a coarse-timestamp
   filesystem cannot hide a same-size write) and write it into the manifest.
8. If the diff is empty (verified by digest), delete the snapshot just created —
   a no-op must not cost a snapshot ("the no snapshot needed" case in
   acceptance).
9. If `fn()` threw, keep the snapshot, set `failed: true`, and rethrow the
   original error untouched — a failed operation is exactly when the user wants
   the backup.
10. Warnings from step 5 (threshold skip, the one-time `.gitignore` notice) are
    added as a **second content part** reading `⚠ <msg>`. The central catch
    renders only the error, so a warning can never ride on a failure. content[0]
    is left byte-identical — four wrapped tools return pure JSON there. The
    `snapshotId` itself is **not** added to the response: that would change the
    output of seventeen existing tools, which their contracts forbid.
    `list_snapshots` is how a caller sees it.

### Cost bound (contractual)

- A snapshot must never copy or read:
  - anything under `.git`, `node_modules`, `dist` or any dotted directory
    (`.gm-forge` included, which is also the recursion guard),
  - any `*.tmp-*` file,
  - any file over `SNAPSHOT_MAX_FILE_BYTES = 8 MiB` (listed in `skipped`).
- Byte cost per snapshot: the changed files only (link mode) or the whole tree
  (copy mode). Walk cost: one `readdir`/`stat` pass. Budget: < 250 ms on a
  4,000-file project in link mode; the test asserts call count, not wall time,
  so CI cannot flake.
- When the included set exceeds `SNAPSHOT_MAX_FILES = 20_000` or
  `SNAPSHOT_MAX_BYTES = 512 MiB`, the auto path **skips** the snapshot and
  appends:

  `⚠ snapshot skipped: project has 31,204 files / 780 MB, over the 20,000-file / 512 MB limit. The write proceeded without a backup.`

  The write still happens — blocking would break every existing tool contract
  on a big project. An explicit `create_snapshot` on the same project throws
  instead (contract 1), because the caller asked for a backup and would
  otherwise believe they had one.
- A snapshot that fails for any other reason (ENOSPC, EACCES, read error) is
  **fatal**: the write is aborted with the underlying error. `skipSnapshot` is
  the documented escape hatch, so "backup failed, wrote anyway" is never a
  silent mode.

### `.gm-forge/` in the user's repo

- The store is created lazily on the first snapshot, never at server start.
- It is **not** added to the user's `.gitignore` automatically. Instead, the
  first time the store is created inside a directory that contains `.git`, the
  tool output gains a one-time notice naming the path and the line to add. A
  server that edits a file nobody asked it to edit is the thing this subproject
  exists to stop.
- `src/gm/references.ts`'s dotted-directory skip already keeps `.gm-forge` out
  of `find_references`, `rename_resource` and `delete_resource`. A regression
  test pins that: a snapshot must not inflate a reference count.
- This repo's own `.gitignore` gains `.gm-forge/` (it is only ever created in
  scratch projects during tests, but a stray run must not be committable).

## Acceptance criteria

- `npm run typecheck` clean.
- `npm test` passes with the 415 pre-existing assertions untouched. The only
  permitted edit inside an existing assertion is the literal tool count
  `53 → 61` at `test/verify.ts:1956,1958,1960`; everything else is appended.
- New coverage, all appended to `test/verify.ts`:
  - every new write path, including the "no snapshot needed" case (a no-op
    `set_room_layer` leaves `list_snapshots` unchanged and reports
    `snapshotId: null`);
  - a snapshot is created automatically for each of the ten wrapper-driven
    tools, asserted through `list_snapshots`;
  - `read_file` and `patch_file` cannot escape the project: `..` traversal,
    absolute path, drive-letter path, and a **symlink inside the project
    pointing outside it** — all four refused, with the resolved real path in the
    error;
  - `restore_snapshot` round-trips a mutated `.yy`: snapshot, mutate a layer
    depth, restore, assert byte equality with the pre-mutation file;
  - `undo_last` removes a file the operation created and restores one it
    edited, then reports "nothing to undo" on a third call;
  - `patch_file` with 0 or 2 matches fails before writing, and the file is byte
    identical afterwards; `count: "all"` replaces both;
  - an interrupted write cannot leave a truncated file: force the temp→final
    `rename` to fail (target path replaced by a directory) and assert the
    original bytes survive and no `*.tmp-*` file remains;
  - snapshot exclusions: `.git`, `node_modules`, `dist`, `.gm-forge`, `*.tmp-*`
    and an 9 MiB file are all absent from `files` and the last is in `skipped`;
  - retention: 21 snapshots leaves 20, and the pruned id is reported.
- README tool table updated: a **Safety** section listing all eight tools, and
  the count moves from 53 to 61.
- `lint_project` (ProjectTool) runs against a scratch project **after** a
  restore and reports no errors — proof that a restored project is still a valid
  GameMaker project, not just a byte-identical one.
- All tests run in a scratch project under the OS temp dir. Nothing in the suite
  writes to `E:\GMprojects\261103GJ`.
- Restores are atomic per file and idempotent; no restore path uses
  `fs.writeFile` on the target.

## Risks

- **Snapshot cost on a large project.** A 30,000-file project hits the
  threshold and every destructive tool starts printing a skip warning. That is
  the intended trade (visible honesty over a 40-second stall inside the project
  lock), but the threshold numbers are the ones users will argue about; they are
  exported constants, not magic numbers, and the warning quotes them.
- **`.gm-forge/` polluting the user's repo.** Mitigated by the dotted-directory
  skip in `references.ts`, a `.gitignore` notice instead of an edit, and
  `.*.tmp-*` already being ignored. A user who commits `.gm-forge/` will get
  large commits — the notice is the only defence, and it is one-shot.
- **Restore racing the IDE.** GameMaker holds `.yy` files open on Windows and
  saves them from its own in-memory copy. A restore that succeeds while the IDE
  is open is lost on the next save, silently. The lock file, the EPERM/EACCES
  text and the description all say "close GameMaker" in the error itself, not
  only in the docs.
- **`patch_file` on a file the IDE has open.** Windows returns EPERM on the
  rename; the `writeRoomYy` message pattern (`src/gm/room_layers.ts:59-64`)
  already names the cause and the fix, so reuse it verbatim rather than writing
  a second, subtly different message.
- **Hard-link dedupe is only safe while snapshots are immutable and every write
  replaces the inode.** One stray `fs.writeFile` onto a snapshotted path
  silently rewrites history in every snapshot that links it. Wave 1's write-path
  migration is therefore a prerequisite, `DEDUPE_MODE` starts at `"copy"`, and
  wave 3 verifies that no plain `fs.writeFile` remains on a path the snapshot
  walk can include.
- **Restore is not a mirror.** Deleting a file in the IDE and restoring an older
  snapshot does not resurrect it unless that snapshot's `files/` holds it —
  which it does, since `files` is a full copy set. But a file created *after*
  the snapshot and then restored-over is left in place; users may expect
  rollback semantics. The contract says "restore the recorded files", and
  `list_changes` is how you see the rest.
- **Three pinned tool-count assertions must change** (`53 → 61`). That is the
  one edit to existing test text; if a reviewer sees it and calls it a
  violation, the spec is the appeal.
- **`withProjectLock` is per-process.** Two MCP client instances on one project
  still race; the lock file only guards restores. Cross-process locking is out
  of scope and stated as such.

## Shipped (wave 2)

Wave 1 built `atomic.ts`, `snapshot.ts`, `files.ts` and `write.ts` unregistered;
wave 2 registered the eight tools, installed the hook at the one call site,
finished the atomic-write migration, and shipped the regression block. Where the
implementation and the draft above disagreed, this is what actually shipped and
why.

### Retention: 21 snapshots leave 20, and `previous` is not protected

The draft said "never prune a snapshot referenced as `previous` by a surviving
snapshot". That rule cannot coexist with `SNAPSHOT_KEEP = 20`: every surviving
snapshot references its predecessor, so the predecessor of the oldest survivor
is always `previous` of something and retention stalls at 21 forever. The
acceptance criterion — "retention: 21 snapshots leaves 20" — is the real
contract, so `pruneSnapshots` (`src/gm/snapshot.ts`) protects only:

- the snapshot just written,
- the snapshot `undo_last` would currently pick (`findUndoTarget`), and
- ~~any snapshot whose manifest carries `undoHold`~~ — **removed 2026-11-13
  (subproject D fix pass):** `undoHold` was parsed and honoured but never
  written by any code path, so it was a dead manifest field. The field and both
  branches are gone; the two protections above are what actually hold.

**Caveat, stated plainly:** those exceptions mean "20" is the normal case, not a
hard ceiling. If the undo target sits in the prunable slice (the oldest 21st), it
is protected and that run leaves **21** directories behind — one extra snapshot
is the price of never deleting the undo point a user is about to need.
`pruned` reports exactly what retention did remove, so the count is observable
rather than implied.

Deleting an old snapshot directory only decrements hard-link counts; a surviving
snapshot keeps its own inode and loses no bytes, which is what makes the
`previous` exemption safe now that link mode is on.

### Skip vs throw, decided twice on purpose

- `create_snapshot` (explicit) throws `SnapshotTooLargeError` naming the
  project's real file/byte counts and both limits.
- The auto path (`withAutoSnapshot`) passes `onOverThreshold: "skip"`, runs the
  handler anyway, and appends
  `⚠ snapshot skipped: project has … files / … , over the … limit. The write
  proceeded without a backup.` The write is never blocked by project size; the
  tool says plainly that it has no backup.
- Any *other* snapshot failure (ENOSPC, EACCES, a read error) is fatal and
  aborts the write. `skipSnapshot: true` is the documented escape hatch.

### The auto-snapshot hook

`withAutoSnapshot(name, projectDir, args, fn, schema?)` in `src/gm/write.ts`,
installed at the single dispatch site (`callTool` in `src/index.ts`, which the
`CallToolRequestSchema` handler delegates to). `schema` is
`TOOL_DEFS.find(d => d.name === name)?.schema`, passed in by that one caller
because `write.ts → index.ts` would be an import cycle. Nothing else in the tree
takes a snapshot.

**Member list (`AUTO_SNAPSHOT_TOOLS`), as shipped: 17 entries** — chosen by one
rule: the call can overwrite or remove content that already exists in a resource
file. `rename_resource`, `delete_resource`, `remove_room_layer`,
`set_room_tiles`, `fill_room_tiles`, `edit_object`, `edit_room`, `edit_script`,
`edit_sprite`, `edit_shader`, `edit_sound`, `edit_font`, `edit_tileset`,
`set_room_layer`, `add_room_layer`, `add_room_instance`, `add_object_event`.
`patch_file` snapshots itself through `writeWithSnapshot` and `undo_last` needs
no backup, so both are excluded and double snapshots are impossible by
construction. Excluded because they only append a brand-new resource (or a
group) to the catalog and remove nothing the user had: `create_project`,
`add_script`, `add_object`, `add_sprite_from_images`, `add_shader`, `add_sound`,
`add_font`, `add_note`, `add_tileset`, `add_extension`, `add_particle_system`,
`add_anim_curve`, `add_room`, `add_texture_group`, `add_audio_group`.
`reorder_room`/`move_room_relative` only permute `RoomOrderNodes` and touch no
resource content. `remove_resource` was dropped from the draft's table because no
such tool exists.

Behaviour worth pinning, all covered by `test/verify.ts`:

- the snapshot is taken **inside** the project lock, **before** the handler;
- a call that fails the tool's own schema is dispatched immediately with **no**
  snapshot: it cannot write, and a full project copy retained as `failed: true`
  per typo would let 20 typos prune the user's real undo points;
- a `projectDir` that is not a GameMaker project (no `.yyp` of its own, the same
  rule `loadYyp` uses) is not snapshotted, so the handler's own
  "No .yyp found in …" error is preserved and an unrelated directory is never
  copied;
- a no-op call (a `set_room_layer` that changes nothing) discards the snapshot it
  just took — decided by **digest**, not by size+mtime: any file modified from
  two seconds before the snapshot onward is re-hashed, because a coarse-timestamp
  filesystem can report both size and mtime unchanged for a real write and
  discarding the only backup of a real write is the one failure this feature must
  never make;
- a failed handler keeps its snapshot with `failed: true` and rethrows the
  original error;
- the snapshot id is not appended to the response text (that would change nine
  existing tools' output), and warnings are a **second content part** — appending
  `⚠ …` to `content[0]` would make `add_room_layer`, `remove_room_layer`,
  `set_room_tiles` and `fill_room_tiles` return invalid JSON.

### `DEDUPE_MODE = "link"`

Every project-file write replaces the inode: 33 `fs.writeFile` sites across 14
modules go through `atomicWriteFile`/`atomicWriteJson`, imported assets through
`atomicCopyFile`, the `.yyp` through `atomicReplaceWith` (which owns the temp
name, the rename and the single EPERM/EACCES message — `Yy.write` still produces
the bytes because it reconciles key order against the existing file), and
snapshot restores through the same helper. Only three plain `fs.writeFile` calls
remain and none can reach a walked project path: the temp half of
`atomicWriteFile`, the `wx`-created restore lock, and the store copy under
`.gm-forge/files/`.

Link dedupe is therefore **on**. `createSnapshot` hashes each file (the digest is
what link dedupe compares and what a restore verifies), hard-links the previous
snapshot's copy when the digest matches, and falls back to a per-file copy on
`EPERM`/`EXDEV`/`EMLINK`/`EACCES`. Each manifest records `dedupe: "link" | "copy"`
plus `stored` per entry, so the mode is visible after the fact. The digest is
skipped only in copy mode with no `previous` snapshot (first snapshot of a
project), where nothing compares it; restore then verifies size instead.
`test/verify.ts` pins the invariant: take a snapshot, atomically write over a
file it recorded, and restore it — the pre-write bytes must come back, which a
shared, in-place-written inode could not do.

### Restore is verified, atomic per file, and rolls back

`verifyStoredFiles` checks every digest **before** the first write. A failure
during the writes is caught per file: the files already replaced are re-written
from the bytes saved just before each replacement, and the error says
`Restore failed after N of M files: <path>: <err>` followed by either "Rolled
back the N file(s) already replaced … the project is back to its pre-restore
state" or "Rollback also failed for … The project tree is MIXED". The lock is
released in `finally` either way, and the message never claims a consistency the
tree does not have.

`undo_last` additionally returns `skippedNotRestored`: the snapshot's
`skipped` paths (over the 8 MiB per-file cap, or a symlink) that are absent from
disk after the undo, i.e. files the deleted resource took with it that cannot come
back.

### Verification actually run

- `npx tsc --noEmit` — clean.
- `npx tsx test/verify.ts` — **577 passed, 0 failed, 0 skipped** (415
  pre-existing assertions plus 162 appended). The only edits to pre-existing
  test text are the three tool-count literals `53 → 61`
  (`test/verify.ts:1959,1961,1963`).
- `npm run build` — succeeds; all 61 tool names are present in
  `dist/index.js`, and `node dist/index.js` still prints
  `GameMaker MCP server running on stdio`.
- Scratch-project acceptance: create project → `create_snapshot` → mutate a room
  with `add_room_layer`/`set_room_layer`/`remove_room_layer` →
  `restore_snapshot` → ProjectTool (`lint_project`'s entry point) reports
  `ProjectTool Successful`, exit 0, and `lintProject` returns no issues.

### Deviations from the draft above, in one list

1. `AUTO_SNAPSHOT_TOOLS` has 17 members, not ten: `remove_resource` does not
   exist, and the audit added the six `edit_*` whole-file rewriters plus
   `add_room_instance` and `add_object_event` (they rewrite an existing room /
   object `.yy`), which the draft's table missed.
2. Retention does not protect `previous` (see above); acceptance's 21 → 20 wins,
   and 21 directories can survive when the undo target is in the prunable slice.
3. The auto hook appends warnings only, never `snapshot: <id>`, and only as a
   second content part.
4. "32 call sites across 15 modules" was 33 across 14 in the actual tree
   (`snapshot.ts`'s and `room_layers.ts`'s temp halves do not count).
5. `restore_snapshot` reports the atomic helper's locked-file text, which is
   byte-identical to the old `writeRoomYy` wording — one message, not two; that
   message is now also what `writeYyp` surfaces.
6. `writeYyp` is collapsed onto `atomicReplaceWith`, not literally onto
   `atomicWriteFile`: `Yy.write` reconciles key order against the existing file,
   and a plain string write would reorder a `.yyp` on every save.


