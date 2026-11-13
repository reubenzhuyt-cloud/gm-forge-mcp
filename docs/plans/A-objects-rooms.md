# Plan A — Object & Room authoring parity

Implements `docs/specs/A-objects-rooms.md`. Work happens in the repo working copy
at `C:\Users\31087\mcp\gm-forge-mcp`; `E:\GMprojects\261103GJ` is a **read-only**
sample project used exclusively for capturing `REF` key-sets.

Branch: `feat/local-tool-discovery` · Upstream fork: `fork` →
`reubenzhuyt-cloud/gm-forge-mcp`.

## Why waves

`src/index.ts`, `test/verify.ts` and `README.md` are single-file choke points
that every task would otherwise edit. Wave 1 gives each coder a private module so
three people can work at once on disjoint files; wave 2 is one integrator, serial,
so the choke points are touched exactly once.

## Wave 1 — parallel, disjoint files

No edits to `src/index.ts`, `test/verify.ts`, `README.md`, `package.json` in this
wave. Wave-1 code is unregistered and therefore unreachable from MCP until wave 2.

| ID | Files | Deliverable |
|----|-------|-------------|
| W1 | `src/gm/objects.ts` only (+ private helpers) | `editObject()` implementing contract 1, including sprite/mask/parent resolution with expected-path errors, the `physics` 1:1 key mapping, and `variableDefinitions` → `properties`. No dispatch wiring. |
| W2 | `src/gm/room_layers.ts` (new) + `src/gm/rooms.ts` | Layer CRUD: `listRoomLayers`, `addRoomLayer`, `removeRoomLayer`, `setRoomLayer`, plus the exported `findRoomLayer` lookup used later by W3. Tile layer creation computes `gridX/gridY` from the tileset and emits an all-empty buffer. |
| W3 | `src/gm/room_tiles.ts` only | `encodeTileData()` plus `getRoomTiles`/`setRoomTiles`/`fillRoomTiles`, using a **private** layer lookup (replaced in wave 2). Encoder round-trip self-check. |

Self-verification: each coder writes a throwaway script at
`test/_wip_<name>.ts`, runs it with `tsx`, and **deletes it before reporting**.
Nothing in `test/` may be left behind by wave 1.

Wave-1 gate per coder: `npm run typecheck` clean; throwaway script demonstrates
the module's behaviour against a scratch fixture project (not the read-only
sample); no files outside the assigned list changed (verify with `git status`
read-only).

## Wave 2 — single integrator, serial

One agent, sequential steps, no overlap:

1. Register all 8 tool schemas (`ProjectSchema.extend`), their `TOOL_DEFS`
   entries, and 8 `dispatchTool` cases in `src/index.ts`.
2. Unify `room_tiles.ts` onto `findRoomLayer` from `room_layers.ts`; delete the
   private duplicate lookup left by W3.
3. Move every regression from the throwaway scripts into `test/verify.ts`, adding
   new `REF` key-sets captured from real GameMaker files — one per write path,
   each with a default/omitted case.
4. Update `README.md:47-77` with the eight new tools.
5. Run `npm run typecheck` and `npm test`; report the exact output (pass/fail
   counts, any skips).

Wave-2 gate: both commands clean, `test/_wip_*.ts` gone, `git status` shows only
the intended files, no existing assertion modified (only appended).

**Wave-2 outcome (done):** all 8 tools registered in `src/index.ts` (53 total);
`room_tiles.ts` now imports `findRoomLayer` from `room_layers.ts` directly —
the resulting module cycle is function-body-only, so it is safe in ESM and no
`room_lookup.ts` was needed; `removeRoomLayer` prunes `instanceCreationOrder`
entries for instances it deletes; `addRoomLayer`/`removeRoomLayer` return the
shapes the spec names. `npm test` went from 264 to 376 assertions, all green.

**Fix pass after review (done):** `countLayerElements` now counts
`GMRAssetLayer.assets`; `gravityScale` is rejected by the zod schema itself;
tile-layer `tiles` serialises in GameMaker's field order; `add_room` and the
layer tools share `ROOM_LAYER_GRID = 32`; tile indices are bounded to
`-1..2147483646` and below the tileset's `tile_count`; removing a room's last
layer is refused; layer names are free text (own validator); `set_room_layer` is
a no-op when nothing differs; background `x`/`y` exist; `writeRoomYy` is atomic.
`src/index.ts` is now import-safe (entry-point guard) so the suite asserts the
real registry and schemas. 413 assertions.

## Wave 3 — review

One reviewer agent, full audit of the integrated diff. Deliverable: findings with
`file:line`, severity, and a concrete fix each. Blocking findings go back to the
integrator, not to wave-1 owners.

## Do not

- No `npm install` (the tree is already provisioned).
- No `git commit`, `git push`, or branch manipulation — only the Chief Agent
  commits.
- No builds against `E:\GMprojects\261103GJ`: that project is read-only for this
  work and the user edits its rooms by hand.
- No `lint_project` / `compile_project` runs, no Igor, no Runner, no MCP
  screenshots.
- No `.yy` or `.yyp` restructuring beyond the named fields; no reorder of keys,
  no re-encoding of layers that were not explicitly written.
- No new tool beyond the eight; the tool count must land at exactly 53.
