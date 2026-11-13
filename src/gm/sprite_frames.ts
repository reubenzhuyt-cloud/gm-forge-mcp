import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { atomicCopyFile, atomicWriteFile, describeLockedFile, sha256File } from "./atomic.js";
import { frameEntry, frameKeyframe, readPngDimensions } from "./sprites.js";
import { assertSafePathSegment, MAX_PATH_SEGMENT_LENGTH, type SegmentRules } from "./path_safety.js";
import { assertSafeResourceName, fileExists, parseGameMakerJson } from "./yyp.js";

// Sprite frame editing. A frame is TWO pngs, never one: the composite
// sprites/<name>/<frameGuid>.png and the per-layer copy
// sprites/<name>/layers/<frameGuid>/<layerGuid>.png. importFrames in sprites.ts
// explains why the duplicate exists -- GameMaker refuses to load a sprite that
// is missing the second -- so every create/copy/delete below goes through
// writeFramePngs/deleteFramePngs and no tool can drift one half out of sync.
//
// The other invariant is that sequence.length counts FRAMES, not seconds: the
// real 4-frame sample has length 4.0 with playbackSpeed 10.0, so
// frameCount / playbackSpeed (0.4) is never the answer. playbackSpeed and every
// other per-sprite setting is preserved verbatim; nothing here touches the .yyp,
// textureGroupId, nineSlice or the origin.

export interface SpriteFrameInfo {
  index: number;
  guid: string;
  file: string;
  existsOnDisk: boolean;
}

export interface SpriteFramesInfo {
  width: number;
  height: number;
  origin: { x: number; y: number };
  frameCount: number;
  frames: SpriteFrameInfo[];
  sequence: { length: number; playbackSpeed: number; playbackSpeedType: number; keyframeCount: number };
  verdict: string;
  missingFiles: string[];
}

export interface AddSpriteFrameResult {
  spriteName: string;
  index: number;
  frameCount: number;
}

export interface RemoveSpriteFrameResult {
  spriteName: string;
  frameCount: number;
  removedGuid: string;
  /** Files the .yy no longer references that could NOT be deleted (locked, read-only). */
  leftoverFiles: string[];
}

export interface ReplaceSpriteFrameResult {
  spriteName: string;
  index: number;
  width: number;
  height: number;
  changed: boolean;
}

export interface ReorderSpriteFramesResult {
  spriteName: string;
  frameCount: number;
  changed: boolean;
}

export interface TrimSpriteFramesResult {
  spriteName: string;
  frameCount: number;
  removed: number;
  /** Files the .yy no longer references that could NOT be deleted (locked, read-only). */
  leftoverFiles: string[];
}

interface SpriteDoc {
  sprite: any;
  yyPath: string;
  spriteDir: string;
  /** Serialisation as read, so a mutation that changes nothing writes nothing. */
  before: string;
}

function serialise(sprite: any): string {
  return JSON.stringify(sprite);
}

function projectRelative(projectDir: string, file: string): string {
  return path.relative(projectDir, file).split(path.sep).join("/");
}

async function readSpriteDoc(projectDir: string, spriteName: string): Promise<SpriteDoc> {
  assertSafeResourceName(spriteName);
  const spriteDir = path.join(projectDir, "sprites", spriteName);
  const yyPath = path.join(spriteDir, `${spriteName}.yy`);
  let sprite: any;
  try {
    sprite = parseGameMakerJson(await fs.readFile(yyPath, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new Error(`Sprite "${spriteName}" does not exist (expected ${yyPath})`);
    }
    throw new Error(`Failed to read sprite "${spriteName}" at ${yyPath}: ${e.message}`);
  }
  return { sprite, yyPath, spriteDir, before: serialise(sprite) };
}

// The .yy write is a temp file plus rename in the sprite's own directory; the
// shared EPERM/EACCES message ("close the sprite in GameMaker and retry") comes
// from atomicWriteFile. JSON.stringify(parsed, null, 2) restyles the file the way
// add_sprite_from_images already does, which is why an unchanged sprite is never
// rewritten -- the IDE accepts the restyle, but it is not byte-identical.
async function writeSpriteYy(yyPath: string, sprite: any): Promise<void> {
  await atomicWriteFile(yyPath, JSON.stringify(sprite, null, 2));
}

function readFrameList(sprite: any, spriteName: string): any[] {
  if (!Array.isArray(sprite?.frames)) {
    throw new Error(`sprite "${spriteName}" has no "frames" array; refusing to edit frames it cannot describe`);
  }
  return sprite.frames;
}

function frameGuidOf(frame: any, spriteName: string, index: number): string {
  const guid = typeof frame?.name === "string" ? frame.name : frame?.["%Name"];
  if (typeof guid !== "string" || guid.length === 0) {
    throw new Error(`sprite "${spriteName}" frame ${index} has no name; refusing to edit frames it cannot describe`);
  }
  return assertSafeFrameGuid(guid, spriteName, index);
}

// A frame guid is not just an identifier: it is used verbatim as
// sprites/<sprite>/<guid>.png, as the layers/<guid>/ directory name, and a
// removal rm -r's that directory. So a guid (or a layer name) read out of a
// hand-edited .yy is a path component, and one containing ".." or a separator
// would let deleteFramePngs remove an arbitrary tree and let
// replace_sprite_frame write caller-chosen bytes outside the sprite. Nothing
// here validates guid *shape* (the IDE's guids are not RFC-4122 and have changed
// across releases); the shared path_safety rules only guarantee it stays one
// filename inside the sprite directory.
const SPRITE_FILE_SEGMENT_RULES: SegmentRules = {
  maxLength: MAX_PATH_SEGMENT_LENGTH,
  separatorHint:
    "it is also a filename inside the sprite directory, so a separator would point the file (and any delete) anywhere on disk",
  illegalCharsHint: "it is also a filename inside the sprite directory",
  reservedHint: "it is also a filename inside the sprite directory, and Windows cannot create it",
};

function assertSafeSpriteFileName(value: string, what: string): string {
  assertSafePathSegment(value, what, SPRITE_FILE_SEGMENT_RULES);
  return value;
}

function assertSafeFrameGuid(guid: string, spriteName: string, index: number): string {
  return assertSafeSpriteFileName(guid, `sprite "${spriteName}" frame ${index} guid`);
}

function keyframeFrameGuid(keyframe: any, spriteName: string, index: number): string | undefined {
  const guid = keyframe?.Channels?.["0"]?.Id?.name;
  if (typeof guid !== "string" || guid.length === 0) return undefined;
  return assertSafeSpriteFileName(guid, `sprite "${spriteName}" keyframe ${index} channel guid`);
}

function duplicateGuids(guids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const guid of guids) {
    if (seen.has(guid)) dupes.add(guid);
    else seen.add(guid);
  }
  return [...dupes];
}

// Locate the frames track by name AND resourceType -- never tracks[0], and never
// the first match of several: a sequence the tools cannot describe is refused.
function locateFramesTrack(sprite: any, spriteName: string): { track: any; keyframes: any[] } {
  const tracks: any[] = Array.isArray(sprite?.sequence?.tracks) ? sprite.sequence.tracks : [];
  const matches = tracks.filter((t: any) => t?.name === "frames" && t?.resourceType === "GMSpriteFramesTrack");
  if (matches.length !== 1) {
    const why = matches.length === 0 ? "has no frames track" : `has ${matches.length} frames tracks`;
    throw new Error(`sprite "${spriteName}" ${why} in its sequence; refusing to edit frames it cannot describe`);
  }
  const store = matches[0].keyframes;
  if (!store || !Array.isArray(store.Keyframes)) {
    throw new Error(`sprite "${spriteName}" has a frames track with no keyframe store; refusing to edit frames it cannot describe`);
  }
  return { track: matches[0], keyframes: store.Keyframes };
}

function layerIdsOf(sprite: any, spriteName: string): string[] {
  const layers: any[] = Array.isArray(sprite?.layers) ? sprite.layers : [];
  const ids: string[] = [];
  for (const [index, layer] of layers.entries()) {
    const id = typeof layer?.name === "string" ? layer.name : layer?.["%Name"];
    if (typeof id === "string" && id.length > 0) {
      ids.push(assertSafeSpriteFileName(id, `sprite "${spriteName}" image layer ${index} name`));
    }
  }
  return ids;
}

// Every frame's per-layer copy is layers/<frameGuid>/<layerId>.png, where
// layerId is the single entry in layers[] (importFrames writes exactly that). A
// sprite with zero or several image layers has no such single path, so mutations
// refuse instead of picking one.
function singleLayerIdOf(sprite: any, spriteName: string): string {
  const ids = layerIdsOf(sprite, spriteName);
  if (ids.length !== 1) {
    throw new Error(
      `sprite "${spriteName}" has ${ids.length} image layers; every frame is stored as one layers/<frameGuid>/<layerId>.png, ` +
        `so refusing to edit this sprite's frames`
    );
  }
  return ids[0];
}

// Every path this module hands to fs goes through here, and every guid it hands
// in has already been through assertSafeFrameGuid/assertSafeSpriteFileName --
// the check is repeated at the join so a future caller that forgets cannot
// escape the sprite directory.
function frameFilePaths(spriteDir: string, frameGuid: string, layerIds: string[]): string[] {
  return [
    path.join(spriteDir, assertSafeSpriteFileName(frameGuid, "frame guid") + ".png"),
    ...layerIds.map((layerId) =>
      path.join(
        spriteDir,
        "layers",
        assertSafeSpriteFileName(frameGuid, "frame guid"),
        `${assertSafeSpriteFileName(layerId, "image layer name")}.png`
      )
    ),
  ];
}

/**
 * The `frames[]` entries and the track's `Keyframes` must agree BEFORE any edit:
 * a tool cannot know which side is authoritative, and rewriting one to match the
 * other would silently change an animation the user authored in the IDE. Returns
 * the existing keyframe for each frame guid, so a surviving frame keeps its own
 * keyframe `id` untouched.
 */
function assertFramesAgreeWithSequence(
  sprite: any,
  spriteName: string,
  frames: any[],
  keyframes: any[]
): Map<string, any> {
  if (frames.length === 0) {
    throw new Error(`sprite "${spriteName}" has no frames; a sprite GameMaker can load has at least one`);
  }
  if (frames.length !== keyframes.length) {
    throw new Error(
      `sprite "${spriteName}" is already inconsistent: ${frames.length} entries in "frames" but ${keyframes.length} keyframes in its frames track; ` +
        `refusing to edit it -- list_sprite_frames reports the mismatch and nothing repairs one (re-import the sprite instead)`
    );
  }

  const guids = frames.map((frame, index) => frameGuidOf(frame, spriteName, index));
  const frameDupes = duplicateGuids(guids);
  if (frameDupes.length > 0) {
    throw new Error(
      `sprite "${spriteName}" lists the frame guid ${frameDupes[0]} more than once; refusing to edit it (two frames would resolve to one png)`
    );
  }

  // The pre-state must be exactly the shape this module knows how to rebuild:
  // Key[i] === i, every keyframe one frame long, and every channel pointing back
  // at this sprite's own .yy. Normalising any of those silently would change an
  // animation or a keyframe the user authored in the IDE, and a foreign Id.path
  // would make the rewritten file claim a frame of another sprite.
  const expectedPath = `sprites/${spriteName}/${spriteName}.yy`;
  keyframes.forEach((keyframe, index) => {
    if (keyframe?.Key !== index) {
      throw new Error(
        `sprite "${spriteName}" keyframe ${index} has Key ${keyframe?.Key}, not ${index}; refusing to edit a sequence whose keyframes are out of order`
      );
    }
    if (keyframe?.Length !== 1) {
      throw new Error(
        `sprite "${spriteName}" keyframe ${index} has Length ${keyframe?.Length}; a sprite frame keyframe is always 1.0 frame long, ` +
          `so refusing to edit a sequence this tool cannot describe`
      );
    }
    const channelPath = keyframe?.Channels?.["0"]?.Id?.path;
    if (channelPath !== expectedPath) {
      throw new Error(
        `sprite "${spriteName}" keyframe ${index} points at "${channelPath ?? "(no path)"}" instead of "${expectedPath}"; ` +
          `refusing to edit a sequence whose channels belong to another resource`
      );
    }
  });

  const channelGuids = keyframes.map((keyframe, index) => {
    const guid = keyframeFrameGuid(keyframe, spriteName, index);
    if (guid === undefined) {
      throw new Error(
        `sprite "${spriteName}" keyframe ${index} in its frames track names no frame; refusing to edit frames it cannot describe`
      );
    }
    return guid;
  });
  const channelDupes = duplicateGuids(channelGuids);
  if (channelDupes.length > 0) {
    throw new Error(
      `sprite "${spriteName}" has more than one keyframe for the frame guid ${channelDupes[0]}; refusing to edit a sequence it cannot describe`
    );
  }

  const byFrame = new Map<string, any>();
  guids.forEach((guid, index) => {
    const channelIndex = channelGuids.indexOf(guid);
    if (channelIndex < 0) {
      throw new Error(
        `sprite "${spriteName}" frame ${guid} has no keyframe in its frames track; refusing to edit frames it cannot describe (frames and sequence disagree)`
      );
    }
    byFrame.set(guid, keyframes[channelIndex]);
  });
  for (const guid of channelGuids) {
    if (!byFrame.has(guid)) {
      throw new Error(
        `sprite "${spriteName}" keyframe ${guid} belongs to no entry in "frames"; refusing to edit frames it cannot describe (frames and sequence disagree)`
      );
    }
  }
  return byFrame;
}

/**
 * The one sequence rewrite. Rebuilds the keyframe list from the new frame order,
 * reusing each surviving frame's own keyframe object (its `id`, `Disabled`,
 * `IsCreationKey`, `Stretch`, `Length` and channel path survive), creating a fresh
 * keyframe only for a genuinely new frame, then renumbers `Key` to the position
 * and sets `sequence.length` to the frame count -- never frameCount / playbackSpeed.
 */
function rewriteFrames(
  sprite: any,
  spriteName: string,
  frames: any[],
  keyframesByFrame: Map<string, any>
): void {
  const { track } = locateFramesTrack(sprite, spriteName);
  const keyframes = frames.map((frame, index) => {
    const guid = frameGuidOf(frame, spriteName, index);
    const keyframe = keyframesByFrame.get(guid) ?? frameKeyframe(spriteName, guid, index);
    keyframe.Key = index;
    return keyframe;
  });
  sprite.frames = frames;
  track.keyframes.Keyframes = keyframes;
  sprite.sequence.length = frames.length;
}

// In-process post-conditions, run before anything reaches disk: the three counts
// agree, Key[i] is i, and every guid appears exactly once on both sides. A
// violation throws and writes nothing.
function assertFrameInvariants(sprite: any, spriteName: string): void {
  const frames = readFrameList(sprite, spriteName);
  const { keyframes } = locateFramesTrack(sprite, spriteName);
  const fail = (detail: string): never => {
    throw new Error(`internal: sprite "${spriteName}" would be written in an inconsistent state (${detail}); nothing was written`);
  };

  if (frames.length === 0) fail("zero frames");
  if (frames.length !== keyframes.length) fail(`${frames.length} frames but ${keyframes.length} keyframes`);
  if (sprite.sequence.length !== frames.length) {
    fail(`${frames.length} frames but sequence.length ${sprite.sequence.length}`);
  }

  const guids = frames.map((frame, index) => frameGuidOf(frame, spriteName, index));
  const frameDupes = duplicateGuids(guids);
  if (frameDupes.length > 0) fail(`the frame guid ${frameDupes[0]} appears twice in "frames"`);

  const channelGuids = keyframes.map((keyframe, index) => keyframeFrameGuid(keyframe, spriteName, index) ?? "");
  const channelDupes = duplicateGuids(channelGuids);
  if (channelDupes.length > 0) fail(`the frame guid ${channelDupes[0]} appears twice in the keyframes`);
  if (channelGuids.some((guid) => !guids.includes(guid))) fail("a keyframe refers to a frame that is not in \"frames\"");
  if (guids.some((guid) => !channelGuids.includes(guid))) fail("a frame has no keyframe");

  keyframes.forEach((keyframe, index) => {
    if (keyframe.Key !== index) fail(`keyframe ${index} has Key ${keyframe.Key}`);
  });
}

// The disk half of the post-condition: a .yy that points at a png which is not
// there is what actually stops GameMaker loading the project.
async function missingFrameFiles(
  projectDir: string,
  spriteName: string,
  spriteDir: string,
  sprite: any
): Promise<string[]> {
  const layerIds = layerIdsOf(sprite, spriteName);
  const missing: string[] = [];
  for (const [index, frame] of readFrameList(sprite, spriteName).entries()) {
    const guid = frameGuidOf(frame, spriteName, index);
    for (const file of frameFilePaths(spriteDir, guid, layerIds)) {
      if (!(await fileExists(file))) missing.push(projectRelative(projectDir, file));
    }
  }
  return missing;
}

// Every directory this module creates is under the sprite's own directory, and a
// failure here is still a throw (nothing has been written yet), so the shared
// "close it in GameMaker and retry" wording applies.
async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e: any) {
    throw describeLockedFile(dir, e, "create") ?? new Error(`Could not create ${dir}: ${e?.message ?? String(e)}`);
  }
}

async function writeFramePngs(
  spriteDir: string,
  frameGuid: string,
  layerId: string,
  sourceImagePath: string
): Promise<void> {
  const guid = assertSafeSpriteFileName(frameGuid, "frame guid");
  const layerDir = path.join(spriteDir, "layers", guid);
  await ensureDir(layerDir);
  await atomicCopyFile(sourceImagePath, path.join(spriteDir, `${guid}.png`));
  await atomicCopyFile(sourceImagePath, path.join(layerDir, `${assertSafeSpriteFileName(layerId, "image layer name")}.png`));
}

/**
 * Removes both copies of one frame. Never throws: on the remove/trim paths this
 * runs AFTER the .yy was written, and a locked png must not turn a completed
 * frame-list change into a reported failure -- the caller would retry the call
 * and delete a different frame. Failures are handed to `onError` so the tool can
 * report them as leftovers.
 *
 * rm -r on layers/<frameGuid>/ drops every per-layer copy in one step, so a
 * hand-edited layers[] length cannot leave an orphan png behind.
 */
async function deleteFramePngs(
  spriteDir: string,
  frameGuid: string,
  onError: (file: string, e: any) => void
): Promise<void> {
  const guid = assertSafeSpriteFileName(frameGuid, "frame guid");
  const targets: Array<{ target: string; options: { recursive?: boolean; force?: boolean } }> = [
    // The composite is a file: never rm -r it, so a hand-crafted directory at
    // that path cannot take its contents with it.
    { target: path.join(spriteDir, `${guid}.png`), options: { force: true } },
    { target: path.join(spriteDir, "layers", guid), options: { recursive: true, force: true } },
  ];
  for (const { target, options } of targets) {
    try {
      await fs.rm(target, options);
    } catch (e: any) {
      onError(target, e);
    }
  }
}

async function readSourcePng(sourceImagePath: string): Promise<{ width: number; height: number }> {
  try {
    return await readPngDimensions(sourceImagePath);
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error(`Source image "${sourceImagePath}" does not exist`);
    throw new Error(`Source image "${sourceImagePath}" is not a readable PNG: ${e?.message ?? String(e)}`);
  }
}

function assertFrameIndex(index: number, frameCount: number, spriteName: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= frameCount) {
    throw new Error(
      `frame index ${index} is out of range for sprite "${spriteName}" (${frameCount} frame${frameCount === 1 ? "" : "s"}); ` +
        `valid range is 0..${frameCount - 1}`
    );
  }
}

async function fileShaMatches(file: string, sha: string): Promise<boolean> {
  if (!(await fileExists(file))) return false;
  return (await sha256File(file)) === sha;
}

export async function listSpriteFrames(projectDir: string, spriteName: string): Promise<SpriteFramesInfo> {
  const { sprite, spriteDir } = await readSpriteDoc(projectDir, spriteName);
  const frames = readFrameList(sprite, spriteName);
  const { keyframes } = locateFramesTrack(sprite, spriteName);
  const layerIds = layerIdsOf(sprite, spriteName);

  const framesOut: SpriteFrameInfo[] = [];
  const missingFiles: string[] = [];
  for (const [index, frame] of frames.entries()) {
    const guid = frameGuidOf(frame, spriteName, index);
    const files = frameFilePaths(spriteDir, guid, layerIds);
    let existsOnDisk = true;
    for (const file of files) {
      if (!(await fileExists(file))) {
        existsOnDisk = false;
        missingFiles.push(projectRelative(projectDir, file));
      }
    }
    framesOut.push({ index, guid, file: projectRelative(projectDir, files[0]), existsOnDisk });
  }

  return {
    width: sprite.width,
    height: sprite.height,
    origin: { x: sprite.sequence?.xorigin ?? 0, y: sprite.sequence?.yorigin ?? 0 },
    frameCount: frames.length,
    frames: framesOut,
    sequence: {
      length: sprite.sequence?.length,
      playbackSpeed: sprite.sequence?.playbackSpeed,
      playbackSpeedType: sprite.sequence?.playbackSpeedType,
      keyframeCount: keyframes.length,
    },
    verdict:
      frames.length === keyframes.length
        ? "ok"
        : `frames-vs-sequence mismatch: ${frames.length} vs ${keyframes.length}`,
    missingFiles,
  };
}

export async function addSpriteFrame(
  projectDir: string,
  spriteName: string,
  sourceImagePath: string,
  index?: number
): Promise<AddSpriteFrameResult> {
  const doc = await readSpriteDoc(projectDir, spriteName);
  const { sprite } = doc;
  const layerId = singleLayerIdOf(sprite, spriteName);
  const frames = readFrameList(sprite, spriteName);
  const { keyframes } = locateFramesTrack(sprite, spriteName);
  const keyframesByFrame = assertFramesAgreeWithSequence(sprite, spriteName, frames, keyframes);

  const frameCount = frames.length;
  const insertAt = index ?? frameCount;
  if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > frameCount) {
    throw new Error(
      `frame index ${insertAt} is out of range for sprite "${spriteName}" (${frameCount} frame${frameCount === 1 ? "" : "s"}); ` +
        `valid range is 0..${frameCount} (${frameCount} appends)`
    );
  }

  const source = await readSourcePng(sourceImagePath);
  if (source.width !== sprite.width || source.height !== sprite.height) {
    throw new Error(
      `Source image "${sourceImagePath}" is ${source.width}x${source.height} but sprite "${spriteName}" is ${sprite.width}x${sprite.height}; ` +
        `every frame of a sprite must be the same size (no implicit resize)`
    );
  }

  const frameGuid = crypto.randomUUID();
  const taken = new Set(frames.map((frame, i) => frameGuidOf(frame, spriteName, i)));
  if (taken.has(frameGuid)) {
    throw new Error(`internal: generated frame guid ${frameGuid} already exists in sprite "${spriteName}"; nothing was written`);
  }

  const nextFrames = [...frames.slice(0, insertAt), frameEntry(frameGuid), ...frames.slice(insertAt)];
  rewriteFrames(sprite, spriteName, nextFrames, keyframesByFrame);
  assertFrameInvariants(sprite, spriteName);

  // Images before the .yy, so the .yy never references a png that is not there.
  await writeFramePngs(doc.spriteDir, frameGuid, layerId, sourceImagePath);
  try {
    const missing = await missingFrameFiles(projectDir, spriteName, doc.spriteDir, sprite);
    if (missing.length > 0) {
      throw new Error(`sprite "${spriteName}" would reference frame pngs that are missing (${missing.join(", ")}); the .yy was not written`);
    }
    await writeSpriteYy(doc.yyPath, sprite);
  } catch (e) {
    // The .yy still lists the old frame set, so the pair just written is
    // unreferenced: drop it rather than leave noise in the project. A failure to
    // delete here cannot fail the call -- the rewrite is already being reported
    // as failed, and a leftover png does not stop GameMaker loading.
    await deleteFramePngs(doc.spriteDir, frameGuid, () => {});
    throw e;
  }

  return { spriteName, index: insertAt, frameCount: nextFrames.length };
}

export async function removeSpriteFrame(
  projectDir: string,
  spriteName: string,
  index: number
): Promise<RemoveSpriteFrameResult> {
  const doc = await readSpriteDoc(projectDir, spriteName);
  const { sprite } = doc;
  singleLayerIdOf(sprite, spriteName);
  const frames = readFrameList(sprite, spriteName);
  const { keyframes } = locateFramesTrack(sprite, spriteName);
  const keyframesByFrame = assertFramesAgreeWithSequence(sprite, spriteName, frames, keyframes);

  if (frames.length === 1) {
    throw new Error(
      `cannot remove the last frame from ${spriteName}; delete the resource instead (a zero-frame sprite cannot be loaded)`
    );
  }
  assertFrameIndex(index, frames.length, spriteName);

  const removedGuid = frameGuidOf(frames[index], spriteName, index);
  const nextFrames = frames.filter((_, i) => i !== index);
  rewriteFrames(sprite, spriteName, nextFrames, keyframesByFrame);
  assertFrameInvariants(sprite, spriteName);

  const missing = await missingFrameFiles(projectDir, spriteName, doc.spriteDir, sprite);
  if (missing.length > 0) {
    throw new Error(`sprite "${spriteName}" would reference frame pngs that are missing (${missing.join(", ")}); nothing was written`);
  }
  await writeSpriteYy(doc.yyPath, sprite);
  // Only after the .yy no longer references them: a failed delete here leaves an
  // unreferenced png (loadable, reported as a leftover), the reverse order would
  // leave a dangling reference (not loadable). It must never throw -- the frame
  // list change has already landed, so a "failed" report would invite a retry
  // that removes a different frame.
  const leftoverFiles: string[] = [];
  await deleteFramePngs(doc.spriteDir, removedGuid, (file, e) => {
    leftoverFiles.push(`${projectRelative(projectDir, file)} (${e?.code ?? e?.message ?? String(e)})`);
  });

  return { spriteName, frameCount: nextFrames.length, removedGuid, leftoverFiles };
}

// A resize must not leave the collision mask or the nine-slice borders hanging
// outside the new frame: GameMaker loads such a sprite and then mis-clips it, so
// the tool refuses instead of shrinking (or growing) a mask the user authored.
function assertBoxFits(
  what: string,
  box: { left: number; top: number; right: number; bottom: number },
  width: number,
  height: number,
  spriteName: string
): void {
  const values = [box.left, box.top, box.right, box.bottom];
  if (!values.every((value) => Number.isFinite(value))) {
    throw new Error(
      `refusing to resize sprite "${spriteName}": its ${what} is not four finite numbers (${JSON.stringify(values)}), ` +
        `so it cannot be proven to stay inside ${width}x${height}`
    );
  }
  if (
    box.left < 0 ||
    box.top < 0 ||
    box.right > width - 1 ||
    box.bottom > height - 1 ||
    box.left > box.right ||
    box.top > box.bottom
  ) {
    throw new Error(
      `refusing to resize sprite "${spriteName}" to ${width}x${height}: its ${what} ` +
        `(${box.left},${box.top},${box.right},${box.bottom}) would fall outside the new frame; set it inside ` +
        `0,0..${width - 1},${height - 1} first (a custom mask is never rewritten)`
    );
  }
}

function assertNineSliceFits(nineSlice: any, width: number, height: number, spriteName: string): void {
  if (nineSlice === null || nineSlice === undefined) return;
  if (typeof nineSlice !== "object") {
    throw new Error(
      `refusing to resize sprite "${spriteName}": its nineSlice is not an object, so its borders cannot be checked against ${width}x${height}`
    );
  }
  const borders = ["left", "right", "top", "bottom"].filter((key) => key in nineSlice);
  if (borders.length === 0) return;
  for (const key of borders) {
    if (!Number.isFinite(nineSlice[key])) {
      throw new Error(
        `refusing to resize sprite "${spriteName}": its nineSlice.${key} is not a finite number, ` +
          `so its borders cannot be checked against ${width}x${height}`
      );
    }
  }
  const horizontal = (nineSlice.left ?? 0) + (nineSlice.right ?? 0);
  const vertical = (nineSlice.top ?? 0) + (nineSlice.bottom ?? 0);
  if (horizontal > width || vertical > height) {
    throw new Error(
      `refusing to resize sprite "${spriteName}" to ${width}x${height}: its nine-slice borders need ${horizontal}x${vertical} px, ` +
        `which no longer fits the frame (nine-slice data is never rewritten -- resize or disable it first)`
    );
  }
}

export async function replaceSpriteFrame(
  projectDir: string,
  spriteName: string,
  index: number,
  sourceImagePath: string,
  allowResize: boolean = false
): Promise<ReplaceSpriteFrameResult> {
  const doc = await readSpriteDoc(projectDir, spriteName);
  const { sprite } = doc;
  const layerId = singleLayerIdOf(sprite, spriteName);
  const frames = readFrameList(sprite, spriteName);
  const { keyframes } = locateFramesTrack(sprite, spriteName);
  assertFramesAgreeWithSequence(sprite, spriteName, frames, keyframes);

  assertFrameIndex(index, frames.length, spriteName);
  const frameGuid = frameGuidOf(frames[index], spriteName, index);

  const source = await readSourcePng(sourceImagePath);
  const resizes = source.width !== sprite.width || source.height !== sprite.height;
  if (resizes) {
    if (allowResize !== true) {
      throw new Error(
        `Source image "${sourceImagePath}" is ${source.width}x${source.height} but sprite "${spriteName}" frame ${index} is ` +
          `${sprite.width}x${sprite.height}; every frame of a sprite must be the same size (pass allowResize on a single-frame sprite to change it)`
      );
    }
    if (frames.length !== 1) {
      throw new Error(
        `refusing to resize sprite "${spriteName}" from ${sprite.width}x${sprite.height} to ${source.width}x${source.height}: ` +
          `it has ${frames.length} frames and only one would change size, which GameMaker cannot load (re-import the animation instead)`
      );
    }

    // The origin rule is 0 <= xorigin <= width (the IDE allows xorigin == width:
    // the bottom-centre preset puts yorigin at the height), so "inside the new
    // bounds" is inclusive. An origin that is not two finite numbers is refused
    // rather than skipped: a resize that silently keeps a hand-edited origin, or
    // clamps one to 0, moves every instance using this sprite.
    const xorigin = sprite.sequence?.xorigin;
    const yorigin = sprite.sequence?.yorigin;
    if (!Number.isFinite(xorigin) || !Number.isFinite(yorigin)) {
      throw new Error(
        `refusing to resize sprite "${spriteName}": its sequence origin is ${JSON.stringify(xorigin)},${JSON.stringify(yorigin)}, ` +
          `not two finite numbers, so it cannot be proven inside ${source.width}x${source.height} (set a real origin with edit_sprite first)`
      );
    }
    if (xorigin < 0 || xorigin > source.width || yorigin < 0 || yorigin > source.height) {
      throw new Error(
        `refusing to resize sprite "${spriteName}" to ${source.width}x${source.height}: origin ${xorigin},${yorigin} would fall outside the ` +
          `frame; set the origin to 0..${source.width},0..${source.height} first (origin is never clamped)`
      );
    }

    // A bbox follows the new size only when it is the automatic full-frame one:
    // bboxMode 2 is a hand-authored mask even if its numbers happen to match the
    // full frame, and it is then checked against the new size instead.
    const looksFullFrame =
      sprite.bbox_left === 0 &&
      sprite.bbox_top === 0 &&
      sprite.bbox_right === sprite.width - 1 &&
      sprite.bbox_bottom === sprite.height - 1;
    const followsSize = sprite.bboxMode !== 2 && looksFullFrame;
    if (!followsSize) {
      assertBoxFits(
        "bbox",
        { left: sprite.bbox_left, top: sprite.bbox_top, right: sprite.bbox_right, bottom: sprite.bbox_bottom },
        source.width,
        source.height,
        spriteName
      );
    }
    assertNineSliceFits(sprite.nineSlice, source.width, source.height, spriteName);

    sprite.width = source.width;
    sprite.height = source.height;
    if (followsSize) {
      sprite.bbox_left = 0;
      sprite.bbox_top = 0;
      sprite.bbox_right = source.width - 1;
      sprite.bbox_bottom = source.height - 1;
    }
  }

  const sourceSha = await sha256File(sourceImagePath);
  const targets = frameFilePaths(doc.spriteDir, frameGuid, [layerId]);
  const stale: string[] = [];
  for (const target of targets) {
    if (!(await fileShaMatches(target, sourceSha))) stale.push(target);
  }
  const yyChanged = serialise(sprite) !== doc.before;
  if (stale.length === 0 && !yyChanged) {
    return { spriteName, index, width: sprite.width, height: sprite.height, changed: false };
  }

  if (!resizes) {
    // Same size: the .yy content does not change, so copying the images first
    // leaves at most one frame with stale bytes and a .yy that still describes a
    // consistent sprite.
    for (const target of stale) {
      await ensureDir(path.dirname(target));
      await atomicCopyFile(sourceImagePath, target);
    }
    if (yyChanged) await writeSpriteYy(doc.yyPath, sprite);
    return { spriteName, index, width: sprite.width, height: sprite.height, changed: true };
  }

  // A resize cannot use that order: the .yy then claims the new dimensions while
  // the png at sprites/<sprite>/<guid>.png is still the old size. Stage the new
  // pixels beside their targets and rename them into place only after the .yy.
  const staged: Array<{ temp: string; target: string }> = [];
  let yyWritten = false;
  try {
    for (const target of stale) {
      const dir = path.dirname(target);
      await ensureDir(dir);
      const temp = path.join(dir, `.${path.basename(target)}.tmp-${crypto.randomUUID()}`);
      await atomicCopyFile(sourceImagePath, temp);
      staged.push({ temp, target });
    }
    await writeSpriteYy(doc.yyPath, sprite);
    yyWritten = true;
    for (const { temp, target } of staged) await fs.rename(temp, target);
  } catch (e: any) {
    for (const { temp } of staged) await fs.rm(temp, { force: true }).catch(() => {});
    if (!yyWritten) throw e;
    throw new Error(
      `sprite "${spriteName}" .yy was updated to ${sprite.width}x${sprite.height} but its frame pngs could not be replaced ` +
        `(${e?.message ?? String(e)}); re-run the same replace_sprite_frame call to finish it -- the frame index and guid are unchanged`
    );
  }

  return { spriteName, index, width: sprite.width, height: sprite.height, changed: true };
}

export async function reorderSpriteFrames(
  projectDir: string,
  spriteName: string,
  order: number[]
): Promise<ReorderSpriteFramesResult> {
  const doc = await readSpriteDoc(projectDir, spriteName);
  const { sprite } = doc;
  singleLayerIdOf(sprite, spriteName);
  const frames = readFrameList(sprite, spriteName);
  const { keyframes } = locateFramesTrack(sprite, spriteName);
  const keyframesByFrame = assertFramesAgreeWithSequence(sprite, spriteName, frames, keyframes);

  const frameCount = frames.length;
  if (!Array.isArray(order) || order.length !== frameCount) {
    throw new Error(
      `order has ${Array.isArray(order) ? order.length : 0} entr${Array.isArray(order) && order.length === 1 ? "y" : "ies"} but sprite ` +
        `"${spriteName}" has ${frameCount} frame${frameCount === 1 ? "" : "s"}; order must be a permutation of 0..${frameCount - 1}`
    );
  }
  const seen = new Set<number>();
  for (const value of order) {
    if (!Number.isInteger(value) || value < 0 || value >= frameCount) {
      throw new Error(
        `order contains ${value}, which is not a frame index for sprite "${spriteName}" (valid range is 0..${frameCount - 1})`
      );
    }
    if (seen.has(value)) {
      throw new Error(`order contains the duplicate index ${value}; every frame must appear exactly once`);
    }
    seen.add(value);
  }

  const nextFrames = order.map((i) => frames[i]);
  rewriteFrames(sprite, spriteName, nextFrames, keyframesByFrame);
  assertFrameInvariants(sprite, spriteName);

  // The disk post-condition runs before the no-op return: a reorder that changes
  // nothing reports changed: false only if the sprite it leaves behind is
  // actually loadable. Otherwise the caller would read a clean success from a
  // sprite GameMaker refuses.
  const missing = await missingFrameFiles(projectDir, spriteName, doc.spriteDir, sprite);
  if (missing.length > 0) {
    throw new Error(`sprite "${spriteName}" references frame pngs that are missing (${missing.join(", ")}); nothing was written`);
  }
  if (serialise(sprite) === doc.before) {
    return { spriteName, frameCount, changed: false };
  }
  await writeSpriteYy(doc.yyPath, sprite);

  return { spriteName, frameCount, changed: true };
}

export async function trimSpriteFrames(
  projectDir: string,
  spriteName: string,
  from: number,
  to: number
): Promise<TrimSpriteFramesResult> {
  const doc = await readSpriteDoc(projectDir, spriteName);
  const { sprite } = doc;
  singleLayerIdOf(sprite, spriteName);
  const frames = readFrameList(sprite, spriteName);
  const { keyframes } = locateFramesTrack(sprite, spriteName);
  const keyframesByFrame = assertFramesAgreeWithSequence(sprite, spriteName, frames, keyframes);

  const frameCount = frames.length;
  const range = `0..${frameCount - 1}`;
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error(`trim range ${from}..${to} is not a pair of frame indices for sprite "${spriteName}" (valid range is ${range})`);
  }
  if (from > to) {
    throw new Error(`trim range ${from}..${to} is empty; "from" must be less than or equal to "to" for sprite "${spriteName}"`);
  }
  if (from < 0 || to > frameCount - 1) {
    throw new Error(`trim range ${from}..${to} is out of bounds for sprite "${spriteName}" (${frameCount} frames; valid range is ${range})`);
  }

  const kept = frames.slice(from, to + 1);
  const dropped: string[] = [];
  frames.forEach((frame, i) => {
    if (i < from || i > to) dropped.push(frameGuidOf(frame, spriteName, i));
  });
  rewriteFrames(sprite, spriteName, kept, keyframesByFrame);
  assertFrameInvariants(sprite, spriteName);

  const missing = await missingFrameFiles(projectDir, spriteName, doc.spriteDir, sprite);
  if (missing.length > 0) {
    throw new Error(`sprite "${spriteName}" would reference frame pngs that are missing (${missing.join(", ")}); nothing was written`);
  }
  if (serialise(sprite) === doc.before) {
    return { spriteName, frameCount: kept.length, removed: 0, leftoverFiles: [] };
  }
  await writeSpriteYy(doc.yyPath, sprite);
  // Never throws after the .yy: see removeSpriteFrame.
  const leftoverFiles: string[] = [];
  for (const guid of dropped) {
    await deleteFramePngs(doc.spriteDir, guid, (file, e) => {
      leftoverFiles.push(`${projectRelative(projectDir, file)} (${e?.code ?? e?.message ?? String(e)})`);
    });
  }

  return { spriteName, frameCount: kept.length, removed: dropped.length, leftoverFiles };
}
