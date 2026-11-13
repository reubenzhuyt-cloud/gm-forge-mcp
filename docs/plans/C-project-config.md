# Plan C — Project-level configuration

Implements `docs/specs/C-project-config.md`. Work happens in the repo working copy
at `C:\Users\31087\mcp\gm-forge-mcp`; `E:\GMprojects\261103GJ` is a **read-only**
sample project used exclusively for capturing `REF` key-sets and read-only smoke
tests.

Branch: `feat/objects-rooms-authoring` (continues from A's commit `4f6312c`).

## Why waves

Same reason as A: `src/index.ts`, `test/verify.ts` and `README.md` are single-file
choke points. Wave 1 gives each coder a private new module, so three can work at
once; wave 2 is one integrator, serial, so the choke points are touched once.
One extra constraint here: **subproject E must land before wave 2**, because every
write in C is an overwrite of an IDE-owned file and must ride E's snapshot hook
rather than invent its own.

## Wave 0 — precondition (E, already scheduled first)

C does not implement snapshots or atomic writes. It imports them:

- `writeWithSnapshot(path, contents, note)` for `.yy`/`.yyp`/`.gml` writes, and
  E's auto-snapshot hook for the destructive paths (`remove_included_file`,
  `add_included_file` with `overwrite: true`, `set_macro` rewriting a line,
  `set_project_option` changing a value).
- E's `atomicWriteFile` for the included-file copy and for `.gml` edits; `writeYyp`
  stays the `.yyp` path.
- Named-argument/API drift from what E actually exports is resolved by adapting
  C's call sites, never by adding a second write helper.

Gate: `writeWithSnapshot` is importable, and one throwaway write on a scratch
project produces exactly one snapshot. If E has not landed, wave 1 may still be
written (it is pure logic), but **wave 2 is blocked** — do not fake the helper.

## Wave 1 — parallel, disjoint files

No edits to `src/index.ts`, `test/verify.ts`, `README.md`, `package.json` in this
wave. Wave-1 code is unregistered and unreachable from MCP until wave 2.

| ID | Files | Deliverable |
|----|-------|-------------|
| W1 | `src/gm/options.ts` (new) only | `OPTION_ALLOWLIST` (one table: logical name → type, scope, on-disk key template, availability), `getProjectOptions()`, `setProjectOption()`. Envelope-key constants exported for the wave-2 `REF`. Rejection messages name the reason (`unknown` / `read-only` / `unverified`). |
| W2 | `src/gm/included_files.ts` (new) only | `listIncludedFiles`, `addIncludedFile`, `removeIncludedFile`, plus the exported `INCLUDED_FILE_KEYS` (7-key captured set, frozen) used for both emission order and validation. No `.yyp` helper changes. |
| W3 | `src/gm/macros.ts` (new) + additive `ensureFolderPath()` in `src/gm/yyp.ts` | `listMacros`, `setMacro`, `MACRO_LINE_RE`, EOL detection, and the path-aware folder-node helper (nested node = 6 keys, no `parent`, parent encoded in `folderPath`). Reuses `newScriptYy`'s key order and `registerResource`. |

Rules for all three:

- New modules are pure enough to unit-drive from a throwaway script: pass in the
  parsed project/`.yyp` and the project directory; throw before touching disk.
- Every format shape comes from the captured sets above, exported as a constant in
  the owning module — **not** retyped in `test/verify.ts` later.
- If a required shape is missing (no sample, no fixture), throw
  `unverified format: <shape>`. No placeholder keys, no "probably fine".

Self-verification: each coder writes a throwaway script at `test/_wip_<name>.ts`,
runs it with `tsx` against a scratch project under `$env:TEMP`, and **deletes it
before reporting**. Nothing in `test/` may be left behind by wave 1.

Wave-1 gate per coder:

```powershell
npm run typecheck
npx tsx test/_wip_options.ts     # etc.; deleted before reporting
git status --porcelain           # only the assigned files
```

Plus: the scratch script must show the refusal cases (unknown option, read-only
`option_gameguid`, `unverified` key, duplicate macro, missing included file), not
just the happy path.

## Wave 2 — single integrator, serial

One agent, sequential steps, no overlap:

1. **Format capture gate, before pinning any writer.** Create a scratch project
   (from `create_project`, under `$env:TEMP`, never `E:`), apply each shape once
   with a throwaway harness, run **GameMaker's ProjectTool** on it, then re-read
   every written file and diff key sets/order against what C wrote. Any
   disagreement — especially `IncludedFiles.filePath` for a nested
   `datafiles/<targetName>/` layout, and the `folders/Scripts/Macros.yy` node —
   is resolved in GameMaker's favour *now*. If ProjectTool is unavailable, the
   nested-layout clauses stay refused (`unverified`) rather than shipped.
2. Register the 7 schemas (`ProjectSchema.extend`), 7 `TOOL_DEFS` entries and 7
   `dispatchTool` cases in `src/index.ts` → exactly **60** tools.
3. Move each throwaway regression into `test/verify.ts`, deriving `REF` entries
   from the modules' exported key constants (`REF.includedFile`,
   `REF.projectResource`, `REF.folderNode`, options envelope). Three cases per
   write path: populated, omitted/default, error.
4. Read-only smoke assertions against the sample project: ten platforms, display
   names `macOS`/`Opera GX`/`HTML5`, exactly one platform with
   `interpolate_pixels: false`, 42 macros, zero duplicates.
5. Update `README.md:47-79` with a **Project config** group (7 tools, alphabetical
   within the group).
6. Run both gates and report exact output (assertion counts, skips).

Wave-2 gate:

```powershell
npm run typecheck
npm test
git status --porcelain
Test-Path test/_wip_options.ts   # must be False, same for the other two
```

Both commands clean; 413 pre-existing assertions unmodified (append only); tool
count 60; only intended files in `git status`; no write ever lands in
`E:\GMprojects\261103GJ` (verify its `.yyp` mtime and `git -C E:\GMprojects\261103GJ
status --porcelain` are unchanged before/after).

**Sequencing across subprojects:** B (sprite frames) has its own wave-2
integrator and touches the same three choke points. C's wave 2 must not run
concurrently with B's wave 2 — wave 1 is safely parallel, wave 2 is not.

## Wave 2 — outcome (2026-11-13)

Landed in the working tree (no commits — the Chief Agent commits). Starting point
was **61** tools, not 53/60: subproject A added 8 and E added 8 before this wave,
so the plan's "exactly 60" was stale. C adds 7 → **68**.

1. **Format capture gate.** The nested `IncludedFiles.filePath`
   (`datafiles/<targetName>`) and the `folders/Scripts/Macros.yy` node were
   applied on a scratch project under `%TEMP%` and loaded by ProjectTool
   2024.14.165 (`ProjectTool Successful`, exit 0, `lintProject` no issues, `.yyp`
   hash unchanged — ProjectTool's validator is read-only). No shape was amended.
2. **Registration.** 7 schemas (`ProjectSchema.extend`, `.describe()` on every
   field), 7 `TOOL_DEFS` entries and 7 `dispatchTool` cases in `src/index.ts`.
   `set_project_option.key` is a `z.string()` whose description is generated from
   `OPTION_ALLOWLIST` (the writable set is platform/version dependent and the
   three rejected names need their own reasons; a `z.enum` would flatten both
   into one zod message). Object results are `JSON.stringify(result, null, 2)`.
3. **Snapshot wiring, asymmetric by design.** `add_included_file` and
   `remove_included_file` joined `AUTO_SNAPSHOT_TOOLS` (19 members) because
   `writeYyp` takes no snapshot; `set_project_option` and `set_macro` stayed off
   it because they call `writeWithSnapshot` themselves. Tested: each of the five
   write tools (`patch_file` included) produces exactly one snapshot per
   successful call, and an already-equal `set_project_option` produces none.
4. **The `.yyp` degradation was real and is fixed centrally.** A no-op
   `loadYyp → writeYyp` on the real sample rewrote
   `"$GMAudioGroup":"v1"` → `""` and dropped `exportDir`, because
   `@bscotch/yy`'s project schema names neither and zod drops unnamed keys. The
   tags are per-record schema-version markers (`v1`/`v2`/`v4`/`v5` across one
   real project; the library itself rewrites several of them per IDE version), so
   `writeYyp` now restores every dropped key from the file on disk, matched by
   record identity, before stringifying. A no-op save of the real 161-line `.yyp`
   is byte-identical on a temp copy; an edit changes only the changed keys.
5. **Regression tests.** `test/verify.ts` 577 → **734 passed, 0 failed, 0
   skipped** (+157, after the fix pass), all appended; the only pre-existing
   edits are the three tool-count literals (61 → 68) and two entries in the F1
   `minimalArgs` table. Fixtures: the ten `options/*/options_*.yy` in
   `test/fixtures/options/`.
6. **Gates.** `npx tsc --noEmit` clean; build OK with all 68 names in
   `dist/index.js` and the stdio banner intact; scratch-project ProjectTool
   after create_project + add_included_file + set_project_option + set_macro →
   `ProjectTool Successful`, exit 0. Nothing was written to
   `E:\GMprojects\261103GJ` (only read; its `.yyp` round-trip ran on a temp copy).

Wave-2 gate as run:

```powershell
npx tsc --noEmit              # clean
npx tsx test/verify.ts        # 734 passed, 0 failed, 0 skipped (after the fix pass below)
git status --short            # only the intended files
Test-Path test/_wip_options.ts  # False, and no wave-1/wave-2 scratch scripts left
```

### Fix pass (wave-3 audit returned "fix-then-ship", applied same day)

Thirteen code findings + the doc corrections, all inside C's own files:

| # | Finding | Fix |
|---|---|---|
| 1 | `set_project_option` / `set_macro` discarded the `writeWithSnapshot` result, so `skipSnapshot` and an over-threshold skip were silent | both results now carry `snapshotId` / `snapshotSkippedReason` (and `changed`), like `patch_file` |
| 2 | `set_project_option` fell back to `JSON.stringify` (silent whole-file reformat) | fallback deleted: a key not alone on its line is a refusal; both branches tested (hand-spaced file edited in place, compact file refused byte-identical, no snapshot) |
| 3 | Sample assertion pinned "42 macros / 7 files" | now `count > 0`, no duplicates, no file under a dot-directory |
| 4 | `restoreDroppedKeys` filled *any* absent key (could resurrect a removed key, re-add `"Options": []`) | scoped to `$GM*` + `exportDir`; `IncludedFiles` extras restored separately per entry |
| 5 | `resourceVersion` is library-normalised and the restore cannot win | documented (README + spec) and pinned by a 1.3 → 2.0 test; the byte-identical claim now says "already at 2.0" |
| 6 | `readTextIfExists` rethrew anything but `ENOENT` | every read/parse error skips the restore; a save can never be blocked by fidelity |
| 7 | `overwrite: true` with a new `targetName` moved the entry, dropped extras, orphaned the old copy | refused, naming `remove_included_file`; extras now read from the raw `.yyp` |
| 8 | `set_macro` rewrote identical bytes and cost a snapshot | identical value → `changed: false`, no write, no snapshot |
| 9 | `AddIncludedFileOptions.skipSnapshot` was dead | removed; the dispatch hook is the only opt-out |
| 10 | `assertSafeSegment` missed `<>:"\|?*` and `CON`/`NUL`/`COM1`… | refused with a clear message, extension-insensitive |
| 11 | `remove_included_file` removed the entry then threw on a directory/EPERM target | delete decided before the write; failures become `fileDeletionSkipped` |
| 12 | `#macro` inside `/* … */` counted as a definition | block-comment state carried across lines (string-aware) |
| 13 | an existing macro under `output/` could be rewritten in place | `output/`, `datafiles/`, `options/` refused for updates too |

Result: 708 → **734 passed, 0 failed, 0 skipped** (+26 assertions), no pre-existing
test lines touched beyond the already-documented literals/entries.

## Wave 3 — review

One reviewer agent, full audit of the integrated diff. Deliverable: findings with
`file:line`, severity, and a concrete fix each. Blocking findings go back to the
integrator, not to wave-1 owners. Specific things to check:

- No key outside the resolved one changed in any `options/*.yy` (order, values,
  presence), including on the `changed: false` path.
- No `Folders`/`DataFiles` node appeared for included files.
- `set_macro` on a CRLF file and on a no-trailing-newline file is byte-identical
  apart from the one line.
- `list_macros` ignores `.gamemaker-mcp/`, `output/`, `datafiles/`.
- Every rejection message names the allowlist or the expected path — no bare
  "invalid argument".

## Do not

- No `npm install` (the tree is already provisioned).
- No `git commit`, `git push`, or branch manipulation — only the Chief Agent
  commits.
- No writes to `E:\GMprojects\261103GJ` of any kind, at any stage: no ProjectTool,
  no `lint_project` / `compile_project`, no Igor, no Runner, no MCP screenshots,
  no scratch project created there. The user edits that project by hand.
- No invented `.yy`/`.yyp` keys. `$GMIncludedFile`, the folder node and the script
  resource are copied from captured files; if a shape is uncaptured, the tool
  refuses.
- No key reordering, no whitespace/format normalisation of files that were not
  explicitly written, no re-encoding of untouched options files.
- No `option_gameguid`, licence, signing or Steam writes; no `option_*_texture_page`
  ("that is the texture-group subproject"); no `configs` work.
- No new tool beyond the seven; the tool count must land at exactly 60.
- No second copy of the option allowlist, and no second script-resource writer:
  reuse `newScriptYy`'s shape and `ensureFolderPath`.
- No wave-2 start before E's `writeWithSnapshot` exists and wave 1 is integrated.
