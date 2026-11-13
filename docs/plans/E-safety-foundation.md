# Plan E — Safety foundation

Implements `docs/specs/E-safety-foundation.md`. Work happens in the repo working
copy at `C:\Users\31087\mcp\gm-forge-mcp`; `E:\GMprojects\261103GJ` is a
**read-only** sample project. Every test writes into a scratch project created
under the OS temp directory, never into the sample.

Branch: `feat/local-tool-discovery` · Upstream fork: `fork` →
`reubenzhuyt-cloud/gm-forge-mcp`.

## Why waves

Subproject E is the only one that touches *every* write path, so the natural
failure mode is fifteen edits to `src/index.ts`. Two choke points are kept
single-owner: `src/index.ts` (registry + the one hook call site at :1026) and
`test/verify.ts` (append-only). Wave 1 builds three private modules with a
one-way import graph, wave 2 wires them in once, wave 3 audits.

Import graph, fixed before any coding starts (this is the whole coordination
contract):

```
atomic.ts   (zero imports)
   ↑
snapshot.ts (atomic.ts)                 ← manifests, store, retention, restore
   ↑
files.ts    (atomic.ts, snapshot.ts)    ← read_file, patch_file, list_changes
   ↑
write.ts    (atomic.ts, snapshot.ts)    ← writeWithSnapshot + AUTO_SNAPSHOT_TOOLS
   ↑
index.ts                                ← registration + the single hook call
```

No cycles, so nobody needs to reason about ESM function-body hoisting. The one
signature agreed up front, before wave 1 branches:

```ts
// src/gm/atomic.ts
export async function atomicWriteFile(dest: string, data: string): Promise<void>;
// temp in path.dirname(dest), fs.rename over dest, original untouched on any
// throw, EPERM/EACCES reworded exactly like writeRoomYy (:59-64).
```

`atomic.ts` has no imports, so W1A and W1B can code against it while W1C is
still writing it; typecheck only has to pass at the wave-1 gate, not
mid-wave.

## Wave 1 — parallel, disjoint files

No edits to `src/index.ts`, `test/verify.ts`, `README.md`, `package.json` in this
wave. Wave-1 code is unregistered and unreachable from MCP until wave 2.

| ID | Files | Deliverable |
|----|-------|-------------|
| W1A | `src/gm/snapshot.ts` (new) | `createSnapshot`, `listSnapshots`, `restoreSnapshot`, `deleteSnapshot`, `undoLast`, plus `readManifest`/`latestSnapshot` exported for W1B. Store layout, manifest schema, link-or-copy dedupe, retention (`KEEP = 20`), the `.gm-forge/lock`, `journal.jsonl`, the size/file caps, and `resolveInProject` (realpath containment — W1B imports it, so it lands here). No dispatch wiring. |
| W1B | `src/gm/files.ts` (new) | `readFile`, `patchFile`, `listChanges`. Literal matching only (`indexOf`, never `RegExp`), `exact`/`all` semantics, EOL + BOM preservation, binary NUL sniff, the 2 MiB caps, `.gm-forge/` write refusal, and `patchFile` calling `writeWithSnapshot` (imported from W1C's `write.ts`). |
| W1C | `src/gm/atomic.ts` (new), `src/gm/write.ts` (new), `src/gm/yyp.ts`, `src/gm/room_layers.ts` | `atomicWriteFile`; `writeYyp` and `writeRoomYy` refactored onto it with **byte-identical** output and identical error text; `writeWithSnapshot` (pre-snapshot, run, post-write `touched` diff, no-op snapshot removal, failed-op retention, warning append) and `AUTO_SNAPSHOT_TOOLS`. |

`writeWithSnapshot` gets its own module rather than living in `snapshot.ts` so
that `snapshot.ts` stays import-cycle-free (it must not import the wrapper that
imports it) and so `index.ts` has exactly one new import for the hook.

`files.ts` importing `write.ts` means W1B depends on W1C's file. If that blocks,
W1B stubs the call behind the agreed signature and wave 2 swaps it — the
signature, not the file, is the contract.

Self-verification: each coder writes a throwaway script at
`test/_wip_<name>.ts`, runs it with `tsx` against a scratch project under
`os.tmpdir()`, and **deletes it before reporting**. Nothing in `test/` may be
left behind by wave 1.

Wave-1 gate per coder:

- `npm run typecheck` clean.
- The throwaway script demonstrates the module end to end: W1A a snapshot +
  restore round trip on a mutated `.yy`; W1B a refused traversal (both `..` and a
  symlink) and a 0-match / 2-match patch that leaves the file untouched; W1C an
  interrupted rename that leaves the original intact.
- `git status` (read-only) shows only the assigned files.
- No `fs.writeFile` left in the files touched by W1C except the temp half of
  `atomicWriteFile`.

## Wave 2 — single integrator, serial

One agent, sequential steps, no overlap:

1. Register the eight schemas (`ProjectSchema.extend`), their `TOOL_DEFS` entries
   and eight `dispatchTool` cases in `src/index.ts`; **61** tools total.
2. Add `skipSnapshot?: boolean` to exactly the eleven write-tool schemas named in
   the spec's table.
3. Install the hook at the single existing call site (`src/index.ts:1026`):
   `withProjectLock(projectDir, () => withAutoSnapshot(name, projectDir, args, () => dispatchTool(name, args)))`.
   Confirm by grep that no handler body gained snapshot code.
4. Migrate the remaining plain project-file `fs.writeFile` sites onto
   `atomicWriteFile` — 32 call sites across 15 modules at the time of writing —
   one module per step, output unchanged. Snapshot hashing/linking is only
   switched to `DEDUPE_MODE = "link"` after this step is complete and typecheck
   is green.
5. Move every wave-1 regression into `test/verify.ts`, appended. Update the
   three tool-count assertions (`53 → 61` at `test/verify.ts:1956,1958,1960`) —
   the only permitted edit inside existing test text.
6. Update `README.md`: a **Safety** section with all eight tools, the count
   53 → 61, and one sentence on `.gm-forge/` and `.gitignore`.
7. Add `.gm-forge/` to the repo's own `.gitignore`.
8. Run the gates below and report exact output (pass/fail counts, skips).

Wave-2 gate:

- `npx tsc --noEmit` clean.
- `npx tsx test/verify.ts` → 0 failed, 415 pre-existing assertions unchanged,
  new count reported.
- `npm run build` succeeds and `dist/index.js` starts, lists 61 tools.
- ProjectTool (`lint_project`) on a scratch project **after** a
  `restore_snapshot` → no errors. This is the proof a restored project is still
  valid, not merely byte-identical.
- `test/_wip_*.ts` gone; `git status` shows only intended files.

### Wave-2 outcome (integrated)

All eight steps done in one serial pass; details and the reasoning behind each
correction live in `docs/specs/E-safety-foundation.md` → "Shipped (wave 2)".

1. Eight tools registered: schemas (`CreateSnapshotSchema`,
   `RestoreSnapshotSchema`, `DeleteSnapshotSchema`, `ReadFileSchema`,
   `PatchFileSchema`, and `ProjectSchema` for the three no-arg tools), eight
   `TOOL_DEFS` entries, eight dispatch cases, 53 → **61**.
2. `skipSnapshot` added to the nine write schemas in `AUTO_SNAPSHOT_TOOLS` plus
   `patch_file` (ten total; the spec's eleventh, `remove_resource`, does not
   exist).
3. Hook installed at the single site, which became `callTool(name, args)` in
   `src/index.ts` (the `CallToolRequestSchema` handler delegates to it) so the
   suite can drive the real path — lock, wrapper, dispatch, catch — without
   starting a stdio transport. No handler body gained snapshot code.
4. Write migration finished: 33 plain `fs.writeFile` sites across 14 modules →
   `atomicWriteFile` / `atomicWriteJson`; `writeRoomYy` and `snapshot.ts`'s
   `atomicReplace` reduced to calls of the one helper. `DEDUPE_MODE` left at
   `"copy"` deliberately.
5. 103 assertions appended to `test/verify.ts` (415 → 518), three count
   literals updated, nothing else edited.6. `README.md` gained a **Safety** section and a `.gm-forge/` section.
7. `.gm-forge/` added to this repo's `.gitignore`.
8. Gates: typecheck clean; suite 518 passed / 0 failed / 0 skipped; `npm run
   build` OK (61 tool names in `dist/index.js`, stdio banner intact); scratch
   project restored then validated by ProjectTool → `ProjectTool Successful`,
   exit 0.

### Fix pass after the wave-2 audit (fix-then-ship)

The audit's findings A1–G3 were all fixed in place; the shipped state, the final
17-member `AUTO_SNAPSHOT_TOOLS`, and the reasoning are in
`docs/specs/E-safety-foundation.md` → "Shipped (wave 2)". In one paragraph: the
hook now pre-validates against the registered schema and refuses to snapshot a
directory that is not a GameMaker project, so a typo costs nothing; warnings are
a second content part so the four JSON-returning tools stay parseable; the no-op
discard is decided by digest (a coarse-timestamp filesystem would otherwise
discard the backup of a real same-size write); `DEDUPE_MODE` is now `"link"` with
a regression test proving a hard-linked copy cannot be mutated by an atomic write;
a restore that fails partway rolls back and says whether the tree is mixed; the
lock error is actionable (absolute path, when to delete, `skipSnapshot`
escape hatch); the six `edit_*` whole-file rewriters plus `add_room_instance` and
`add_object_event` are now protected; `undo_last` reports snapshot-skipped files
that did not come back; `writeYyp` and imported `.png`/`.wav`/`.ogg` go through
the single atomic helper. Suite: **577 passed, 0 failed, 0 skipped**.

## Wave 3 — review

One reviewer agent, full audit of the integrated diff. Deliverable: findings with
`file:line`, severity, and a concrete fix each. Must specifically check:

- **No plain `fs.writeFile` on a path the snapshot walk can include.** Not "most
  of them" — link-mode dedupe corrupts every snapshot the moment one survives.
- No snapshot code inside a handler body; the hook is one call site.
- Every refusal path is pre-write: 0-match and 2-match `patch_file`, unknown
  snapshot id, unknown file in `restore_snapshot`, over-threshold
  `create_snapshot`.
- `resolveInProject` is used by all four path-taking tools, and the symlink case
  actually resolves (`realpath`, not `normalize`).
- Error text that mentions closing GameMaker exists in the restore path *and* the
  EPERM path, and both name the file.
- Retention can never delete the snapshot `undo_last` would pick, nor one a
  restore is reading.

Blocking findings go back to the integrator, not to wave-1 owners.

## Gates (run as written)

```powershell
cd C:\Users\31087\mcp\gm-forge-mcp
npx tsc --noEmit                     # == npm run typecheck
npx tsx test/verify.ts               # == npm test
npm run build
```

ProjectTool check (GameMaker closed, scratch project only):

```powershell
# lint_project against test-scratch/<project> after restore_snapshot
# expected: no errors; any error is a blocking finding
```

Wave 1 additionally: `npm run typecheck` plus the WIP script, per coder.

## Do not

- No writes to `E:\GMprojects\261103GJ` — read-only sample, and the user edits
  its rooms by hand. No snapshot store may be created there, not even by a test.
- No `npm install` (the tree is already provisioned).
- No `git commit`, `git push`, `git checkout`, stash, or branch manipulation —
  only the Chief Agent commits; `git status`/`git diff` read-only is fine.
- No GameMaker build, `lint_project`, `compile_project`, Igor, Runner or MCP
  screenshot against the user's project. The one permitted ProjectTool run is on
  the scratch project, once, in wave 2.
- No regex in `patch_file` — `find` goes to `indexOf`, and no code path may build
  a `RegExp` from user input.
- No write outside the project directory: no temp files in `os.tmpdir()` for a
  project write, no absolute-path escape, no symlink escape.
- No new tool beyond the eight; the count must land at exactly **61**.
- No `fs.writeFile` onto a project file that a snapshot can include; that is the
  invariant link-mode dedupe depends on.
- No auto-deleting a stale `.gm-forge/lock`, no auto-editing a user's
  `.gitignore`, no snapshot store creation at server start.
- No re-serialising a snapshot: it is a byte copy, so `@bscotch/yy`'s key order
  and float spelling are preserved exactly.
