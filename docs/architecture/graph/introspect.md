# introspect

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The twelve `get_*_info` readers: they parse one resource's `.yy` (plus its
sidecar code when relevant) and return a plain summary. They never write, never
snapshot, and never repair a malformed file — they report what it says.

## Key Paths

- `src/gm/introspect.ts` (195 lines) — one private `readResourceYy` helper and one
  exported function per resource type.
- `readResourceYy(projectDir, category, name)` (`:22`) — `assertSafeResourceName`
  before the `path.join`, `parseGameMakerJson` (trailing commas tolerated); only
  `ENOENT` is reported as "does not exist", anything else as "failed to read".
  Module-private: per-entry error tolerance needs a non-throwing read, and only
  `timelines.ts`/`sequences.ts` need that, so they keep their own.

## Public API

| Function | Line | Returns |
|----------|------|---------|
| `getObjectInfo` | `:35` | sprite, parent, physics, events with human-readable names (`EVENT_TYPE_NAMES`, `:5`) |
| `getRoomInfo` | `:53` | dimensions, persistence, layers, every placed instance |
| `getSpriteInfo` | `:75` | real dimensions, frame count, origin, collision settings |
| `getShaderInfo` | `:88` | vertex + fragment code |
| `getExtensionInfo` | `:106` | version, file count |
| `getParticleSystemInfo` | `:115` | emitter count and names |
| `getAnimCurveInfo` | `:124` | channel count, names, point counts |
| `getTilesetInfo` | `:134` | source sprite, tile dimensions, tile count |
| `getSoundInfo` | `:146` | file, volume, playback settings |
| `getFontInfo` | `:158` | system font name, size, style |
| `getNoteInfo` | `:170` | note content |
| `getScriptInfo` | `:182` | current GML code |

## Contracts

- `get_room_info` lists **instances only**; tile-drawn geometry is invisible to it
  — that is exactly what `find_tile_region` exists for (`room-tiles.md`).
- `get_object_info`'s event names come from the same eventType→name mapping as
  `objects.ts`, but are a separate literal (`:5-20` vs `objects.ts:26-41`); a
  change to one must be mirrored.
- Read-only: no snapshot, no lock beyond the dispatch-level project lock.

## Dependencies

- In: `yyp.ts` (`parseGameMakerJson`, `assertSafeResourceName`).
- Out: `index.ts` (twelve dispatch cases), `test/verify.ts` (read-tool parity
  assertions).
