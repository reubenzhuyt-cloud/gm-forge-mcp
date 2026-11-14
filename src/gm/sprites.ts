import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import type { Yyp } from "@bscotch/yy";
import { atomicCopyFile, atomicWriteFile, atomicWriteJson } from "./atomic.js";
import { ensureFolder, ensureTextureGroup, registerResource, validateResourceName, RESOURCE_VERSIONS, parseGameMakerJson, assertSafeResourceName } from "./yyp.js";

interface ImageSize {
  width: number;
  height: number;
}

// Reads just the IHDR chunk of a PNG (signature + 8 bytes of header) to get
// real dimensions -- avoids pulling in an image library for one field.
export async function readPngDimensions(pngPath: string): Promise<ImageSize> {
  const handle = await fs.open(pngPath, "r");
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    const signatureOk = header.readUInt32BE(0) === 0x89504e47 && header.readUInt32BE(4) === 0x0d0a1a0a;
    if (!signatureOk) {
      throw new Error(`Not a valid PNG file: ${pngPath}`);
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

async function listFrameSources(framesDir: string): Promise<string[]> {
  const pngs = (await fs.readdir(framesDir))
    .filter(f => f.toLowerCase().endsWith(".png"))
    .sort();
  if (pngs.length === 0) {
    throw new Error(`No PNG frames found in ${framesDir}`);
  }
  return pngs;
}

interface ImportedFrames {
  frameIds: string[];
  size: ImageSize;
}

/**
 * Copies each source PNG into the sprite directory twice: once as the flat
 * composite (what GameMaker renders) and once under layers/<frameId>/ (what
 * the sprite editor loads for non-destructive layer editing). GameMaker
 * refuses to load the project without the second copy, even though it
 * duplicates the first.
 */
async function importFrames(framesDir: string, files: string[], spriteDir: string, layerId: string): Promise<ImportedFrames> {
  const frameIds: string[] = [];
  let size: ImageSize | null = null;

  for (const file of files) {
    const source = path.join(framesDir, file);
    const dims = await readPngDimensions(source);
    if (!size) {
      size = dims;
    } else if (dims.width !== size.width || dims.height !== size.height) {
      throw new Error(`Frame ${file} is ${dims.width}x${dims.height}, expected ${size.width}x${size.height} (all frames must match the first frame's size)`);
    }

    const frameId = crypto.randomUUID();
    frameIds.push(frameId);

    await atomicCopyFile(source, path.join(spriteDir, `${frameId}.png`));

    const layerDir = path.join(spriteDir, "layers", frameId);
    await fs.mkdir(layerDir, { recursive: true });
    await atomicCopyFile(source, path.join(layerDir, `${layerId}.png`));
  }

  return { frameIds, size: size! };
}

export function frameEntry(frameId: string) {
  return {
    name: frameId,
    resourceType: "GMSpriteFrame",
    resourceVersion: RESOURCE_VERSIONS.spriteFrame,
    "$GMSpriteFrame": "v1",
    "%Name": frameId
  };
}

function layerEntry(layerId: string) {
  return {
    visible: true,
    isLocked: false,
    blendMode: 0,
    opacity: 100.0,
    displayName: "default",
    name: layerId,
    resourceType: "GMImageLayer",
    resourceVersion: RESOURCE_VERSIONS.spriteLayer,
    "$GMImageLayer": "",
    "%Name": layerId
  };
}

export function frameKeyframe(spriteName: string, frameId: string, index: number) {
  return {
    id: crypto.randomUUID(),
    Key: index,
    Length: 1.0,
    Stretch: false,
    Disabled: false,
    IsCreationKey: false,
    Channels: {
      "0": {
        Id: { name: frameId, path: `sprites/${spriteName}/${spriteName}.yy` },
        resourceType: "SpriteFrameKeyframe",
        resourceVersion: RESOURCE_VERSIONS.spriteFrameKeyframe,
        "$SpriteFrameKeyframe": ""
      }
    },
    resourceType: "Keyframe<SpriteFrameKeyframe>",
    resourceVersion: RESOURCE_VERSIONS.spriteFrameKeyframe,
    "$Keyframe<SpriteFrameKeyframe>": ""
  };
}

function sequenceEntry(spriteName: string, frameIds: string[]) {
  const keyframes = frameIds.map((id, i) => frameKeyframe(spriteName, id, i));
  const framesTrack = {
    name: "frames",
    spriteId: null,
    keyframes: {
      Keyframes: keyframes,
      resourceType: "KeyframeStore<SpriteFrameKeyframe>",
      resourceVersion: RESOURCE_VERSIONS.spriteFrameKeyframe,
      "$KeyframeStore<SpriteFrameKeyframe>": ""
    },
    trackColour: 0,
    inheritsTrackColour: true,
    builtinName: 0,
    traits: 0,
    interpolation: 1,
    tracks: [],
    events: [],
    modifiers: [],
    isCreationTrack: false,
    resourceType: "GMSpriteFramesTrack",
    resourceVersion: RESOURCE_VERSIONS.spriteFramesTrack,
    "$GMSpriteFramesTrack": ""
  };

  return {
    name: spriteName,
    length: frameIds.length,
    playback: 1,
    playbackSpeed: 30.0,
    playbackSpeedType: 0,
    autoRecord: true,
    volume: 1.0,
    lockOrigin: false,
    showBackdrop: true,
    showBackdropImage: false,
    backdropImagePath: "",
    backdropImageOpacity: 0.5,
    backdropWidth: 1366,
    backdropHeight: 768,
    backdropXOffset: 0.0,
    backdropYOffset: 0.0,
    xorigin: 0,
    yorigin: 0,
    eventToFunction: {},
    eventStubScript: null,
    visibleRange: null,
    timeUnits: 1,
    tracks: [framesTrack],
    moments: {
      Keyframes: [],
      resourceType: "KeyframeStore<MomentsEventKeyframe>",
      resourceVersion: RESOURCE_VERSIONS.spriteMomentsKeyframes,
      "$KeyframeStore<MomentsEventKeyframe>": ""
    },
    events: {
      Keyframes: [],
      resourceType: "KeyframeStore<MessageEventKeyframe>",
      resourceVersion: RESOURCE_VERSIONS.spriteMessageKeyframes,
      "$KeyframeStore<MessageEventKeyframe>": ""
    },
    resourceType: "GMSequence",
    resourceVersion: RESOURCE_VERSIONS.spriteSequence,
    "$GMSequence": "v1",
    "%Name": spriteName
  };
}

function spriteYy(name: string, size: ImageSize, frameIds: string[], layerId: string) {
  return {
    name,
    type: 0,
    origin: 0,
    preMultiplyAlpha: false,
    edgeFiltering: false,
    collisionKind: 0,
    collisionTolerance: 0,
    DynamicTexturePage: false,
    For3D: false,
    HTile: false,
    VTile: false,
    width: size.width,
    height: size.height,
    bboxMode: 0,
    bbox_left: 0,
    bbox_top: 0,
    bbox_right: size.width - 1,
    bbox_bottom: size.height - 1,
    gridX: 0,
    gridY: 0,
    swfPrecision: 0.5,
    nineSlice: null,
    swatchColours: null,
    textureGroupId: { name: "Default", path: "texturegroups/Default" },
    frames: frameIds.map(frameEntry),
    layers: [layerEntry(layerId)],
    sequence: sequenceEntry(name, frameIds),
    parent: { name: "Sprites", path: "folders/Sprites.yy" },
    resourceType: "GMSprite",
    resourceVersion: RESOURCE_VERSIONS.sprite,
    "$GMSprite": "v2",
    "%Name": name
  };
}

export async function addSpriteFromImages(projectDir: string, yyp: Yyp, name: string, framesDir: string): Promise<Yyp> {
  validateResourceName(yyp, name);

  const spriteDir = path.join(projectDir, "sprites", name);
  await fs.mkdir(spriteDir, { recursive: true });

  const sources = await listFrameSources(framesDir);
  const layerId = crypto.randomUUID();
  const { frameIds, size } = await importFrames(framesDir, sources, spriteDir, layerId);

  await atomicWriteJson(path.join(spriteDir, `${name}.yy`), spriteYy(name, size, frameIds, layerId));

  ensureFolder(yyp, "Sprites");
  ensureTextureGroup(yyp);
  registerResource(yyp, name, `sprites/${name}/${name}.yy`);

  return yyp;
}

export interface SpriteEditOptions {
  xorigin?: number;
  yorigin?: number;
  collisionKind?: number;
  bboxMode?: number;
  bbox_left?: number;
  bbox_top?: number;
  bbox_right?: number;
  bbox_bottom?: number;
}

// The values this tree can actually evidence, not a guess at GameMaker's enum.
// collisionKind: 0 is what spriteYy above writes for every sprite the tools
// create (IDE-accepted, asserted by the key-set tests); 1 is what all 46 sprites
// of the real 261103GJ project carry, so no other member of the enum has a
// sample behind it.
export const SPRITE_COLLISION_KINDS: readonly number[] = [0, 1];
// bboxMode: 0 (Automatic) and 1 (Full Image) occur in real project files;
// 2 (Manual) is the only mode under which GameMaker keeps hand-written
// bbox_* numbers, and is what sprite_frames.ts's resize guard already treats as
// a hand-authored mask.
export const SPRITE_BBOX_MODES: readonly number[] = [0, 1, 2];
export const MANUAL_BBOX_MODE = 2;

export const SPRITE_BBOX_KEYS = ["bbox_left", "bbox_top", "bbox_right", "bbox_bottom"] as const;

export function describeSpriteCollisionKinds(): string {
  const names: Record<number, string> = { 0: "Precise", 1: "Rectangle" };
  return SPRITE_COLLISION_KINDS.map(value => `${value} (${names[value]})`).join(", ");
}

export function describeSpriteBboxModes(): string {
  const names: Record<number, string> = { 0: "Automatic", 1: "Full Image", 2: "Manual" };
  return SPRITE_BBOX_MODES.map(value => `${value} (${names[value]})`).join(", ");
}

function showValue(value: unknown): string {
  return typeof value === "number" && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
}

function assertFiniteValue(name: string, field: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `${field} must be a finite number for sprite "${name}", got ${showValue(value)} -- ` +
        `JSON.stringify writes a non-finite number as null, which GameMaker cannot read as a coordinate or a bounds edge`
    );
  }
}

/**
 * Everything that can be refused without touching disk. The tool schema repeats
 * the parts that need no file (finite numbers, the two allowlists, bboxMode 2
 * with bbox_*); the ranges below need the sprite's real width/height.
 */
function validateSpriteEdit(sprite: any, name: string, options: SpriteEditOptions): void {
  if (options.collisionKind !== undefined) {
    assertFiniteValue(name, "collisionKind", options.collisionKind);
    if (!Number.isInteger(options.collisionKind)) {
      throw new Error(`collisionKind must be a whole number for sprite "${name}", got ${options.collisionKind}`);
    }
    if (!SPRITE_COLLISION_KINDS.includes(options.collisionKind)) {
      throw new Error(
        `collisionKind ${options.collisionKind} is not supported: the only values this tree can evidence are ` +
          `${describeSpriteCollisionKinds()}. Nothing was written.`
      );
    }
  }
  if (options.bboxMode !== undefined) {
    assertFiniteValue(name, "bboxMode", options.bboxMode);
    if (!Number.isInteger(options.bboxMode)) {
      throw new Error(`bboxMode must be a whole number for sprite "${name}", got ${options.bboxMode}`);
    }
    if (!SPRITE_BBOX_MODES.includes(options.bboxMode)) {
      throw new Error(
        `bboxMode ${options.bboxMode} is not supported: the only values this tree can evidence are ` +
          `${describeSpriteBboxModes()}. Nothing was written.`
      );
    }
  }

  const suppliedBox = SPRITE_BBOX_KEYS.filter(key => options[key] !== undefined);
  if (suppliedBox.length > 0 && options.bboxMode !== MANUAL_BBOX_MODE) {
    throw new Error(
      `bbox_* (${suppliedBox.join(", ")}) need bboxMode 2 (Manual) on sprite "${name}", got bboxMode ` +
        `${options.bboxMode === undefined ? `omitted (the sprite is at ${JSON.stringify(sprite.bboxMode)})` : options.bboxMode}. ` +
        `The IDE discards manual bounds under Automatic (0) and Full Image (1) and recomputes the mask, so these numbers ` +
        `would never be read. Pass bboxMode: 2 with the bounds. Nothing was written.`
    );
  }

  const needsSize =
    options.xorigin !== undefined ||
    options.yorigin !== undefined ||
    suppliedBox.length > 0;
  if (!needsSize) return;

  const width = sprite.width;
  const height = sprite.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(
      `sprite "${name}" has no usable width/height (${JSON.stringify(width)}x${JSON.stringify(height)}), so its origin and ` +
        `bounding box cannot be checked against the frame. Nothing was written.`
    );
  }

  if (options.xorigin !== undefined) {
    assertFiniteValue(name, "xorigin", options.xorigin);
    if (options.xorigin < 0 || options.xorigin > width) {
      throw new Error(
        `xorigin ${options.xorigin} is outside 0..${width} for sprite "${name}" (the origin may sit on the far edge, so the ` +
          `upper bound is the width itself). Nothing was written.`
      );
    }
  }
  if (options.yorigin !== undefined) {
    assertFiniteValue(name, "yorigin", options.yorigin);
    if (options.yorigin < 0 || options.yorigin > height) {
      throw new Error(
        `yorigin ${options.yorigin} is outside 0..${height} for sprite "${name}" (the origin may sit on the far edge, so the ` +
          `upper bound is the height itself). Nothing was written.`
      );
    }
  }

  if (suppliedBox.length === 0) return;
  const box = {
    left: options.bbox_left ?? sprite.bbox_left,
    top: options.bbox_top ?? sprite.bbox_top,
    right: options.bbox_right ?? sprite.bbox_right,
    bottom: options.bbox_bottom ?? sprite.bbox_bottom,
  };
  for (const [label, value] of [
    ["bbox_left", box.left],
    ["bbox_top", box.top],
    ["bbox_right", box.right],
    ["bbox_bottom", box.bottom],
  ] as const) {
    assertFiniteValue(name, label, value);
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be a whole number of pixels for sprite "${name}", got ${value}. Nothing was written.`);
    }
  }
  if (box.left < 0 || box.top < 0 || box.right > width - 1 || box.bottom > height - 1) {
    throw new Error(
      `bounding box (${box.left},${box.top},${box.right},${box.bottom}) does not fit sprite "${name}" (${width}x${height}): ` +
        `every edge must lie inside 0,0..${width - 1},${height - 1}. Nothing was written.`
    );
  }
  if (box.left >= box.right || box.top >= box.bottom) {
    throw new Error(
      `bounding box (${box.left},${box.top},${box.right},${box.bottom}) for sprite "${name}" is empty or inverted: ` +
        `bbox_left must be < bbox_right and bbox_top < bbox_bottom. Nothing was written.`
    );
  }
}

/**
 * Replaces one scalar's own token in the file text, leaving every other byte
 * alone -- the same in-place technique set_project_option uses (options.ts),
 * because the IDE's writer (`"k":v,`, trailing commas, `1.0` for floats) and
 * JSON.stringify(obj, null, 2) disagree on every line. A key that is not alone
 * on its own line is refused rather than reformatted.
 */
function rewriteScalarInPlace(text: string, key: string, value: number | boolean, rel: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^([ \\t]*"${escaped}"[ \\t]*:[ \\t]*)("(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)([ \\t]*,?[ \\t]*\\r?)$`,
    "gm"
  );
  const matches: RegExpExecArray[] = [];
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    matches.push(m);
    if (matches.length > 1) break;
  }
  if (matches.length !== 1) {
    const found =
      matches.length === 0
        ? `"${key}" is missing, or is not alone on its own line`
        : `"${key}" appears on more than one line`;
    throw new Error(
      `cannot rewrite ${rel} in place: ${found}, so changing it would mean restyling the whole file; refusing. Nothing was written.`
    );
  }
  const [match] = matches;
  const start = match.index + match[1].length;
  return text.slice(0, start) + JSON.stringify(value) + text.slice(start + match[2].length);
}

/**
 * Edit an existing sprite's origin, collision kind, and/or bounding box --
 * not its frame data, which is a bigger concern closer to delete+recreate
 * than an in-place edit. Setting xorigin/yorigin also flips the top-level
 * origin preset to 9 (Custom) and `sequence.lockOrigin` to false, matching what
 * the IDE does when you type a coordinate instead of picking a preset (a locked
 * origin makes the IDE ignore the new numbers).
 *
 * Only the changed lines are rewritten: the request is applied to the parsed
 * file, the changed keys are substituted into the original text, and the result
 * is re-parsed and compared before anything is written. A request that changes
 * nothing writes nothing and says so instead of reporting an update.
 */
export async function editSprite(
  projectDir: string,
  name: string,
  options: SpriteEditOptions
): Promise<string> {
  assertSafeResourceName(name);
  const yyPath = path.join(projectDir, "sprites", name, `${name}.yy`);
  const rel = `sprites/${name}/${name}.yy`;
  let text: string;
  let sprite: any;
  try {
    text = await fs.readFile(yyPath, "utf8");
    sprite = parseGameMakerJson(text);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new Error(`Sprite "${name}" does not exist (expected ${yyPath})`);
    }
    throw new Error(`Failed to read sprite "${name}" at ${yyPath}: ${e.message}`);
  }

  validateSpriteEdit(sprite, name, options);

  const before = JSON.stringify(sprite);
  const changes: string[] = [];
  const patches: Array<{ key: string; value: number | boolean }> = [];

  let originTouched = false;
  if (options.xorigin !== undefined || options.yorigin !== undefined) {
    if (!sprite.sequence || typeof sprite.sequence !== "object" || Array.isArray(sprite.sequence)) {
      throw new Error(
        `sprite "${name}" has no sequence object, so its origin cannot be set. Nothing was written.`
      );
    }
    if (options.xorigin !== undefined && sprite.sequence.xorigin !== options.xorigin) {
      sprite.sequence.xorigin = options.xorigin;
      patches.push({ key: "xorigin", value: options.xorigin });
      changes.push(`xorigin=${options.xorigin}`);
      originTouched = true;
    }
    if (options.yorigin !== undefined && sprite.sequence.yorigin !== options.yorigin) {
      sprite.sequence.yorigin = options.yorigin;
      patches.push({ key: "yorigin", value: options.yorigin });
      changes.push(`yorigin=${options.yorigin}`);
      originTouched = true;
    }
    if (originTouched) {
      if (sprite.sequence.lockOrigin !== false) {
        sprite.sequence.lockOrigin = false;
        patches.push({ key: "lockOrigin", value: false });
        changes.push("lockOrigin=false");
      }
      if (sprite.origin !== 9) {
        sprite.origin = 9; // Custom
        patches.push({ key: "origin", value: 9 });
        changes.push("origin=9");
      }
    }
  }

  for (const key of ["collisionKind", "bboxMode", "bbox_left", "bbox_top", "bbox_right", "bbox_bottom"] as const) {
    const next = options[key];
    if (next === undefined || sprite[key] === next) continue;
    sprite[key] = next;
    patches.push({ key, value: next });
    changes.push(`${key}=${next}`);
  }

  if (JSON.stringify(sprite) === before) {
    return (
      `✓ Sprite "${name}" already in the requested state -- nothing differed, so ${rel} was left untouched ` +
      `(not rewritten, no backup taken)`
    );
  }

  let nextText = text;
  for (const patch of patches) {
    nextText = rewriteScalarInPlace(nextText, patch.key, patch.value, rel);
  }
  if (JSON.stringify(parseGameMakerJson(nextText)) !== JSON.stringify(sprite)) {
    throw new Error(
      `internal: rewriting ${rel} in place did not produce the requested state; nothing was written`
    );
  }
  await atomicWriteFile(yyPath, nextText);
  return `✓ Updated sprite "${name}": ${changes.join(", ")}`;
}
