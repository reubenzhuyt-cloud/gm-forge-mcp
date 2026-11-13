import { promises as fs } from "fs";
import crypto from "crypto";
import path from "path";
import { parseGameMakerJson, assertSafeResourceName, fileExists } from "./yyp.js";
import { decompressTileData, EMPTY_TILE } from "./room_tiles.js";

// Every layer type in a 2024.4 room carries the same resourceVersion -- only
// the type-specific keys (instances/assets/tiles/tilesetId/pathId/colour...)
// differ. Verified against every layer in 261103GJ's rm_lv1..rm_lv3_2.
const LAYER_VERSION = "2.0";

// Editor snap grid, shared with addRoom's scaffold so one server cannot emit two
// different grids. 32 is what GameMaker writes for this project's rooms.
export const ROOM_LAYER_GRID = 32;

export interface RoomLayerInfo {
  name: string;
  type: string;
  depth: number;
  visible: boolean;
  elementCount: number;
  parentLayerName?: string;
}

export interface RoomYy {
  room: any;
  file: string;
}

/**
 * Reads a room's own .yy. Only ENOENT means "no such room" -- a permissions or
 * parse failure is reported as a failure, not as a missing room.
 */
export async function readRoomYy(projectDir: string, roomName: string): Promise<RoomYy> {
  assertSafeResourceName(roomName);
  const file = path.join(projectDir, "rooms", roomName, `${roomName}.yy`);
  try {
    const room = parseGameMakerJson(await fs.readFile(file, "utf8"));
    return { room, file };
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new Error(`Room "${roomName}" does not exist (expected ${file})`);
    }
    throw new Error(`Failed to read room "${roomName}" at ${file}: ${e.message}`);
  }
}

// Temp file + rename in the same directory, mirroring writeYyp: a crash mid-write
// can't leave a truncated room .yy behind. Single-file atomicity only, no backup.
// The temp name matches .gitignore's `.*.tmp-*`, so an interrupted write can't
// show up as untracked noise in a user's project.
export async function writeRoomYy(file: string, room: any): Promise<void> {
  const tempPath = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(tempPath, JSON.stringify(room, null, 2), "utf8");
    await fs.rename(tempPath, file);
  } catch (e: any) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    // Windows reports a rename over an open file as EPERM/EACCES -- in practice
    // that means the IDE (or an antivirus scan) is holding this room open.
    if (e?.code === "EPERM" || e?.code === "EACCES") {
      throw new Error(
        `Could not replace ${file}: ${e.code} -- the file is locked by another program. Close the room in GameMaker (or wait for the antivirus scan) and retry. (${e.message})`
      );
    }
    throw e;
  }
}

// Layer names are free text in GameMaker's room editor ("World Reality",
// "BG - sky") and never become part of a path, so this is deliberately not
// assertSafeResourceName: no GML-identifier rule applies, only the four
// characters that would break a .yy file or a tool that ever did round-trip one
// through a path.
const MAX_LAYER_NAME_LENGTH = 255;

export function assertValidLayerName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Layer name cannot be empty");
  }
  if (name.length > MAX_LAYER_NAME_LENGTH) {
    throw new Error(`Layer name is ${name.length} characters, over the ${MAX_LAYER_NAME_LENGTH}-character limit`);
  }
  if (/[/\\:.]/.test(name)) {
    throw new Error(`Layer name "${name}" cannot contain "/", "\\", ":" or "."`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`Layer name "${name}" cannot contain control characters`);
  }
}

function layerNameOf(layer: any): string {
  return layer.name ?? layer["%Name"];
}

/**
 * Locate a layer anywhere in the room's layer tree (folders nest arbitrarily
 * deep), returning the array that holds it so callers can splice it out.
 */
export function findRoomLayer(
  roomYy: any,
  layerName: string
): { layer: any; container: any[]; index: number } | undefined {
  function search(container: any[]): { layer: any; container: any[]; index: number } | undefined {
    for (let index = 0; index < container.length; index++) {
      const layer = container[index];
      if (layerNameOf(layer) === layerName) return { layer, container, index };
      if (Array.isArray(layer.layers) && layer.layers.length > 0) {
        const nested = search(layer.layers);
        if (nested) return nested;
      }
    }
    return undefined;
  }
  return search(roomYy.layers ?? []);
}

function requireRoomLayer(room: any, roomName: string, layerName: string) {
  const found = findRoomLayer(room, layerName);
  if (!found) {
    throw new Error(`Room "${roomName}" has no layer named "${layerName}"`);
  }
  return found;
}

// GameMaker's depth ordering runs high -> low, so a new layer's default has to
// sit behind everything that already exists, sub-layers included.
function maxLayerDepth(layers: any[]): number {
  let max = -Infinity;
  for (const layer of layers) {
    if (typeof layer.depth === "number" && layer.depth > max) max = layer.depth;
    if (Array.isArray(layer.layers)) max = Math.max(max, maxLayerDepth(layer.layers));
  }
  return max;
}

// Which layer kinds carry countable contents. A folder's own count is the sum
// of its sub-layers (see recursiveElementCount). Path and effect layers hold no
// in-layer elements at all -- their payload is a pathId/effectType pointing at a
// project resource -- so they legitimately count 0 and a removal of one never
// destroys an element.
function countLayerElements(layer: any): number {
  switch (layer.resourceType) {
    case "GMRInstanceLayer":
      return layer.instances?.length ?? 0;
    case "GMRTileLayer": {
      const flat = decompressTileData(layer.tiles?.TileCompressedData ?? []);
      return flat.filter(v => v !== EMPTY_TILE).length;
    }
    case "GMRAssetLayer":
      return layer.assets?.length ?? 0;
    default:
      return 0;
  }
}

// What the layer editor's own count column shows: a folder counts everything
// inside it, which is what makes list_room_layers' folder rows useful even
// though the nested layers are listed separately too.
function recursiveElementCount(layer: any): number {
  let total = countLayerElements(layer);
  for (const child of layer.layers ?? []) total += recursiveElementCount(child);
  return total;
}

// A folder layer is $GMRLayer in 2024.14+; $GMRFolder is what older GameMaker
// releases wrote, so both are accepted when reading.
function isLayerFolder(layer: any): boolean {
  return layer.resourceType === "GMRLayer" || layer.resourceType === "GMRFolder";
}

function newLayerDepth(room: any, explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const topLevel = room.layers ?? [];
  return topLevel.length > 0 ? maxLayerDepth(topLevel) + 100 : 0;
}

/**
 * List every layer in a room, in layer-editor order, recursing into folder
 * layers (nested layers carry the name of the folder that holds them).
 * elementCount follows removeRoomLayer's definition of "non-empty".
 */
export async function listRoomLayers(projectDir: string, roomName: string): Promise<RoomLayerInfo[]> {
  const { room } = await readRoomYy(projectDir, roomName);
  const out: RoomLayerInfo[] = [];

  function walk(layers: any[], parentLayerName?: string): void {
    for (const layer of layers) {
      const info: RoomLayerInfo = {
        name: layerNameOf(layer),
        type: layer.resourceType,
        depth: layer.depth,
        visible: layer.visible ?? true,
        elementCount: recursiveElementCount(layer),
      };
      if (parentLayerName !== undefined) info.parentLayerName = parentLayerName;
      out.push(info);
      if (Array.isArray(layer.layers) && layer.layers.length > 0) walk(layer.layers, info.name);
    }
  }

  walk(room.layers ?? []);
  return out;
}

export type NewLayerType = "instance" | "asset" | "tile" | "path" | "background" | "effect" | "folder";

export interface AddRoomLayerOptions {
  layerType: NewLayerType;
  depth?: number;
  visible?: boolean;
  parentLayerName?: string;
  tilesetName?: string;
  spriteName?: string;
  color?: number;
  tiled?: boolean;
  stretch?: boolean;
  horizontalTile?: boolean;
  verticalTile?: boolean;
  xscale?: number;
  yscale?: number;
  hspeed?: number;
  vspeed?: number;
  x?: number;
  y?: number;
}

// GameMaker writes a layer's own keys in case-insensitive alphabetical order
// ($Type and %Name first) and nests its type-specific objects (tiles, tilesetId,
// spriteId) in the order those structs' fields happen to serialise. Matching the
// top-level order keeps diffs small; it is NOT byte-fidelity: JSON.stringify
// prints 1.0 as 1, so an IDE resave of what we write still diffs on float
// spelling.
function sortKeys(obj: Record<string, unknown>): any {
  const out: any = {};
  const keys = Object.keys(obj).sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al !== bl) return al < bl ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const key of keys) out[key] = obj[key];
  return out;
}

// The part every layer kind shares. Type-specific keys get merged in and the
// whole thing re-sorted, so each builder stays a short extra-keys list.
function commonLayer(kind: string, name: string, depth: number, visible: boolean, extra: Record<string, unknown>) {
  return sortKeys({
    [`$${kind}`]: "",
    "%Name": name,
    depth,
    effectEnabled: true,
    effectType: null,
    gridX: ROOM_LAYER_GRID,
    gridY: ROOM_LAYER_GRID,
    hierarchyFrozen: false,
    inheritLayerDepth: false,
    inheritLayerSettings: false,
    inheritSubLayers: true,
    inheritVisibility: true,
    layers: [],
    name,
    properties: [],
    resourceType: kind,
    resourceVersion: LAYER_VERSION,
    userdefinedDepth: false,
    visible,
    ...extra,
  });
}

function randomGraphicName(): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += "0123456789ABCDEF"[Math.floor(Math.random() * 16)];
  return `graph_${suffix}`;
}

// An "asset layer" holds GMRGraphic/GMRSpriteGraphic elements; a whole sprite
// is a GMRSpriteGraphic (GMRGraphic is the sub-rect/legacy-tile variant).
function spriteGraphic(spriteName: string, opts: AddRoomLayerOptions, colour: number) {
  const name = randomGraphicName();
  return sortKeys({
    $GMRSpriteGraphic: "",
    "%Name": name,
    animationSpeed: 1.0,
    colour,
    frozen: false,
    headPosition: 0.0,
    ignore: false,
    inheritedItemId: null,
    inheritItemSettings: false,
    name,
    resourceType: "GMRSpriteGraphic",
    resourceVersion: LAYER_VERSION,
    rotation: 0.0,
    scaleX: opts.xscale ?? 1.0,
    scaleY: opts.yscale ?? 1.0,
    spriteId: { name: spriteName, path: `sprites/${spriteName}/${spriteName}.yy` },
    x: 0.0,
    y: 0.0,
  });
}

async function tilesetFor(projectDir: string, tilesetName: string): Promise<{ tileWidth: number; tileHeight: number }> {
  assertSafeResourceName(tilesetName);
  const yyPath = path.join(projectDir, "tilesets", tilesetName, `${tilesetName}.yy`);
  if (!(await fileExists(yyPath))) {
    throw new Error(`Tileset "${tilesetName}" does not exist (expected ${yyPath})`);
  }
  const tileset = parseGameMakerJson(await fs.readFile(yyPath, "utf8"));
  return { tileWidth: tileset.tileWidth, tileHeight: tileset.tileHeight };
}

function tileLayer(name: string, depth: number, visible: boolean, tilesetName: string, columns: number, rows: number) {
  const cells = columns * rows;
  return commonLayer("GMRTileLayer", name, depth, visible, {
    // A fresh tile layer is a room-sized grid of EMPTY_TILE, RLE-encoded as one
    // run -- the same shape a real GameMaker file has when nothing is drawn.
    // Field order matches GameMaker's own (rm_lv1.yy:41,48,52,60); the tiles
    // struct is not run through sortKeys, so the literal order is what ships.
    tiles: { SerialiseHeight: rows, SerialiseWidth: columns, TileCompressedData: [-cells, EMPTY_TILE], TileDataFormat: 1 },
    tilesetId: { name: tilesetName, path: `tilesets/${tilesetName}/${tilesetName}.yy` },
    x: 0,
    y: 0,
  });
}

function backgroundLayer(name: string, depth: number, visible: boolean, opts: AddRoomLayerOptions) {
  return commonLayer("GMRBackgroundLayer", name, depth, visible, {
    animationFPS: 15.0,
    animationSpeedType: 0,
    colour: opts.color ?? 4278190080,
    hspeed: opts.hspeed ?? 0.0,
    htiled: opts.horizontalTile ?? opts.tiled ?? false,
    spriteId: null,
    stretch: opts.stretch ?? false,
    userdefinedAnimFPS: false,
    vspeed: opts.vspeed ?? 0.0,
    vtiled: opts.verticalTile ?? opts.tiled ?? false,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
  });
}

/**
 * Add a layer to an existing room. The layer's .yy shape follows what
 * GameMaker itself writes; anything the options don't cover keeps GameMaker's
 * own default for that layer type.
 */
export async function addRoomLayer(
  projectDir: string,
  roomName: string,
  layerName: string,
  opts: AddRoomLayerOptions
): Promise<{ roomName: string; layerName: string; layerType: string; depth: number; elementCount: number }> {
  assertValidLayerName(layerName);
  const { room, file } = await readRoomYy(projectDir, roomName);

  if (findRoomLayer(room, layerName)) {
    throw new Error(`Room "${roomName}" already has a layer named "${layerName}"`);
  }

  if (room.layers === undefined) room.layers = [];
  let container: any[] = room.layers;
  if (opts.parentLayerName !== undefined) {
    const parent = requireRoomLayer(room, roomName, opts.parentLayerName);
    if (!isLayerFolder(parent.layer)) {
      throw new Error(
        `Layer "${opts.parentLayerName}" is a ${parent.layer.resourceType}, not a folder -- only folder layers can hold sub-layers`
      );
    }
    if (parent.layer.layers === undefined) parent.layer.layers = [];
    container = parent.layer.layers;
  }

  const depth = newLayerDepth(room, opts.depth);
  const visible = opts.visible ?? true;
  let layer: any;

  switch (opts.layerType) {
    case "instance":
      layer = commonLayer("GMRInstanceLayer", layerName, depth, visible, { instances: [] });
      break;
    case "asset": {
      const assets: any[] = [];
      if (opts.spriteName !== undefined) {
        assertSafeResourceName(opts.spriteName);
        const spriteYy = path.join(projectDir, "sprites", opts.spriteName, `${opts.spriteName}.yy`);
        if (!(await fileExists(spriteYy))) {
          throw new Error(`Sprite "${opts.spriteName}" does not exist (expected ${spriteYy})`);
        }
        assets.push(spriteGraphic(opts.spriteName, opts, opts.color ?? 4294967295));
      }
      layer = commonLayer("GMRAssetLayer", layerName, depth, visible, { assets });
      break;
    }
    case "tile": {
      if (opts.tilesetName === undefined) {
        throw new Error(`A tile layer needs a tilesetName -- add_tileset first if the project has none`);
      }
      const tileset = await tilesetFor(projectDir, opts.tilesetName);
      const roomWidth = room.roomSettings?.Width ?? 0;
      const roomHeight = room.roomSettings?.Height ?? 0;
      const columns = Math.max(1, Math.ceil(roomWidth / tileset.tileWidth));
      const rows = Math.max(1, Math.ceil(roomHeight / tileset.tileHeight));
      layer = tileLayer(layerName, depth, visible, opts.tilesetName, columns, rows);
      break;
    }
    case "path":
      // No pathId option: a path layer with nothing selected is legal in the
      // editor and serialises as null.
      layer = commonLayer("GMRPathLayer", layerName, depth, visible, {
        colour: opts.color ?? 4294967295,
        pathId: null,
      });
      break;
    case "background":
      layer = backgroundLayer(layerName, depth, visible, opts);
      break;
    case "effect":
      layer = commonLayer("GMREffectLayer", layerName, depth, visible, {});
      break;
    case "folder":
      // A layer folder serialises as $GMRLayer in 2024.14+; the older
      // $GMRFolder spelling is rejected outright by GameMaker's own validator
      // ("Resource type '$GMRFolder' is not in the target GameMaker release",
      // ProjectTool 2024.14.165).
      layer = commonLayer("GMRLayer", layerName, depth, visible, {});
      break;
    default:
      throw new Error(`Unknown layer type "${(opts as any).layerType}"`);
  }

  container.push(layer);
  await writeRoomYy(file, room);
  return { roomName, layerName, layerType: layer.resourceType, depth, elementCount: countLayerElements(layer) };
}

/**
 * A room's instanceCreationOrder must name exactly the instances the room
 * holds -- GameMaker refuses to load a room whose order lists an instance it
 * can't find, which is what a forced instance-layer removal would otherwise
 * leave behind.
 */
function pruneInstanceCreationOrder(room: any): void {
  if (!Array.isArray(room.instanceCreationOrder)) return;
  const alive = new Set<string>();
  (function walk(layers: any[]): void {
    for (const layer of layers) {
      for (const instance of layer.instances ?? []) {
        const name = instance.name ?? instance["%Name"];
        if (typeof name === "string") alive.add(name);
      }
      if (Array.isArray(layer.layers)) walk(layer.layers);
    }
  })(room.layers ?? []);
  room.instanceCreationOrder = room.instanceCreationOrder.filter(
    (entry: any) => typeof entry?.name !== "string" || alive.has(entry.name)
  );
}

/**
 * Remove a layer. Non-empty layers need force: true -- same for a folder that
 * would otherwise take its sub-layers with it.
 */
export async function removeRoomLayer(
  projectDir: string,
  roomName: string,
  layerName: string,
  opts: { force?: boolean } = {}
): Promise<{ roomName: string; layerName: string; removed: true }> {
  const { room, file } = await readRoomYy(projectDir, roomName);
  const found = requireRoomLayer(room, roomName, layerName);
  const elementCount = countLayerElements(found.layer);

  // A room needs at least one layer; GameMaker writes an empty layers array for
  // a room whose only layer was deleted by hand, and the room then fails to open.
  if (found.container === room.layers && room.layers.length <= 1) {
    throw new Error(
      `Layer "${layerName}" is the last layer in room "${roomName}" -- GameMaker needs at least one layer, so add another (add_room_layer) before removing this one`
    );
  }

  if (elementCount > 0 && !opts.force) {
    throw new Error(
      `Layer "${layerName}" in room "${roomName}" still holds ${elementCount} element(s) -- pass force: true to delete it with its contents`
    );
  }
  const subLayers = found.layer.layers?.length ?? 0;
  if (subLayers > 0 && !opts.force) {
    throw new Error(
      `Layer "${layerName}" in room "${roomName}" is a folder holding ${subLayers} sub-layer(s) -- pass force: true to delete it and them`
    );
  }

  found.container.splice(found.index, 1);
  pruneInstanceCreationOrder(room);
  await writeRoomYy(file, room);
  return { roomName, layerName, removed: true };
}

/**
 * Change a layer's visibility and/or depth. No rename: GameMaker resolves
 * layers by name at runtime and in creation code, so renaming is a rewrite of
 * every reference, not a field edit. A call that changes nothing leaves the file
 * untouched, for the same reason every other writer here does.
 */
export async function setRoomLayer(
  projectDir: string,
  roomName: string,
  layerName: string,
  opts: { visible?: boolean; depth?: number }
): Promise<string> {
  if (opts.visible === undefined && opts.depth === undefined) {
    throw new Error(`Nothing to change on layer "${layerName}": pass visible and/or depth`);
  }
  const { room, file } = await readRoomYy(projectDir, roomName);
  const { layer } = requireRoomLayer(room, roomName, layerName);

  const changes: string[] = [];
  if (opts.visible !== undefined && layer.visible !== opts.visible) {
    layer.visible = opts.visible;
    changes.push(`visible=${opts.visible}`);
  }
  if (opts.depth !== undefined && layer.depth !== opts.depth) {
    layer.depth = opts.depth;
    changes.push(`depth=${opts.depth}`);
  }

  if (changes.length === 0) {
    return `Layer "${layerName}" in room "${roomName}" unchanged -- no field differed from the requested values`;
  }

  await writeRoomYy(file, room);
  return `Updated layer "${layerName}" in room "${roomName}": ${changes.join(", ")}`;
}
