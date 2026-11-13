# Spec A — Object & Room authoring parity

Status: draft · Scope: subproject A · Repo: `gm-forge-mcp`

## Goal

Close the authoring gaps that make the server unable to round-trip a real room:

1. `add_object` writes a fixed object template and offers no way to change it
   afterwards, so sprite, parent, solid/visible/persistent, physics and
   variable definitions can only be set by hand.
2. `add_room` emits exactly two layers (`Instances` at depth 0, `Background` at
   depth 100) and nothing can add, remove, reorder or inspect a layer.
3. Tile layers are read-only: there is no writer for `GMRTileLayer` anywhere in
   the codebase, so tile-based geometry (the bulk of level art in real projects)
   cannot be authored.

Deliver eight new MCP tools that make those three operations first-class,
without changing the behaviour of any existing tool.

## Non-goals

- Sprite frame / image editing (`edit_sprite` stays as-is); sequences, timelines,
  animation curves beyond the existing tools.
- Included Files, macros, `options/*.yy`.
- Object event editing beyond the existing `add_object_event` (no reordering, no
  deletion, no GML editing); per-room variable overrides.
- Backup / snapshot / multi-file transaction / rollback — deferred to subproject E.
- Tile *regions* beyond axis-aligned rectangles: no flood fill, no brush shapes,
  no autotiling, no randomisation. Undo: every tool is a one-way write.

## Format facts (verified, do not re-derive)

- `src/index.ts` is the sole registry: zod schemas, `TOOL_DEFS`, the
  `dispatchTool` switch, the central `withProjectLock`, and the catch that renders
  `Error: <msg>`. It opens a stdio transport only when it is the entry point, so
  the suite can import it and assert the real schemas and tool list.
- `.yyp` IO goes through `@bscotch/yy` (`src/gm/yyp.ts:124,205,217`). `.yy` IO
  uses `parseGameMakerJson` (`src/gm/yyp.ts:85-113`) and
  `JSON.stringify(v, null, 2)`.
- Atomic single-file writes: `writeYyp` (`src/gm/yyp.ts:208-223`) and
  `writeRoomYy` (temp file + rename). No backup, no multi-file transaction.
- Tests are one hand-rolled script, `test/verify.ts`, run by `tsx`, with `ok()`,
  `expectThrows()`, `keysMatchRef()` and `REF` key-sets captured from real
  GameMaker files. `tsconfig.json` has `strict: true`; no ESLint.
- Tile pitch must come from the tileset, not the layer's own `gridX`/`gridY` —
  those are editor snap settings (both now write the same 32px grid).

All eight tools are additive. Every write path: read `.yy` with
`parseGameMakerJson`, mutate only the fields named in the arguments, write back
with `JSON.stringify(v, null, 2)`, throw on any validation failure before
touching disk.

## Tool contracts

Common shape: `projectDir` is the first argument, names are `snake_case`, each
schema built as `ProjectSchema.extend({...})`.

### 1. `edit_object`

```ts
{ objectName: string,
  spriteName?: string | null, spriteMaskName?: string | null,
  parentObjectName?: string | null,
  solid?: boolean, visible?: boolean, persistent?: boolean,
  physics?: { enabled?, density?, friction?, restitution?, collisionGroup?,
              kinematic?, sensor?, shape?, startAwake?, angularDamping?,
              linearDamping? },
  variableDefinitions?: { name: string, value: string, type: "real" | "asset" }[] }
```

- `null` clears a field; omitted leaves it unchanged.
- Sprite / mask / parent resolve to `{ name, path }` references. The target
  resource must exist; otherwise error naming the expected absolute path.
- `physics` maps 1:1 onto the existing `NO_PHYSICS` field names
  (`src/gm/objects.ts:108-121`): `density→physicsDensity`,
  `friction→physicsFriction`, `restitution→physicsRestitution`,
  `collisionGroup→physicsGroup`, `kinematic→physicsKinematic`,
  `sensor→physicsSensor`, `shape→physicsShape`,
  `startAwake→physicsStartAwake`, `angularDamping→physicsAngularDamping`,
  `linearDamping→physicsLinearDamping`. Reuse those key names verbatim; do not
  rename keys in the file.
- **No `gravityScale`.** A `GMObject` `.yy` has no gravity-scale key at all
  (GameMaker keeps gravity per room instance), so the option is not exposed and
  passing it is an error rather than a silently dropped field. `enabled: false`
  restores GameMaker's default physics block; `enabled: true` sets
  `physicsObject`.
- `variableDefinitions` maps `{name, value, type}` onto GameMaker's `properties`
  array; `[]` empties it. `type` is limited to `real` (varType 0) and `asset`
  (varType 4) — the only encodings verified against a real IDE-authored object;
  anything else throws instead of being guessed at.

### 2. `list_room_layers`
`{ roomName }` → JSON array of `{ name, type, depth, visible, elementCount }`,
recursing into folder layers (folder entries report their recursive element
count; nested layers are also emitted as flat entries).

### 3. `add_room_layer`
`{ roomName, layerName, layerType: instance|asset|tile|path|background|effect|folder,
   depth?, visible?, parentLayerName?,
   tilesetName? (required when tile), spriteName? (asset),
   color?, tiled?, stretch?, horizontalTile?, verticalTile?,
   xscale?, yscale?, hspeed?, vspeed?, x?, y? (background) }`

- Default `depth` = max existing depth + 100.
- `layerName` is free text, as in GameMaker's editor (`"World Reality"`,
  `"BG - sky"` are legal): non-empty, ≤ 255 chars, no `/ \ : .` and no control
  characters. GML-identifier rules do **not** apply — a layer name is never a
  path and never a GML symbol.
- `parentLayerName` attaches under that folder layer; unknown parent → error.
- Tile layers: `gridX/gridY` computed from the tileset's `tileWidth/tileHeight`,
  `SerialiseWidth = ceil(roomWidth / gridX)`,
  `SerialiseHeight = ceil(roomHeight / gridY)`, buffer = all-empty encoding.
- A layer folder serialises as `$GMRLayer` in 2024.14+ — the older `$GMRFolder`
  spelling is rejected by GameMaker's own validator, so it is only read, never
  written.
- Returns `{ roomName, layerName, layerType, depth, elementCount: 0 }`.

### 4. `remove_room_layer`
`{ roomName, layerName, force? }` — refuses a non-empty layer unless
`force: true`; the error message states the element count. Counted elements:
instances, non-empty tile cells, asset-layer graphics (a folder sums everything
nested in it); path/effect layers hold none. Refuses to remove a room's last
top-level layer, and a forced instance-layer removal also drops those instances'
`instanceCreationOrder` entries. Returns `{ roomName, layerName, removed: true }`.

### 5. `set_room_layer`
`{ roomName, layerName, visible?, depth? }` — explicitly **no rename**, works on
nested layers, and a call that changes nothing reports "unchanged" without
rewriting the file.

### 6. `get_room_tiles`
`{ roomName, layerName, x?, y?, width?, height? }` →
`{ tilesetName, gridX, gridY, width, height, tiles: number[][] }`, row-major,
`-1` = empty. Omitted rect = whole layer. `gridX`/`gridY` are the real tile
pitch, taken from the tileset — the layer's own `gridX`/`gridY` is only an editor
snap setting and is ignored when a tileset is referenced. Two spellings of "no
tile here" are translated in exactly one place: on disk a cell is GameMaker's
int32 sentinel `EMPTY_TILE = -2147483648`, at the API it is `-1`.

### 7. `set_room_tiles`
`{ roomName, layerName, tiles: { x, y, index }[] }` → `{ updated }`.
`index: -1` clears a cell. Out-of-bounds → error naming the bounds. All cells are
validated before anything is written, and a call whose cells already hold the
requested values returns `updated: 0` and does not rewrite the file.

`index` is bounded to `-1 .. 2147483646` (an int32 slot: 2147483647 reads back
negative, 2147483648 wraps) and, when the layer's tileset resolves, to below its
`tile_count`. **Out of scope: GameMaker's tile transform bits** (mirror/rotate,
stored below -1) — values below -1 are rejected, so author transformed tiles in
the IDE.

### 8. `fill_room_tiles`
`{ roomName, layerName, x, y, width, height, index }` → `{ updated }`.
Rectangle only, inclusive of the origin cell, clipped-to-bounds violations are
errors, not silent clips. Same skip-if-unchanged rule as `set_room_tiles`.

## Encoder contract

`encodeTileData(tiles: number[]): number[]` in `src/gm/room_tiles.ts` — the
exact inverse of `decompressTileData` as implemented there (:22-35):

- `decompressTileData(encodeTileData(t))` must equal `t` for every tile array,
  including all-empty, single-cell, and fully-literal arrays.
- Run encoding: a positive count `N` is a **literal** run followed by `N`
  values; a negative count `-N` is a **repeat** run followed by one value
  repeated `N` times. Both directions must stay inside GameMaker's documented
  run-length limits; oversize runs are split into multiple runs at
  `MAX_TILE_RUN = 1_000_000` cells (`export const` in `src/gm/room_tiles.ts`, so
  the split boundary is pinned by a test rather than left implicit).
- Empty cells are encoded as a repeat run of the `EMPTY_TILE` sentinel -- a
  freshly-created tile layer is exactly `[-cells, EMPTY_TILE]`.
- Output must be accepted by GameMaker (verified against a resaved room).
- **The transform is many-to-one**: multiple valid encodings decode to the same
  array. Byte-identical re-encoding of an untouched layer is therefore *not*
  guaranteed, and no tool may rewrite a layer it did not change.

## Acceptance criteria

- `npm run typecheck` clean.
- `npm test` passes: the 264 pre-existing assertions unchanged, 149 new ones
  added (413 total), 0 failed.
- Every new write path has a `test/verify.ts` regression block comparing writer
  output against `REF` key-sets captured from real GameMaker files, including
  the omitted/default case (not just the fully-populated one).
- Encoder round-trip test over real tile data read (read-only) from
  `E:\GMprojects\261103GJ\rooms\rm_lv1\rm_lv1.yy`, plus an empty layer.
- `README.md:47-79` lists the eight new tools under Objects / Rooms / Room tiles;
  no existing tool's behaviour changes (same arguments, output, errors).
- Read-only smoke test: `list_room_layers` and `get_room_tiles` on `rm_lv1`
  report the two tile layers with correct dimensions and pitch.
- Room writes are atomic (temp file + rename) and a no-op leaves the file
  byte-identical. JSON is re-stringified, so float spelling normalises (`1.0` →
  `1`): matching GameMaker's key order is not byte-fidelity with an IDE resave.

## Risks

- Real-GameMaker key sets for variable definitions and for each layer type must
  be captured from an actual file rather than invented. If no sample exists for
  a field, the tool must fail loudly rather than guess — a plausible-looking
  `.yy` that GameMaker rejects is worse than a refusal.
- Tile layers carrying `userdefined*` fields must be preserved verbatim; do not
  normalise or drop unknown keys.
- Tool schemas and dispatch are exercised by importing `src/index.ts` (it only
  opens a stdio transport when it is the process entry point): the real
  `TOOL_DEFS` list and the real schemas are asserted, and the switch itself is
  counted as text so a commented-out case can't pass. Exactly 53 tools.
- Parallel work contends on `src/index.ts`, `test/verify.ts` and `README.md`;
  implementation is therefore wave-based (see `docs/plans/A-objects-rooms.md`).
- No multi-file transaction: each room write is atomic on its own, but a crash
  between two writes (room .yy + .yyp) can still leave them out of step.
