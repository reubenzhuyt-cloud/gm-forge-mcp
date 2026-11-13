# Spec B — Sprite frame editing

Status: draft · Scope: subproject B · Repo: `gm-forge-mcp`

## Goal

`src/gm/sprites.ts` (300 lines) can create a sprite from a folder of PNGs
(`addSpriteFromImages`, :229-250) and can edit origin, collision kind and
bounding box (`editSprite`, :270-300) — origin handling is :287-291. It cannot
change the frame list afterwards at all. A sprite imported with one frame stays
that way; a sprite imported with a wrong ordering can only be fixed by deleting
the resource and re-importing it, which regenerates every guid and breaks any
room instance that referenced an `imageIndex`.

Deliver six new MCP tools that make the frame list first-class:

1. `list_sprite_frames` — the frame/sequence state of a sprite, with a
   consistency verdict (there is currently no reader that even looks at
   `frames[]`, let alone at the sequence: `getSpriteInfo` in
   `src/gm/introspect.ts:75` reports only `sprite.frames.length`).
2. `add_sprite_frame`
3. `remove_sprite_frame`
4. `replace_sprite_frame`
5. `reorder_sprite_frames`
6. `trim_sprite_frames`

All six are additive: `add_sprite_from_images`, `edit_sprite` and
`get_sprite_info` keep their arguments, output and errors.

## Non-goals

- No drawing, no pixel editing, no compositing: every tool takes an existing
  PNG from disk verbatim or moves/deletes one already in the sprite.
- No texture-group assignment (`textureGroupId` is preserved byte-for-byte) and
  no texture-page packing.
- No nine-slice / border editing (`nineSlice` is preserved verbatim; the
  existing `edit_sprite` already covers bbox and origin).
- No sprite *layers*: no adding a second `GMImageLayer`, no per-frame layer
  merging, no layer visibility editing. A frame is one flattened PNG copied to
  the two places GameMaker expects (see format facts).
- No automatic atlas/strip packing or import-time splitting of a strip into
  frames — `trim_sprite_frames` is range selection over existing frames, not a
  strip importer.
- No `spr_*.yy` key reordering: files keep the insertion order that
  `JSON.stringify` produces (same convention as every other writer here), never
  GameMaker's alphabetical order.
- No migration of older sprite formats, no repair of a sprite that is already
  inconsistent: the reader reports, the writers refuse.

## Format facts (verified, do not re-derive)

Sample project: `E:\GMprojects\261103GJ` — **read-only**, never written by this
subproject. `MetaData.IDEVersion` is `"2026.0.0.16"` (`261103GJ.yyp:27-29`) and
every sprite resource is `resourceVersion: "2.0"`.

- Sprite IO path: `sprites/<name>/<name>.yy`, resolved through
  `assertSafeResourceName` (`src/gm/yyp.ts:247`). Read with
  `parseGameMakerJson` (`yyp.ts:85-113`, tolerates GameMaker's trailing commas),
  write with `JSON.stringify(v, null, 2)`.
- **A sprite frame is two files, not one.** `importFrames`
  (`sprites.ts:51-75`) writes the composite `sprites/<name>/<frameGuid>.png`
  (:67) *and* `sprites/<name>/layers/<frameGuid>/<layerGuid>.png` (:69-71),
  where `<layerGuid>` is the single entry in the sprite's `layers[]` array. The
  comment at :44-49 and the assertion at `test/verify.ts:435-437` both record
  why: GameMaker refuses to load a project whose sprite is missing the
  per-layer copy, even though it duplicates the composite. Every add/replace/
  remove path must handle both copies or the sprite is broken in a way no
  `.yy`-only diff can see.
- The real sample `sprites/spr_jingling1_walk` (64x64, 4 frames, origin 32,64)
  has exactly one layer, `6a677a4f-1c61-9ebf-eeab-77029a4855f7`
  (`spr_jingling1_walk.yy:24-26`), and `layers/6a677a4f-…/` contains one PNG.
- `frames[]` entries are 5-key objects (`spr_jingling1_walk.yy:14-19`):

  ```json
  {"$GMSpriteFrame":"v1","%Name":"b4e5ad93-ecac-d0f7-2697-25e9b73e88d6",
   "name":"b4e5ad93-ecac-d0f7-2697-25e9b73e88d6",
   "resourceType":"GMSpriteFrame","resourceVersion":"2.0"}
  ```

  `name` and `%Name` are the same guid, and that guid is the png's filename.
  The guids are IDE-generated and **not** RFC-4122 v4 (`b4e5ad93-ecac-d0f7-…`),
  so nothing may validate or normalise guid shape. The pngs on disk are named
  for those guids (`spr_jingling1_walk/{b4e5ad93-…,a0ce69f8-…,f0c6766d-…,
  df59ec7e-…}.png`).
- `sequence.tracks` has exactly one entry whose `name` is `"frames"` and whose
  `resourceType` is `"GMSpriteFramesTrack"` (`spr_jingling1_walk.yy:72-87`),
  15 keys: `$GMSpriteFramesTrack`, `builtinName`, `events`,
  `inheritsTrackColour`, `interpolation`, `isCreationTrack`, `keyframes`,
  `modifiers`, `name`, `resourceType`, `resourceVersion`, `spriteId`,
  `trackColour`, `tracks`, `traits`. Its `keyframes` store has 4 keys:
  `$KeyframeStore<SpriteFrameKeyframe>`, `Keyframes`, `resourceType`,
  `resourceVersion`.
- A keyframe is a 10-key object (`spr_jingling1_walk.yy:74-76`, one per frame,
  in frame order):

  ```json
  {"$Keyframe<SpriteFrameKeyframe>":"","Channels":{
     "0":{"$SpriteFrameKeyframe":"",
          "Id":{"name":"b4e5ad93-ecac-d0f7-2697-25e9b73e88d6",
                "path":"sprites/spr_jingling1_walk/spr_jingling1_walk.yy"},
          "resourceType":"SpriteFrameKeyframe","resourceVersion":"2.0"}},
   "Disabled":false,"id":"8cc4c110-4f74-6359-19ab-ac12911c6181",
   "IsCreationKey":false,"Key":0.0,"Length":1.0,
   "resourceType":"Keyframe<SpriteFrameKeyframe>","resourceVersion":"2.0",
   "Stretch":false}
  ```

  Note `Channels["0"].Id.name` is the **frame guid**, `Id.path` points back at
  the sprite's own `.yy`, and the keyframe's own `id` is a *different* guid
  that is not present in `frames[]`. `Key` is the 0-based position and `Length`
  is always `1.0`.
- The existing writer already reproduces these shapes exactly:
  `frameEntry` (`sprites.ts:77-85`), `frameKeyframe` (:102-122),
  `sequenceEntry` (:124-190). Reuse that key set verbatim; do not invent fields.
- **`sequence.length` counts frames, not seconds.** The 4-frame sample has
  `length: 4.0`, `playbackSpeed: 10.0`, `playbackSpeedType: 0`, `timeUnits: 1`
  (`spr_jingling1_walk.yy:55,64-65,71`); every 1-frame sprite in the project has
  `length: 1.0` (with `playbackSpeed: 30.0`). So the captured relation is

  ```
  sequence.length == keyframe count == frames.length
  ```

  `frameCount / playbackSpeed` would be `0.4` for the sample and is **wrong**:
  `playbackSpeed` only sets the playback rate. This invariant is the one to
  implement; `length` is never derived from fps.
- `playbackSpeed`, `playbackSpeedType`, `timeUnits`, `volume`, `lockOrigin`,
  `xorigin`, `yorigin`, `moments`, `events`, `visibleRange`, `parent` and
  `textureGroupId` are per-sprite settings and must survive a frame edit
  untouched. The sample has `lockOrigin: true` and `swfPrecision: 2.525`;
  `sprites.ts` writes `lockOrigin: false` and `swfPrecision: 0.5` instead. That
  divergence is pre-existing and out of scope for B — a frame tool must preserve
  whatever value it finds, never "correct" it.
- `frames[].name` order and keyframe order agree in both real multi-frame
  sprites (`spr_jingling1_walk`, `spr_jinglin3_walk`), and `Key` runs `0..N-1`.
  Order is still matched **by guid**, never by position, on input; the output
  order is then asserted.
- The `.yyp` is **not** touched by any frame edit: the sprite resource is
  already registered (`registerResource`, `yyp.ts:274`). No `loadYyp`, no
  `writeYyp`, no `TextureGroups` change.
- Atomic writes: `writeYyp` (`yyp.ts:212-223`) and `writeRoomYy`
  (`room_layers.ts:52-68`) both use temp-file-plus-rename with a distinctive
  `EPERM`/`EACCES` message for the IDE holding the file. Sprite writes get the
  same treatment; a crash must not truncate a `.yy`.
- Tests are the hand-rolled `test/verify.ts` (`npm test` → `tsx`), 415
  assertions as of 2026-11-13, with `REF` key-sets captured from real GameMaker
  files (`verify.ts:92-128`; sprite-related ones at :115-128) and
  `keysMatchRef()` at :217-222. The sprite block is :417-444.
- `test/fixtures/` holds one PNG, `frame0.png` (16x24). Every new image fixture
  is needed because the existing suite has exactly one frame to work with.

## Tool contracts

Common shape: `projectDir` is the first argument, `spriteName` is the sprite
resource name, indices are 0-based, each schema is
`ProjectSchema.extend({...})`. Every write path reads the `.yy` once, mutates
the parsed object, validates, and writes back only if the serialised result
differs from the pre-write serialisation. Every validation failure throws
before any bytes are written or deleted; when a sprite mutation and its png
operations both fail, the `.yy` is written last so a half-applied frame list
cannot survive (see "Write ordering" below).

### 1. `list_sprite_frames`

```ts
{ projectDir: string, spriteName: string } →
{ width, height,
  origin: { x, y },
  frameCount,
  frames: [{ index, guid, file, existsOnDisk }],
  sequence: { length, playbackSpeed, playbackSpeedType, keyframeCount },
  verdict: string,            // "ok" | "frames-vs-sequence mismatch: N vs M"
  missingFiles: string[] }
```

- `origin` comes from `sequence.xorigin/yorigin` — the authoritative pair, the
  same source `getSpriteInfo` uses (`introspect.ts:75+`); the top-level
  `origin` preset (7 = bottom centre for 32,64) is a UI label and is reported
  nowhere.
- `file` is the project-relative path `sprites/<name>/<guid>.png`.
  `existsOnDisk` is true only when **both** copies exist (composite and
  `layers/<guid>/<layerGuid>.png`); `missingFiles` names every absent path, so
  a sprite that GameMaker would refuse to load is visible without opening it.
- `keyframeCount` is `Keyframes.length` of the single `frames` track.
  `verdict` is the literal string `ok` when `frames.length === keyframeCount`
  and every png is present, otherwise
  `frames-vs-sequence mismatch: <frames.length> vs <keyframeCount>`
  (`missingFiles` covers the all-present half of the check).
- Read-only by construction: this tool never opens a file for writing, and a
  test asserts the `.yy` hash is unchanged after a call.

### 2. `add_sprite_frame`

```ts
{ projectDir: string, spriteName: string,
  sourceImagePath: string, index?: number } →
{ spriteName: string, index: number, frameCount: number }
```

- `index` omitted (or equal to `frameCount`) appends; otherwise `0..frameCount-1`
  inserts before that frame. Out of range → error naming the valid range.
- `sourceImagePath` must exist and be a readable PNG whose IHDR dimensions equal
  the sprite's `width`/`height` (`readPngDimensions`, `sprites.ts:14-27`).
  Anything else is an error naming both sizes — no implicit resize, because
  GameMaker requires every frame of a sprite to be the same size.
- A **fresh** `crypto.randomUUID()` becomes the frame guid, exactly as
  `importFrames` does (`sprites.ts:64`); reusing the source file's name or an
  existing guid would make two `frames[]` entries share one png. Write both
  copies (composite + `layers/<newGuid>/<layerGuid>.png`) before inserting.
- Insert a `frames[]` entry (5 keys) at `index`, and a keyframe at the same
  position with a fresh keyframe `id`, `Channels["0"].Id.name = newGuid`,
  `Key = index`, `Length = 1.0`; renumber all following `Key`s; set
  `sequence.length = frameCount`.
- Returns the new `frameCount`.

### 3. `remove_sprite_frame`

```ts
{ projectDir: string, spriteName: string, index: number } →
{ spriteName: string, frameCount: number, removedGuid: string }
```

- Refuses when `frameCount === 1`: "cannot remove the last frame from
  <sprite>; delete the resource instead" — a zero-frame sprite is not a thing
  GameMaker can load.
- Splices `frames[index]` and the keyframe whose channel points at that guid,
  renumbers `Key`, sets `length = frameCount`, then deletes the composite png
  and the `layers/<guid>/` directory (rm -r, both copies, no orphan png left
  behind — an orphan png is silently re-adopted by nothing and shows up as
  untracked noise in the user's project).
- Deletion happens **after** the `.yy` is written (see "Write ordering"): a crash
  between the two leaves an unreferenced png, which does not stop GameMaker
  loading the project — the reverse order would leave the `.yy` pointing at a
  png that no longer exists, which does.

### 4. `replace_sprite_frame`

```ts
{ projectDir: string, spriteName: string, index: number,
  sourceImagePath: string, allowResize?: boolean } →
{ spriteName: string, index: number, width: number, height: number,
  changed: boolean }
```

- The frame **guid is kept**: `frames[index]`, the keyframe channel and both png
  filenames are unchanged, so any `imageIndex` in a room stays valid. Only the
  bytes change (both copies).
- Default (`allowResize` omitted/false): the source PNG's dimensions must equal
  `width`/`height`, else the call throws naming both sizes and the frame index.
- `allowResize: true` is only legal when `frameCount === 1`; for a multi-frame
  sprite it throws, because shrinking/growing one frame would leave the other
  frames at the old size, which GameMaker cannot load. When it does apply, it
  updates `width`/`height`, and rewrites `bbox_left/top/right/bottom` **only if**
  the bbox is automatic (`bboxMode !== 2`) *and* is the full-frame default
  (`0, 0, width-1, height-1`); a custom or manual bbox is left alone and is
  instead checked against the new size. `sequence.xorigin/yorigin` must satisfy
  `0 <= xorigin <= width` and `0 <= yorigin <= height` for the new size — the
  bounds are inclusive, because the bottom-centre preset legitimately puts
  `yorigin` at the height and a real sprite has `xorigin == width` — and an
  origin that is not two finite numbers is refused as well. If either check
  fails the call throws instead of clamping, so a deliberate origin is never
  silently moved.
- Byte-identical source → `changed: false`, and the `.yy` is not rewritten
  (both pngs are still rewritten only if their bytes differ; a copy over
  identical bytes is skipped).

### 5. `reorder_sprite_frames`

```ts
{ projectDir: string, spriteName: string, order: number[] } →
{ spriteName: string, frameCount: number, changed: boolean }
```

- `order` must be a permutation of `0..frameCount-1`: same length, every value
  an integer in range, no duplicates. A duplicated or missing index throws with
  the offending value, rather than producing a sprite with a repeated frame.
- Rewrites `frames` as `order.map(i => oldFrames[i])` and rewrites the keyframe
  list so position `k` holds the keyframe belonging to `frames[k]` — each
  keyframe's own `id` travels with its frame guid, so no keyframe is regenerated
  and nothing else in the sequence changes. `Key` is renumbered `0..N-1`;
  `length` is unchanged (still `frameCount`).
- The identity permutation returns `changed: false` and does not touch the file.

### 6. `trim_sprite_frames`

```ts
{ projectDir: string, spriteName: string, from: number, to: number } →
{ spriteName: string, frameCount: number, removed: number }
```

- Keeps the contiguous inclusive range `from..to` (the usual cleanup after
  importing a strip that begins with padding frames). `0 <= from <= to <=
  frameCount-1`, else an error naming the range and the frame count.
- Frames outside the range are removed exactly as `remove_sprite_frame` removes
  them: keyframe out, `Key`s renumbered from 0, `length` set to the surviving
  count, both png copies deleted.
- `from === 0 && to === frameCount-1` is a no-op: `removed: 0`, `frameCount`
  unchanged, file untouched. Reducing to a single frame is legal (unlike
  `remove_sprite_frame`, this cannot reach zero frames because the range is
  non-empty).

## Sequence rewrite contract

Every mutation above funnels through **one** internal rewrite function; the six
tools differ only in what they hand it. This is where the subproject's difficulty
lives, and where hitting an unexpected shape must mean *refuse*, not guess.

1. Locate the track by `name === "frames" && resourceType === "GMSpriteFramesTrack"`
   inside `sequence.tracks`. Zero matches → `sprite "<name>" has no frames track
   in its sequence; refusing to edit frames it cannot describe`. More than one →
   refuse. Never index `tracks[0]` blindly.
2. `frames[]` and `Keyframes[]` must be the same length **before** the mutation
   and every `frames[i].name` must appear exactly once as a
   `Channels["0"].Id.name`. If the input already disagrees, refuse with the
   counts and the offending guids: the tool cannot know which side is
   authoritative, and rewriting the sequence to match `frames` would silently
   change an animation the user authored in the IDE. (Only `list_sprite_frames`
   reports a mismatch; nothing repairs one.)
3. Rebuild the keyframe list from the new frame order, reusing each existing
   keyframe object for a surviving frame (its `id`, `Disabled`, `IsCreationKey`,
   `Stretch`, `Length` and `Channels["0"].Id.path` are preserved), and creating a
   fresh keyframe only for a genuinely new frame. Then set `Key = index` for all
   entries and `sequence.length = frameCount`.
4. Preserve every other sequence key verbatim (see format facts). In particular
   do not touch `playbackSpeed`, `playbackSpeedType`, `xorigin`, `yorigin`,
   `lockOrigin`, `moments`, `events`.
5. Post-conditions, asserted in-process before writing:
   - `frames.length === Keyframes.length === sequence.length`;
   - `Key[i] === i` for every keyframe;
   - the multiset of `Channels["0"].Id.name` equals the set of `frames[].name`,
     with no duplicates;
   - every referenced guid has both pngs on disk.
   A violation throws and writes nothing.
6. Serialise with `JSON.stringify(v, null, 2)`. The file keeps the writer's key
   order and normalises float spelling (`4.0` → `4`, `2.525` stays `2.525`); the
   IDE accepts this (already shipped by `add_sprite_from_images`). It is not
   byte-fidelity with an IDE resave, which is why an untouched sprite must never
   be rewritten.

## Write ordering

For each mutation: read → validate → mutate the in-memory object → run the
post-conditions → create/overwrite any new png copies → write the `.yy`
atomically → **then** delete any dropped png copies. A failure before the `.yy`
write leaves at most an extra png (harmless); a failure after it leaves a
complete, loadable sprite and at most one orphan png. The alternative ordering
(delete first) can leave a sprite referencing a png that no longer exists, which
is the failure mode GameMaker actually refuses to load.

## Acceptance criteria

- `npm run typecheck` clean.
- `npm test` green: `415 passed, 0 failed, 0 skipped` today (verified by running
  it during spec authoring) plus at least 70 new assertions, landing at
  **≥ 485 passed, 0 failed**. Pre-existing assertions are untouched except:
  the three tool-count totals at `test/verify.ts:1956-1960` become **59** (labels
  updated to "53 existing + 6 new"), the tool-name list at :1950-1951 gains the
  six new names, and the README-documentation assertion at :1961-1963 covers
  them.
- Every write path has, in `test/verify.ts`: a populated case, an
  omitted/default case (`add_sprite_frame` without `index`,
  `replace_sprite_frame` without `allowResize`), and an error case. Error cases
  covered explicitly: index out of range, missing source file, non-PNG source,
  size mismatch on add and on replace, `allowResize` on a multi-frame sprite,
  removing the last frame, non-permutation `order`, duplicate index in `order`,
  `trim` with `to < from`.
- New `REF` key-sets captured from `spr_jingling1_walk` and asserted with
  `keysMatchRef()`: the `frames[]` entry (already `REF.spriteFrame`), the frames
  track (15 keys), the keyframe store (4 keys), the keyframe (10 keys), the
  `Channels["0"]` entry (4 keys) and its `Id` (2 keys). No field may be invented
  for any of them.
- A test that `frames.length === keyframe count === sequence.length` holds after
  each of `add`, `remove`, `reorder` and `trim`, on a sprite that started with
  4 frames (so removal leaves 3, trim to `1..2` leaves 2, and so on).
- A test that a no-op call does not touch the `.yy`: sha256 before/after for
  `reorder` with the identity permutation, `trim` over the full range,
  `replace` with byte-identical source, and a plain `list_sprite_frames` call.
- A test that a frame add creates **both** pngs and a remove deletes **both**,
  and that the new guid is not any pre-existing guid.
- ProjectTool passes (`lint_project`) on a scratch project built by
  `create_project` that contains a mutated sprite (added, reordered and trimmed
  in one sprite), run once at the wave-2 gate with GameMaker closed. When
  GameMaker is not installed the check skips and the skip is reported — the
  suite's rule is that a skip must be visible, not silent.
- Read-only smoke on the real sample: `list_sprite_frames` on
  `spr_jingling1_walk` reports `64x64`, 4 frames, origin `{x:32,y:64}`,
  `length: 4`, `playbackSpeed: 10`, `keyframeCount: 4`, `verdict: "ok"`. The
  test is skipped when `E:\GMprojects\261103GJ` is absent.
- `README.md:61` lists the six new tools under **Sprites**, and the tool count
  is 59 everywhere it is stated.
- Nothing in this subproject writes to `E:\GMprojects\261103GJ`.

## Risks

- Sequence keyframe semantics are version-dependent. The captured shapes are
  from IDE `2026.0.0.16` with `resourceVersion: "2.0"`; pre-2023 projects used a
  different `GMSequence` and older keyframe stores. The tools refuse an
  unrecognised shapeset instead of migrating it, and the spec makes no promise
  for projects older than the sample.
- Frame pngs are referenced by guid: a copy that reuses a guid makes two frames
  resolve to one image, which looks fine in JSON and wrong in the IDE. Fresh
  `crypto.randomUUID()` per frame, and a post-condition that the guid appears
  once.
- The IDE caches sprite frames. After a mutation the user may need to reopen
  the sprite (or restart GameMaker) before the change is visible; the tools'
  own report is the source of truth in the meantime.
- A `frames`/sequence mismatch is silently accepted by the JSON layer and by
  `get_sprite_info`; it only surfaces as a broken animation. That is why the
  invariant is asserted before every write and exposed as a verdict on read.
- ProjectTool's sprite validation is shallow: it catches dangling frame
  references and missing pngs, not wrong keyframe ordering. The in-process
  post-conditions carry the ordering guarantee; ProjectTool is a second,
  independent check, not the primary one.
- `replace_sprite_frame` with `allowResize` deliberately refuses multi-frame
  sprites. A user who genuinely needs to resize an animation must re-import it;
  silently resizing one frame of four is the corrupting alternative.
- Windows file locks: an open sprite in the IDE makes the `.yy` rename fail with
  `EPERM`/`EACCES`. Reuse `writeRoomYy`'s message (`room_layers.ts:59-65`) so the
  advice ("close the sprite and retry") is the same everywhere.
- Parallel work contends on `src/index.ts`, `test/verify.ts` and `README.md`;
  implementation is wave-based (see `docs/plans/B-sprite-frames.md`).

## Shipped (wave 2, 2026-11-13)

This section records what actually landed and supersedes the projection numbers
in "Acceptance criteria" (415 → 485 assertions, 53/59 tools), which were written
before subprojects A, C and E merged. The tree went from **68 to 74 tools** and
from **734 to 862 assertions** (`862 passed, 0 failed, 0 skipped`).

- **Module.** `src/gm/sprite_frames.ts` is unchanged from wave 1 apart from being
  reached over MCP for the first time: one sequence-rewrite routine
  (`rewriteFrames`), one pre-mutation agreement check, one structural
  post-condition, one disk post-condition, and exactly two png code paths
  (`writeFramePngs`/`deleteFramePngs`). `sprites.ts` only gained `export` on
  `frameEntry` and `frameKeyframe`.
- **`allowResize` decision.** Exposed on `replace_sprite_frame` only, defaulting
  to `false` in the zod schema *and* in the module, so the flag is opt-in at the
  tool boundary rather than a schema field the module then rejects. It is refused
  for a multi-frame sprite (one frame at a different size is exactly what
  GameMaker cannot load) and accepted on a single-frame sprite, where it rewrites
  `bbox_*` only if they were the full-frame default and refuses if
  `sequence.xorigin/yorigin` would fall outside the new bounds. No clamping, no
  implicit resize on `add_sprite_frame`, no re-encode anywhere.
- **Two-png invariant.** Every write path touches the composite
  `sprites/<name>/<guid>.png` *and* `sprites/<name>/layers/<guid>/<layerId>.png`;
  every drop deletes both (the layer directory with `rm -r`). Images are created
  before the `.yy` and deleted after it. A sprite with anything other than exactly
  one image layer is refused, because the per-layer path would be ambiguous.
- **`sequence.length` semantics.** It counts frames, not seconds. Every writer
  sets `length = frameCount` after rebuilding the keyframe list and never derives
  it from `playbackSpeed`; `playbackSpeed`, `playbackSpeedType`, `timeUnits`,
  `xorigin`, `yorigin`, `lockOrigin`, `moments` and `events` are preserved
  verbatim.
- **Verdict grammar.** `list_sprite_frames.verdict` is the literal `"ok"` when
  `frames.length === keyframeCount`, otherwise exactly
  `"frames-vs-sequence mismatch: N vs M"`. Missing pngs are *not* folded into the
  verdict: they are listed path-by-path in `missingFiles` and reflected in
  `frames[].existsOnDisk`, and the verdict stays `"ok"` in that case (this is how
  the spec's "missingFiles covers the all-present half of the check" was
  implemented, and a test pins it).
- **Refusal ordering.** `remove_sprite_frame` tests "this is the last frame"
  before the index range, so removing index 0 of a one-frame sprite reports the
  delete-the-resource advice rather than an out-of-range error. Every other
  writer validates the existing `frames`/`Keyframes` agreement first, so an
  already-inconsistent sprite is refused with both counts before any argument is
  examined.
- **Snapshot wiring.** The five writers are on `AUTO_SNAPSHOT_TOOLS` (24 members);
  `list_sprite_frames` is not. A refused call still leaves exactly one snapshot
  recorded `failed: true`; a call that changes nothing has its snapshot discarded,
  so a no-op costs no retention slot.
- **Gaps the sample could not ground, and how they are handled.**
  - Only a single-layer sprite exists in `261103GJ`, so the record shape for a
    second `GMImageLayer` is unverified — the tools refuse a sprite with zero or
    several image layers instead of picking one.
  - The real sample is one 4-frame, 64x64 sprite; multi-size, `allowResize` and
    all refusal paths are exercised only on synthetic sprites built from
    `test/fixtures/frames/*.png`. Those fixtures live in a sub-directory because
    an existing assertion imports every top-level PNG under `test/fixtures/` as
    one sprite's frames and would fail on the 24x24 / 16x32 files.
  - No 2026-era sample has a hand-edited (inconsistent) sequence, so the
    mismatch path is covered by injecting a 4-vs-3 mismatch in a test copy.
  - The read-only smoke test runs against a **copy** of `spr_jingling1_walk`
    under `%TEMP%`, never the live project, so a user's hand edits cannot turn it
    red.
  - **Resize limits.** A single-frame `allowResize` changes the picture, the
    bbox (only when it is the automatic full-frame one) and the frame pngs. It
    does **not** repack a texture page, re-derive a shrunken/tightened collision
    mask, or rewrite `nineSlice`: a mask or nine-slice border that would fall
    outside the new frame is refused (the existing values are never shrunk for
    the user), and texture-page repacking stays the IDE's job on its next save.
    A multi-frame animation is never resized at all — re-import it instead.
  - The sample has no sprite with a hand-edited, non-numeric origin, so the
    "origin is not two finite numbers" refusal is covered only by injecting one
    in a test copy.
- **Refusal messages added by the hardening pass** (all raised before anything is
  written, and each pinned by a test):
  - a frame guid / image-layer name that is not a single safe path component
    (`cannot be ".."`, `must be a single path segment -- ...`, `reserved Windows
    device name (CON)`) — a guid is used as `sprites/<sprite>/<guid>.png` and as
    the `layers/<guid>/` directory a removal deletes, so it is validated as a
    path, not just an identifier;
  - `has 0 image layers` / `has 2 image layers` (was already there, now tested);
  - `has no frames track` / `has 2 frames tracks` (likewise);
  - `lists the frame guid <g> more than once` / `more than one keyframe for the
    frame guid <g>`;
  - `keyframe <i> has Key <k>, not <i>` — a pre-state Key order that is not
    `0..N-1` is refused instead of renumbered;
  - `keyframe <i> has Length <n>` — a keyframe that is not 1.0 frame long is
    refused, because `sequence.length` counts frames;
  - `keyframe <i> points at "<path>" instead of "sprites/<sprite>/<sprite>.yy"` —
    a channel bound to another resource is refused;
  - `its sequence origin is <x>,<y>, not two finite numbers` and `origin <x>,<y>
    would fall outside the frame` (resize);
  - `its bbox (<l>,<t>,<r>,<b>) would fall outside the new frame` and
    `nine-slice borders need <w>x<h> px` (resize);
  - a delete that fails after the `.yy` no longer throws: it is reported as
    `leftoverFiles: ["sprites/<sprite>/<guid>.png (ERR_FS_EISDIR)"]` plus a
    `⚠` second content part, so a retry cannot remove a different frame.
- **Not done, by design.** No `.yyp`, `textureGroupId` or `nineSlice` write; no
  pixel/drawing tools; no atlas or strip importer; no repair or migration of an
  inconsistent sprite; no key reordering of the `.yy`.

