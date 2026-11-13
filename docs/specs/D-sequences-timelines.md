# Spec D — Sequences & Timelines

Status: draft · Scope: subproject D · Repo: `gm-forge-mcp`

## Goal

The server can author every resource family that a real room round-trip needs
(objects, rooms, layers, tiles, sprites, tilesets, sounds, shaders, fonts, notes,
extensions, particle systems, animation curves) and still cannot author the two
resources whose file format is *deepest*: timelines (`timelines/<n>/<n>.yy`) and
sequences (`sequences/<n>/<n>.yy`).

This spec exists to answer one question honestly: **can those shapes be written
without guessing?** A sequence `.yy` is not a flat record — it is tracks, track
types, keyframe stores, keyframes with nested parameter blobs, moments, and
per-track colour/interpolation state. A shape invented at this depth is still
valid JSON, so nothing in this repo fails loudly; the IDE simply refuses the
project. This subproject therefore leads with a gate, not with a writer.

Deliverables, in order of certainty:

1. `list_timelines` and `list_sequences` — read-only summaries that survive a
   shape they were not written against (they report what is in the file, they do
   not assert what should be).
2. Timeline writers (`add_timeline`, `add_timeline_moment`,
   `edit_timeline_moment`, `remove_timeline_moment`) — **only if** the gate
   passes for timelines.
3. Sequence writers (`add_sequence`, `set_sequence_sprite_track`) — **only if**
   the gate passes for sequences. A minimal sequence is one sprite track with one
   keyframe; this is explicitly not a sequence editor.

## Non-goals

- General keyframe / curve / parameter editing: no arbitrary track types, no
  adding, moving, or retiming keyframes, no `Keyframe` parameter blobs authored
  by us.
- Particle, audio, colour, sub-image, path, and text tracks.
- "Moment of truth" / sequence playback events beyond whatever a listing tool
  can report.
- Building a sequence from a directory of sprites as a flipbook (a later
  subproject; `add_sprite_from_images` already produces each individual sprite).
- Editing sequences or timelines that were exported from, or resaved by, the IDE
  — writes are only ever to files this tool created, and only where the gate
  grounds them.
- Assigning a sequence to a room (`sequenceId` stays `null`;
  `src/gm/rooms.ts:143`), sequence shortcuts, and sequence inheritance.
- Backup, snapshot, rollback, multi-file transactions — subproject E owns that
  seam (`docs/specs/E-safety-foundation.md`). D routes every write through it and
  implements none of it.
- Room/layer/tile authoring — subproject A owns it and has landed
  (`docs/specs/A-objects-rooms.md`); D does not re-specify any of it.

## Go/no-go gate (read before anything else)

**Rule.** Every `.yy` shape D writes must be captured from a real
GameMaker-generated file, on disk, in this session. Not from memory, not from a
third-party schema, not from a plausible-looking extrapolation of the sprite
sequence. A capture means: the file's absolute path, the IDE version that
produced it, and the literal key sets of the root and of every nested object the
writer touches, pasted into `test/verify.ts`'s `REF` block as `Set` literals.

**Why the gate is not theatre.** `src/gm/animation_curves.ts:6-14` documents
exactly the failure mode this gate prevents: the curve shape was captured from
`@bscotch/yy`'s sample fixtures, and then *four* required fields (`$GMAnimCurve`,
`%Name`, `$GMAnimCurveChannel`, `%Name`) had to be discovered one at a time
through live `ProjectTool` rejections. Curves are the shallowest resource in this
family — a root object and one array of point records. A sequence is an order of
magnitude deeper, so the same discovery process would be a sequence of failures
with no upper bound.

**Gate result on this machine (2026-11-13): FIRED for both resource types.**

The research was run before this spec was written, and it is reproducible. What
was searched: every GameMaker project on the machine, the IDE install, its
project templates, its prefab bundles, its StartPage template cache, the runtime
cache, and the installed `@bscotch/yy` package.

- No `timelines/` directory exists in any GameMaker project. No file anywhere
  under the project roots contains `"GMTimeline"`.
- No standalone `sequences/` directory exists either. No `sequences/<n>/<n>.yy`
  file exists to copy.
- `E:\GMprojects\261103GJ` (the only GameMaker project on the machine) contains
  `animcurves/`, `objects/`, `rooms/`, `scripts/`, `sounds/`, `sprites/`,
  `tilesets/` — and neither `timelines/` nor `sequences/`.
- The IDE install (`D:\steam\steamapps\common\GameMaker Studio 2`,
  `GameMaker.exe` **2026.0.0.16**) ships `TimelineEditorGUI` and `AnimCurveGUI`
  but no sequence editor plugin directory, three project templates
  (`new_blank`, `new_gamestrip`, `new_wallpaper` — the latter two are
  sequence-shaped products) and 45 prefab bundles, none of which contains a
  sequence or a timeline file. `new_gamestrip.yyz` and `LiveWallpaperTemplate.yyz`
  were unpacked and contain only `objects/`, `rooms/`, `sprites/`, `notes/`.

Consequence, binding for this subproject:

| Resource | Gate | Ships |
|----------|------|-------|
| Timeline | **FIRED** — no sample | `list_timelines` only |
| Sequence | **FIRED** — no standalone sample | `list_sequences` only |

**The two types are gated independently.** A timeline `.yy` is far simpler than a
sequence `.yy` (a name, a length, and a flat array of moments), so a future
capture of one must not be held hostage to a capture of the other, and vice
versa. Any amendment to this spec re-runs only the gate for the type whose
evidence changed.

**Sub-gates.** Passing the main gate is not enough for every contract:

- `add_timeline_moment` / `edit_timeline_moment` may carry a `code` argument
  **only if** a captured timeline contains a moment with code, and the capture
  establishes unambiguously whether that code lives inline in the `.yy` or in a
  sibling `.gml` with a naming convention — and, if the latter, whether a script
  resource must also be registered and under which folder. If no captured moment
  has code, those tools accept codeless moments only and reject `code` with an
  error naming the missing evidence. Guessing a GML file name is how a project
  becomes unopenable.
- `add_sequence` may ship **only if** the capture is a standalone
  `sequences/<n>/<n>.yy` including its `parent` folder reference and its root
  `resourceVersion`, *and* the generated file passes `ProjectTool`. The
  sprite-embedded `GMSequence` in `src/gm/sprites.ts:124-190` is **not**
  sufficient: a sprite's sequence lives inside the `GMSprite` record, has no
  `parent`, and is never registered as a resource of its own.
- `list_*` is never gated. Reading a file we cannot write is always in scope, and
  it is how future captures get collected.

**Gate commands** (PowerShell, read-only; run them again if this spec is ever
amended, and paste the output into the plan's outcome section):

```powershell
# 1. Resource directories, anywhere on the machine a project might live
Get-ChildItem 'E:\GMprojects','C:\Users\31087\Documents','C:\Users\31087\mcp' `
  -Directory -Include 'timelines','sequences' -Recurse -Depth 6 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName

# 2. Any file claiming to be one
Get-ChildItem 'E:\GMprojects' -Include '*.yy','*.yyp' -Recurse -ErrorAction SilentlyContinue |
  Select-String -Pattern '"GMTimeline"|resourceType":\s*"GMSequence"' -List |
  Select-Object Path, LineNumber

# 3. The IDE that would have written it
(Get-Item 'D:\steam\steamapps\common\GameMaker Studio 2\GameMaker.exe').VersionInfo.FileVersion
```

If command 1 or 2 returns a path, stop and capture: root key set, the key set of
each nested object the writer touches, `resourceVersion` strings at every level,
and the IDE version. If command 2 returns only *sprite* files (`sprites/<n>/<n>.yy`
hitting `GMSequence`), the gate has **not** passed — see the sub-gate above.

## Shipped state (2026-11-13 — both gates remained FIRED)

The implementation re-ran the gate commands above (fresh, not inherited) before
writing code. Output:

1. `Get-ChildItem 'E:\GMprojects','C:\Users\31087\Documents','C:\Users\31087\mcp'
   -Directory -Include 'timelines','sequences' -Recurse -Depth 6` — two hits,
   both FL Studio Mobile synth-preset folders
   (`C:\Users\31087\Documents\Image-Line\...\GMSynth\Sequences` and `...\SuperSaw\Sequences`),
   not GameMaker. No `timelines/` anywhere.
2. `Get-ChildItem 'E:\GMprojects' -Include '*.yy','*.yyp' -Recurse |
   Select-String '"GMTimeline"|resourceType":\s*"GMSequence"'` — **0**
   `"GMTimeline"` hits; 830 `GMSequence` files, all inside `sprites/<n>/<n>.yy`
   (plus 15 copies under this tool's own `.gamemaker-mcp/temp` and
   `.gamemaker-mcp/staging` directories, which are sprite files moved there by
   sprite-frame work). No standalone sequence resource.
3. `GameMaker.exe` `FileVersion` on this machine: still **2026.0.0.16**.
4. `Test-Path` on `timelines`/`sequences` under both GameMaker projects on the
   machine (`E:\GMprojects\261103GJ`, `E:\GMprojects\NewGame`): all **False**.

Verdict unchanged: **FIRED for timelines, FIRED for sequences**.

What shipped, and only this:

| Item | State |
|------|-------|
| `list_timelines` | registered (`src/gm/timelines.ts`) |
| `list_sequences` | registered (`src/gm/sequences.ts`) |
| `add_timeline`, `add_timeline_moment`, `edit_timeline_moment`, `remove_timeline_moment` | **absent** — no schema, no `TOOL_DEFS` entry, no dispatch case, no template function |
| `add_sequence`, `set_sequence_sprite_track` | **absent**, same |
| `RESOURCE_VERSIONS` timeline/sequence entries | **none added** (gate G4) |
| `readResourceYy` export (gate G3) | **not needed**: per-entry `parseError` tolerance requires a non-throwing read, so `src/gm/introspect.ts` is untouched |
| `AUTO_SNAPSHOT_TOOLS` | unchanged (both tools are read-only) |

Amendments to the contracts above, as shipped:

- **Output shape of the listing form.** `list_timelines` returns the bare
  `TimelineSummary[]` described in contract 1. `list_sequences` returns
  `{ sequences: SequenceSummary[], spriteEmbeddedSequenceCount }` rather than a
  bare array: the sprite-embedded count is project-level, and a bare array has
  nowhere to carry it. A named lookup returns the single entry for both tools,
  as contracts 1 and 6 require.
- **Notes go out as a second content part**, prefixed `⚠` (the convention
  `src/gm/write.ts` already uses for warnings), so `content[0]` stays parseable
  JSON. This is the "`[]` with a note" form: a project with no timelines or no
  sequences answers the empty list plus one sentence saying why.
- **Extra reporting fields**, all additive and never asserted as fact:
  `TimelineSummary.momentsKey` (which root key held the moments, `null` when
  none did) and `foundKeys` on both summaries (the root keys the file actually
  has, present only when the expected collection was missing). This is the
  risk-section mitigation made concrete: the reader never reports a confident
  `0` for a file it could not read the way it expected.
- **`step` / `hasCode` are read, not defined.** `step` is the first finite
  number under `step`/`time`; `hasCode` is true when any `*code*` key holds a
  non-empty string (`code: ""` counts as no code). Both keep the provisional
  names contract 1 already flags; a capture would rename them. **The names are
  provisional: no GameMaker-authored timeline exists on this machine to confirm
  them.** `hasCode` also cannot yet distinguish inline GML from a GML *path*
  (`codeFile`/`eventCodeFile`): a key naming a file counts as code, and that is
  stated in `hasCodePayload`'s comment rather than guessed around.
- **`keyframeCount`** reads `track.keyframes.Keyframes`, the one store form the
  sprite-embedded capture grounds; a track with no store or no such array is
  `0`, and nested sub-tracks are not walked.
- **Per-entry failure is the contract, including unreadable files** (fix pass).
  Neither reader may throw for one resource. `fs.stat` errors are all caught:
  `ENOENT`/`ENOTDIR` reads as a plain "not on disk" (`existsOnDisk: false`, no
  `parseError`); **every other code** (`EACCES`, `EPERM`, `ELOOP`, `EBUSY`, ...)
  returns the entry with `existsOnDisk: false` and `parseError: "<abs path>:
  <message>"`. A directory where the `<name>.yy` belongs reports `parseError`
  ("expected a file, found a directory") rather than passing as missing.
- **A named lookup of a registered-but-vanished resource returns the zeroed
  entry, not an error** (fix pass, intentional deviation from contract 1/6's
  shared "does not exist" rule). `existsOnDisk: false` plus `parseError` when it
  could not be read is more informative than "does not exist": the `.yyp` says
  it exists and the disk disagrees, which is exactly the state a user needs
  named. Only a name the `.yyp` does **not** register raises the error.
- **A crafted name is quoted, never joined** (fix pass). The "does not exist
  (expected <abs path>)" message only builds a path once the requested name
  passes `assertSafeResourceName`; otherwise it says `("<name>" is not a usable
  resource name, so there is no path to expect)`. A name like `../../evil` never
  reaches `path.join`.
- **The sprite-embedded scan is bounded** (fix pass). `MAX_SPRITE_SCAN = 500`
  sprite `.yy` files per `list_sequences` call; the scan returns
  `{ count, scanned, total, truncated, unreadable, unrecognised }`, sorts the
  directories so a truncated scan is deterministic, and the note says the count
  is a **lower bound** whenever `truncated` is true. `unreadable` entries are
  `{ name, reason }` and `unrecognised` names sprites whose `sequence` is a
  record without `resourceType: "GMSequence"` -- counted, but not silently
  normalised. Note prose caps its name lists at five plus "and N more".
- **Test route for the gated types.** No scratch `timelines/` or `sequences/`
  fixture is grounded, so the suite uses deliberately synthetic minimal JSON
  (contracts 1/6's tolerant-parse cases plus malformed, missing-collection,
  unknown-track-type and trailing-comma cases), never a shape presented as a
  capture. `list_sequences`' sprite count is checked against a **copy** of the
  real `spr_jingling1_walk` in the OS temp directory, never the live project;
  the scan cap is exercised on a synthetic 501-sprite tree.
- **Tool count.** The table above is stale in one respect only: the tree was at
  74 tools when this subproject landed (A + E + C + B), not 53. The fired/fired
  row therefore lands on **76**, and the suite's literals assert 76.

## Format facts (verified, do not re-derive)

### Zero coverage today

- `grep -r 'timelines/|sequences/' src/` returns nothing. Neither path is
  written, read, scaffolded, renamed, deleted, or referenced anywhere in the
  server.
- `src/gm/yyp.ts:118` (`ensureProjectScaffold`) creates no `timelines/` or
  `sequences/` directory. A project created by `create_project` has neither.
- The only occurrences of the word "sequence" in `src/` are: `sequenceId: null`
  in a room (`src/gm/rooms.ts:143`), the origin lookup in
  `src/gm/introspect.ts:82`, the sprite-embedded sequence in
  `src/gm/sprites.ts:124-190,220,288-289`, and `spriteSequence` in
  `RESOURCE_VERSIONS` (`src/gm/yyp.ts:27`). None of them touches a sequence
  resource.
- Room `.yy` files write `sequenceId: null` (`src/gm/rooms.ts:143`) and there is
  no tool that sets it. This spec does not add one.

### The animation-curve precedent — what `src/gm/animation_curves.ts` (64 lines) actually does

Three functions, one writer, no reader:

- `newAnimCurveYy(name)` (`:15-26`) — a hardcoded `GMAnimCurve` template: root
  `$GMAnimCurve: ""`, `%Name`, `name`, one channel, `function: 0`,
  `parent: { name: "Animation Curves", path: "folders/Animation Curves.yy" }`,
  `resourceType: "GMAnimCurve"`, `resourceVersion: RESOURCE_VERSIONS.animCurve`
  (`"1.2"`).
- `defaultChannel(channelName)` (`:28-42`) — `$GMAnimCurveChannel: ""`, `%Name`,
  `name`, `colour: 4290799884`, two points from `(0,0)` to `(1,1)` with
  `th0/th1/tv0/tv1` tangent scalars, `resourceType: "GMAnimCurveChannel"`,
  `resourceVersion: RESOURCE_VERSIONS.animCurveChannel` (`"1.0"`), `visible`.
- `addAnimCurve(projectDir, yyp, name)` (`:49-64`) — the whole write path, and
  the pattern D reuses verbatim if the gate ever passes: `validateResourceName`
  → `mkdir animcurves/<name>` → write `<name>.yy` with
  `JSON.stringify(v, null, 2)` → `ensureFolder(yyp, "Animation Curves")` →
  `registerResource(yyp, name, "animcurves/<name>/<name>.yy")` → return `yyp`.
  It does **not** write the `.yyp`; the caller does, under `withProjectLock`.

So the reusable pattern is: one template function per nested record type, one
`*_yy` builder, one thin `add*` that writes the file and registers the resource
and folder node. What it is *not* is evidence for a sequence shape — it is
evidence that this pattern needs a live validator behind it, which is why
`add_timeline`/`add_sequence` are gated on `ProjectTool` acceptance and not on
"looks like the sprite one".

Its reader is separate and lives in the info tools:
`getAnimCurveInfo` (`src/gm/introspect.ts:124-132`) returns
`{ name, channelCount, channelNames, pointCounts }` computed with `?? []` guards
over `channels`/`points`. That is the shape a read-only listing tool should
copy: counts and names, defensive against absent arrays, no key-set assertion.

### The one real `GMSequence` on this machine is embedded in a sprite

`src/gm/sprites.ts:124-190` builds a sprite's embedded sequence, captured from a
real sprite `.yy`. It grounds, for the *embedded* case: the `GMSequence` root
field list (`name`, `length`, `playback`, `playbackSpeed`, `playbackSpeedType`,
`autoRecord`, `volume`, `lockOrigin`, `showBackdrop*`, `xorigin`, `yorigin`,
`eventToFunction`, `eventStubScript`, `visibleRange`, `timeUnits`, `tracks`,
`moments`, `events`, `resourceType`, `resourceVersion`, `$GMSequence`, `%Name`),
the `GMSpriteFramesTrack` fields (`:126-147`), and the empty
`KeyframeStore<MomentsEventKeyframe>` / `KeyframeStore<MessageEventKeyframe>`
stores (`:173-184`).

It does **not** ground: `parent`, any `sequences/` path convention, the root
`resourceVersion` for a standalone sequence resource, `$GMAnimationTrack`,
`KeyframeStore<...>` for any track type other than sprite frames, keyframe
parameter blobs, or `shortcuts`. Treat it as a hint for a future capture, never
as the capture.

### `.yyp` registration seam (already exists, reuse, do not extend)

- `RESOURCE_VERSIONS` — `src/gm/yyp.ts:12-42`, `as const`, one entry per
  sub-structure. It has `spriteSequence`, `spriteFramesTrack`,
  `spriteFrameKeyframe`, `spriteMomentsKeyframes`, `spriteMessageKeyframes` —
  all sprite-internal. It has **no** `timeline`, `sequence`, `sequenceTrack`, or
  `keyframeStore` entry. Any such entry must be added with a captured value; if
  the gate fires, no entry is added at all.
- `registerResource(yyp, name, resourcePath)` — `src/gm/yyp.ts:274-279`, pushes
  `{ id: { name, path } }` if the path is absent.
- `ensureFolder(yyp, name)` — `src/gm/yyp.ts:284-299`, creates the `$GMFolder`
  node at `folders/<name>.yy` on demand. `"Timelines"` / `"Sequences"` need no
  new code, only the call.
- `validateResourceName` — `src/gm/yyp.ts:264-271`, enforces GML-identifier
  safety and project-wide name uniqueness. Timeline and sequence names are GML
  identifiers (`timeline_index`, `sequence_create`), so they take this check,
  unlike free-text layer names.
- `withProjectLock` — `src/gm/yyp.ts:59`, serialises per project. Every write
  path must run inside it, and `writeYyp` (`:212`) must be called by the
  dispatcher exactly as the other `add_*` cases do.

### Reader seam

`readResourceYy(projectDir, category, name)` (`src/gm/introspect.ts:22-33`) does
the whole job: `assertSafeResourceName`, read
`<projectDir>/<category>/<name>/<name>.yy`, `parseGameMakerJson`, and a
path-naming error on `ENOENT`. It is **module-private** — a one-word `export` is
required before wave 1 can use it, which is why that change is owned by the gate
step and not by a parallel wave-1 task.

`parseGameMakerJson` (`src/gm/yyp.ts:85`) tolerates GameMaker's trailing commas,
so a file resaved by the IDE still parses. Reading is therefore always safe;
*writing* is what the gate governs.

### Write seam (subproject E, landed — use it, do not reimplement)

- `writeWithSnapshot(projectDir, file, data, ctx)` — `src/gm/write.ts:89`. Snapshots
  the project first, then calls `atomicWriteFile`; a snapshot failure aborts the
  write, a size-exceeded snapshot is skipped *and reported* in the result rather
  than silently. New write tools pass `{ tool: "<tool_name>", reason }` so the
  snapshot records what caused it.
- `atomicWriteFile` / `atomicWriteJson` — `src/gm/atomic.ts:101,119`. Temp file
  plus rename. A sequence `.yy` is ~10–40 KB and well under
  `SNAPSHOT_MAX_FILE_BYTES` (`:7`); a project with many sprites can approach the
  snapshot limits (`:8-9`), which is E's problem, not D's.
- `AUTO_SNAPSHOT_TOOLS` — `src/gm/write.ts:18`. Every tool D ships as a writer
  must be added to this set, or its writes bypass the snapshot hook entirely.

D writes two files per create (the resource `.yy` and the `.yyp`) through two
separate `writeWithSnapshot` calls; the snapshot taken by the first covers the
project state before either, so an interrupted pair is recoverable with
`restore_snapshot`/`undo_last` (E contracts 3 and 8). This is exactly why D adds
no transaction code of its own.

### Machines and versions (record these, they will drift)

- IDE installed here: **2026.0.0.16** (LTS 2026, Steam).
- `test/verify.ts:91` — the existing `REF` key-sets are "captured from real
  Convoy project files (2026-07-17)".
- `src/gm/animation_curves.ts:8` — the curve capture predates
  **2024.14.4.222** and needed fields added for that IDE.
- Sample project `E:\GMprojects\261103GJ` is **read-only** for this work; its
  sprite sequences carry `resourceVersion: "2.0"` but were not resaved by
  2026.0.0.16, so that value is not proof of what 2026 writes.

## Tool contracts

Common shape, matching the house style in `src/index.ts`:

- Every schema is `ProjectSchema.extend({...})` (`src/index.ts:57-59`).
- The brief names the resource argument `name`; house convention is
  `<type>Name` (`objectName`, `roomName`, `animCurveName`, `tilesetName`), so
  these take `timelineName` / `sequenceName`. Tool names are unchanged.
- Every result is returned as
  `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`,
  like `get_anim_curve_info` (`src/index.ts:944-948`).
- Names go through `assertSafeResourceName` on read and
  `validateResourceName` on create. A missing resource raises the existing
  "does not exist (expected <abs path>)" error; it never returns an empty object.
- Write tools mutate only the fields named in their arguments and write back
  with `JSON.stringify(v, null, 2)` through `writeWithSnapshot`
  (`src/gm/write.ts:89`), never with a bare `fs.writeFile`. Anything a writer
  cannot place from a capture is an error, not a default.

Each contract is tagged with its gate status **as of this machine's research**.
The tags are the acceptance contract: a tool tagged GATED must not be registered
until the gate result for its type flips and this spec is amended with the
evidence.

### Timeline contracts (gate: FIRED → all four writers GATED)

**1. `list_timelines` — SHIPS**

```ts
{ projectDir, timelineName?: string }
```

→ one entry per timeline on disk, or an array of entries when `timelineName` is
omitted:

```ts
{ name, momentCount, moments: [{ step, hasCode }] }
```

- With `timelineName`, a single object; without, an array. A project with no
  `timelines/` directory returns `[]`, not an error.
- `moments` is sorted ascending by `step` in the output regardless of file order.
- The parser is shape-tolerant by construction: it locates the moments
  collection on the parsed object, and for each entry reports the numeric
  position and whether a code payload is present, both read with optional
  chaining. Unknown keys are ignored, never re-emitted.
- **Output field names are provisional.** `step` / `hasCode` are the intended API
  names; if a captured file calls them something else, the *returned* keys follow
  the capture and this section is amended in the same commit as the capture. The
  tool's name, arguments, ordering rule, and error behaviour do not change.

**2. `add_timeline` — GATED**

```ts
{ projectDir, timelineName, moments?: [{ step: number, code?: string }] }
```

- Would write `timelines/<name>/<name>.yy` from the captured root key set, with
  `moments` sorted by `step`, one moment object per entry, and code stubs as the
  capture dictates; then `ensureFolder(yyp, "Timelines")`,
  `registerResource(yyp, name, "timelines/<name>/<name>.yy")`, `writeYyp` — all
  inside `withProjectLock`.
- Every key the capture does not show is absent, not defaulted.
- Code-bearing moments are additionally sub-gated; without a capture of a coded
  moment, `code` is rejected.
- Refuses a duplicate `step` in the input, a non-integer `step`, and a negative
  `step`; refuses a name that already exists (via `validateResourceName`) before
  creating the directory.

**3. `add_timeline_moment` — GATED**

```ts
{ projectDir, timelineName, step: number, code?: string }
```

- Refuses a step already occupied, naming the existing step in the error.
- Returns the resource's new `momentCount`.

**4. `edit_timeline_moment` — GATED**

```ts
{ projectDir, timelineName, step: number, code: string }
```

- Replaces the code payload of the moment at `step`; error if no moment sits at
  that step. `code: ""` is a legal, distinct value from "no code".
- A call whose payload is byte-identical to the current one reports "unchanged"
  and does not rewrite the file.

**5. `remove_timeline_moment` — GATED**

```ts
{ projectDir, timelineName, step: number }
```

- Removes exactly one moment; error if absent. Removing the last moment leaves a
  valid, empty timeline (the capture decides whether that is `[]` or an omitted
  key — do not normalise).

### Sequence contracts (gate: FIRED → both writers GATED)

**6. `list_sequences` — SHIPS**

```ts
{ projectDir, sequenceName?: string }
```

→ one entry per sequence, or an array when `sequenceName` is omitted:

```ts
{ name, length, playbackSpeed, trackCount,
  tracks: [{ name, type, keyframeCount }] }
```

- `type` is the track's `resourceType` string as found in the file (e.g.
  `"GMSpriteFramesTrack"`), never a normalised enum of our invention — a track
  type we have never seen must still list.
- `keyframeCount` counts the keyframes present in the track's store; a track with
  no store, or a store with no `Keyframes`, reports `0`.
- `length` and `playbackSpeed` pass through as-is when present, `null` when the
  file does not have them. Numbers are not rounded and not coerced.
- A missing `sequences/` directory returns `[]`.
- Same provisional-field-name caveat as `list_timelines`.

**7. `add_sequence` — GATED**

```ts
{ projectDir, sequenceName, length: number, playbackSpeed?: number }
```

- Would write the **minimal** valid sequence: exactly one animation track of the
  captured sprite-frame type, containing exactly one keyframe pointing at a
  sprite, plus whatever required empty stores the capture shows. Nothing else —
  no colour track, no moments, no events, no shortcuts.
- `playbackSpeed` defaults to the captured file's own default, not to a number
  invented here; if the capture has no default, the argument is required.
- The gate's `ProjectTool` requirement is part of the contract: a sequence that
  loads but renders nothing in the editor is a failure, so the writer's
  acceptance includes opening a project that contains it.
- `length` must be a positive integer; `playbackSpeed` a positive finite number.

**8. `set_sequence_sprite_track` — GATED**

```ts
{ projectDir, sequenceName, trackIndex?: number, spriteName: string, frameCount?: number }
```

- The only mutation this subproject supports: retarget the single animation
  track's sprite reference (and, when `frameCount` is given, its keyframe count),
  leaving every other field byte-identical.
- `trackIndex` defaults to `0` and must address a track whose type is the
  captured sprite-frame track type; anything else is an error naming the track
  type found.
- `spriteName` resolves to `{ name, path }` against `sprites/<n>/<n>.yy`; an
  unknown sprite errors with the expected absolute path (same rule as
  `edit_object`).
- `frameCount` is bounded to the sprite's frame count; exceeding it is an error,
  not a clamp.

## Acceptance criteria

Universal (holds whichever way the gates go):

- `npm run typecheck` (`tsc --noEmit`) clean.
- `npm test` green, with **every pre-existing assertion untouched** — new checks
  are appended, never edited, and the summary line reports the same
  skip-reason list as before.
- Each shipped tool has three regression blocks in `test/verify.ts`: fully
  populated arguments, omitted/default arguments (only where the contract has
  defaults), and an error case (`expectThrows`) — the same rule subproject A
  applied.
- `list_*` tools are exercised against a project with **no** `timelines/` /
  `sequences/` directory (`[]`, no throw), against a synthesised fixture file
  with unknown extra keys and a missing optional array (tolerant parse), and
  against a file with trailing commas (resaved-by-IDE simulation).
- JSON key order of untouched files is preserved; a listing tool never writes.
- `README.md:47-79` gains a **Timelines** line and a **Sequences** line listing
  exactly the tools that shipped, with the gated ones absent. The tool count in
  the docs matches `TOOL_DEFS` exactly:

  | Timelines | Sequences | Tools added | Total |
  |-----------|-----------|-------------|-------|
  | pass | pass | 8 | 61 |
  | pass | fired | 6 | 59 |
  | fired | pass | 4 | 57 |
  | **fired** | **fired** | **2** | **55** |

  The suite asserts the real `TOOL_DEFS` length and the real schema objects by
  importing `src/index.ts` (it only opens a transport as entry point), so a
  half-registered build fails loudly instead of shipping.

If the gate fires for a type (the state today):

- That type is **list-only**: `list_timelines` / `list_sequences` are registered
  and the four/four write tools are **not** registered anywhere — no schema, no
  `TOOL_DEFS` entry, no `dispatchTool` case, no dead `case` comment.
- No `RESOURCE_VERSIONS` entry is added for that type, and no template function
  exists in the module — the module contains the reader and nothing else.
- `list_sequences` is verified against the *real* sprite-embedded
  `GMSequence` in `E:\GMprojects\261103GJ` only to the extent that it proves the
  parser does not choke on a deep nested object; it does not assert a standalone
  shape, and it must not be described in the README as sequence authoring.

If the gate passes for a type:

- `ProjectTool` (found via `findProjectTool`, `test/verify.ts:29,1045-1069`)
  accepts a **scratch** project in the OS temp directory that contains the
  generated resource; the check skips with a printed reason when the tool is not
  installed, and the skip is reported in the summary, never hidden.
- `REF` gains one key set per nested object the writer touches, populated from
  the captured sample, including the omitted/default case.
- The generated file is opened once in the IDE by the human operator (a
  checklist item, not an automated step): the resource appears in the asset
  browser under the right folder, and the sequence/timeline plays.

## Risks

- **Version drift is the primary risk.** Sequence and timeline formats are
  versioned per sub-structure and GameMaker bumps them independently
  (`RESOURCE_VERSIONS`, `src/gm/yyp.ts:8-11` documents this exact lesson). A
  capture from 2024.14.4.222 (the version `animation_curves.ts` was corrected
  against) is not evidence for 2026.0.0.16, which is what is installed here. Every
  capture must record the producing IDE version next to it, and the gate must be
  re-run when the IDE updates.
- **A minimal hand-written sequence can be loadable and unusable.** The IDE may
  accept the file and render nothing because a required track, store, or playback
  field is missing. Structural key-set equality cannot detect this; only
  `ProjectTool` plus a human open can. That is precisely why `add_sequence` is
  gated rather than "written carefully".
- **Timeline code stubs depend on an unverified file-naming convention.** If
  moment code is externalised to GML rather than inlined in the `.yy`, the file
  name, the `.gml` placement, and whether a `GMScript` resource must be
  registered are all unknown here. Getting it wrong produces a timeline whose
  moments silently do nothing. The sub-gate forbids shipping `code` until a
  captured file answers all three questions.
- **Adding the reader is not free either.** A tolerant parser can still be wrong
  in a way that *looks* right: reporting `momentCount: 0` on a file whose moments
  live under a differently-named key would be silently misleading. Mitigation:
  the listing tools report the key names they actually found when they cannot
  find the expected collection, rather than reporting zero.
- **Choke points.** `src/index.ts`, `test/verify.ts`, `README.md` and
  `src/gm/yyp.ts` are single-file choke points; `RESOURCE_VERSIONS` and the
  `readResourceYy` export both live in shared files. The wave structure in
  `docs/plans/D-sequences-timelines.md` exists to keep parallel agents off them.
- **Adjacent tools do not know these resources.** `find_references`,
  `delete_resource` and `rename_resource` (`src/gm/references.ts`,
  `src/gm/delete.ts`, `src/gm/rename.ts`) will not see references from a
  sequence or timeline, and a renamed timeline's `.yy` path is not rewritten.
  Out of scope here, but it must be stated in the README line rather than
  discovered later by a user.
- **No multi-file transaction inside D.** A timeline create touches
  `timelines/<n>/<n>.yy` and the `.yyp` as two writes. E's snapshot hook covers
  the recovery path, but the two files are still briefly out of step; the
  acceptance and the README must not claim otherwise.
