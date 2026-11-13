# sprites

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Importing a sprite from a directory of PNGs and editing a sprite's origin,
collision kind and bounding box. It owns the sprite `.yy` scaffold and the
frame/keyframe record shapes that `sprite_frames.md` reuses. It does **not** edit
frame images or the frame list (`sprite_frames.md`), and never touches the
`.yyp`'s texture group.

## Key Paths

- `src/gm/sprites.ts` (297 lines) — `sprites/<name>/<name>.yy`.
- Frame images: `sprites/<name>/<frameGuid>.png` **and**
  `sprites/<name>/layers/<frameGuid>/<layerGuid>.png`.

## Public API / Key Types

- `readPngDimensions(pngPath)` (`:15`) — reads the IHDR width/height without a
  decoder; used instead of trusting caller input.
- `frameEntry(frameId)` (`:78`) — `$GMSpriteFrame` record; exported so the shape
  has exactly one definition.
- `frameKeyframe(spriteName, frameId, index)` (`:103`) — `Key: index`,
  `Length: 1.0`, channel `Id = { name: frameGuid, path: sprites/<s>/<s>.yy }`.
- `sequenceEntry(spriteName, frameIds)` (`:125`) — `GMSequence` with one
  `GMSpriteFramesTrack` named `frames`; `length = frameIds.length` (**frames, not
  seconds**), `playbackSpeed: 30.0`, empty `moments`/`events` stores.
- `spriteYy(name, size, frameIds, layerId)` (`:193`) — `bbox` = full frame,
  `textureGroupId` = `Default`, `parent` = `folders/Sprites.yy`,
  `"$GMSprite": "v2"`.
- `addSpriteFromImages(projectDir, yyp, name, framesDir)` (`:230`) — imports
  every PNG in the directory, requires one consistent size, creates both png
  copies per frame and registers the resource.
- `SpriteEditOptions` (`:249`) / `editSprite(...)` (`:267`) — origin, collision
  kind, bbox; explicitly not frame data.

## Contracts

- A frame is two pngs, always; GameMaker refuses a sprite missing the per-layer
  copy. Each copy is written with `atomicCopyFile` (`:68`, `:72`) and the `.yy`
  with `atomicWriteJson` (`:240`, `:296`), so a crash cannot leave a truncated
  image the `.yy` already points at. All create/copy/delete paths live in
  `sprites.ts`/`sprite_frames.ts`, so no tool can drift one half out of sync.
- All frames of a sprite share one size; an import with mixed sizes is refused.
- `add_sprite_from_images` is an append tool (not auto-snapshotted);
  `edit_sprite` is auto-snapshotted.
- `edit_sprite` cannot resize — size changes belong to
  `replace_sprite_frame`'s `allowResize`, which only works on a single-frame
  sprite.

## Dependencies

- In: `yyp.ts`, `atomic.ts`.
- Out: `sprite_frames.ts` (`frameEntry`, `frameKeyframe`, `readPngDimensions`),
  `tilesets.ts` (source sprite dimensions), `introspect.ts`, `lint.ts`,
  `index.ts`.
