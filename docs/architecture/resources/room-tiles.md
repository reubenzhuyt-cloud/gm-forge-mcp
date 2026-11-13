# room tiles

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

GameMaker's compressed tile-layer data: decode, encode, read a rectangle, set
cells, fill a rectangle, and answer "is this world point on a real tile, and how
far does the connected region reach". It owns only `GMRTileLayer` payloads inside
a room `.yy`; layer creation/removal is `room-layers.md`.

## Key Paths

- `src/gm/room_tiles.ts` (497 lines). Field: `layer.tiles` with
  `TileCompressedData`, `SerialiseWidth`, `SerialiseHeight`.

## The format

- `EMPTY_TILE = -2147483648` (`:8`) — GameMaker's int32 "no tile" sentinel,
  verified against real room data.
- `decompressTileData(data)` (`:23`) — a positive `N` copies the next `N` values
  literally; a negative `N` repeats the next single value `|N|` times.
- `encodeTileData(tiles)` (`:58`) — the inverse but **not** a bijection: several
  encodings decode to the same buffer, so re-encoding an untouched layer is not
  guaranteed to reproduce its bytes (`:52-56`). Greedy: longest repeat run first,
  else the longest literal run stopping before the next repeated pair.
- `MAX_TILE_RUN = 1_000_000` (`:45`) — encoder-only split bound. The format has
  no run ceiling (the decoder just loops `|n|` times); the only hard bound is the
  int32 slot per element, and any real layer is far smaller (~27,000 cells). Runs
  longer than this are emitted as several runs; the boundary is pinned by tests.

## Public API / Key Types

- `TileLayerInfo` (`:79`) — `layerName, tilesetName, x, y, tileWidth, tileHeight,
  width, height, grid` (row-major, raw stored values).
- `getRoomTileLayers(projectDir, roomName)` (`:121`) — walks nested layers;
  pitch falls back to `gridX/gridY` then 32 when the tile set is unreadable.
- `findTileRegion(layers, worldX, worldY)` (`:193`) — per layer, the cell is
  `floor((world - origin) / pitch)`; occupied → 4-way flood fill, capped at
  `MAX_FLOOD_FILL_CELLS = 500_000` (`:182`), returning `bbox` in world pixels and
  `tileCount`.
- `getRoomTiles(..., rect?)` (`:384`) — public index space where `-1` = empty;
  an omitted rect reads the whole layer; out-of-bounds is an error naming the
  layer size.
- `setRoomTiles(..., entries)` (`:421`) / `fillRoomTiles(...)` (`:457`) — every
  cell and index is validated before any mutation; a call that changes nothing
  returns `updated: 0` and **does not write the file** (`:446`, `:492`), since a
  needless re-encode would still churn bytes.

## Contracts

- Public `-1` ⇄ stored `EMPTY_TILE` translation happens at the tool boundary
  (`toTileIndex` / `toStoredTile`); the encoder never sees `-1`.
- Tile indices are validated against the tile set's real tile count; a rect that
  runs past the layer is an error, never a silent clip.
- `set_room_tiles` / `fill_room_tiles` are auto-snapshotted; the read tools are
  not.

## Dependencies

- In: `yyp.ts`, `room_layers.ts` (`findRoomLayer`, `writeRoomYy`).
- Out: `room_layers.ts` (asks this module to decode layer payloads),
  `index.ts`, `lint.ts` (indirectly via room reads).
