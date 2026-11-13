# Plan D — Sequences & Timelines

Implements `docs/specs/D-sequences-timelines.md`. Work happens in the repo
working copy at `C:\Users\31087\mcp\gm-forge-mcp`; `E:\GMprojects\261103GJ` is a
**read-only** sample project used only for evidence gathering and for confirming
that the readers do not choke on a real, deeply nested object.

Branch: `feat/local-tool-discovery` · Upstream fork: `fork` →
`reubenzhuyt-cloud/gm-forge-mcp`.

Depends on: subproject A (`docs/specs/A-objects-rooms.md`, landed — 53 tools),
subproject E (`docs/specs/E-safety-foundation.md`, landed — `src/gm/write.ts`,
`src/gm/atomic.ts`). D writes through `writeWithSnapshot`
(`src/gm/write.ts:89`) and adds its writer tool names to `AUTO_SNAPSHOT_TOOLS`
(`src/gm/write.ts:18`); it adds no backup or transaction logic of its own.

## Why waves, and why a gate before them

`src/index.ts`, `test/verify.ts`, `README.md` and `src/gm/yyp.ts` are single-file
choke points. Wave 1 gives each coder a private module so parallel work touches
disjoint files; wave 2 is one integrator, serial, so the choke points are touched
once.

The gate comes first because this subproject can be *entirely* blocked by
missing evidence, and because a wrong sequence shape passes `tsc`, passes the
suite, and fails only in the IDE. Discovering that in wave 3 wastes all of
waves 1–2. The gate is therefore a deliverable with a written outcome, not a
formality.

## Gate stage — serial, before wave 1, owned by the integrator

**G1 · Research.** Run the three commands in the spec's "Gate commands" block
(fresh, this session — no reuse of the result printed in the spec). Search every
place a GameMaker project can live on this machine: project roots, the IDE
install (`D:\steam\steamapps\common\GameMaker Studio 2`, 2026.0.0.16), its
`ProjectTemplates/*.yyz`, `Prefabs/*`, `Cache/StartPage/TemplateFiles`, and the
installed `@bscotch/yy` package. Unpacking a template `.yyz` into the OS temp
directory is allowed; writing anything into a GameMaker project is not.

**G2 · Per-type decision, recorded.** Timelines and sequences are decided
separately. For each:

| Outcome | Evidence required to record it |
|---------|-------------------------------|
| GO | Absolute path of a real, GameMaker-generated file; the producing IDE version (`GameMaker.exe` `FileVersion`); the root key set; the key set of every nested object the intended writer touches; the `resourceVersion` string at each level. Pasted into `test/verify.ts`'s `REF` block. |
| NO-GO | The commands run, their output, and the roots searched. A sprite-embedded `GMSequence` alone is a NO-GO for `add_sequence` — see the spec's sub-gate. |

Write the outcome into the "Gate result on this machine" section of the spec
(date, commands, roots, verdict per type), and into the outcome log at the
bottom of this plan. The spec already records the 2026-11-13 run as **FIRED for
both**; G1 exists so the implementer confirms it rather than inheriting it.

**G3 · Enabling change (serial, one commit-sized diff).** Export the existing
private reader: `export` on `readResourceYy` in `src/gm/introspect.ts:22`. No
behaviour change, no test change. This is gate-owned precisely so the two
parallel wave-1 coders never both edit `introspect.ts`.

**G4 · Schema freeze.** If a type is GO, add its `RESOURCE_VERSIONS` entries
(`src/gm/yyp.ts:12-42`) now, with values copied from the capture, one entry per
sub-structure. If a type is NO-GO, add nothing — a version constant with no
capture behind it is the exact failure this spec forbids.

Gate exit criteria: the spec states a verdict per type with evidence or with
commands; `npm run typecheck` clean; `git status` shows only `src/gm/introspect.ts`
(and `src/gm/yyp.ts` when G4 added entries) plus the docs.

## Wave 1 — parallel, disjoint files

No edits to `src/index.ts`, `test/verify.ts`, `README.md`, `package.json` in this
wave. Wave-1 code is unregistered and unreachable from MCP until wave 2.

| ID | Files | Deliverable |
|----|-------|-------------|
| W1 | `src/gm/timelines.ts` (new) | `listTimelines()` per contract 1 — tolerant parser, `[]` for a missing directory, sorted output, found-key reporting when the moments collection is absent. If the timeline gate passed: `addTimeline`, `addTimelineMoment`, `editTimelineMoment`, `removeTimelineMoment` against the frozen `REF`, using the `animation_curves.ts:49-64` pattern (mkdir → write → `ensureFolder(yyp, "Timelines")` → `registerResource` → return `yyp`), with the write going through `writeWithSnapshot` (`src/gm/write.ts:89`). |
| W2 | `src/gm/sequences.ts` (new) | `listSequences()` per contract 6 — track types passed through verbatim, `keyframeCount` defensive, `null` for absent `length`/`playbackSpeed`. If the sequence gate passed: `addSequence` (one sprite track, one keyframe, nothing else) and `setSequenceSpriteTrack` (retarget only), same pattern with `ensureFolder(yyp, "Sequences")`, writes through `writeWithSnapshot`. |

Both coders read `readResourceYy` from `src/gm/introspect.ts` (exported in G3)
and neither touches it.

Self-verification: each coder writes a throwaway script at
`test/_wip_<name>.ts`, runs it with `tsx`, and **deletes it before reporting**.
Nothing in `test/` may be left behind by wave 1.

Wave-1 gate per coder: `npm run typecheck` clean; the throwaway script shows the
reader returning `[]` on a scratch project with no resource directory, parsing a
fixture with unknown keys and a trailing comma, and (writers only) producing a
file whose key set matches the frozen `REF` — all against a scratch fixture
project in the temp directory, never the sample project; no files outside the
assigned list changed (`git status`, read-only).

## Wave 2 — single integrator, serial

One agent, sequential steps, no overlap:

1. Register **only the tools the gate allows** in `src/index.ts`: schemas
   (`ProjectSchema.extend`), `TOOL_DEFS` entries and `dispatchTool` cases.
   Expected count after this subproject: 55 (both gated), 57 (sequences only
   GO), 59 (timelines only GO), 61 (both GO) — see the spec's table. Do not
   register a gated tool "for later"; an unregistered contract is the correct
   state, and the suite counts `TOOL_DEFS`.
2. Add `RESOURCE_VERSIONS` entries, if G4 deferred them; do not touch entries
   that were not part of a capture. Add every shipped writer tool name to
   `AUTO_SNAPSHOT_TOOLS` (`src/gm/write.ts:18`) — a writer missing from that set
   bypasses the snapshot hook silently, which E's spec forbids.
3. Move every regression from the throwaway scripts into `test/verify.ts`:
   populated / omitted / error for each shipped tool, plus a `TOOL_DEFS` length
   assertion and a comment-stripped count of `case "..."` entries so a
   commented-out or duplicated case cannot pass.
4. Update `README.md:47-79`: a **Timelines** line and a **Sequences** line,
   listing only what shipped, with a one-clause note that
   `find_references`/`delete_resource`/`rename_resource` do not yet follow
   sequence or timeline references.
5. Run `npm run typecheck` and `npm test`; report the exact output (pass/fail/
   skip counts and skip reasons).

Wave-2 gate: both commands clean; `test/_wip_*.ts` gone; `git status` shows only
the intended files; no existing assertion modified (only appended); README's
count matches `TOOL_DEFS`; no tool registered whose type is NO-GO.

## Wave 3 — review

One reviewer agent, full audit of the integrated diff against the spec. Extra
focus areas for this subproject:

- Any writer that emits a key not present in a frozen `REF` set, or that fills a
  missing key with a "sensible" default.
- Any `catch` that turns a parse failure into an empty list — a corrupt file
  must be an error naming the path, never silently "no timelines".
- Any number coercion (rounding, `Number()` on a string) in either listing tool.
- Whether the README's wording claims more than the gate allows.

Deliverable: findings with `file:line`, severity, and a concrete fix each.
Blocking findings go back to the integrator, not to wave-1 owners.

## Do not

- **No invented sequence or timeline shape.** If the gate fired, the writer is
  not written — not "written but disabled", not behind a flag, not in a comment.
  A plausible `.yy` that the IDE rejects is worse than a refusal, and this repo
  would ship it as a passing test.
- No `npm install` (the tree is already provisioned).
- No `git commit`, `git push`, or branch manipulation — only the Chief Agent
  commits.
- No writes against `E:\GMprojects\261103GJ`: that project is read-only for this
  work and the user edits its rooms by hand. Reading a sprite `.yy` to check the
  parser is fine; opening the project in the IDE while a task runs is not.
- No `lint_project` / `compile_project` runs, no Igor, no Runner, no MCP
  screenshots. `ProjectTool` may run **only** via `test/verify.ts`'s existing
  block, against a scratch project in the OS temp directory, at most once per
  suite invocation.
- No `.yy` or `.yyp` restructuring beyond the named fields; no key reordering; no
  re-encoding of a resource that was not explicitly written.
- No bare `fs.writeFile` in a writer — every write goes through
  `writeWithSnapshot`, and every new writer is in `AUTO_SNAPSHOT_TOOLS`.
- No edits to `src/gm/introspect.ts` outside G3, and none to `src/gm/yyp.ts`
  outside G4 — they are shared files and the wave structure depends on that.
- No new tool beyond the eight candidates, and no tool at all whose type is
  NO-GO. The tool count must land on exactly one of 55 / 57 / 59 / 61 as recorded
  in the gate outcome.

## Outcome log

- **2026-11-13 · evidence research (pre-implementation).** No real `timelines/`
  or standalone `sequences/` file exists on this machine. Searched: the only
  GameMaker project (`E:\GMprojects\261103GJ`), the IDE install and its
  `ProjectTemplates/*.yyz` (both sequence-shaped templates unpacked: no sequence
  or timeline files), 45 prefab bundles, `Cache/StartPage`, and
  `node_modules/@bscotch/yy` (ships `dist/` only, no sample fixtures). Verdict:
  **NO-GO for timelines, NO-GO for sequences** → wave 1 ships two read-only
  modules, wave 2 registers 2 tools (**55 total**). Gate G1 must re-run fresh
  before wave 1 begins; if it finds evidence, this entry is superseded, not
  edited.

- **2026-11-13 · G1 re-run + waves 1–2 shipped (both NO-GO confirmed).** G1 was
  re-run fresh before any code was written: the directory search returned only
  two FL Studio synth-preset `Sequences` folders, `"GMTimeline"` had 0 hits
  under `E:\GMprojects`, every `GMSequence` hit was a `sprites/<n>/<n>.yy` (or a
  copy of one under `.gamemaker-mcp/`), the IDE is still `2026.0.0.16`, and
  neither `261103GJ` nor `NewGame` has a `timelines/` or `sequences/`
  directory. **G2: NO-GO both, recorded in the spec's "Shipped state"
  section.** **G3 not needed** — the readers tolerate a bad file per entry, which
  `readResourceYy`'s throwing contract cannot do, so it stayed private and no
  shared file was touched. **G4: no `RESOURCE_VERSIONS` entry added.**

  Wave 1 delivered `src/gm/timelines.ts` (`listTimelines`) and
  `src/gm/sequences.ts` (`listSequences`, `scanSpriteEmbeddedSequences`) — reader
  only, no writer, no template, no commented-out `case`. Wave 2 registered the
  two tools in `src/index.ts` (74 → **76**, not 55: A/E/C/B had already landed),
  appended 33 assertions to `test/verify.ts` and moved the three tool-count
  literals 74 → 76. The fixtures are synthetic minimal JSON, not captures — the
  honest route for a gated type; the only real-file check copies
  `spr_jingling1_walk` into `%TEMP%`.

  Deviation from the wave-1 table, recorded rather than hidden: the listing form
  of `list_sequences` returns `{ sequences, spriteEmbeddedSequenceCount }` instead
  of a bare array, because the sprite-embedded count is project-level and has
  nowhere else to live; `list_timelines` keeps the bare array. Both put a
  "nothing here" note in a `⚠` second content part, so `content[0]` stays
  parseable JSON.

  Verification: `npx tsc --noEmit` clean; `npx tsx test/verify.ts` → **951
  passed, 0 failed, 0 skipped**; `npm run build` OK with 76 names in
  `dist/index.js` and the stdio banner; read-only smoke on
  `E:\GMprojects\261103GJ` → both lists empty with the documented note
  (`spriteEmbeddedSequenceCount: 35`), no `.gm-forge/` created, project mtimes
  and the top-level listing unchanged.

- **2026-11-13 · D fix pass (audit blockers 1-2, should-fix 3-10).** Two
  read-only modules changed, no tool added: the stat failure rule is now
  "every error is per-entry reporting" (missing folder → plain `existsOnDisk:
  false`; `EACCES`/`EPERM`/`ELOOP`/`EBUSY` → `parseError`), and the sprite scan
  is capped at `MAX_SPRITE_SCAN = 500` with `scanned`/`total`/`truncated`,
  `unreadable: { name, reason }[]` and an `unrecognised` bucket, the note
  calling the count a lower bound when it is one. Named lookups of registered
  resources keep returning the zeroed entry (documented; crafted names are
  quoted, never joined). Cross-subproject: `reorder_room` and `move_room_relative`
  joined `AUTO_SNAPSHOT_TOOLS` (26 members) and `snapshot.ts`'s dead `undoHold`
  field is gone; a global registry assertion (snake_case, unique, README-listed)
  covers all 76 names. Verification: tsc clean, **975 passed, 0 failed, 0
  skipped**, build with 76 names and the banner, same read-only smoke on the
  sample project (`count: 35`, `scanned: 35`, `total: 35`, `truncated: false`,
  no `.gm-forge/`, mtimes unchanged).
