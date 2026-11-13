# room layers

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Reading, adding, removing and re-configuring the layers inside one room `.yy`:
instance, asset, tile, path, background, effect and folder, including nesting
under a folder layer. It owns the room-file read/write pair and the layer tree
walk; tile *cell* data is `room-tiles.md`.

## Key Paths

- `src/gm/room_layers.ts` (524 lines).
- `LAYER_VERSION = "2.0"` (`:10`) — every layer type in a 2024.4 room carries the
  same `resourceVersion`; only type-specific keys differ.
- `ROOM_LAYER_GRID = 32` (`:14`) — shared with `addRoom`'s scaffold so one server
  cannot emit two different grids.

## Public API / Key Types

- `readRoomYy(projectDir, roomName)` (`:34`) — only `ENOENT` means "no such
  room"; a permissions or parse failure is reported as a failure.
- `writeRoomYy(file, room)` (`:53`) — `atomicWriteFile` + `JSON.stringify(v, null, 2)`.
  Single-file atomicity only; backups are the dispatch hook's job.
- `assertValidLayerName` (`:64`) — free text (layer names never become paths):
  non-empty, ≤ 255 chars, no `.yy`-breaking characters.
- `findRoomLayer` (`:87`) — recursive lookup, returns the layer and its parent
  array.
- `listRoomLayers(projectDir, roomName)` (`:170`) — layer-editor order, recursing
  into folders; reports name, type, depth, visibility, element count and parent.
- `addRoomLayer(...)` (`:338`) — any `NewLayerType` (`:193`); a tile layer is
  created room-sized and all-`-1`, gridded by its tile set.
- `removeRoomLayer(...)` (`:454`) — refuses a layer that still holds
  instances/tiles/sub-layers unless `force=true`; keeps
  `instanceCreationOrder` consistent.
- `setRoomLayer(...)` (`:496`) — visibility and/or depth only; layers cannot be
  renamed.

## Contracts

- Layer `depth` is the draw order (lower = in front in GameMaker's editor
  numbering); the tools pass values through unchanged.
- Removing a folder must not orphan its children: the refusal is the default, not
  a silent flatten.
- Key order is matched (`sortKeys`, `:221`), but this is **not** byte-fidelity
  with an IDE resave: `JSON.stringify` prints `1.0` as `1` (`:215-220`).
- No IDE round-trip has been recorded for the asset / path / effect payloads this
  module builds. The `REF` key sets come from real Convoy files and the suite
  asserts those key sets — not an IDE re-opening of a layer this server created.
- All three mutating tools (`add_room_layer`, `remove_room_layer`,
  `set_room_layer`) are on `AUTO_SNAPSHOT_TOOLS` — each overwrites an existing
  `.yy`.

## Dependencies

- In: `yyp.ts` (`parseGameMakerJson`, `assertSafeResourceName`, `fileExists`),
  `atomic.ts`, `room_tiles.ts` (`decompressTileData`, `EMPTY_TILE`).
- Out: `rooms.ts`, `room_tiles.ts`, `instances.ts` (same file), `index.ts`.
