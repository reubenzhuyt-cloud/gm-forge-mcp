import { promises as fs } from "fs";
import path from "path";
import { parseGameMakerJson, assertSafeResourceName } from "./yyp.js";
import { findRoomLayer, writeRoomYy } from "./room_layers.js";

// GameMaker's own "no tile here" sentinel. Verified against real GameMaker
// data (see decompressTileData).
export const EMPTY_TILE = -2147483648;

/**
 * Decode GameMaker's run-length-compressed room tile data (TileCompressedData)
 * into a flat array of tile values. @bscotch/yy (the library the rest of this
 * project is built on) declares this field `unknown` -- it isn't documented
 * anywhere official. This scheme was reverse-engineered from independent
 * community implementations and then verified against a real GameMaker room's
 * actual compressed array: decoding it produced exactly SerialiseWidth *
 * SerialiseHeight values, byte for byte.
 *
 * Encoding: a positive N means the next N values in the stream are literal
 * tiles, copied as-is; a negative N means "repeat the next single value N
 * times" (an RLE run).
 */
export function decompressTileData(data: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const n = data[i++];
    if (n < 0) {
      const v = data[i++];
      for (let k = 0; k < -n; k++) out.push(v);
    } else {
      for (let k = 0; k < n; k++) out.push(data[i++]);
    }
  }
  return out;
}

// Run-length limit for encoding. decompressTileData never checks a count's
// magnitude -- it just loops |n| times -- so the decoder itself imposes no
// ceiling; the only hard bound in the format is the int32 slot each element
// occupies in a saved room. We split far below that: splitting costs one extra
// count per MAX_TILE_RUN cells, and 1,000,000 cells already exceeds any real
// room's entire tile layer (Convoy's largest is ~27,000), so no count this size
// ever comes from real data. Exported so tests can pin the split boundary.
export const MAX_TILE_RUN = 1_000_000;

/**
 * Encode a flat, row-major tile buffer into GameMaker's TileCompressedData --
 * the inverse of decompressTileData. A positive count introduces that many
 * literal values; a negative count repeats the single value after it.
 *
 * The transform is many-to-one (several encodings decode to the same buffer),
 * so re-encoding an untouched layer is never guaranteed to reproduce its
 * original bytes. This encoder is greedy: longest repeat run first, else the
 * longest literal run that stops just before the next repeated pair. Runs
 * longer than MAX_TILE_RUN are split into several runs.
 */
export function encodeTileData(tiles: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < tiles.length) {
    const value = tiles[i];
    let repeat = 1;
    while (i + repeat < tiles.length && repeat < MAX_TILE_RUN && tiles[i + repeat] === value) repeat++;
    if (repeat > 1) {
      out.push(-repeat, value);
      i += repeat;
      continue;
    }
    let end = i + 1;
    while (end < tiles.length && end - i < MAX_TILE_RUN && tiles[end] !== tiles[end + 1]) end++;
    out.push(end - i);
    for (let k = i; k < end; k++) out.push(tiles[k]);
    i = end;
  }
  return out;
}

export interface TileLayerInfo {
  layerName: string;
  tilesetName: string | null;
  x: number;
  y: number;
  tileWidth: number;
  tileHeight: number;
  width: number; // grid columns
  height: number; // grid rows
  grid: number[][]; // [row][col]
}

// A tile layer's own gridX/gridY is only an editor-grid snap setting -- NOT
// necessarily the real tile size. The real pitch comes from the referenced
// tileset's own tileWidth/tileHeight (learned the hard way while placing a
// door: a room used gridX=32 for its snap grid while its tileset's real tiles
// were 16x16). Only fall back to gridX/gridY when there's no tileset to ask.
// tileCount rides along because it is the only honest upper bound for a tile
// index on that layer.
async function readTilesetInfo(
  projectDir: string,
  tilesetName: string
): Promise<{ tileWidth: number; tileHeight: number; tileCount: number | null } | null> {
  assertSafeResourceName(tilesetName);
  const yyPath = path.join(projectDir, "tilesets", tilesetName, `${tilesetName}.yy`);
  try {
    const tileset = parseGameMakerJson(await fs.readFile(yyPath, "utf8"));
    return {
      tileWidth: tileset.tileWidth,
      tileHeight: tileset.tileHeight,
      tileCount: typeof tileset.tile_count === "number" ? tileset.tile_count : null,
    };
  } catch {
    return null;
  }
}

/**
 * Read and decode every tile layer (GMRTileLayer) in a room, including ones
 * nested inside folder-like layers. Returns each layer's tile grid in real
 * world coordinates, ready to query.
 */
export async function getRoomTileLayers(projectDir: string, roomName: string): Promise<TileLayerInfo[]> {
  assertSafeResourceName(roomName);
  const roomYyPath = path.join(projectDir, "rooms", roomName, `${roomName}.yy`);
  let room: any;
  try {
    room = parseGameMakerJson(await fs.readFile(roomYyPath, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new Error(`Room "${roomName}" does not exist (expected ${roomYyPath})`);
    }
    throw new Error(`Failed to read room "${roomName}" at ${roomYyPath}: ${e.message}`);
  }

  const results: TileLayerInfo[] = [];

  async function walk(layers: any[]): Promise<void> {
    for (const layer of layers ?? []) {
      if (layer.resourceType === "GMRTileLayer" && layer.tiles) {
        const tilesetName: string | null = layer.tilesetId?.name ?? null;
        const size = tilesetName ? await readTilesetInfo(projectDir, tilesetName) : null;
        const tileWidth = size?.tileWidth ?? layer.gridX ?? 32;
        const tileHeight = size?.tileHeight ?? layer.gridY ?? 32;
        const width: number = layer.tiles.SerialiseWidth;
        const height: number = layer.tiles.SerialiseHeight;
        const flat = decompressTileData(layer.tiles.TileCompressedData ?? []);
        const grid: number[][] = [];
        for (let r = 0; r < height; r++) grid.push(flat.slice(r * width, (r + 1) * width));
        results.push({
          layerName: layer.name ?? layer["%Name"],
          tilesetName,
          x: layer.x ?? 0,
          y: layer.y ?? 0,
          tileWidth,
          tileHeight,
          width,
          height,
          grid,
        });
      }
      if (Array.isArray(layer.layers) && layer.layers.length > 0) {
        await walk(layer.layers);
      }
    }
  }

  await walk(room.layers ?? []);
  return results;
}

export interface TileRegionResult {
  layerName: string;
  tilesetName: string | null;
  occupied: boolean;
  tileValue?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  tileCount?: number;
}

// Cap on flood-fill size -- a sane guard against a pathologically huge fully-
// solid layer, not something expected to trigger on real rooms (Convoy's
// largest room's entire tile grid is ~27,000 cells).
const MAX_FLOOD_FILL_CELLS = 500_000;

/**
 * For each tile layer, check whether the given world point sits on a real
 * (non-empty) tile, and if so, flood-fill the connected region of non-empty
 * tiles it belongs to and report that region's bounding box. This is what
 * answers "is this spot actually inside the building, and how far does the
 * building extend" -- the exact question static instance data can't answer,
 * since decorative/collision geometry drawn via tiles is invisible to
 * get_room_info.
 */
export function findTileRegion(layers: TileLayerInfo[], worldX: number, worldY: number): TileRegionResult[] {
  return layers.map(layer => {
    const col = Math.floor((worldX - layer.x) / layer.tileWidth);
    const row = Math.floor((worldY - layer.y) / layer.tileHeight);
    if (row < 0 || row >= layer.height || col < 0 || col >= layer.width || layer.grid[row][col] === EMPTY_TILE) {
      return { layerName: layer.layerName, tilesetName: layer.tilesetName, occupied: false };
    }

    const visited = new Set<number>();
    const key = (r: number, c: number) => r * layer.width + c;
    const queue: [number, number][] = [[row, col]];
    visited.add(key(row, col));
    let minR = row, maxR = row, minC = col, maxC = col;
    let count = 0;
    while (queue.length > 0 && count < MAX_FLOOD_FILL_CELLS) {
      const [r, c] = queue.pop()!;
      count++;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= layer.height || nc < 0 || nc >= layer.width) continue;
        if (layer.grid[nr][nc] === EMPTY_TILE) continue;
        const k = key(nr, nc);
        if (visited.has(k)) continue;
        visited.add(k);
        queue.push([nr, nc]);
      }
    }

    return {
      layerName: layer.layerName,
      tilesetName: layer.tilesetName,
      occupied: true,
      tileValue: layer.grid[row][col],
      bbox: {
        x0: layer.x + minC * layer.tileWidth,
        y0: layer.y + minR * layer.tileHeight,
        x1: layer.x + (maxC + 1) * layer.tileWidth,
        y1: layer.y + (maxR + 1) * layer.tileHeight,
      },
      tileCount: count,
    };
  });
}

// Tile indices at the tool level use -1 for "no tile"; the .yy stores
// GameMaker's int32 sentinel instead (EMPTY_TILE). Everything between those two
// representations happens here, so no caller has to know about the sentinel.
const EMPTY_TILE_INDEX = -1;

function toStoredTile(index: number): number {
  return index === EMPTY_TILE_INDEX ? EMPTY_TILE : index;
}

function toTileIndex(value: number): number {
  return value === EMPTY_TILE ? EMPTY_TILE_INDEX : value;
}

export interface RoomTilesResult {
  tilesetName: string; // "" when the layer references no tileset
  gridX: number; // real tile pitch (from the tileset), not the layer's snap grid
  gridY: number;
  width: number;
  height: number;
  tiles: number[][]; // [row][col], -1 = empty
}

async function readRoom(projectDir: string, roomName: string): Promise<{ room: any; roomYyPath: string }> {
  assertSafeResourceName(roomName);
  const roomYyPath = path.join(projectDir, "rooms", roomName, `${roomName}.yy`);
  try {
    return { room: parseGameMakerJson(await fs.readFile(roomYyPath, "utf8")), roomYyPath };
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new Error(`Room "${roomName}" does not exist (expected ${roomYyPath})`);
    }
    throw new Error(`Failed to read room "${roomName}" at ${roomYyPath}: ${e.message}`);
  }
}

// The layer lookup itself lives in room_layers.ts (shared with every other
// layer tool); only the "which tile layers does this room actually have" list
// for the error text is local here.
function tileLayerNames(room: any): string {
  const names: string[] = [];
  const walk = (layers: any[]): void => {
    for (const layer of layers ?? []) {
      if (layer.resourceType === "GMRTileLayer" && layer.tiles) names.push(layer.name ?? layer["%Name"]);
      if (Array.isArray(layer.layers)) walk(layer.layers);
    }
  };
  walk(room.layers ?? []);
  return names.length > 0 ? names.join(", ") : "none";
}

function requireTileLayer(room: any, roomName: string, layerName: string): any {
  const found = findRoomLayer(room, layerName);
  if (found && found.layer.resourceType === "GMRTileLayer" && found.layer.tiles) return found.layer;
  if (found) {
    throw new Error(
      `Room "${roomName}" layer "${layerName}" is a ${found.layer.resourceType ?? "layer"} with no tile data -- not a tile layer (tile layers in this room: ${tileLayerNames(room)})`
    );
  }
  throw new Error(`Room "${roomName}" has no tile layer named "${layerName}" (expected one of: ${tileLayerNames(room)})`);
}

async function readLayerPitch(projectDir: string, layer: any): Promise<{ tilesetName: string; gridX: number; gridY: number }> {
  const tilesetName: string = layer.tilesetId?.name ?? "";
  const size = tilesetName ? await readTilesetInfo(projectDir, tilesetName) : null;
  return {
    tilesetName,
    gridX: size?.tileWidth ?? layer.gridX ?? 32,
    gridY: size?.tileHeight ?? layer.gridY ?? 32,
  };
}

// The whole buffer is re-encoded on every write, so a layer whose compressed
// data doesn't cover SerialiseWidth * SerialiseHeight cells is corrupt for our
// purposes: encoding it would silently truncate or pad the grid.
function readLayerTiles(layer: any, roomName: string): { flat: number[]; width: number; height: number } {
  const width: number = layer.tiles.SerialiseWidth;
  const height: number = layer.tiles.SerialiseHeight;
  const flat = decompressTileData(layer.tiles.TileCompressedData ?? []);
  const expected = width * height;
  if (flat.length !== expected) {
    throw new Error(
      `Tile layer "${layer.name ?? layer["%Name"]}" in room "${roomName}" declares ${width}x${height} = ${expected} tiles but its compressed data decodes to ${flat.length} values -- refusing to edit a corrupt layer`
    );
  }
  return { flat, width, height };
}

function assertCellInBounds(x: number, y: number, width: number, height: number, roomName: string, layerName: string): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error(
      `Tile (${x}, ${y}) is outside layer "${layerName}" in room "${roomName}" (${width}x${height} tiles, valid x 0-${width - 1}, y 0-${height - 1})`
    );
  }
}

// A tile value occupies an int32 slot in a saved room. 2147483647 would wrap to
// the negative side when GameMaker reads it back (and -2147483648 is the empty
// sentinel), so the writable range stops one below the int32 maximum.
const MAX_TILE_INDEX = 2147483646;

function assertTileIndex(index: number): void {
  if (!Number.isInteger(index) || index < EMPTY_TILE_INDEX || index > MAX_TILE_INDEX) {
    throw new Error(
      `Tile index must be an integer between ${EMPTY_TILE_INDEX} (empty) and ${MAX_TILE_INDEX}, got ${index}`
    );
  }
}

// GameMaker transform bits (mirror/rotate) live below -1 in the stored value;
// they are out of scope here, so anything below -1 is rejected above rather than
// silently producing a flag combination no test has verified.
// Resolving the tileset costs a file read + parse, so a caller resolves it once
// and reuses the bound for every cell it writes.
async function resolveTilesetTileCount(
  projectDir: string,
  layer: any
): Promise<{ tilesetName: string; tileCount: number } | null> {
  const tilesetName: string | undefined = layer.tilesetId?.name;
  if (!tilesetName) return null;
  const size = await readTilesetInfo(projectDir, tilesetName);
  if (!size || size.tileCount === null) return null;
  return { tilesetName, tileCount: size.tileCount };
}

function assertTileIndexInTileset(
  tileset: { tilesetName: string; tileCount: number } | null,
  index: number,
  roomName: string,
  layerName: string
): void {
  if (index === EMPTY_TILE_INDEX || !tileset) return;
  if (index >= tileset.tileCount) {
    throw new Error(
      `Tile index ${index} is outside tileset "${tileset.tilesetName}" (${tileset.tileCount} tiles, valid 0-${tileset.tileCount - 1}, or -1 to clear) for layer "${layerName}" in room "${roomName}"`
    );
  }
}

/**
 * Read one tile layer's cells as a row-major grid of tile indices, -1 meaning
 * "no tile". rect is inclusive of its origin cell and must stay inside the
 * layer's serialised bounds.
 */
export async function getRoomTiles(
  projectDir: string,
  roomName: string,
  layerName: string,
  rect?: { x?: number; y?: number; width?: number; height?: number }
): Promise<RoomTilesResult> {
  const { room } = await readRoom(projectDir, roomName);
  const layer = requireTileLayer(room, roomName, layerName);
  const { flat, width, height } = readLayerTiles(layer, roomName);
  const pitch = await readLayerPitch(projectDir, layer);

  const x = rect?.x ?? 0;
  const y = rect?.y ?? 0;
  const w = rect?.width ?? width - x;
  const h = rect?.height ?? height - y;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)
    || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) {
    throw new Error(
      `Requested tile region x=${x}, y=${y}, width=${w}, height=${h} is outside layer "${layerName}" in room "${roomName}" (${width}x${height} tiles, valid x 0-${width - 1}, y 0-${height - 1})`
    );
  }

  const tiles: number[][] = [];
  for (let r = y; r < y + h; r++) {
    const row: number[] = [];
    for (let c = x; c < x + w; c++) row.push(toTileIndex(flat[r * width + c]));
    tiles.push(row);
  }
  return { tilesetName: pitch.tilesetName, gridX: pitch.gridX, gridY: pitch.gridY, width: w, height: h, tiles };
}

/**
 * Set individual tile cells. Every coordinate is validated before anything is
 * mutated; cells whose value already matches are skipped, and a call that
 * changes nothing does not touch the .yy at all (re-encoding is many-to-one, so
 * a needless rewrite would still churn the file).
 */
export async function setRoomTiles(
  projectDir: string,
  roomName: string,
  layerName: string,
  entries: Array<{ x: number; y: number; index: number }>
): Promise<{ updated: number; width: number; height: number }> {
  const { room, roomYyPath } = await readRoom(projectDir, roomName);
  const layer = requireTileLayer(room, roomName, layerName);
  const { flat, width, height } = readLayerTiles(layer, roomName);
  const tileset = await resolveTilesetTileCount(projectDir, layer);

  for (const entry of entries) {
    assertTileIndex(entry.index);
    assertCellInBounds(entry.x, entry.y, width, height, roomName, layerName);
    assertTileIndexInTileset(tileset, entry.index, roomName, layerName);
  }

  let updated = 0;
  for (const entry of entries) {
    const at = entry.y * width + entry.x;
    const value = toStoredTile(entry.index);
    if (flat[at] === value) continue;
    flat[at] = value;
    updated++;
  }
  if (updated === 0) return { updated, width, height };

  layer.tiles.TileCompressedData = encodeTileData(flat);
  await writeRoomYy(roomYyPath, room);
  return { updated, width, height };
}

/**
 * Fill an axis-aligned rectangle of cells (inclusive of its origin cell) with
 * one tile index. Same validate-first, skip-if-unchanged rules as setRoomTiles.
 */
export async function fillRoomTiles(
  projectDir: string,
  roomName: string,
  layerName: string,
  rect: { x: number; y: number; width: number; height: number; index: number }
): Promise<{ updated: number; width: number; height: number }> {
  const { room, roomYyPath } = await readRoom(projectDir, roomName);
  const layer = requireTileLayer(room, roomName, layerName);
  const { flat, width, height } = readLayerTiles(layer, roomName);

  assertTileIndex(rect.index);
  assertTileIndexInTileset(await resolveTilesetTileCount(projectDir, layer), rect.index, roomName, layerName);
  if (!Number.isInteger(rect.width) || !Number.isInteger(rect.height) || rect.width < 1 || rect.height < 1
    || rect.width > width || rect.height > height) {
    throw new Error(
      `Fill region ${rect.width}x${rect.height} is outside layer "${layerName}" in room "${roomName}" (${width}x${height} tiles)`
    );
  }
  assertCellInBounds(rect.x, rect.y, width, height, roomName, layerName);
  if (rect.x + rect.width > width || rect.y + rect.height > height) {
    throw new Error(
      `Fill region x=${rect.x}, y=${rect.y}, width=${rect.width}, height=${rect.height} runs past layer "${layerName}" in room "${roomName}" (${width}x${height} tiles, valid x 0-${width - 1}, y 0-${height - 1})`
    );
  }

  const value = toStoredTile(rect.index);
  let updated = 0;
  for (let r = rect.y; r < rect.y + rect.height; r++) {
    for (let c = rect.x; c < rect.x + rect.width; c++) {
      const at = r * width + c;
      if (flat[at] === value) continue;
      flat[at] = value;
      updated++;
    }
  }
  if (updated === 0) return { updated, width, height };

  layer.tiles.TileCompressedData = encodeTileData(flat);
  await writeRoomYy(roomYyPath, room);
  return { updated, width, height };
}
