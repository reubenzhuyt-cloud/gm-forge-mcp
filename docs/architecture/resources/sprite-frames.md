# sprite frames

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The six frame tools: `list_sprite_frames` plus add / remove / replace / reorder /
trim. It owns the frames↔keyframes↔`sequence.length` invariant, both png copies
per frame, and every refusal that protects an existing sprite. It never draws,
packs, resizes a multi-frame sprite, or touches the `.yyp` / texture group /
nine-slice.

## Key Paths

- `src/gm/sprite_frames.ts` (921 lines) — the module.
- Frame identity: `frames[].name` is the guid; `sequence.tracks[name="frames"]`
  holds one keyframe per frame; `Channels["0"].Id.name` is the same guid and
  `Id.path` is the sprite's own `.yy`.

## Public API / Key Types

- `listSpriteFrames(projectDir, spriteName)` (`:482`) — per-frame guid, png path,
  whether both copies exist; sequence length/speed/keyframe count; `verdict`
  (`ok` iff `frames.length === keyframeCount`, else
  `frames-vs-sequence mismatch: N vs M`); `missingFiles` lists gaps — the verdict
  grammar has no third form (`:29-38`).
- `addSpriteFrame(...)` (`:523`) — append or insert; fresh `randomUUID()` per
  frame; source PNG must match the sprite size.
- `removeSpriteFrame(...)` (`:583`) — refuses the only frame; deletes both png
  copies; renumbers remaining keyframes.
- `replaceSpriteFrame(...)` (`:685`) — keeps the frame guid so every room
  `imageIndex` stays valid; sha256-compares both pngs, so a byte-identical source
  reports `changed: false` and copies nothing.
- `reorderSpriteFrames(...)` (`:819`) — `order` must be a permutation of
  `0..frameCount-1`; each keyframe travels with its frame; identity order writes
  nothing.
- `trimSpriteFrames(...)` (`:871`) — inclusive `from..to`; the full range is a
  no-op.

## Invariants and refusals

- After every mutation: `frames.length === Keyframes.length ===
  sequence.length`. Never `frameCount / playbackSpeed` — the real 4-frame sample
  is `length 4.0`, `playbackSpeed 10.0` (`:16-19`).
- Pre-mutation gate (`assertFramesAgreeWithSequence`, `:242`) refuses a
  frames/sequence guid-set mismatch, a `Key` order that is not `0..N-1`, a
  keyframe `Length !== 1.0`, a foreign `Channels["0"].Id.path`, duplicate guids,
  a non-permutation order, an out-of-range trim, and a size-mismatched source.
  Pre-write post-conditions (`assertFrameInvariants`, `:357`) and a disk check
  (`missingFrameFiles`, `:387`).
- **Path traversal closed:** every guid/layer id read out of the `.yy` is
  validated by `assertSafeFrameGuid` / `layerIdsOf` via `path_safety.ts` before it
  becomes `sprites/<s>/<guid>.png` or the `layers/<guid>/` directory that removal
  deletes. Guid *shape* is still never validated (IDE guids are not RFC-4122).
- Images are created before the `.yy` and deleted after it. `deleteFramePngs`
  takes an `onError` callback and never throws; removal/trim return
  `leftoverFiles`, which `index.ts:249` emits as a `⚠` second content part.
- `allowResize` (single-frame only): refuses a non-numeric origin, rewrites the
  bbox only when it is the untouched full-frame default (`assertBoxFits`,
  `:628`), refuses nine-slice borders that no longer fit (`assertNineSliceFits`,
  `:658`), and stages both pngs as `.<name>.tmp-<uuid>` until after the `.yy`.
- Disk-free `prevalidate` in `index.ts:224-243` keeps an argument-level refusal
  from spending a `failed: true` snapshot.

## Dependencies

- In: `sprites.ts` (record shapes, png dimensions), `path_safety.ts`,
  `atomic.ts`, `yyp.ts`.
- Out: `index.ts` (`spriteFrameResponse`, six dispatch cases), `test/verify.ts`.
