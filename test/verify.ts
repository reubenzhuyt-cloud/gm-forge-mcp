// Regression suite for the resource writers. Expected key-sets below came
// from real, GameMaker-authored files that load cleanly in the actual IDE.
// If GameMaker's file format changes, refresh these from a real project
// export rather than editing them to make a test pass.
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { loadYyp, writeYyp, withProjectLock, addTextureGroup, addAudioGroup, parseGameMakerJson, ensureProjectScaffold } from "../src/gm/yyp.js";
import { addRoom, editRoom, reorderRoom, moveRoomRelativeTo } from "../src/gm/rooms.js";
import { addScript, editScript } from "../src/gm/scripts.js";
import { addObject, addObjectEvent } from "../src/gm/objects.js";
import { addSpriteFromImages, editSprite } from "../src/gm/sprites.js";
import { addRoomInstance } from "../src/gm/instances.js";
import { addShader, editShader } from "../src/gm/shaders.js";
import { addSound, editSound, parseOggMetadata } from "../src/gm/sounds.js";
import { addFont, editFont } from "../src/gm/fonts.js";
import { addTileset, editTileset } from "../src/gm/tilesets.js";
import { decompressTileData, getRoomTileLayers, findTileRegion, EMPTY_TILE } from "../src/gm/room_tiles.js";
import { addExtension } from "../src/gm/extensions.js";
import { addParticleSystem } from "../src/gm/particle_systems.js";
import { addAnimCurve } from "../src/gm/animation_curves.js";
import { getObjectInfo, getRoomInfo, getSpriteInfo, getScriptInfo, getShaderInfo, getSoundInfo, getFontInfo, getNoteInfo, getTilesetInfo, getExtensionInfo, getParticleSystemInfo, getAnimCurveInfo } from "../src/gm/introspect.js";
import { findReferences } from "../src/gm/references.js";
import { deleteResource, ResourceInUseError } from "../src/gm/delete.js";
import { renameResource } from "../src/gm/rename.js";
import { lintProject } from "../src/gm/lint.js";
import { addNote } from "../src/gm/notes.js";
import { compileProject } from "../src/gm/build.js";
import { findProjectTool, findIgor } from "../src/gm/gamemaker-tools.js";
import { editObject } from "../src/gm/objects.js";
import { listRoomLayers, addRoomLayer, removeRoomLayer, setRoomLayer } from "../src/gm/room_layers.js";
import { encodeTileData, MAX_TILE_RUN, getRoomTiles, setRoomTiles, fillRoomTiles } from "../src/gm/room_tiles.js";
// src/index.ts is import-safe: it only opens the stdio transport when it is the
// process entry point, so the suite can assert on the real registry and schemas.
import { TOOL_DEFS, EditObjectSchema, callTool } from "../src/index.js";
import { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, undoLast, readManifest, SNAPSHOT_KEEP, SNAPSHOT_MAX_FILE_BYTES, diffAgainstSnapshot } from "../src/gm/snapshot.js";
import { readFile, patchFile, listChanges, READ_MAX_BYTES } from "../src/gm/files.js";
import { AUTO_SNAPSHOT_TOOLS, withAutoSnapshot } from "../src/gm/write.js";
import { atomicCopyFile, atomicWriteFile } from "../src/gm/atomic.js";
import { getProjectOptions, setProjectOption, OPTION_ALLOWLIST, OPTION_ENVELOPE_KEYS } from "../src/gm/options.js";
import { listIncludedFiles, addIncludedFile, removeIncludedFile, INCLUDED_FILE_KEYS } from "../src/gm/included_files.js";
import { listMacros, setMacro, DEFAULT_MACRO_FILE, DEFAULT_MACRO_SCRIPT, MACRO_LINE_RE, MACROS_NOTE } from "../src/gm/macros.js";
import { listSpriteFrames, addSpriteFrame, removeSpriteFrame, replaceSpriteFrame, reorderSpriteFrames, trimSpriteFrames } from "../src/gm/sprite_frames.js";
import { listTimelines } from "../src/gm/timelines.js";
import { listSequences, scanSpriteEmbeddedSequences, MAX_SPRITE_SCAN } from "../src/gm/sequences.js";

let passed = 0;
let failed = 0;
let skipped = 0;
const skippedReasons: string[] = [];

/**
 * Every skip here means one of the most authoritative checks (real
 * ProjectTool/Igor validation, not just our own structural assertions) did
 * NOT run on this machine. That's silent by default in most test runners --
 * "N passed, 0 failed" reads the same whether those ran or not -- so it gets
 * its own counter and its own line in the summary instead.
 */
function skip(label: string) {
  skipped++;
  skippedReasons.push(label);
  console.log(`SKIP: ${label}`);
}

function ok(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}${detail ? " -- " + detail : ""}`);
  }
}

async function expectThrows(label: string, fn: () => Promise<any>) {
  try {
    await fn();
    ok(label, false, "expected an error, none was thrown");
  } catch {
    ok(label, true);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function keysMatch(a: object, b: object): boolean {
  const ak = new Set(Object.keys(a));
  const bk = new Set(Object.keys(b));
  if (ak.size !== bk.size) return false;
  for (const k of ak) if (!bk.has(k)) return false;
  return true;
}

// Reference key-sets captured from real Convoy project files (2026-07-17)
const REF = {
  room: new Set(["$GMRoom", "%Name", "creationCodeFile", "inheritCode", "inheritCreationOrder",
    "inheritLayers", "instanceCreationOrder", "isDnd", "layers", "name", "parent", "parentRoom",
    "physicsSettings", "resourceType", "resourceVersion", "roomSettings", "sequenceId",
    "views", "viewSettings", "volume"]),
  roomInstanceLayer: new Set(["$GMRInstanceLayer", "%Name", "depth", "effectEnabled", "effectType",
    "gridX", "gridY", "hierarchyFrozen", "inheritLayerDepth", "inheritLayerSettings",
    "inheritSubLayers", "inheritVisibility", "instances", "layers", "name", "properties",
    "resourceType", "resourceVersion", "userdefinedDepth", "visible"]),
  roomInstance: new Set(["$GMRInstance", "%Name", "colour", "frozen", "hasCreationCode", "ignore",
    "imageIndex", "imageSpeed", "inheritCode", "inheritedItemId", "inheritItemSettings", "isDnd",
    "name", "objectId", "properties", "resourceType", "resourceVersion", "rotation", "scaleX",
    "scaleY", "x", "y"]),
  script: new Set(["$GMScript", "%Name", "resourceType", "resourceVersion", "name",
    "isCompatibility", "isDnD", "parent"]),
  object: new Set(["$GMObject", "%Name", "resourceType", "resourceVersion", "name", "spriteId",
    "solid", "visible", "managed", "spriteMaskId", "persistent", "parentObjectId",
    "physicsObject", "physicsSensor", "physicsShape", "physicsGroup", "physicsDensity",
    "physicsRestitution", "physicsLinearDamping", "physicsAngularDamping", "physicsFriction",
    "physicsStartAwake", "physicsKinematic", "physicsShapePoints", "eventList", "properties",
    "overriddenProperties", "parent"]),
  objectEvent: new Set(["$GMEvent", "%Name", "collisionObjectId", "eventNum", "eventType",
    "isDnD", "name", "resourceType", "resourceVersion"]),
  sprite: new Set(["$GMSprite", "%Name", "bboxMode", "bbox_bottom", "bbox_left", "bbox_right",
    "bbox_top", "collisionKind", "collisionTolerance", "DynamicTexturePage", "edgeFiltering",
    "For3D", "frames", "gridX", "gridY", "height", "HTile", "layers", "name", "nineSlice",
    "origin", "parent", "preMultiplyAlpha", "resourceType", "resourceVersion", "sequence",
    "swatchColours", "swfPrecision", "textureGroupId", "type", "VTile", "width"]),
  spriteFrame: new Set(["$GMSpriteFrame", "%Name", "name", "resourceType", "resourceVersion"]),
  spriteLayer: new Set(["$GMImageLayer", "%Name", "blendMode", "displayName", "isLocked", "name",
    "opacity", "resourceType", "resourceVersion", "visible"]),
  spriteSequence: new Set(["$GMSequence", "%Name", "autoRecord", "backdropHeight",
    "backdropImageOpacity", "backdropImagePath", "backdropWidth", "backdropXOffset",
    "backdropYOffset", "events", "eventStubScript", "eventToFunction", "length", "lockOrigin",
    "moments", "name", "playback", "playbackSpeed", "playbackSpeedType", "resourceType",
    "resourceVersion", "showBackdrop", "showBackdropImage", "timeUnits", "tracks",
    "visibleRange", "volume", "xorigin", "yorigin"]),
  // Captured from 261103GJ/sprites/spr_jingling1_walk/spr_jingling1_walk.yy:71-85.
  spriteFramesTrack: new Set(["$GMSpriteFramesTrack", "builtinName", "events",
    "inheritsTrackColour", "interpolation", "isCreationTrack", "keyframes", "modifiers",
    "name", "resourceType", "resourceVersion", "spriteId", "trackColour", "tracks",
    "traits"]),
  // .../spr_jingling1_walk.yy:72-73 (the track's keyframe store).
  spriteFrameKeyframeStore: new Set(["$KeyframeStore<SpriteFrameKeyframe>", "Keyframes",
    "resourceType", "resourceVersion"]),
  // .../spr_jingling1_walk.yy:74-76 (one keyframe per frame, in frame order).
  spriteFrameKeyframe: new Set(["$Keyframe<SpriteFrameKeyframe>", "Channels", "Disabled",
    "id", "IsCreationKey", "Key", "Length", "resourceType", "resourceVersion", "Stretch"]),
  // .../spr_jingling1_walk.yy:75 (Channels["0"], the only channel a sprite frame has).
  spriteFrameKeyframeChannel: new Set(["$SpriteFrameKeyframe", "Id", "resourceType",
    "resourceVersion"]),
  // .../spr_jingling1_walk.yy:75-76: Id.name is the frame guid, Id.path the sprite's own .yy.
  spriteFrameKeyframeId: new Set(["name", "path"]),
  shader: new Set(["$GMShader", "%Name", "name", "parent", "resourceType", "resourceVersion", "type"]),
  sound: new Set(["$GMSound", "%Name", "audioGroupId", "bitDepth", "channelFormat", "compression",
    "compressionQuality", "conversionMode", "duration", "exportDir", "name", "parent", "preload",
    "resourceType", "resourceVersion", "sampleRate", "soundFile", "volume"]),
  font: new Set(["$GMFont", "%Name", "AntiAlias", "applyKerning", "ascender", "ascenderOffset",
    "bold", "canGenerateBitmap", "charset", "first", "fontName", "glyphOperations", "glyphs",
    "hinting", "includeTTF", "interpreter", "italic", "kerningPairs", "last", "lineHeight",
    "maintainGms1Font", "name", "parent", "pointRounding", "ranges", "regenerateBitmap",
    "resourceType", "resourceVersion", "sampleText", "sdfSpread", "size", "styleName",
    "textureGroupId", "TTFName", "usesSDF"]),
  tileset: new Set(["$GMTileSet", "%Name", "autoTileSets", "macroPageTiles", "name", "out_columns",
    "out_tilehborder", "out_tilevborder", "parent", "resourceType", "resourceVersion", "spriteId",
    "spriteNoExport", "textureGroupId", "tileAnimationFrames", "tileAnimationSpeed", "tileHeight",
    "tilehsep", "tilevsep", "tileWidth", "tilexoff", "tileyoff", "tile_count"]),
  extension: new Set(["$GMExtension", "%Name", "androidactivityinject", "androidclassname",
    "androidcodeinjection", "androidinject", "androidmanifestinject", "androidPermissions",
    "androidProps", "androidsourcedir", "author", "classname", "copyToTargets", "description",
    "exportToGame", "extensionVersion", "files", "gradleinject", "hasConvertedCodeInjection",
    "helpfile", "HTML5CodeInjection", "html5Props", "IncludedResources", "installdir",
    "iosCocoaPodDependencies", "iosCocoaPods", "ioscodeinjection", "iosdelegatename",
    "iosplistinject", "iosProps", "iosSystemFrameworkEntries", "iosThirdPartyFrameworkEntries",
    "license", "maccompilerflags", "maclinkerflags", "macsourcedir", "name", "options",
    "optionsFile", "packageId", "parent", "productId", "resourceType", "resourceVersion",
    "sourcedir", "supportedTargets", "tvosclassname", "tvosCocoaPodDependencies", "tvosCocoaPods",
    "tvoscodeinjection", "tvosdelegatename", "tvosmaccompilerflags", "tvosmaclinkerflags",
    "tvosplistinject", "tvosProps", "tvosSystemFrameworkEntries", "tvosThirdPartyFrameworkEntries"]),
  particleSystem: new Set(["resourceType", "resourceVersion", "name", "backdropHeight",
    "backdropImageOpacity", "backdropImagePath", "backdropWidth", "backdropXOffset",
    "backdropYOffset", "drawOrder", "emitters", "parent", "showBackdrop", "showBackdropImage",
    "xorigin", "yorigin", "$GMParticleSystem", "%Name"]),
  particleEmitter: new Set(["$GMPSEmitter", "%Name", "resourceType", "resourceVersion", "name",
    "additiveBlend", "directionIncrease", "directionMax", "directionMin", "directionWiggle",
    "distribution", "editorColour", "editorDrawShape", "emitCount", "emitDelayMax",
    "emitDelayMin", "emitDelayUnits", "emitIntervalMax", "emitIntervalMin", "emitIntervalUnits",
    "enabled", "endColour", "GMPresetName", "gravityDirection", "gravityForce", "headPosition",
    "lifetimeMax", "lifetimeMin", "linkedEmitter", "locked", "midColour", "mode",
    "orientationIncrease", "orientationMax", "orientationMin", "orientationRelative",
    "orientationWiggle", "regionH", "regionW", "regionX", "regionY", "scaleX", "scaleY", "shape",
    "sizeIncrease", "sizeMax", "sizeMin", "sizeWiggle", "spawnOnDeathCount", "spawnOnDeathGMPreset",
    "spawnOnDeathId", "spawnOnUpdateCount", "spawnOnUpdateGMPreset", "spawnOnUpdateId",
    "speedIncrease", "speedMax", "speedMin", "speedWiggle", "spriteAnimate", "spriteId",
    "spriteRandom", "spriteStretch", "startColour", "texture"]),
  animCurve: new Set(["$GMAnimCurve", "%Name", "name", "channels", "function", "parent",
    "resourceType", "resourceVersion"]),
  animCurveChannel: new Set(["$GMAnimCurveChannel", "%Name", "name", "colour", "points",
    "resourceType", "resourceVersion", "visible"]),
  // Captured from a real IDE-authored object: 261103GJ/objects/obj_transit_trigger
  // /obj_transit_trigger.yy:31-40 -- every variable definition entry has exactly
  // these keys, and varType is 0 (real) or 4 (asset).
  objectProperty: new Set(["$GMObjectProperty", "%Name", "filters", "listItems", "multiselect",
    "name", "rangeEnabled", "rangeMax", "rangeMin", "resourceType", "resourceVersion",
    "value", "varType"]),
  // Captured from 261103GJ/rooms/rm_lv1/rm_lv1.yy, layer "world_reality_tiles".
  roomTileLayer: new Set(["$GMRTileLayer", "%Name", "depth", "effectEnabled", "effectType",
    "gridX", "gridY", "hierarchyFrozen", "inheritLayerDepth", "inheritLayerSettings",
    "inheritSubLayers", "inheritVisibility", "layers", "name", "properties", "resourceType",
    "resourceVersion", "tiles", "tilesetId", "userdefinedDepth", "visible", "x", "y"]),
  // Captured from 261103GJ/rooms/rm_lv1/rm_lv1.yy, layer "Background".
  roomBackgroundLayer: new Set(["$GMRBackgroundLayer", "%Name", "animationFPS",
    "animationSpeedType", "colour", "depth", "effectEnabled", "effectType", "gridX", "gridY",
    "hierarchyFrozen", "hspeed", "htiled", "inheritLayerDepth", "inheritLayerSettings",
    "inheritSubLayers", "inheritVisibility", "layers", "name", "properties", "resourceType",
    "resourceVersion", "spriteId", "stretch", "userdefinedAnimFPS", "userdefinedDepth",
    "visible", "vspeed", "vtiled", "x", "y"]),
  // shape from GameMaker's writer; no 2026-era sample on this machine
  roomAssetLayer: new Set(["$GMRAssetLayer", "%Name", "assets", "depth", "effectEnabled",
    "effectType", "gridX", "gridY", "hierarchyFrozen", "inheritLayerDepth",
    "inheritLayerSettings", "inheritSubLayers", "inheritVisibility", "layers", "name",
    "properties", "resourceType", "resourceVersion", "userdefinedDepth", "visible"]),
  // shape from GameMaker's writer; no 2026-era sample on this machine
  roomPathLayer: new Set(["$GMRPathLayer", "%Name", "colour", "depth", "effectEnabled",
    "effectType", "gridX", "gridY", "hierarchyFrozen", "inheritLayerDepth",
    "inheritLayerSettings", "inheritSubLayers", "inheritVisibility", "layers", "name",
    "pathId", "properties", "resourceType", "resourceVersion", "userdefinedDepth", "visible"]),
  // shape from GameMaker's writer; no 2026-era sample on this machine
  roomEffectLayer: new Set(["$GMREffectLayer", "%Name", "depth", "effectEnabled", "effectType",
    "gridX", "gridY", "hierarchyFrozen", "inheritLayerDepth", "inheritLayerSettings",
    "inheritSubLayers", "inheritVisibility", "layers", "name", "properties", "resourceType",
    "resourceVersion", "userdefinedDepth", "visible"]),
  // shape from GameMaker's writer; no 2026-era sample on this machine. The
  // class name is $GMRLayer -- ProjectTool 2024.14.165 rejects $GMRFolder as
  // "not in the target GameMaker release" and accepts this one.
  roomFolder: new Set(["$GMRLayer", "%Name", "depth", "effectEnabled", "effectType", "gridX",
    "gridY", "hierarchyFrozen", "inheritLayerDepth", "inheritLayerSettings", "inheritSubLayers",
    "inheritVisibility", "layers", "name", "properties", "resourceType", "resourceVersion",
    "userdefinedDepth", "visible"]),
};

function keysMatchRef(obj: object, ref: Set<string>): boolean {
  const keys = new Set(Object.keys(obj));
  if (keys.size !== ref.size) return false;
  for (const k of keys) if (!ref.has(k)) return false;
  return true;
}

// GameMaker writes .yy keys in case-insensitive alphabetical order. Matching
// it means a tool-written file and an IDE resave of it produce no diff.
function keysSorted(obj: object): boolean {
  const keys = Object.keys(obj);
  const sorted = [...keys].sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al !== bl) return al < bl ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys.every((k, i) => k === sorted[i]);
}

async function makeBareProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-mcp-test-"));
  const yyp = {
    "$GMProject": "v1",
    "%Name": "TestProj",
    AudioGroups: [],
    Folders: [],
    configs: { name: "Default", children: [] },
    defaultScriptType: 0,
    ForcedPrefabProjectReferences: [],
    IncludedFiles: [],
    isEcma: false,
    LibraryEmitters: [],
    MetaData: { IDEVersion: "2024.14.4.222" },
    name: "TestProj",
    resources: [],
    resourceType: "GMProject",
    resourceVersion: "2.0",
    RoomOrderNodes: [],
    templateType: "game",
    TextureGroups: []
  };
  await fs.writeFile(path.join(dir, "TestProj.yyp"), JSON.stringify(yyp, null, 2), "utf8");
  return dir;
}

async function main() {
  const dir = await makeBareProject();

  // --- Room ---
  let yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmTest", { width: 800, height: 600, persistent: false, creationCode: "show_debug_message(1);" });
  await writeYyp(dir, yyp);
  const room = JSON.parse(await fs.readFile(path.join(dir, "rooms/rmTest/rmTest.yy"), "utf8"));
  ok("room: top-level keys match real GameMaker schema", keysMatchRef(room, REF.room));
  ok("room: Instances layer keys match", keysMatchRef(room.layers[0], REF.roomInstanceLayer));
  ok("room: width/height applied", room.roomSettings.Width === 800 && room.roomSettings.Height === 600);
  ok("room: Rooms folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Rooms.yy"));

  // Regression: a room with NO creation code must still have creationCodeFile
  // present (as "") -- GameMaker's own validator rejects it if the key is
  // missing entirely, a real bug caught by ProjectTool against a live
  // project, invisible until then because every other room-key test
  // happened to always pass creationCode.
  yyp = await addRoom(dir, yyp, "rmNoCreationCode", { width: 400, height: 300, persistent: false });
  await writeYyp(dir, yyp);
  const roomNoCode = JSON.parse(await fs.readFile(path.join(dir, "rooms/rmNoCreationCode/rmNoCreationCode.yy"), "utf8"));
  ok("room (no creation code): still matches real GameMaker schema", keysMatchRef(roomNoCode, REF.room));
  ok("room (no creation code): creationCodeFile is empty string, not absent", roomNoCode.creationCodeFile === "");

  // --- Edit room ---
  await editRoom(dir, "rmTest", { width: 1024, height: 768, persistent: true });
  const editedRoom = JSON.parse(await fs.readFile(path.join(dir, "rooms/rmTest/rmTest.yy"), "utf8"));
  ok("editRoom: width/height/persistent applied", editedRoom.roomSettings.Width === 1024
    && editedRoom.roomSettings.Height === 768 && editedRoom.roomSettings.persistent === true);
  ok("editRoom: views resized too", editedRoom.views[0].wview === 1024 && editedRoom.views[0].hview === 768);
  await expectThrows("editRoom: rejects nonexistent room", () => editRoom(dir, "rmDoesNotExist", { width: 100 }));

  // --- Script ---
  yyp = await loadYyp(dir);
  yyp = await addScript(dir, yyp, "scrTest", "function scrTest() { return 1; }\n");
  await writeYyp(dir, yyp);
  const script = JSON.parse(await fs.readFile(path.join(dir, "scripts/scrTest/scrTest.yy"), "utf8"));
  ok("script: top-level keys match real GameMaker schema", keysMatchRef(script, REF.script));

  // --- Edit script ---
  await editScript(dir, "scrTest", "function scrHelper() { return 2; }\n", "append");
  const appendedGml = await fs.readFile(path.join(dir, "scripts/scrTest/scrTest.gml"), "utf8");
  ok("editScript: append preserves original content", appendedGml.includes("function scrTest()"));
  ok("editScript: append adds new content", appendedGml.includes("function scrHelper()"));
  await expectThrows("editScript: rejects appending exact duplicate content", () =>
    editScript(dir, "scrTest", "function scrHelper() { return 2; }\n", "append"));
  await editScript(dir, "scrTest", "function scrTest() { return 99; }\n", "replace");
  const replacedGml = await fs.readFile(path.join(dir, "scripts/scrTest/scrTest.gml"), "utf8");
  ok("editScript: replace overwrites entirely", replacedGml.trim() === "function scrTest() { return 99; }");
  await expectThrows("editScript: rejects nonexistent script", () => editScript(dir, "scrDoesNotExist", "x", "append"));

  // --- Object ---
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objTest", [{ eventType: 0, eventNum: 0 }, { eventType: 3, eventNum: 0 }]);
  await writeYyp(dir, yyp);
  const obj = JSON.parse(await fs.readFile(path.join(dir, "objects/objTest/objTest.yy"), "utf8"));
  ok("object: top-level keys match real GameMaker schema", keysMatchRef(obj, REF.object));
  ok("object: event keys match", keysMatchRef(obj.eventList[0], REF.objectEvent));
  ok("object: eventNum passed through", obj.eventList[0].eventNum === 0);

  // --- Add event to existing object ---
  await addObjectEvent(dir, "objTest", { eventType: 8, eventNum: 0 }, "// custom draw code\n");
  const objWithNewEvent = JSON.parse(await fs.readFile(path.join(dir, "objects/objTest/objTest.yy"), "utf8"));
  ok("addObjectEvent: event count grew from 2 to 3", objWithNewEvent.eventList.length === 3);
  ok("addObjectEvent: new event keys match real schema", keysMatchRef(objWithNewEvent.eventList[2], REF.objectEvent));
  const newEventGml = await fs.readFile(path.join(dir, "objects/objTest/Draw_0.gml"), "utf8");
  ok("addObjectEvent: stub file has the given code", newEventGml.includes("custom draw code"));
  await expectThrows("addObjectEvent: rejects duplicate event", () => addObjectEvent(dir, "objTest", { eventType: 0, eventNum: 0 }));
  await expectThrows("addObjectEvent: rejects nonexistent object", () => addObjectEvent(dir, "objDoesNotExist", { eventType: 0, eventNum: 0 }));

  // --- Collision event targeting (was hardcoded to null, found during the
  // event-type-mapping task) ---
  await addObjectEvent(dir, "objTest", { eventType: 4, eventNum: 0, collisionTargetName: "objTest" }, "// collision code\n");
  const objWithCollision = JSON.parse(await fs.readFile(path.join(dir, "objects/objTest/objTest.yy"), "utf8"));
  const collisionEvent = objWithCollision.eventList.find((e: any) => e.eventType === 4);
  ok("addObjectEvent: collision target resolved to a real {name,path} reference",
    collisionEvent?.collisionObjectId?.name === "objTest" && collisionEvent?.collisionObjectId?.path === "objects/objTest/objTest.yy");
  await expectThrows("addObjectEvent: rejects a nonexistent collision target",
    () => addObjectEvent(dir, "objTest", { eventType: 4, eventNum: 1, collisionTargetName: "objDoesNotExist" }));

  // --- Event code files must use GameMaker's real naming (Create_0.gml,
  // Collision_<target>.gml) or GameMaker silently ignores them -- proven by
  // an Igor A/B compile: invalid GML in a wrong-named file compiles
  // "successfully", the same file under the real name fails. ---
  ok("event files: Create_0.gml, not <obj>_0_0.gml", await fileExists(path.join(dir, "objects/objTest/Create_0.gml")));
  ok("event files: Step_0.gml", await fileExists(path.join(dir, "objects/objTest/Step_0.gml")));
  ok("event files: Draw_0.gml for the added draw event", await fileExists(path.join(dir, "objects/objTest/Draw_0.gml")));
  ok("event files: collision file named after its target", await fileExists(path.join(dir, "objects/objTest/Collision_objTest.gml")));
  ok("event files: legacy <obj>_<type>_<num>.gml never written", !(await fileExists(path.join(dir, "objects/objTest/objTest_0_0.gml"))));

  // Collision events all share (type 4, num 0) legitimately, one per target
  // -- only a duplicate TARGET is a real duplicate.
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objOtherTarget", []);
  await writeYyp(dir, yyp);
  await addObjectEvent(dir, "objTest", { eventType: 4, eventNum: 0, collisionTargetName: "objOtherTarget" }, "// second collision\n");
  ok("collision events: second event with a different target allowed", await fileExists(path.join(dir, "objects/objTest/Collision_objOtherTarget.gml")));
  await expectThrows("collision events: same-target duplicate rejected",
    () => addObjectEvent(dir, "objTest", { eventType: 4, eventNum: 0, collisionTargetName: "objOtherTarget" }));
  await expectThrows("events: unknown eventType rejected", () => addObjectEvent(dir, "objTest", { eventType: 99, eventNum: 0 }));
  await expectThrows("events: negative eventNum rejected", () => addObjectEvent(dir, "objTest", { eventType: 8, eventNum: -1 }));

  // Renaming a collision TARGET must also rename Collision_<target>.gml in
  // every OTHER object's directory -- the target's name is in the filename,
  // not just the .yy content.
  yyp = await loadYyp(dir);
  yyp = await renameResource(dir, yyp, "objects", "objOtherTarget", "objOtherRenamed");
  await writeYyp(dir, yyp);
  ok("rename: external Collision_<target>.gml follows the target's rename",
    (await fileExists(path.join(dir, "objects/objTest/Collision_objOtherRenamed.gml"))) &&
    !(await fileExists(path.join(dir, "objects/objTest/Collision_objOtherTarget.gml"))));
  const secondCollisionContent = await fs.readFile(path.join(dir, "objects/objTest/Collision_objOtherRenamed.gml"), "utf8");
  ok("rename: renamed collision file keeps its code", secondCollisionContent.includes("second collision"));

  // --- Error messages distinguish "doesn't exist" from other real errors ---
  // Renaming a directory to look like the expected .yy path triggers EISDIR on
  // read, not ENOENT -- confirms we don't misreport a real error as "missing".
  const fakeObjDir = path.join(dir, "objects", "objFakeDirClash");
  await fs.mkdir(path.join(fakeObjDir, "objFakeDirClash.yy"), { recursive: true });
  try {
    await addObjectEvent(dir, "objFakeDirClash", { eventType: 0, eventNum: 0 });
    ok("error handling: distinguishes real errors from ENOENT", false, "expected an error");
  } catch (e: any) {
    ok("error handling: distinguishes real errors from ENOENT", !e.message.includes("does not exist"), e.message);
  }

  // --- Critical: editing a file GameMaker has resaved (trailing-comma JSON) ---
  // GameMaker's own writer uses trailing commas, invalid per strict JSON.parse.
  // A file we created can get resaved by the IDE at any point during normal
  // use -- editing must not silently break just because GameMaker touched it.
  const objTestYyPath = path.join(dir, "objects/objTest/objTest.yy");
  const rawObjText = await fs.readFile(objTestYyPath, "utf8");
  const gmStyleObj = rawObjText.replace(/(\n\s*)(\]|\})/, ",$1$2");
  await fs.writeFile(objTestYyPath, gmStyleObj, "utf8");
  try {
    await addObjectEvent(dir, "objTest", { eventType: 5, eventNum: 0 }, "// after GM resave\n");
    ok("handles GameMaker-resaved (trailing-comma) files", true);
  } catch (e: any) {
    ok("handles GameMaker-resaved (trailing-comma) files", false, e.message);
  }

  // --- Room instance placement ---
  const { instanceName } = await addRoomInstance(dir, "rmTest", "objTest", 288, 192, { rotation: 45 });
  const roomWithInstance = JSON.parse(await fs.readFile(path.join(dir, "rooms/rmTest/rmTest.yy"), "utf8"));
  const placedInstance = roomWithInstance.layers[0].instances.find((i: any) => i.name === instanceName);
  ok("instance: was actually placed in the Instances layer", !!placedInstance);
  ok("instance: keys match real GameMaker schema", placedInstance && keysMatchRef(placedInstance, REF.roomInstance));
  ok("instance: position applied", placedInstance?.x === 288 && placedInstance?.y === 192);
  ok("instance: rotation applied", placedInstance?.rotation === 45);
  ok("instance: objectId references the right object", placedInstance?.objectId?.name === "objTest");
  ok("instance: registered in instanceCreationOrder", roomWithInstance.instanceCreationOrder.some((n: any) => n.name === instanceName));
  await expectThrows("instance: rejects nonexistent room", () => addRoomInstance(dir, "rmDoesNotExist", "objTest", 0, 0));
  await expectThrows("instance: rejects nonexistent object", () => addRoomInstance(dir, "rmTest", "objDoesNotExist", 0, 0));

  // --- Sprite ---
  yyp = await loadYyp(dir);
  const framesDir = path.join(dir, "_frames_src");
  await fs.mkdir(framesDir, { recursive: true });
  await fs.copyFile(path.join(process.cwd(), "test/fixtures/frame0.png"), path.join(framesDir, "frame0.png"));
  yyp = await addSpriteFromImages(dir, yyp, "sprTest", framesDir);
  await writeYyp(dir, yyp);
  const sprite = JSON.parse(await fs.readFile(path.join(dir, "sprites/sprTest/sprTest.yy"), "utf8"));
  ok("sprite: top-level keys match real GameMaker schema", keysMatchRef(sprite, REF.sprite));
  ok("sprite: frame keys match", keysMatchRef(sprite.frames[0], REF.spriteFrame));
  ok("sprite: layer keys match", keysMatchRef(sprite.layers[0], REF.spriteLayer));
  ok("sprite: sequence keys match", keysMatchRef(sprite.sequence, REF.spriteSequence));
  ok("sprite: dimensions read from actual PNG (16x24)", sprite.width === 16 && sprite.height === 24, `got ${sprite.width}x${sprite.height}`);
  ok("sprite: bbox derived from dimensions", sprite.bbox_right === 15 && sprite.bbox_bottom === 23);
  ok("sprite: TextureGroups 'Default' entry registered (a genuinely bare project has none by default)",
    ((yyp as any).TextureGroups ?? []).some((g: any) => g.name === "Default"));
  const frameId = sprite.frames[0].name;
  const layerId = sprite.layers[0].name;
  ok("sprite: flat composite PNG exists", await fileExists(path.join(dir, `sprites/sprTest/${frameId}.png`)));
  ok("sprite: per-frame per-layer source PNG exists (GameMaker refuses to load without this)",
    await fileExists(path.join(dir, `sprites/sprTest/layers/${frameId}/${layerId}.png`)));

  await editSprite(dir, "sprTest", { xorigin: 8, yorigin: 12, collisionKind: 1 });
  const editedSprite = JSON.parse(await fs.readFile(path.join(dir, "sprites/sprTest/sprTest.yy"), "utf8"));
  ok("editSprite: origin updated and preset flipped to Custom", editedSprite.sequence.xorigin === 8 && editedSprite.sequence.yorigin === 12 && editedSprite.origin === 9);
  ok("editSprite: collisionKind updated", editedSprite.collisionKind === 1);
  ok("editSprite: frame/dimension data untouched by edit", editedSprite.width === 16 && editedSprite.height === 24 && editedSprite.frames.length === 1);
  await expectThrows("editSprite: rejects nonexistent sprite", () => editSprite(dir, "sprDoesNotExist", { xorigin: 0 }));

  // --- Read-tool parity ---
  const objInfo = await getObjectInfo(dir, "objTest");
  ok("getObjectInfo: reports correct name", objInfo.name === "objTest");
  ok("getObjectInfo: reports all events with human-readable names",
    objInfo.events.length === 6 && objInfo.events[0].type === "Create" && objInfo.events[2].type === "Draw" && objInfo.events[3].type === "Collision",
    JSON.stringify(objInfo.events));
  await expectThrows("getObjectInfo: rejects nonexistent object", () => getObjectInfo(dir, "objDoesNotExist"));

  const roomInfo = await getRoomInfo(dir, "rmTest");
  ok("getRoomInfo: reports resized dimensions", roomInfo.width === 1024 && roomInfo.height === 768);
  ok("getRoomInfo: reports persistent flag", roomInfo.persistent === true);
  ok("getRoomInfo: reports the placed instance", roomInfo.instanceCount === 1 && roomInfo.instances[0].object === "objTest");
  await expectThrows("getRoomInfo: rejects nonexistent room", () => getRoomInfo(dir, "rmDoesNotExist"));

  const spriteInfo = await getSpriteInfo(dir, "sprTest");
  ok("getSpriteInfo: reports real dimensions from PNG", spriteInfo.width === 16 && spriteInfo.height === 24);
  ok("getSpriteInfo: reports frame count", spriteInfo.frameCount === 1);
  await expectThrows("getSpriteInfo: rejects nonexistent sprite", () => getSpriteInfo(dir, "sprDoesNotExist"));

  const scriptInfo = await getScriptInfo(dir, "scrTest");
  ok("getScriptInfo: reports current (replaced) code", scriptInfo.code.includes("return 99"));
  await expectThrows("getScriptInfo: rejects nonexistent script", () => getScriptInfo(dir, "scrDoesNotExist"));

  // --- Shader ---
  yyp = await loadYyp(dir);
  yyp = await addShader(dir, yyp, "shTest");
  await writeYyp(dir, yyp);
  const shader = JSON.parse(await fs.readFile(path.join(dir, "shaders/shTest/shTest.yy"), "utf8"));
  ok("shader: top-level keys match real GameMaker schema", keysMatchRef(shader, REF.shader));
  ok("shader: vsh file exists", await fileExists(path.join(dir, "shaders/shTest/shTest.vsh")));
  ok("shader: fsh file exists", await fileExists(path.join(dir, "shaders/shTest/shTest.fsh")));
  ok("shader: Shaders folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Shaders.yy"));
  const shaderInfo = await getShaderInfo(dir, "shTest");
  ok("getShaderInfo: reports both code files", shaderInfo.vertexCode.length > 0 && shaderInfo.fragmentCode.length > 0);
  await expectThrows("addShader: rejects invalid name", () => addShader(dir, yyp, "1BadShader"));

  // Valid GLSL (not a bare comment) -- this project stays shared with the
  // later real Igor compile test, and an editShader call leaving invalid
  // shader code in place would break that unrelated test.
  const editedVsh = "attribute vec3 in_Position;\nvoid main() { gl_Position = vec4(in_Position, 1.0); }\n";
  const editedFsh = "void main() { gl_FragColor = vec4(1.0); }\n";
  await editShader(dir, "shTest", { vertexCode: editedVsh, fragmentCode: editedFsh });
  ok("editShader: vertex code updated", (await fs.readFile(path.join(dir, "shaders/shTest/shTest.vsh"), "utf8")) === editedVsh);
  ok("editShader: fragment code updated", (await fs.readFile(path.join(dir, "shaders/shTest/shTest.fsh"), "utf8")) === editedFsh);
  await expectThrows("editShader: rejects nonexistent shader", () => editShader(dir, "shDoesNotExist", { vertexCode: "x" }));

  // --- Sound ---
  yyp = await loadYyp(dir);
  yyp = await addSound(dir, yyp, "sndTest", path.join(process.cwd(), "test/fixtures/beep.wav"));
  await writeYyp(dir, yyp);
  const sound = JSON.parse(await fs.readFile(path.join(dir, "sounds/sndTest/sndTest.yy"), "utf8"));
  ok("sound: top-level keys match real GameMaker schema (per @bscotch/yy v2)", keysMatchRef(sound, REF.sound));
  ok("sound: audio file copied", await fileExists(path.join(dir, "sounds/sndTest/sndTest.wav")));
  ok("sound: soundFile field correct", sound.soundFile === "sndTest.wav");
  ok("sound: Sounds folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Sounds.yy"));
  ok("sound: real sample rate derived from WAV header (not hardcoded)", sound.sampleRate === 44100);
  ok("sound: real channel count derived (mono -> channelFormat 0)", sound.channelFormat === 0);
  ok("sound: real bit depth derived (16-bit -> bitDepth 1)", sound.bitDepth === 1);
  ok("sound: real duration computed from data chunk size", Math.abs(sound.duration - 0.1) < 0.01, `got ${sound.duration}`);
  ok("sound: AudioGroups 'audiogroup_default' entry registered (a genuinely bare project has none by default)",
    ((yyp as any).AudioGroups ?? []).some((g: any) => g.name === "audiogroup_default"));
  const soundInfo = await getSoundInfo(dir, "sndTest");
  ok("getSoundInfo: reports soundFile", soundInfo.soundFile === "sndTest.wav");
  await expectThrows("addSound: rejects non-wav format", () =>
    addSound(dir, yyp, "sndBad", path.join(process.cwd(), "test/fixtures/frame0.png")));
  await expectThrows("addSound: rejects unsupported sample rate", () =>
    addSound(dir, yyp, "sndBadRate", path.join(process.cwd(), "test/fixtures/badrate.wav")));

  await editSound(dir, "sndTest", { volume: 0.5, preload: false });
  const editedSound = JSON.parse(await fs.readFile(path.join(dir, "sounds/sndTest/sndTest.yy"), "utf8"));
  ok("editSound: volume/preload updated", editedSound.volume === 0.5 && editedSound.preload === false);
  ok("editSound: real audio metadata untouched by edit", editedSound.sampleRate === 44100 && editedSound.channelFormat === 0);
  await expectThrows("editSound: rejects nonexistent sound", () => editSound(dir, "sndDoesNotExist", { volume: 1 }));

  // --- Font ---
  yyp = await loadYyp(dir);
  const fontResult = await addFont(dir, yyp, "fntTest", "Arial", { size: 16, bold: true });
  yyp = fontResult.yyp;
  await writeYyp(dir, yyp);
  const font = JSON.parse(await fs.readFile(path.join(dir, "fonts/fntTest/fntTest.yy"), "utf8"));
  ok("font: top-level keys match real Convoy font schema", keysMatchRef(font, REF.font));
  ok("font: system font name applied", font.fontName === "Arial");
  ok("font: size/bold applied", font.size === 16 && font.bold === true);
  ok("font: Fonts folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Fonts.yy"));
  const fontInfo = await getFontInfo(dir, "fntTest");
  ok("getFontInfo: reports system font name", fontInfo.systemFontName === "Arial");
  ok("addFont: no warning for a real, near-universal Windows font (Arial)", fontResult.warning === null);
  await expectThrows("addFont: rejects invalid name", () => addFont(dir, yyp, "1BadFont", "Arial"));

  yyp = await loadYyp(dir);
  const badFontResult = await addFont(dir, yyp, "fntBogus", "TotallyNotARealFontXYZ123");
  yyp = badFontResult.yyp;
  await writeYyp(dir, yyp);
  ok("addFont: warns (but still creates) when the system font isn't installed",
    badFontResult.warning === null || badFontResult.warning.includes("TotallyNotARealFontXYZ123"),
    "warning should either be null (registry unreadable -- skip gracefully) or explicitly name the missing font");
  ok("addFont: resource is created even when the font doesn't exist (visual issue, not a crash risk)",
    await fileExists(path.join(dir, "fonts/fntBogus/fntBogus.yy")));

  const editFontResult = await editFont(dir, "fntTest", { size: 20, bold: false, italic: true });
  const editedFont = JSON.parse(await fs.readFile(path.join(dir, "fonts/fntTest/fntTest.yy"), "utf8"));
  ok("editFont: size/bold/italic updated", editedFont.size === 20 && editedFont.bold === false && editedFont.italic === true);
  ok("editFont: styleName recomputed", editedFont.styleName === "Italic");
  ok("editFont: no warning editing size only (font name unchanged)", editFontResult.warning === null);
  await expectThrows("editFont: rejects nonexistent font", () => editFont(dir, "fntDoesNotExist", { size: 10 }));

  // --- Tileset (sprTest is a real 16x24 sprite added earlier) ---
  yyp = await loadYyp(dir);
  yyp = await addTileset(dir, yyp, "tsTest", "sprTest", 8, 8);
  await writeYyp(dir, yyp);
  const tileset = JSON.parse(await fs.readFile(path.join(dir, "tilesets/tsTest/tsTest.yy"), "utf8"));
  ok("tileset: top-level keys match real Convoy tileset schema", keysMatchRef(tileset, REF.tileset));
  ok("tileset: sprite reference correct", tileset.spriteId.name === "sprTest" && tileset.spriteId.path === "sprites/sprTest/sprTest.yy");
  ok("tileset: tile dimensions applied", tileset.tileWidth === 8 && tileset.tileHeight === 8);
  ok("tileset: columns/rows/count derived from real 16x24 sprite (2x3=6 tiles of 8x8)",
    tileset.out_columns === 2 && tileset.tile_count === 6, `got columns=${tileset.out_columns} count=${tileset.tile_count}`);
  ok("tileset: Tilesets folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Tilesets.yy"));
  const tilesetInfo = await getTilesetInfo(dir, "tsTest");
  ok("getTilesetInfo: reports sprite and tile dimensions", tilesetInfo.sprite === "sprTest" && tilesetInfo.tileWidth === 8 && tilesetInfo.tileCount === 6);
  await expectThrows("addTileset: rejects invalid name", () => addTileset(dir, yyp, "1BadTileset", "sprTest", 8, 8));
  await expectThrows("addTileset: rejects a nonexistent source sprite", () => addTileset(dir, yyp, "tsNoSprite", "sprDoesNotExist", 8, 8));

  await editTileset(dir, "tsTest", { tileWidth: 4, tileHeight: 4 });
  const editedTileset = JSON.parse(await fs.readFile(path.join(dir, "tilesets/tsTest/tsTest.yy"), "utf8"));
  ok("editTileset: tile dimensions updated", editedTileset.tileWidth === 4 && editedTileset.tileHeight === 4);
  ok("editTileset: columns/count recomputed from real sprite (16/4=4 cols, 24/4=6 rows, 24 tiles)",
    editedTileset.out_columns === 4 && editedTileset.tile_count === 24, `got columns=${editedTileset.out_columns} count=${editedTileset.tile_count}`);
  await expectThrows("editTileset: rejects nonexistent tileset", () => editTileset(dir, "tsDoesNotExist", { tileWidth: 4 }));

  yyp = await renameResource(dir, yyp, "tilesets", "tsTest", "tsRenamed");
  await writeYyp(dir, yyp);
  ok("renameResource: works on tilesets", await fileExists(path.join(dir, "tilesets/tsRenamed/tsRenamed.yy"))
    && !(await fileExists(path.join(dir, "tilesets/tsTest"))));

  yyp = await deleteResource(dir, yyp, "tilesets", "tsRenamed");
  await writeYyp(dir, yyp);
  ok("deleteResource: works on tilesets", !(await fileExists(path.join(dir, "tilesets/tsRenamed"))));

  // --- Extension (empty shell -- real ground truth has no populated
  // functions/constants example available, see module comment) ---
  yyp = await loadYyp(dir);
  yyp = await addExtension(dir, yyp, "extTest");
  await writeYyp(dir, yyp);
  const extension = JSON.parse(await fs.readFile(path.join(dir, "extensions/extTest/extTest.yy"), "utf8"));
  ok("extension: top-level keys match real bscotch/stitch sample schema", keysMatchRef(extension, REF.extension));
  ok("extension: resourceVersion matches real sample (2.0, not @bscotch/yy's stale 1.2 default)", extension.resourceVersion === "2.0");
  ok("extension: Extensions folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Extensions.yy"));
  const extensionInfo = await getExtensionInfo(dir, "extTest");
  ok("getExtensionInfo: reports version and file count", extensionInfo.extensionVersion === "0.0.1" && extensionInfo.fileCount === 0);
  await expectThrows("addExtension: rejects invalid name", () => addExtension(dir, yyp, "1BadExtension"));

  yyp = await renameResource(dir, yyp, "extensions", "extTest", "extRenamed");
  await writeYyp(dir, yyp);
  ok("renameResource: works on extensions", await fileExists(path.join(dir, "extensions/extRenamed/extRenamed.yy"))
    && !(await fileExists(path.join(dir, "extensions/extTest"))));

  yyp = await deleteResource(dir, yyp, "extensions", "extRenamed");
  await writeYyp(dir, yyp);
  ok("deleteResource: works on extensions", !(await fileExists(path.join(dir, "extensions/extRenamed"))));

  // --- Particle system (real ground truth from a published GameMaker
  // project, see module comment for the version-drift caveat) ---
  yyp = await loadYyp(dir);
  yyp = await addParticleSystem(dir, yyp, "partTest");
  await writeYyp(dir, yyp);
  const particleSystem = JSON.parse(await fs.readFile(path.join(dir, "particles/partTest/partTest.yy"), "utf8"));
  ok("particleSystem: top-level keys match real captured schema", keysMatchRef(particleSystem, REF.particleSystem));
  ok("particleSystem: has one default emitter", particleSystem.emitters.length === 1);
  ok("particleSystem: emitter keys match real captured schema", keysMatchRef(particleSystem.emitters[0], REF.particleEmitter));
  ok("particleSystem: Particles folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Particles.yy"));
  const particleSystemInfo = await getParticleSystemInfo(dir, "partTest");
  ok("getParticleSystemInfo: reports emitter count and names", particleSystemInfo.emitterCount === 1 && particleSystemInfo.emitterNames[0] === "Emitter");
  await expectThrows("addParticleSystem: rejects invalid name", () => addParticleSystem(dir, yyp, "1BadParticleSystem"));

  yyp = await renameResource(dir, yyp, "particles", "partTest", "partRenamed");
  await writeYyp(dir, yyp);
  ok("renameResource: works on particle systems", await fileExists(path.join(dir, "particles/partRenamed/partRenamed.yy"))
    && !(await fileExists(path.join(dir, "particles/partTest"))));

  yyp = await deleteResource(dir, yyp, "particles", "partRenamed");
  await writeYyp(dir, yyp);
  ok("deleteResource: works on particle systems", !(await fileExists(path.join(dir, "particles/partRenamed"))));

  // --- Animation curve (real ground truth from @bscotch/yy's own sample
  // fixtures, see module comment for the version-drift caveat) ---
  yyp = await loadYyp(dir);
  yyp = await addAnimCurve(dir, yyp, "curveTest");
  await writeYyp(dir, yyp);
  const animCurve = JSON.parse(await fs.readFile(path.join(dir, "animcurves/curveTest/curveTest.yy"), "utf8"));
  ok("animCurve: top-level keys match real captured schema", keysMatchRef(animCurve, REF.animCurve));
  ok("animCurve: has one default channel", animCurve.channels.length === 1);
  ok("animCurve: channel keys match real captured schema", keysMatchRef(animCurve.channels[0], REF.animCurveChannel));
  ok("animCurve: straight line from (0,0) to (1,1)", animCurve.channels[0].points.length === 2
    && animCurve.channels[0].points[0].x === 0 && animCurve.channels[0].points[0].y === 0
    && animCurve.channels[0].points[1].x === 1 && animCurve.channels[0].points[1].y === 1);
  ok("animCurve: Animation Curves folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Animation Curves.yy"));
  const animCurveInfo = await getAnimCurveInfo(dir, "curveTest");
  ok("getAnimCurveInfo: reports channel count, names, and point counts", animCurveInfo.channelCount === 1
    && animCurveInfo.channelNames[0] === "channel0" && animCurveInfo.pointCounts[0] === 2);
  await expectThrows("addAnimCurve: rejects invalid name", () => addAnimCurve(dir, yyp, "1BadAnimCurve"));

  yyp = await renameResource(dir, yyp, "animcurves", "curveTest", "curveRenamed");
  await writeYyp(dir, yyp);
  ok("renameResource: works on animation curves", await fileExists(path.join(dir, "animcurves/curveRenamed/curveRenamed.yy"))
    && !(await fileExists(path.join(dir, "animcurves/curveTest"))));

  yyp = await deleteResource(dir, yyp, "animcurves", "curveRenamed");
  await writeYyp(dir, yyp);
  ok("deleteResource: works on animation curves", !(await fileExists(path.join(dir, "animcurves/curveRenamed"))));

  // --- Validation edge cases (rooms, representative of all four writers) ---
  const badNames = ["", "../../etc", "rooms/evil", "evil\\room", "1Room", "my room", "room.yy", "r".repeat(101)];
  for (const name of badNames) {
    yyp = await loadYyp(dir);
    await expectThrows(`rejects invalid name: ${JSON.stringify(name)}`, () =>
      addRoom(dir, yyp, name, { width: 100, height: 100, persistent: false }));
  }
  yyp = await loadYyp(dir);
  await expectThrows("rejects duplicate name (exact)", () =>
    addRoom(dir, yyp, "rmTest", { width: 100, height: 100, persistent: false }));
  await expectThrows("rejects duplicate name (case-insensitive)", () =>
    addRoom(dir, yyp, "RMTEST", { width: 100, height: 100, persistent: false }));

  // --- Folder no-op on already-organized state ---
  const foldersBefore = ((yyp as any).Folders ?? []).length;
  yyp = await addRoom(dir, yyp, "rmSecond", { width: 100, height: 100, persistent: false });
  const foldersAfter = ((yyp as any).Folders ?? []).length;
  ok("Rooms folder not duplicated on second room add", foldersBefore === foldersAfter);

  // --- Texture/audio groups: explicit add (throws on collision), distinct
  // from ensureX's silent auto-provisioning no-op ---
  yyp = await loadYyp(dir);
  addTextureGroup(yyp, "HighRes");
  ok("addTextureGroup: new group registered", ((yyp as any).TextureGroups ?? []).some((g: any) => g.name === "HighRes"));
  await expectThrows("addTextureGroup: rejects a name that already exists", async () => addTextureGroup(yyp, "HighRes"));
  await expectThrows("addTextureGroup: rejects collision with the auto-provisioned Default group", async () => addTextureGroup(yyp, "Default"));

  addAudioGroup(yyp, "Music");
  ok("addAudioGroup: new group registered", ((yyp as any).AudioGroups ?? []).some((g: any) => g.name === "Music"));
  await expectThrows("addAudioGroup: rejects a name that already exists", async () => addAudioGroup(yyp, "Music"));
  await writeYyp(dir, yyp);

  // --- writeYyp atomicity: a failed write must not corrupt the real .yyp file ---
  {
    const yypFileName = (await fs.readdir(dir)).find(f => f.endsWith(".yyp"))!;
    const yypPath = path.join(dir, yypFileName);
    const goodContentBefore = await fs.readFile(yypPath, "utf8");

    const badYyp = { ...(await loadYyp(dir)), resources: "not-an-array" as any };
    let threw = false;
    try {
      await writeYyp(dir, badYyp);
    } catch {
      threw = true;
    }
    ok("writeYyp: throws on invalid data instead of silently writing it", threw);

    const contentAfterFailedWrite = await fs.readFile(yypPath, "utf8");
    ok("writeYyp: original file untouched after a failed write", contentAfterFailedWrite === goodContentBefore);

    const leftoverTemp = (await fs.readdir(dir)).some(f => f.includes(".tmp-"));
    ok("writeYyp: no leftover temp file after a failed write", !leftoverTemp);
  }

  // --- Reference search + safe delete ---
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objRefTarget", []);
  await writeYyp(dir, yyp);
  yyp = await addRoom(dir, yyp, "rmRefHolder", { width: 400, height: 300, persistent: false });
  await writeYyp(dir, yyp);
  await addRoomInstance(dir, "rmRefHolder", "objRefTarget", 10, 10);

  const refs = await findReferences(dir, "objRefTarget");
  ok("findReferences: finds the room that placed an instance of it", refs.some(r => r.file.includes("rmRefHolder")));
  ok("findReferences: excludes the resource's own files", !refs.some(r => r.file.includes("objRefTarget.yy")));
  await expectThrows("findReferences: rejects an empty resourceName instead of matching almost everything", () => findReferences(dir, ""));

  yyp = await loadYyp(dir);
  let caughtInUse = false;
  try {
    await deleteResource(dir, yyp, "objects", "objRefTarget");
  } catch (e) {
    caughtInUse = e instanceof ResourceInUseError;
  }
  ok("deleteResource: refuses to delete a referenced resource", caughtInUse);
  ok("objRefTarget: still exists on disk after refused delete", await fileExists(path.join(dir, "objects/objRefTarget/objRefTarget.yy")));

  yyp = await deleteResource(dir, yyp, "objects", "objRefTarget", true);
  await writeYyp(dir, yyp);
  ok("deleteResource: force=true deletes a referenced resource", !(await fileExists(path.join(dir, "objects/objRefTarget/objRefTarget.yy"))));
  ok("deleteResource: removed from yyp.resources", !yyp.resources.some((r: any) => r.id?.name === "objRefTarget"));

  yyp = await loadYyp(dir);
  yyp = await addScript(dir, yyp, "scrUnreferenced", "function scrUnreferenced() { return 1; }\n");
  await writeYyp(dir, yyp);
  yyp = await deleteResource(dir, yyp, "scripts", "scrUnreferenced");
  await writeYyp(dir, yyp);
  ok("deleteResource: deletes an unreferenced resource without needing force", !(await fileExists(path.join(dir, "scripts/scrUnreferenced/scrUnreferenced.yy"))));

  yyp = await loadYyp(dir);
  const roomOrderBefore = ((yyp as any).RoomOrderNodes ?? []).length;
  yyp = await deleteResource(dir, yyp, "rooms", "rmRefHolder", true);
  await writeYyp(dir, yyp);
  const roomOrderAfter = ((yyp as any).RoomOrderNodes ?? []).length;
  ok("deleteResource: removes deleted room from RoomOrderNodes", roomOrderAfter === roomOrderBefore - 1);

  await expectThrows("deleteResource: rejects nonexistent resource", () =>
    deleteResource(dir, yyp, "objects", "objTotallyMadeUp"));

  // --- Path traversal: every tool taking an EXISTING resource's name must
  // reject a name that isn't a plain identifier before it reaches path.join,
  // not just the create-a-new-resource tools ---
  const traversalName = "../../../../Windows/System32/Tasks";
  await expectThrows("deleteResource: rejects path traversal in resourceName", () =>
    deleteResource(dir, yyp, "objects", traversalName));
  await expectThrows("renameResource: rejects path traversal in oldName", () =>
    renameResource(dir, yyp, "objects", traversalName, "objWhatever"));
  await expectThrows("renameResource: rejects path traversal in newName", () =>
    renameResource(dir, yyp, "scripts", "scrTest", traversalName));
  await expectThrows("editScript: rejects path traversal in scriptName", () =>
    editScript(dir, traversalName, "function evil() {}", "replace"));
  await expectThrows("addObjectEvent: rejects path traversal in objectName", () =>
    addObjectEvent(dir, traversalName, { eventType: 3, eventNum: 0 }));
  await expectThrows("editRoom: rejects path traversal in roomName", () =>
    editRoom(dir, traversalName, { width: 100 }));
  await expectThrows("addRoomInstance: rejects path traversal in roomName", () =>
    addRoomInstance(dir, traversalName, "objTest", 0, 0));
  await expectThrows("addRoomInstance: rejects path traversal in objectName", () =>
    addRoomInstance(dir, "rmTest", traversalName, 0, 0));
  await expectThrows("getObjectInfo: rejects path traversal", () => getObjectInfo(dir, traversalName));
  await expectThrows("getScriptInfo: rejects path traversal", () => getScriptInfo(dir, traversalName));

  // --- Rename (riskiest writer -- must rewrite every reference, not just detect them) ---
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objRenameMe", []);
  await writeYyp(dir, yyp);
  yyp = await addRoom(dir, yyp, "rmRenameHolder", { width: 400, height: 300, persistent: false });
  await writeYyp(dir, yyp);
  await addRoomInstance(dir, "rmRenameHolder", "objRenameMe", 50, 60);

  yyp = await loadYyp(dir);
  yyp = await renameResource(dir, yyp, "objects", "objRenameMe", "objRenamedTarget");
  await writeYyp(dir, yyp);

  ok("rename: old object directory gone", !(await fileExists(path.join(dir, "objects/objRenameMe"))));
  ok("rename: new object directory exists", await fileExists(path.join(dir, "objects/objRenamedTarget/objRenamedTarget.yy")));
  const renamedObj = JSON.parse(await fs.readFile(path.join(dir, "objects/objRenamedTarget/objRenamedTarget.yy"), "utf8"));
  ok("rename: object's own name field updated", renamedObj.name === "objRenamedTarget" && renamedObj["%Name"] === "objRenamedTarget");
  ok("rename: yyp.resources entry updated", yyp.resources.some((r: any) => r.id?.name === "objRenamedTarget")
    && !yyp.resources.some((r: any) => r.id?.name === "objRenameMe"));

  const roomAfterRename = JSON.parse(await fs.readFile(path.join(dir, "rooms/rmRenameHolder/rmRenameHolder.yy"), "utf8"));
  const renamedInstance = roomAfterRename.layers[0].instances[0];
  ok("rename: room's instance objectId.name updated", renamedInstance.objectId.name === "objRenamedTarget");
  ok("rename: room's instance objectId.path updated", renamedInstance.objectId.path === "objects/objRenamedTarget/objRenamedTarget.yy");

  const staleRefs = await findReferences(dir, "objRenameMe", false);
  ok("rename: zero references to the old name remain anywhere", staleRefs.length === 0, JSON.stringify(staleRefs));

  // Room rename, specifically covering a room's self-referencing creationCodeFile path
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmOldRoomName", { width: 200, height: 200, persistent: false, creationCode: "show_debug_message(1);" });
  await writeYyp(dir, yyp);
  yyp = await loadYyp(dir);
  yyp = await renameResource(dir, yyp, "rooms", "rmOldRoomName", "rmNewRoomName");
  await writeYyp(dir, yyp);
  const renamedRoom = JSON.parse(await fs.readFile(path.join(dir, "rooms/rmNewRoomName/rmNewRoomName.yy"), "utf8"));
  ok("rename (room): self-referencing creationCodeFile path updated", renamedRoom.creationCodeFile === "rooms/rmNewRoomName/RoomCreationCode.gml");
  ok("rename (room): RoomOrderNodes updated", ((yyp as any).RoomOrderNodes ?? []).some((n: any) => n.roomId?.name === "rmNewRoomName")
    && !((yyp as any).RoomOrderNodes ?? []).some((n: any) => n.roomId?.name === "rmOldRoomName"));

  // Regression: a rename that fails partway through must roll back
  // everything already done -- external files, own file contents, and any
  // files already renamed -- rather than leave the project half-migrated.
  // Force a real failure at the "rename own files" step by pre-creating a
  // file at the exact path one of those renames would target.
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objRollbackTest", [{ eventType: 0, eventNum: 0 }]);
  await writeYyp(dir, yyp);
  yyp = await addRoom(dir, yyp, "rmRollbackHolder", { width: 100, height: 100, persistent: false });
  await writeYyp(dir, yyp);
  await addRoomInstance(dir, "rmRollbackHolder", "objRollbackTest", 0, 0);

  const rollbackObjDir = path.join(dir, "objects/objRollbackTest");
  const rollbackYyPath = path.join(rollbackObjDir, "objRollbackTest.yy");
  const rollbackEventPath = path.join(rollbackObjDir, "Create_0.gml");
  const rollbackRoomPath = path.join(dir, "rooms/rmRollbackHolder/rmRollbackHolder.yy");
  const originalYyContent = await fs.readFile(rollbackYyPath, "utf8");
  const originalEventContent = await fs.readFile(rollbackEventPath, "utf8");
  const originalRoomContent = await fs.readFile(rollbackRoomPath, "utf8");

  // Conflicts with the rename target for the object's own .yy, forcing
  // fs.rename to throw partway through step 3 -- a directory (not a file)
  // sitting at the target path reliably fails a file-to-that-path rename.
  await fs.mkdir(path.join(rollbackObjDir, "objRollbackNew.yy"), { recursive: true });

  yyp = await loadYyp(dir);
  let rollbackThrew = false;
  try {
    await renameResource(dir, yyp, "objects", "objRollbackTest", "objRollbackNew");
  } catch {
    rollbackThrew = true;
  }
  ok("rename rollback: the forced failure actually threw", rollbackThrew);
  ok("rename rollback: object directory still has the old name", await fileExists(rollbackYyPath));
  ok("rename rollback: object .yy content fully restored", await fs.readFile(rollbackYyPath, "utf8") === originalYyContent);
  ok("rename rollback: event stub content fully restored", await fs.readFile(rollbackEventPath, "utf8") === originalEventContent);
  ok("rename rollback: external room reference fully restored", await fs.readFile(rollbackRoomPath, "utf8") === originalRoomContent);
  ok("rename rollback: new directory was never left behind", !(await fileExists(path.join(dir, "objects/objRollbackNew"))));
  await fs.rm(path.join(rollbackObjDir, "objRollbackNew.yy"), { recursive: true, force: true });

  // Regression: renaming must NOT touch a coincidentally-matching "name"
  // field that isn't actually a reference to the resource -- only the
  // file's own root identity and real {name, path} reference pairs
  // (objectId, spriteId, etc.) should change. A room's own layer has a
  // "name"/"%Name" of its own (normally "Instances") with no sibling
  // "path" key -- if a user renamed that layer to match an object's name,
  // it must survive the object's rename untouched, while the real instance
  // reference in the same file does get updated.
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objCoincidence", []);
  await writeYyp(dir, yyp);
  yyp = await addRoom(dir, yyp, "rmCoincidenceHolder", { width: 200, height: 200, persistent: false });
  await writeYyp(dir, yyp);
  await addRoomInstance(dir, "rmCoincidenceHolder", "objCoincidence", 0, 0);
  const coincidenceRoomPath = path.join(dir, "rooms/rmCoincidenceHolder/rmCoincidenceHolder.yy");
  const coincidenceRoom = JSON.parse(await fs.readFile(coincidenceRoomPath, "utf8"));
  coincidenceRoom.layers[0].name = "objCoincidence";
  coincidenceRoom.layers[0]["%Name"] = "objCoincidence";
  await fs.writeFile(coincidenceRoomPath, JSON.stringify(coincidenceRoom, null, 2), "utf8");

  yyp = await loadYyp(dir);
  yyp = await renameResource(dir, yyp, "objects", "objCoincidence", "objCoincidenceRenamed");
  await writeYyp(dir, yyp);
  const afterCoincidenceRename = JSON.parse(await fs.readFile(coincidenceRoomPath, "utf8"));
  ok("rename: real instance reference IS updated", afterCoincidenceRename.layers[0].instances[0].objectId.name === "objCoincidenceRenamed");
  ok("rename: coincidentally-matching layer name (no sibling path) is left untouched",
    afterCoincidenceRename.layers[0].name === "objCoincidence" && afterCoincidenceRename.layers[0]["%Name"] === "objCoincidence");

  // Regression: a "var <name>" local variable declaration in .gml code that
  // happens to share the resource's exact name must survive a rename of
  // that resource untouched -- scoped mitigation, not full GML-aware
  // precision (a later bare usage of that same local on another line is a
  // known, documented residual gap without a real GML parser).
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objShadowRename", []);
  await writeYyp(dir, yyp);
  yyp = await addScript(dir, yyp, "scrShadowTest", "function scrShadowTest() {\n  var objShadowRename = 123;\n  return objShadowRename;\n}\n");
  await writeYyp(dir, yyp);

  yyp = await renameResource(dir, yyp, "objects", "objShadowRename", "objShadowRenamed");
  await writeYyp(dir, yyp);
  const shadowScriptGml = await fs.readFile(path.join(dir, "scripts/scrShadowTest/scrShadowTest.gml"), "utf8");
  ok("rename: a 'var <name>' local declaration line is left untouched", shadowScriptGml.includes("var objShadowRename = 123;"));

  // Guard rails
  await expectThrows("rename: rejects same old/new name", () => renameResource(dir, yyp, "rooms", "rmNewRoomName", "rmNewRoomName"));
  await expectThrows("rename: rejects invalid new name", () => renameResource(dir, yyp, "rooms", "rmNewRoomName", "1BadName"));
  await expectThrows("rename: rejects collision with existing resource", () => renameResource(dir, yyp, "rooms", "rmNewRoomName", "rmRenameHolder"));
  await expectThrows("rename: rejects nonexistent resource", () => renameResource(dir, yyp, "rooms", "rmDoesNotExist", "rmWhatever"));

  // --- Concurrency: withProjectLock must serialize operations against the
  // same key (this is what stops two racing MCP tool calls from each loading
  // their own copy of the yyp and whoever writes last silently discarding
  // the other's changes), while NOT serializing unrelated project keys ---
  {
    let counter = 0;
    const increment = () => withProjectLock("verify-lock-key", async () => {
      const before = counter;
      await new Promise(r => setTimeout(r, 10));
      counter = before + 1;
    });
    await Promise.all([increment(), increment(), increment(), increment(), increment()]);
    ok("withProjectLock: serializes concurrent operations on the same key (no lost updates)", counter === 5, `expected 5, got ${counter}`);

    let activeCount = 0;
    let sawBothActiveAtOnce = false;
    const track = (key: string) => withProjectLock(key, async () => {
      activeCount++;
      if (activeCount >= 2) sawBothActiveAtOnce = true;
      await new Promise(r => setTimeout(r, 20));
      activeCount--;
    });
    await Promise.all([track("verify-lock-key-A"), track("verify-lock-key-B")]);
    ok("withProjectLock: different keys are not serialized against each other", sawBothActiveAtOnce);
  }

  // --- Lint tool: build a fresh, isolated, known-good cluster, then corrupt
  // one specific thing at a time and confirm each corruption is caught ---
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objLintTarget", []);
  await writeYyp(dir, yyp);
  yyp = await addRoom(dir, yyp, "rmLintHolder", { width: 400, height: 300, persistent: false });
  await writeYyp(dir, yyp);
  await addRoomInstance(dir, "rmLintHolder", "objLintTarget", 0, 0);
  yyp = await loadYyp(dir);
  yyp = await addSound(dir, yyp, "sndLintTarget", path.join(process.cwd(), "test/fixtures/beep.wav"));
  await writeYyp(dir, yyp);
  yyp = await loadYyp(dir);
  yyp = await addSpriteFromImages(dir, yyp, "sprLintTarget", path.join(process.cwd(), "test/fixtures"));
  await writeYyp(dir, yyp);

  const cleanIssues = await lintProject(dir);
  const cleanErrors = cleanIssues.filter(i => i.severity === "error" && i.file?.includes("LintTarget"));
  ok("lint: clean, freshly-built cluster has zero errors", cleanErrors.length === 0, JSON.stringify(cleanErrors));

  // Corrupt 1: dangling reference (delete object file behind the yyp's back)
  await fs.rm(path.join(dir, "objects/objLintTarget"), { recursive: true, force: true });
  let issues = await lintProject(dir);
  ok("lint: catches dangling yyp catalog entry (file deleted behind its back)",
    issues.some(i => i.severity === "error" && i.message.includes("objLintTarget") && i.message.includes("missing")));
  ok("lint: catches the room instance left pointing at the now-deleted object",
    issues.some(i => i.severity === "error" && i.message.includes("rmLintHolder") && i.message.includes("objLintTarget")));

  // Clean up Corrupt 1 fully (not just the files) so later tests -- like the
  // ProjectTool integration below -- operate on a genuinely clean project,
  // not one still carrying this deliberate corruption forward.
  await fs.rm(path.join(dir, "rooms/rmLintHolder"), { recursive: true, force: true });
  yyp = await loadYyp(dir);
  yyp.resources = yyp.resources.filter((r: any) => !r.id?.path?.includes("objLintTarget") && !r.id?.path?.includes("rmLintHolder"));
  (yyp as any).RoomOrderNodes = ((yyp as any).RoomOrderNodes ?? []).filter((n: any) => n.roomId?.name !== "rmLintHolder");
  await writeYyp(dir, yyp);

  // Corrupt 1.5: event declared in eventList but its code file missing --
  // GameMaker loads the project fine and silently treats the event as empty,
  // which no other check can see.
  yyp = await loadYyp(dir);
  yyp = await addObject(dir, yyp, "objLintEvent", [{ eventType: 0, eventNum: 0 }]);
  await writeYyp(dir, yyp);
  await fs.rm(path.join(dir, "objects/objLintEvent/Create_0.gml"), { force: true });
  issues = await lintProject(dir);
  ok("lint: catches an event whose code file is missing",
    issues.some(i => i.severity === "error" && i.message.includes("objLintEvent") && i.message.includes("Create_0")));
  yyp = await loadYyp(dir);
  yyp = await deleteResource(dir, yyp, "objects", "objLintEvent", true);
  await writeYyp(dir, yyp);

  // Corrupt 2: orphaned directory (exists on disk, not registered)
  await fs.mkdir(path.join(dir, "objects/objOrphan"), { recursive: true });
  await fs.writeFile(path.join(dir, "objects/objOrphan/objOrphan.yy"), JSON.stringify({ name: "objOrphan" }), "utf8");
  issues = await lintProject(dir);
  ok("lint: catches an orphaned resource directory", issues.some(i => i.message.includes("objOrphan") && i.message.includes("isn't registered")));
  await fs.rm(path.join(dir, "objects/objOrphan"), { recursive: true, force: true });

  // Corrupt 3: sound metadata mismatch (the real crash-on-load bug)
  const sndYyPath = path.join(dir, "sounds/sndLintTarget/sndLintTarget.yy");
  const sndYy = JSON.parse(await fs.readFile(sndYyPath, "utf8"));
  const realSampleRate = sndYy.sampleRate;
  sndYy.sampleRate = 8000;
  await fs.writeFile(sndYyPath, JSON.stringify(sndYy, null, 2), "utf8");
  issues = await lintProject(dir);
  ok("lint: catches sound sampleRate mismatch (the real crash bug)",
    issues.some(i => i.severity === "error" && i.message.includes("sndLintTarget") && i.message.includes("sampleRate")));
  sndYy.sampleRate = realSampleRate;
  await fs.writeFile(sndYyPath, JSON.stringify(sndYy, null, 2), "utf8");

  // Corrupt 4: sprite dimension mismatch
  const sprYyPath = path.join(dir, "sprites/sprLintTarget/sprLintTarget.yy");
  const sprYy = JSON.parse(await fs.readFile(sprYyPath, "utf8"));
  const realWidth = sprYy.width;
  sprYy.width = 9999;
  await fs.writeFile(sprYyPath, JSON.stringify(sprYy, null, 2), "utf8");
  issues = await lintProject(dir);
  ok("lint: catches sprite dimension mismatch",
    issues.some(i => i.severity === "error" && i.message.includes("sprLintTarget") && i.message.includes("9999")));
  sprYy.width = realWidth;
  await fs.writeFile(sprYyPath, JSON.stringify(sprYy, null, 2), "utf8");

  // Corrupt 5: missing folder registration
  yyp = await loadYyp(dir);
  const beforeFolderRemoval = ((yyp as any).Folders ?? []).length;
  (yyp as any).Folders = ((yyp as any).Folders ?? []).filter((f: any) => f.name !== "Sounds");
  await writeYyp(dir, yyp);
  issues = await lintProject(dir);
  ok("lint: catches a resource parenting to an unregistered folder",
    issues.some(i => i.severity === "error" && i.message.includes("sndLintTarget") && i.message.includes("folder")));

  // Restore, so later tests (like the ProjectTool integration below) run
  // against a genuinely clean project again.
  yyp = await loadYyp(dir);
  const restoredYyp: any = yyp;
  if (!(restoredYyp.Folders ?? []).some((f: any) => f.name === "Sounds")) {
    restoredYyp.Folders = [...(restoredYyp.Folders ?? []), { "$GMFolder": "", "%Name": "Sounds", folderPath: "folders/Sounds.yy", name: "Sounds", resourceType: "GMFolder", resourceVersion: "2.0" }];
  }
  await writeYyp(dir, restoredYyp);

  // Not a corruption: a resource parenting directly to the project's own
  // .yyp (not a category folder) is legal GameMaker behavior and must NOT
  // be flagged as a missing-folder error (a real false positive this
  // session, found by testing lint against real Convoy).
  const sprYyForParentTest = JSON.parse(await fs.readFile(sprYyPath, "utf8"));
  sprYyForParentTest.parent = { name: "TestProj", path: "TestProj.yyp" };
  await fs.writeFile(sprYyPath, JSON.stringify(sprYyForParentTest, null, 2), "utf8");
  issues = await lintProject(dir);
  ok("lint: does NOT flag a resource parenting directly to the project (legal)",
    !issues.some(i => i.message.includes("sprLintTarget") && i.message.includes("folder")));

  // --- ProjectTool integration (GameMaker's own official headless validator) ---
  const badRoomPath = path.join(dir, "rooms/rmProjectToolCheck/rmProjectToolCheck.yy");
  if (await findProjectTool()) {
    yyp = await loadYyp(dir);
    yyp = await addRoom(dir, yyp, "rmProjectToolCheck", { width: 200, height: 200, persistent: false });
    await writeYyp(dir, yyp);

    issues = await lintProject(dir);
    ok("lint+ProjectTool: clean project reports no ProjectTool errors",
      !issues.some(i => i.message.includes("ProjectTool") && i.severity === "error"), JSON.stringify(issues.filter(i => i.message.includes("ProjectTool"))));

    // Reintroduce a real bug class: a room missing creationCodeFile
    // entirely (not empty string -- absent).
    const badRoom = JSON.parse(await fs.readFile(badRoomPath, "utf8"));
    delete badRoom.creationCodeFile;
    await fs.writeFile(badRoomPath, JSON.stringify(badRoom, null, 2), "utf8");

    issues = await lintProject(dir);
    ok("lint+ProjectTool: catches a real schema violation our own semantic checks miss",
      issues.some(i => i.severity === "error" && i.message.includes("ProjectTool") && i.message.includes("creationCodeFile")));

    // Restore, so later tests (including the Igor compile check below) run
    // against a genuinely clean project again.
    badRoom.creationCodeFile = "";
    await fs.writeFile(badRoomPath, JSON.stringify(badRoom, null, 2), "utf8");
  } else {
    skip("ProjectTool.exe not found on this machine -- real-GameMaker-validator integration untested here");
  }

  // --- Igor integration (GameMaker's own real compiler -- catches actual GML
  // compile errors, e.g. duplicate function names, that no structural check
  // above can see) ---
  if (await findIgor()) {
    let result = await compileProject(dir);
    ok("compile: clean project compiles successfully", result.success, result.message);

    // Reintroduce a real compile-error class: two functions with the same
    // name in one script.
    const scriptPath = path.join(dir, "scripts/scrTest/scrTest.gml");
    const originalScript = await fs.readFile(scriptPath, "utf8");
    await fs.writeFile(scriptPath, originalScript + "\nfunction scrTest() {\n  return 2;\n}\n", "utf8");

    result = await compileProject(dir);
    ok("compile: catches a real duplicate-function-name compile error",
      !result.success && result.errors.some(e => e.includes("duplicate script name")), result.message);

    // Restore, so this deliberate breakage doesn't affect any test after this.
    await fs.writeFile(scriptPath, originalScript, "utf8");
  } else {
    skip("Igor not found on this machine (no runtime downloaded) -- real-compile integration untested here");
  }

  // --- Notes (best-effort, no real ground truth -- flagged clearly in the code) ---
  yyp = await loadYyp(dir);
  yyp = await addNote(dir, yyp, "noteTest", "Design notes go here.");
  await writeYyp(dir, yyp);
  ok("note: file created on disk", await fileExists(path.join(dir, "notes/noteTest/noteTest.yy")));
  ok("note: content file created", await fileExists(path.join(dir, "notes/noteTest/noteTest.txt")));
  const noteYy = JSON.parse(await fs.readFile(path.join(dir, "notes/noteTest/noteTest.yy"), "utf8"));
  ok("note: resourceType is GMNotes", noteYy.resourceType === "GMNotes");
  ok("note: Notes folder registered", ((yyp as any).Folders ?? []).some((f: any) => f.folderPath === "folders/Notes.yy"));
  const noteContent = await fs.readFile(path.join(dir, "notes/noteTest/noteTest.txt"), "utf8");
  ok("note: content matches", noteContent === "Design notes go here.");
  await expectThrows("addNote: rejects invalid name", () => addNote(dir, yyp, "1BadNote"));

  // --- Regression: notes were previously a second-class resource -- creatable
  // but not deletable/renamable/listable through the generic tools. Confirm
  // all three now work the same as every other resource category. ---
  const notesListed = await (async () => {
    const y = await loadYyp(dir);
    return y.resources.filter((r: any) => r.id?.path?.startsWith("notes/")).map((r: any) => r.id.name);
  })();
  ok("list_resources: notes are listable by kind", notesListed.includes("noteTest"));

  yyp = await loadYyp(dir);
  yyp = await renameResource(dir, yyp, "notes", "noteTest", "noteRenamed");
  await writeYyp(dir, yyp);
  ok("renameResource: works on notes", await fileExists(path.join(dir, "notes/noteRenamed/noteRenamed.yy"))
    && await fileExists(path.join(dir, "notes/noteRenamed/noteRenamed.txt"))
    && !(await fileExists(path.join(dir, "notes/noteTest"))));

  yyp = await deleteResource(dir, yyp, "notes", "noteRenamed");
  await writeYyp(dir, yyp);
  ok("deleteResource: works on notes", !(await fileExists(path.join(dir, "notes/noteRenamed"))));

  // --- Room reordering ---
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmOrderA", { width: 100, height: 100, persistent: false });
  await writeYyp(dir, yyp);
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmOrderB", { width: 100, height: 100, persistent: false });
  await writeYyp(dir, yyp);
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmOrderC", { width: 100, height: 100, persistent: false });
  await writeYyp(dir, yyp);

  yyp = await loadYyp(dir);
  const orderNames = () => ((yyp as any).RoomOrderNodes ?? []).map((n: any) => n.roomId?.name);
  const idxA = orderNames().indexOf("rmOrderA");
  yyp = reorderRoom(yyp, "rmOrderC", 0);
  ok("reorderRoom: moved to the front", orderNames()[0] === "rmOrderC");

  yyp = moveRoomRelativeTo(yyp, "rmOrderA", "rmOrderB", "after");
  const namesAfterMove = orderNames();
  ok("moveRoomRelativeTo: A now comes immediately after B",
    namesAfterMove.indexOf("rmOrderA") === namesAfterMove.indexOf("rmOrderB") + 1, JSON.stringify(namesAfterMove));
  await writeYyp(dir, yyp);

  await expectThrows("reorderRoom: rejects nonexistent room", () => reorderRoom(yyp, "rmDoesNotExist", 0));
  await expectThrows("moveRoomRelativeTo: rejects nonexistent target", () => moveRoomRelativeTo(yyp, "rmOrderA", "rmDoesNotExist", "before"));
  await expectThrows("moveRoomRelativeTo: rejects moving relative to itself", () => moveRoomRelativeTo(yyp, "rmOrderA", "rmOrderA", "before"));

  // --- Ogg Vorbis support: metadata always parsed from the real file, same
  // contract as WAV (the declared-vs-real mismatch crashed GameMaker once) ---
  const oggMeta = await parseOggMetadata(path.join(process.cwd(), "test/fixtures/beep.ogg"));
  ok("ogg: real sample rate parsed from Vorbis id header", oggMeta.sampleRate === 44100, String(oggMeta.sampleRate));
  ok("ogg: real channel count parsed", oggMeta.channels === 1, String(oggMeta.channels));
  ok("ogg: duration derived from final granule position", oggMeta.durationSeconds > 0.2 && oggMeta.durationSeconds < 0.4, String(oggMeta.durationSeconds));

  yyp = await loadYyp(dir);
  yyp = await addSound(dir, yyp, "sndOggTest", path.join(process.cwd(), "test/fixtures/beep.ogg"));
  await writeYyp(dir, yyp);
  const oggYy = JSON.parse(await fs.readFile(path.join(dir, "sounds/sndOggTest/sndOggTest.yy"), "utf8"));
  ok("ogg: compression is 1 (Compressed, per @bscotch/yy's SoundCompression enum)", oggYy.compression === 1);
  ok("ogg: declared sampleRate matches the real file", oggYy.sampleRate === 44100);
  ok("ogg: declared channelFormat matches the real file (mono)", oggYy.channelFormat === 0);
  ok("ogg: audio file copied into the project", await fileExists(path.join(dir, "sounds/sndOggTest/sndOggTest.ogg")));
  ok("ogg: schema keys match the wav sound schema", keysMatchRef(oggYy, REF.sound));

  await expectThrows("ogg: rejects unsupported sample rate (8000Hz)",
    () => addSound(dir, yyp, "sndOggBadRate", path.join(process.cwd(), "test/fixtures/badrate.ogg")));
  await expectThrows("addSound: still rejects .mp3",
    () => addSound(dir, yyp, "sndMp3", "C:/nonexistent/file.mp3"));

  // lint cross-checks ogg metadata the same way it does wav
  const oggYyPath = path.join(dir, "sounds/sndOggTest/sndOggTest.yy");
  const oggTampered = JSON.parse(await fs.readFile(oggYyPath, "utf8"));
  const oggRealRate = oggTampered.sampleRate;
  oggTampered.sampleRate = 22050;
  await fs.writeFile(oggYyPath, JSON.stringify(oggTampered, null, 2), "utf8");
  const oggIssues = await lintProject(dir);
  ok("lint: catches ogg sampleRate mismatch", oggIssues.some(i => i.severity === "error" && i.message.includes("sndOggTest") && i.message.includes("sampleRate")));
  oggTampered.sampleRate = oggRealRate;
  await fs.writeFile(oggYyPath, JSON.stringify(oggTampered, null, 2), "utf8");

  // --- parseGameMakerJson: trailing commas stripped WITHOUT corrupting
  // string values that legitimately contain ",]" or ",}" ---
  const trickyJson = '{\n  "label": "a,]b,}c",\n  "items": [1, 2,],\n}';
  const trickyParsed = parseGameMakerJson(trickyJson);
  ok("parseGameMakerJson: trailing commas stripped", Array.isArray(trickyParsed.items) && trickyParsed.items.length === 2);
  ok("parseGameMakerJson: ',]' inside a string value survives untouched", trickyParsed.label === "a,]b,}c");

  // --- editScript: whitespace-only append gets a clear refusal, not a
  // confusing duplicate-code error ---
  await expectThrows("editScript: refuses whitespace-only append", () => editScript(dir, "scrTest", "   \n  ", "append"));

  // --- collisionTargetName only means something on Collision events ---
  await expectThrows("events: collisionTargetName rejected on a non-collision event",
    () => addObjectEvent(dir, "objTest", { eventType: 3, eventNum: 2, collisionTargetName: "objTest" }));

  // --- loadYyp: a directory with two .yyp files is ambiguous, not pick-first ---
  const twinDir = path.join(os.tmpdir(), `gm-forge-twin-${Date.now()}`);
  await fs.mkdir(twinDir, { recursive: true });
  await fs.writeFile(path.join(twinDir, "one.yyp"), "{}", "utf8");
  await fs.writeFile(path.join(twinDir, "two.yyp"), "{}", "utf8");
  await expectThrows("loadYyp: refuses a directory with two .yyp files", () => loadYyp(twinDir));
  await fs.rm(twinDir, { recursive: true, force: true });

  // --- create_project safety: traversal-shaped and empty project names ---
  await expectThrows("ensureProjectScaffold: rejects a path-traversal project name",
    () => ensureProjectScaffold(twinDir, "../evil"));
  await expectThrows("ensureProjectScaffold: rejects an empty project name",
    () => ensureProjectScaffold(twinDir, ""));

  // --- Tile layer decoding: entirely synthetic data, deliberately NOT drawn
  // from any real project's assets (this is a public repo). The RLE scheme
  // (positive N = next N literal values; negative N = repeat next value N
  // times) was reverse-engineered and confirmed against real GameMaker output
  // before this was written; these fixtures just pin that behavior down. ---
  ok("decompressTileData: literal runs and repeat runs both decode correctly",
    JSON.stringify(decompressTileData([-5, EMPTY_TILE, 2, 5, 5, -2, EMPTY_TILE, 2, 5, 5, -1, EMPTY_TILE]))
      === JSON.stringify([EMPTY_TILE, EMPTY_TILE, EMPTY_TILE, EMPTY_TILE, EMPTY_TILE, 5, 5, EMPTY_TILE, EMPTY_TILE, 5, 5, EMPTY_TILE]));

  yyp = await loadYyp(dir);
  yyp = await addSpriteFromImages(dir, yyp, "sprTileLayerTest", framesDir);
  await writeYyp(dir, yyp);
  yyp = await loadYyp(dir);
  yyp = await addTileset(dir, yyp, "tsTileLayerTest", "sprTileLayerTest", 8, 8);
  await writeYyp(dir, yyp);
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmTileTest", { width: 200, height: 200, persistent: false });
  await writeYyp(dir, yyp);
  const tileRoomPath = path.join(dir, "rooms/rmTileTest/rmTileTest.yy");
  const tileRoom = JSON.parse(await fs.readFile(tileRoomPath, "utf8"));
  tileRoom.layers.push(
    // References a dedicated test tileset (tileWidth/tileHeight = 8x8).
    // gridX/gridY here is deliberately set to a DIFFERENT value (32) than the
    // tileset's real tile size -- if the code wrongly used the layer's own
    // gridX/gridY instead of the tileset's, this test would catch it.
    {
      resourceType: "GMRTileLayer", name: "TilesLinked", "%Name": "TilesLinked",
      tilesetId: { name: "tsTileLayerTest", path: "tilesets/tsTileLayerTest/tsTileLayerTest.yy" },
      x: 0, y: 0, gridX: 32, gridY: 32, depth: 0, layers: [],
      tiles: {
        SerialiseWidth: 4, SerialiseHeight: 3, TileDataFormat: 1,
        TileCompressedData: [-5, EMPTY_TILE, 2, 5, 5, -2, EMPTY_TILE, 2, 5, 5, -1, EMPTY_TILE],
      },
    },
    // No tilesetId at all -- must fall back to the layer's own gridX/gridY.
    {
      resourceType: "GMRTileLayer", name: "TilesNoTileset", "%Name": "TilesNoTileset",
      tilesetId: null,
      x: 0, y: 0, gridX: 8, gridY: 8, depth: 10, layers: [],
      tiles: {
        SerialiseWidth: 2, SerialiseHeight: 2, TileDataFormat: 1,
        TileCompressedData: [4, 9, 9, 9, 9],
      },
    },
  );
  await fs.writeFile(tileRoomPath, JSON.stringify(tileRoom, null, 2), "utf8");

  const tileLayers = await getRoomTileLayers(dir, "rmTileTest");
  const linked = tileLayers.find(l => l.layerName === "TilesLinked")!;
  ok("getRoomTileLayers: tile size comes from the referenced tileset, not the layer's own gridX/gridY",
    linked.tileWidth === 8 && linked.tileHeight === 8);
  ok("getRoomTileLayers: decoded grid dimensions match SerialiseWidth/SerialiseHeight",
    linked.grid.length === 3 && linked.grid[0].length === 4);

  const noTileset = tileLayers.find(l => l.layerName === "TilesNoTileset")!;
  ok("getRoomTileLayers: falls back to the layer's own gridX/gridY when there's no tileset",
    noTileset.tileWidth === 8 && noTileset.tileHeight === 8);

  // Inside the 2x2 solid block (rows 1-2, cols 1-2 in the 4x3 grid) at 8px tiles: world (12,12)
  const inside = findTileRegion(tileLayers, 12, 12);
  const insideLinked = inside.find(r => r.layerName === "TilesLinked")!;
  ok("findTileRegion: query point inside the block is occupied", insideLinked.occupied === true);
  ok("findTileRegion: reports the real tile value", insideLinked.tileValue === 5);
  ok("findTileRegion: bounding box matches the real 2x2 block in world coordinates",
    JSON.stringify(insideLinked.bbox) === JSON.stringify({ x0: 8, y0: 8, x1: 24, y1: 24}),
    JSON.stringify(insideLinked.bbox));
  ok("findTileRegion: tile count matches the flood-filled region size", insideLinked.tileCount === 4);

  // Just outside the block (world 2,2 -> row 0, col 0 -> empty)
  const outside = findTileRegion(tileLayers, 2, 2);
  ok("findTileRegion: query point outside the block is not occupied",
    outside.find(r => r.layerName === "TilesLinked")!.occupied === false);

  const noTilesetRegion = findTileRegion(tileLayers, 4, 4).find(r => r.layerName === "TilesNoTileset")!;
  ok("findTileRegion: fully-solid no-tileset layer reports the whole grid as one region",
    noTilesetRegion.occupied === true && noTilesetRegion.tileCount === 4);

  await expectThrows("getRoomTileLayers: rejects a nonexistent room", () => getRoomTileLayers(dir, "rmDoesNotExist"));

  // --- edit_object (contract 1): sprite/mask/parent, flags, physics, variable
  // definitions. Undefined leaves a field alone, null clears a reference. ---
  const editObjPath = path.join(dir, "objects/objTest/objTest.yy");
  await editObject(dir, "objTest", {
    spriteName: "sprTest",
    spriteMaskName: "sprTest",
    parentObjectName: "objOtherRenamed",
    solid: true,
    visible: false,
    persistent: true,
  });
  const editedObject = JSON.parse(await fs.readFile(editObjPath, "utf8"));
  ok("edit_object: top-level keys still match real GameMaker schema", keysMatchRef(editedObject, REF.object));
  ok("edit_object: sprite resolved to a real {name,path} reference",
    editedObject.spriteId?.name === "sprTest" && editedObject.spriteId?.path === "sprites/sprTest/sprTest.yy",
    JSON.stringify(editedObject.spriteId));
  ok("edit_object: sprite mask resolved to a real {name,path} reference",
    editedObject.spriteMaskId?.name === "sprTest" && editedObject.spriteMaskId?.path === "sprites/sprTest/sprTest.yy");
  ok("edit_object: parent object resolved to a real {name,path} reference",
    editedObject.parentObjectId?.name === "objOtherRenamed"
    && editedObject.parentObjectId?.path === "objects/objOtherRenamed/objOtherRenamed.yy");
  ok("edit_object: solid/visible/persistent applied",
    editedObject.solid === true && editedObject.visible === false && editedObject.persistent === true);

  await editObject(dir, "objTest", {
    physics: {
      enabled: true, density: 0.7, friction: 0.3, restitution: 0.2, collisionGroup: 3,
      kinematic: true, sensor: true, shape: 2, startAwake: false, angularDamping: 0.4, linearDamping: 0.5,
    },
  });
  const physicsObj = JSON.parse(await fs.readFile(editObjPath, "utf8"));
  ok("edit_object: physics writes GameMaker's real physics* keys (friendly names never reach the .yy)",
    physicsObj.physicsObject === true && physicsObj.physicsDensity === 0.7
    && physicsObj.physicsFriction === 0.3 && physicsObj.physicsRestitution === 0.2
    && physicsObj.physicsGroup === 3 && physicsObj.physicsKinematic === true
    && physicsObj.physicsSensor === true && physicsObj.physicsShape === 2
    && physicsObj.physicsStartAwake === false && physicsObj.physicsAngularDamping === 0.4
    && physicsObj.physicsLinearDamping === 0.5);
  ok("edit_object: physics leaves the object's key set unchanged", keysMatchRef(physicsObj, REF.object));

  await expectThrows("edit_object: physics.gravityScale is rejected (a GMObject .yy has no gravity-scale key)",
    () => editObject(dir, "objTest", { physics: { gravityScale: 1 } }));

  await editObject(dir, "objTest", { physics: { enabled: false } });
  const physicsOff = JSON.parse(await fs.readFile(editObjPath, "utf8"));
  ok("edit_object: physics enabled=false restores GameMaker's default physics block",
    physicsOff.physicsObject === false && physicsOff.physicsDensity === 0.5
    && physicsOff.physicsShape === 1 && physicsOff.physicsGroup === 1
    && physicsOff.physicsStartAwake === true && physicsOff.physicsKinematic === false
    && JSON.stringify(physicsOff.physicsShapePoints) === "[]");

  await editObject(dir, "objTest", {
    variableDefinitions: [
      { name: "target_room", value: "rm_lv2", type: "asset" },
      { name: "target_x", value: "-1" },
    ],
  });
  const varDefObj = JSON.parse(await fs.readFile(editObjPath, "utf8"));
  ok("edit_object: variable definition entry keys match real GameMaker schema",
    varDefObj.properties.length === 2 && keysMatchRef(varDefObj.properties[0], REF.objectProperty),
    JSON.stringify(varDefObj.properties[0]));
  ok("edit_object: variable definition type maps to GameMaker's varType (asset=4, default real=0)",
    varDefObj.properties[0].varType === 4 && varDefObj.properties[1].varType === 0
    && varDefObj.properties[1].type === undefined);
  ok("edit_object: variable definition name/value applied",
    varDefObj.properties[0].name === "target_room" && varDefObj.properties[0].value === "rm_lv2"
    && varDefObj.properties[0]["%Name"] === "target_room");

  await editObject(dir, "objTest", {
    spriteName: null, spriteMaskName: null, parentObjectName: null,
    solid: false, visible: true, variableDefinitions: null,
  });
  const clearedObj = JSON.parse(await fs.readFile(editObjPath, "utf8"));
  ok("edit_object: null clears sprite, mask and parent",
    clearedObj.spriteId === null && clearedObj.spriteMaskId === null && clearedObj.parentObjectId === null);
  ok("edit_object: null variableDefinitions empties properties (never a null list)",
    Array.isArray(clearedObj.properties) && clearedObj.properties.length === 0);
  ok("edit_object: flags cleared", clearedObj.solid === false && clearedObj.visible === true);

  // A call where nothing differs must not rewrite the file at all: re-encoding
  // an untouched .yy (key order, float spelling) is not guaranteed to be
  // byte-identical, so a needless write is churn the IDE then has to reread.
  const editObjBytesBefore = await fs.readFile(editObjPath);
  const noOpText = await editObject(dir, "objTest", {
    spriteName: null, spriteMaskName: null, parentObjectName: null,
    solid: false, visible: true, persistent: true,
    physics: { enabled: false },
    variableDefinitions: [],
  });
  const editObjBytesAfter = await fs.readFile(editObjPath);
  ok("edit_object: a call that changes nothing leaves the file byte-identical",
    editObjBytesBefore.equals(editObjBytesAfter), noOpText);

  await expectThrows("edit_object: empty options throw rather than silently doing nothing",
    () => editObject(dir, "objTest", {}));
  try {
    await editObject(dir, "objTest", { spriteName: "sprDoesNotExist" });
    ok("edit_object: missing sprite error names the expected path", false, "expected an error");
  } catch (e: any) {
    ok("edit_object: missing sprite error names the expected path",
      e.message.includes(path.join(dir, "sprites", "sprDoesNotExist", "sprDoesNotExist.yy")), e.message);
  }
  await expectThrows("edit_object: a duplicate variable definition is rejected",
    () => editObject(dir, "objTest", {
      variableDefinitions: [{ name: "dup", value: "1" }, { name: "dup", value: "2" }],
    }));

  // --- add_room_layer (contract 3): every layer kind, defaults, nesting ---
  // rmLayers is 200x200; tsTileLayerTest is an 8x8 tileset, so its tile layer
  // is a 25x25 grid.
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmLayers", { width: 200, height: 200, persistent: false });
  await writeYyp(dir, yyp);
  const layersRoomPath = path.join(dir, "rooms/rmLayers/rmLayers.yy");
  const readLayersRoom = async () => JSON.parse(await fs.readFile(layersRoomPath, "utf8"));

  // addRoom scaffolds Instances (depth 0) + Background (depth 100), so the
  // first defaulted layer lands at 200 and each later one 100 behind that.
  const addedEffect = await addRoomLayer(dir, "rmLayers", "L_Effect", { layerType: "effect" });
  ok("add_room_layer: default depth is 100 behind the room's deepest layer (max 100 -> 200)",
    addedEffect.depth === 200, JSON.stringify(addedEffect));
  ok("add_room_layer: returns roomName/layerName/layerType/depth/elementCount",
    addedEffect.roomName === "rmLayers" && addedEffect.layerName === "L_Effect"
    && addedEffect.layerType === "GMREffectLayer" && addedEffect.elementCount === 0);

  const addedInstance = await addRoomLayer(dir, "rmLayers", "L_Instance", { layerType: "instance" });
  const addedAsset = await addRoomLayer(dir, "rmLayers", "L_Asset", { layerType: "asset", spriteName: "sprTest" });
  const addedTile = await addRoomLayer(dir, "rmLayers", "L_Tile", { layerType: "tile", tilesetName: "tsTileLayerTest" });
  const addedPath = await addRoomLayer(dir, "rmLayers", "L_Path", { layerType: "path" });
  const addedBackground = await addRoomLayer(dir, "rmLayers", "L_Background", { layerType: "background" });
  const addedFolder = await addRoomLayer(dir, "rmLayers", "L_Folder", { layerType: "folder" });
  ok("add_room_layer: successive defaulted depths are 300/400/500/600/700/800",
    addedInstance.depth === 300 && addedAsset.depth === 400 && addedTile.depth === 500
    && addedPath.depth === 600 && addedBackground.depth === 700 && addedFolder.depth === 800,
    [addedInstance, addedAsset, addedTile, addedPath, addedBackground, addedFolder].map(l => l.depth).join(","));

  const childLayer = await addRoomLayer(dir, "rmLayers", "L_FolderChild", {
    layerType: "instance",
    parentLayerName: "L_Folder",
  });
  const layersRoom = await readLayersRoom();
  const byName = (n: string) => layersRoom.layers.find((l: any) => l.name === n);

  ok("add_room_layer: every layer kind's key set matches GameMaker's",
    keysMatchRef(byName("L_Instance"), REF.roomInstanceLayer)
    && keysMatchRef(byName("L_Tile"), REF.roomTileLayer)
    && keysMatchRef(byName("L_Background"), REF.roomBackgroundLayer)
    && keysMatchRef(byName("L_Asset"), REF.roomAssetLayer)
    && keysMatchRef(byName("L_Path"), REF.roomPathLayer)
    && keysMatchRef(byName("L_Effect"), REF.roomEffectLayer)
    && keysMatchRef(byName("L_Folder"), REF.roomFolder),
    ["L_Instance", "L_Tile", "L_Background", "L_Asset", "L_Path", "L_Effect", "L_Folder"]
      .filter(n => !keysMatchRef(byName(n), (REF as any)[({
        L_Instance: "roomInstanceLayer", L_Tile: "roomTileLayer", L_Background: "roomBackgroundLayer",
        L_Asset: "roomAssetLayer", L_Path: "roomPathLayer", L_Effect: "roomEffectLayer", L_Folder: "roomFolder",
      } as any)[n]])).join(","));
  ok("add_room_layer: every layer kind's keys are in GameMaker's alphabetical order",
    ["L_Instance", "L_Tile", "L_Background", "L_Asset", "L_Path", "L_Effect", "L_Folder"]
      .every(n => keysSorted(byName(n))),
    ["L_Instance", "L_Tile", "L_Background", "L_Asset", "L_Path", "L_Effect", "L_Folder"]
      .filter(n => !keysSorted(byName(n))).join(","));
  ok("add_room_layer: layerName is mirrored into name and %Name",
    byName("L_Folder").name === "L_Folder" && byName("L_Folder")["%Name"] === "L_Folder");

  // Tile layers are a grid the size of the ROOM at the TILESET's pitch -- the
  // layer's own gridX/gridY stays at the editor snap grid, not the tile size.
  const tileLayerYy = byName("L_Tile");
  ok("add_room_layer: tile layer cursor is sized by the tileset (200px room / 8px tiles = 25x25)",
    tileLayerYy.tiles.SerialiseWidth === 25 && tileLayerYy.tiles.SerialiseHeight === 25,
    `${tileLayerYy.tiles.SerialiseWidth}x${tileLayerYy.tiles.SerialiseHeight}`);
  const freshTileBuffer = decompressTileData(tileLayerYy.tiles.TileCompressedData);
  ok("add_room_layer: a fresh tile layer is all-empty and references the tileset",
    freshTileBuffer.length === 625 && freshTileBuffer.every(v => v === EMPTY_TILE)
    && tileLayerYy.tilesetId?.name === "tsTileLayerTest"
    && tileLayerYy.tilesetId?.path === "tilesets/tsTileLayerTest/tsTileLayerTest.yy");
  ok("add_room_layer: tile layer's own gridX/gridY stays the editor snap grid, not the tile size",
    tileLayerYy.gridX === 32 && tileLayerYy.gridY === 32);
  ok("add_room_layer: add_room's scaffold and new layers share one 32px snap grid",
    layersRoom.layers.find((l: any) => l.name === "Instances").gridX === 32
    && layersRoom.layers.find((l: any) => l.name === "Background").gridY === 32,
    `scaffold=${layersRoom.layers.find((l: any) => l.name === "Instances").gridX}`);
  ok("add_room_layer: the tile layer's nested tiles object keeps GameMaker's field order",
    JSON.stringify(Object.keys(tileLayerYy.tiles))
      === JSON.stringify(["SerialiseHeight", "SerialiseWidth", "TileCompressedData", "TileDataFormat"]),
    Object.keys(tileLayerYy.tiles).join(","));

  ok("add_room_layer: visible defaults to true",
    byName("L_Instance").visible === true && byName("L_Folder").visible === true);
  ok("add_room_layer: instance layer starts with no instances", byName("L_Instance").instances.length === 0);
  ok("add_room_layer: folder layer starts with no sub-layers and the child is nested inside it",
    byName("L_Folder").layers.length === 1 && byName("L_Folder").layers[0].name === "L_FolderChild"
    && !byName("L_FolderChild"), "child should not also be a top-level layer");
  ok("add_room_layer: nested child depth still defaults to max+100 (900)",
    childLayer.depth === 900 && byName("L_Folder").layers[0].depth === 900, String(childLayer.depth));

  const assetGraphic = byName("L_Asset").assets[0];
  ok("add_room_layer: asset layer holds a sprite graphic bound to the real sprite",
    byName("L_Asset").assets.length === 1 && assetGraphic.spriteId?.name === "sprTest"
    && assetGraphic.spriteId?.path === "sprites/sprTest/sprTest.yy"
    && assetGraphic.resourceType === "GMRSpriteGraphic" && assetGraphic.scaleX === 1);
  ok("add_room_layer: background layer defaults to opaque black, untiled, unstretched",
    byName("L_Background").colour === 4278190080 && byName("L_Background").htiled === false
    && byName("L_Background").vtiled === false && byName("L_Background").spriteId === null);
  ok("add_room_layer: path layer serialises an unselected path as null", byName("L_Path").pathId === null);

  // Listing walks folders and reports the element counts removeRoomLayer uses.
  const layerList = await listRoomLayers(dir, "rmLayers");
  ok("list_room_layers: reports every layer including nested ones",
    layerList.length === 10 && layerList.filter(l => l.name === "L_FolderChild").length === 1, `${layerList.length}`);
  ok("list_room_layers: nested layers carry their folder name",
    layerList.find(l => l.name === "L_FolderChild")?.parentLayerName === "L_Folder");
  ok("list_room_layers: a fresh tile layer reports 0 elements, not 625 empty cells",
    layerList.find(l => l.name === "L_Tile")?.elementCount === 0);
  ok("list_room_layers: depth and type are reported",
    layerList.find(l => l.name === "L_Tile")?.depth === 500
    && layerList.find(l => l.name === "L_Tile")?.type === "GMRTileLayer");
  await expectThrows("list_room_layers: rejects a nonexistent room", () => listRoomLayers(dir, "rmDoesNotExist"));

  await expectThrows("add_room_layer: a duplicate layer name is rejected",
    () => addRoomLayer(dir, "rmLayers", "L_Tile", { layerType: "folder" }));
  await expectThrows("add_room_layer: a tile layer without tilesetName is rejected",
    () => addRoomLayer(dir, "rmLayers", "L_TileNoTileset", { layerType: "tile" }));
  await expectThrows("add_room_layer: an unknown parent layer is rejected",
    () => addRoomLayer(dir, "rmLayers", "L_Orphan", { layerType: "instance", parentLayerName: "L_NoSuchFolder" }));
  await expectThrows("add_room_layer: a non-folder parent is rejected",
    () => addRoomLayer(dir, "rmLayers", "L_Orphan2", { layerType: "instance", parentLayerName: "L_Instance" }));

  // Layer names are free text in GameMaker's room editor, not GML identifiers.
  await addRoomLayer(dir, "rmLayers", "World Reality", { layerType: "folder" });
  await addRoomLayer(dir, "rmLayers", "BG - sky", { layerType: "background", x: 12, y: -4 });
  const namesRoom = await readLayersRoom();
  ok("add_room_layer: free-text layer names with spaces and hyphens are accepted",
    namesRoom.layers.some((l: any) => l.name === "World Reality" && l["%Name"] === "World Reality")
    && namesRoom.layers.some((l: any) => l.name === "BG - sky"));
  const skyLayer = namesRoom.layers.find((l: any) => l.name === "BG - sky");
  ok("add_room_layer: background x/y options are written to the layer", skyLayer.x === 12 && skyLayer.y === -4,
    `x=${skyLayer.x} y=${skyLayer.y}`);
  await expectThrows("add_room_layer: a layer name with a path separator is rejected",
    () => addRoomLayer(dir, "rmLayers", "Tiles/Top", { layerType: "folder" }));
  await expectThrows("add_room_layer: a layer name with a dot is rejected",
    () => addRoomLayer(dir, "rmLayers", "v1.2 sky", { layerType: "folder" }));
  await expectThrows("add_room_layer: a layer name with a colon is rejected",
    () => addRoomLayer(dir, "rmLayers", "Layer:1", { layerType: "folder" }));
  await expectThrows("add_room_layer: an empty layer name is rejected",
    () => addRoomLayer(dir, "rmLayers", "", { layerType: "folder" }));
  await expectThrows("add_room_layer: a layer name over 255 characters is rejected",
    () => addRoomLayer(dir, "rmLayers", "x".repeat(256), { layerType: "folder" }));

  // --- remove_room_layer: empty vs non-empty vs folder, and instanceCreationOrder ---
  await addRoomLayer(dir, "rmLayers", "L_EmptyFolder", { layerType: "folder" });
  const removedEmpty = await removeRoomLayer(dir, "rmLayers", "L_EmptyFolder");
  ok("remove_room_layer: an empty layer is removed without force",
    removedEmpty.removed === true && removedEmpty.layerName === "L_EmptyFolder"
    && !(await readLayersRoom()).layers.some((l: any) => l.name === "L_EmptyFolder"));

  // A folder reports everything nested inside it (what the layer editor's count
  // column shows), while the nested layer is listed separately with its own count.
  await addRoomLayer(dir, "rmLayers", "L_Group", { layerType: "folder" });
  await addRoomLayer(dir, "rmLayers", "L_GroupTiles", { layerType: "tile", tilesetName: "tsTileLayerTest", parentLayerName: "L_Group" });
  await fillRoomTiles(dir, "rmLayers", "L_GroupTiles", { x: 0, y: 0, width: 2, height: 3, index: 2 });
  const grouped = await listRoomLayers(dir, "rmLayers");
  ok("list_room_layers: a folder reports the recursive element count of everything inside it",
    grouped.find(l => l.name === "L_Group")?.elementCount === 6
    && grouped.find(l => l.name === "L_GroupTiles")?.elementCount === 6,
    JSON.stringify(grouped.filter(l => l.name.startsWith("L_Group"))));
  await removeRoomLayer(dir, "rmLayers", "L_Group", { force: true });

  await fillRoomTiles(dir, "rmLayers", "L_Tile", { x: 0, y: 0, width: 2, height: 2, index: 3 });
  try {
    await removeRoomLayer(dir, "rmLayers", "L_Tile");
    ok("remove_room_layer: a non-empty layer is refused without force", false, "expected an error");
  } catch (e: any) {
    ok("remove_room_layer: a non-empty layer is refused without force, stating the element count",
      e.message.includes("4 element(s)"), e.message);
  }
  const removedTiles = await removeRoomLayer(dir, "rmLayers", "L_Tile", { force: true });
  ok("remove_room_layer: force deletes a non-empty layer",
    removedTiles.removed === true && !(await readLayersRoom()).layers.some((l: any) => l.name === "L_Tile"));

  // A forced instance-layer removal deletes its instances, so their
  // instanceCreationOrder entries must go too -- a room listing an instance it
  // can't find is a .yy GameMaker refuses to open.
  const keptInstance = await addRoomInstance(dir, "rmLayers", "objTest", 8, 8);
  const doomedInstance = await addRoomInstance(dir, "rmLayers", "objTest", 24, 24);
  const roomBeforePrune = await readLayersRoom();
  const instanceLayerYy = roomBeforePrune.layers.find((l: any) => l.name === "L_Instance");
  const doomedEntry = roomBeforePrune.layers
    .find((l: any) => l.resourceType === "GMRInstanceLayer")
    .instances.find((i: any) => i.name === doomedInstance.instanceName);
  instanceLayerYy.instances.push(doomedEntry);
  roomBeforePrune.layers
    .find((l: any) => l.resourceType === "GMRInstanceLayer")
    .instances.splice(roomBeforePrune.layers.find((l: any) => l.resourceType === "GMRInstanceLayer").instances.indexOf(doomedEntry), 1);
  await fs.writeFile(layersRoomPath, JSON.stringify(roomBeforePrune, null, 2), "utf8");
  ok("remove_room_layer: fixture instance sits in the layer about to be removed",
    (await readLayersRoom()).layers.find((l: any) => l.name === "L_Instance").instances
      .some((i: any) => i.name === doomedInstance.instanceName));

  await expectThrows("remove_room_layer: a non-empty instance layer is refused without force",
    () => removeRoomLayer(dir, "rmLayers", "L_Instance"));
  await removeRoomLayer(dir, "rmLayers", "L_Instance", { force: true });
  const roomAfterPrune = await readLayersRoom();
  ok("remove_room_layer: forced instance-layer removal prunes its instanceCreationOrder entries",
    !roomAfterPrune.instanceCreationOrder.some((e: any) => e.name === doomedInstance.instanceName),
    JSON.stringify(roomAfterPrune.instanceCreationOrder.map((e: any) => e.name)));
  ok("remove_room_layer: pruning leaves the instances that still exist alone",
    roomAfterPrune.instanceCreationOrder.some((e: any) => e.name === keptInstance.instanceName)
    && roomAfterPrune.layers.some((l: any) => (l.instances ?? []).some((i: any) => i.name === keptInstance.instanceName)));

  try {
    await removeRoomLayer(dir, "rmLayers", "L_Folder");
    ok("remove_room_layer: a folder holding sub-layers is refused without force", false, "expected an error");
  } catch (e: any) {
    ok("remove_room_layer: a folder holding sub-layers is refused without force",
      e.message.includes("1 sub-layer(s)"), e.message);
  }
  await removeRoomLayer(dir, "rmLayers", "L_Folder", { force: true });
  ok("remove_room_layer: force deletes the folder and everything nested in it",
    !(await readLayersRoom()).layers.some((l: any) => l.name === "L_Folder"));
  await expectThrows("remove_room_layer: rejects a nonexistent layer",
    () => removeRoomLayer(dir, "rmLayers", "L_NoSuchLayer"));

  // An asset layer's contents are its `assets` array -- counting only instance
  // and tile layers reported one as empty and deleted its sprite without force.
  await addRoomLayer(dir, "rmLayers", "L_AssetFull", { layerType: "asset", spriteName: "sprTest" });
  const assetWithSprite = await addRoomLayer(dir, "rmLayers", "L_AssetFull2", { layerType: "asset", spriteName: "sprTest" });
  ok("add_room_layer: reports the element count it just created, not a hardcoded 0",
    assetWithSprite.elementCount === 1, JSON.stringify(assetWithSprite));
  ok("add_room_layer: a fresh tile layer reports 0 elements (empty cells are not elements)",
    (await addRoomLayer(dir, "rmLayers", "L_TileEstimate", { layerType: "tile", tilesetName: "tsTileLayerTest" })).elementCount === 0);
  ok("list_room_layers: an asset layer holding a sprite reports 1 element, not 0",
    (await listRoomLayers(dir, "rmLayers")).find(l => l.name === "L_AssetFull")?.elementCount === 1);
  try {
    await removeRoomLayer(dir, "rmLayers", "L_AssetFull");
    ok("remove_room_layer: a sprite-bearing asset layer is refused without force", false, "expected an error");
  } catch (e: any) {
    ok("remove_room_layer: a sprite-bearing asset layer is refused without force",
      e.message.includes("1 element(s)"), e.message);
  }
  ok("remove_room_layer: force deletes the sprite-bearing asset layer",
    (await removeRoomLayer(dir, "rmLayers", "L_AssetFull", { force: true })).removed === true
    && !(await readLayersRoom()).layers.some((l: any) => l.name === "L_AssetFull"));

  // A room must keep at least one layer -- an empty layers array is a room
  // GameMaker refuses to open.
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmLastLayer", { width: 100, height: 100, persistent: false });
  await writeYyp(dir, yyp);
  await removeRoomLayer(dir, "rmLastLayer", "Background");
  ok("remove_room_layer: leaves a room with exactly one layer", (await listRoomLayers(dir, "rmLastLayer")).length === 1);
  try {
    await removeRoomLayer(dir, "rmLastLayer", "Instances");
    ok("remove_room_layer: refuses to remove the room's last top-level layer", false, "expected an error");
  } catch (e: any) {
    ok("remove_room_layer: refuses to remove the room's last top-level layer",
      e.message.includes("last layer") && e.message.includes("at least one layer"), e.message);
  }
  await expectThrows("remove_room_layer: the last-layer refusal cannot be forced through",
    () => removeRoomLayer(dir, "rmLastLayer", "Instances", { force: true }));
  ok("remove_room_layer: the refused last layer is still there",
    (await listRoomLayers(dir, "rmLastLayer")).length === 1);

  // --- set_room_layer: depth + visibility, explicitly no rename ---
  await setRoomLayer(dir, "rmLayers", "L_Path", { depth: 42, visible: false });
  const setPath = (await readLayersRoom()).layers.find((l: any) => l.name === "L_Path");
  ok("set_room_layer: depth and visibility applied", setPath.depth === 42 && setPath.visible === false);
  await setRoomLayer(dir, "rmLayers", "L_Path", { visible: true });
  const reShownPath = (await readLayersRoom()).layers.find((l: any) => l.name === "L_Path");
  ok("set_room_layer: visibility can be turned back on without touching depth",
    reShownPath.visible === true && reShownPath.depth === 42);

  // A call that changes nothing must not rewrite the file (the same rule every
  // other writer here follows).
  const setBytesBefore = await fs.readFile(layersRoomPath);
  const setStatBefore = await fs.stat(layersRoomPath);
  await new Promise(resolve => setTimeout(resolve, 15));
  const unchangedMessage = await setRoomLayer(dir, "rmLayers", "L_Path", { depth: 42, visible: true });
  const setStatAfter = await fs.stat(layersRoomPath);
  ok("set_room_layer: a call that changes nothing reports it instead of claiming an update",
    /unchanged/.test(unchangedMessage), unchangedMessage);
  ok("set_room_layer: a call that changes nothing leaves the file byte-identical and unrewritten",
    setBytesBefore.equals(await fs.readFile(layersRoomPath)) && setStatAfter.mtimeMs === setStatBefore.mtimeMs,
    `mtime ${setStatBefore.mtimeMs} -> ${setStatAfter.mtimeMs}`);

  // Nested layers are reached the same way as top-level ones.
  await addRoomLayer(dir, "rmLayers", "S_Folder", { layerType: "folder" });
  await addRoomLayer(dir, "rmLayers", "S_Child", { layerType: "instance", parentLayerName: "S_Folder" });
  await setRoomLayer(dir, "rmLayers", "S_Child", { depth: 7, visible: false });
  const nestedChild = (await readLayersRoom()).layers
    .find((l: any) => l.name === "S_Folder").layers.find((l: any) => l.name === "S_Child");
  ok("set_room_layer: works on a layer nested inside a folder", nestedChild.depth === 7 && nestedChild.visible === false);

  await expectThrows("set_room_layer: an empty change is rejected",
    () => setRoomLayer(dir, "rmLayers", "L_Path", {}));
  await expectThrows("set_room_layer: rejects a nonexistent layer",
    () => setRoomLayer(dir, "rmLayers", "L_NoSuchLayer", { depth: 1 }));

  // --- get/set/fill_room_tiles (contracts 6-8) ---
  // 200x200 room, 8x8 tileset -> 25x25 cells at an 8px pitch.
  await addRoomLayer(dir, "rmLayers", "L_Tiles", { layerType: "tile", tilesetName: "tsTileLayerTest" });

  const wholeLayer = await getRoomTiles(dir, "rmLayers", "L_Tiles");
  ok("get_room_tiles: omitted rect reads the whole layer (25x25)",
    wholeLayer.width === 25 && wholeLayer.height === 25 && wholeLayer.tiles.length === 25
    && wholeLayer.tiles[0].length === 25);
  ok("get_room_tiles: pitch comes from the tileset (8px), not the layer's 32px snap grid",
    wholeLayer.gridX === 8 && wholeLayer.gridY === 8, `${wholeLayer.gridX}x${wholeLayer.gridY}`);
  ok("get_room_tiles: an empty layer reads as all -1 (EMPTY_TILE translated at the API)",
    wholeLayer.tiles.every(row => row.every(v => v === -1)));
  ok("get_room_tiles: reports the tileset it is bound to", wholeLayer.tilesetName === "tsTileLayerTest");

  const firstWrite = await setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 0, y: 0, index: 5 }]);
  ok("set_room_tiles: reports how many cells changed", firstWrite.updated === 1);
  const afterFirstWrite = await getRoomTiles(dir, "rmLayers", "L_Tiles", { x: 0, y: 0, width: 2, height: 1 });
  ok("set_room_tiles: the written cell reads back as the tile index, its neighbour stays -1",
    afterFirstWrite.tiles[0][0] === 5 && afterFirstWrite.tiles[0][1] === -1);
  const storedTiles = decompressTileData(
    (await readLayersRoom()).layers.find((l: any) => l.name === "L_Tiles").tiles.TileCompressedData);
  ok("set_room_tiles: on disk the empty cells are GameMaker's int32 sentinel, not -1",
    storedTiles[0] === 5 && storedTiles[1] === EMPTY_TILE && storedTiles.length === 625);

  const clearWrite = await setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 0, y: 0, index: -1 }]);
  ok("set_room_tiles: index -1 clears a cell", clearWrite.updated === 1
    && (await getRoomTiles(dir, "rmLayers", "L_Tiles", { x: 0, y: 0, width: 1, height: 1 })).tiles[0][0] === -1);

  try {
    await setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 25, y: 0, index: 1 }]);
    ok("set_room_tiles: out-of-bounds cell error names the layer's bounds", false, "expected an error");
  } catch (e: any) {
    ok("set_room_tiles: out-of-bounds cell error names the layer's bounds",
      e.message.includes("25x25") && e.message.includes("valid x 0-24, y 0-24"), e.message);
  }
  await expectThrows("set_room_tiles: a tile index below -1 is rejected",
    () => setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 0, y: 0, index: -2 }]));
  try {
    await setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 0, y: 0, index: 2147483648 }]);
    ok("set_room_tiles: an index past the int32 slot is rejected, naming the valid range", false, "expected an error");
  } catch (e: any) {
    ok("set_room_tiles: an index past the int32 slot is rejected, naming the valid range",
      e.message.includes("2147483646") && e.message.includes("-1 (empty)"), e.message);
  }
  await expectThrows("set_room_tiles: 2147483647 (the int32 apex) is rejected rather than wrapping",
    () => setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 0, y: 0, index: 2147483647 }]));

  // The referenced tileset is the honest upper bound for a tile index.
  const tileSetYy = JSON.parse(await fs.readFile(path.join(dir, "tilesets/tsTileLayerTest/tsTileLayerTest.yy"), "utf8"));
  const tilesInSet: number = tileSetYy.tile_count;
  try {
    await setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 0, y: 0, index: tilesInSet }]);
    ok("set_room_tiles: an index past the tileset's tile count is rejected, naming the tileset", false, "expected an error");
  } catch (e: any) {
    ok("set_room_tiles: an index past the tileset's tile count is rejected, naming the tileset",
      e.message.includes("tsTileLayerTest") && e.message.includes(`${tilesInSet} tiles`), e.message);
  }
  try {
    await fillRoomTiles(dir, "rmLayers", "L_Tiles", { x: 0, y: 0, width: 1, height: 1, index: tilesInSet });
    ok("fill_room_tiles: the same tileset bound applies to a fill", false, "expected an error");
  } catch (e: any) {
    ok("fill_room_tiles: the same tileset bound applies to a fill",
      e.message.includes("tsTileLayerTest") && e.message.includes(`${tilesInSet} tiles`), e.message);
  }
  ok("set_room_tiles: the tileset's last real tile index is accepted",
    (await setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 0, y: 0, index: tilesInSet - 1 }])).updated === 1);
  await setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 0, y: 0, index: -1 }]);

  const filled = await fillRoomTiles(dir, "rmLayers", "L_Tiles", { x: 2, y: 2, width: 3, height: 2, index: 4 });
  ok("fill_room_tiles: fills the whole rectangle inclusive of its origin cell", filled.updated === 6);
  const filledRect = await getRoomTiles(dir, "rmLayers", "L_Tiles", { x: 2, y: 2, width: 3, height: 2 });
  ok("fill_room_tiles: every cell in the rectangle reads back, the cell just outside does not",
    filledRect.tiles.every(row => row.every(v => v === 4))
    && (await getRoomTiles(dir, "rmLayers", "L_Tiles", { x: 5, y: 2, width: 1, height: 1 })).tiles[0][0] === -1);

  const tilesFileBeforeRepeat = await fs.readFile(layersRoomPath);
  const repeat = await fillRoomTiles(dir, "rmLayers", "L_Tiles", { x: 2, y: 2, width: 3, height: 2, index: 4 });
  const tilesFileAfterRepeat = await fs.readFile(layersRoomPath);
  ok("fill_room_tiles: repeating an identical fill reports 0 updated", repeat.updated === 0, String(repeat.updated));
  ok("fill_room_tiles: repeating an identical fill does not touch the file",
    tilesFileBeforeRepeat.equals(tilesFileAfterRepeat));
  const repeatSet = await setRoomTiles(dir, "rmLayers", "L_Tiles", [{ x: 3, y: 3, index: 4 }]);
  ok("set_room_tiles: re-writing a cell with its current value reports 0 updated and writes nothing",
    repeatSet.updated === 0 && tilesFileBeforeRepeat.equals(await fs.readFile(layersRoomPath)));

  try {
    await fillRoomTiles(dir, "rmLayers", "L_Tiles", { x: 23, y: 0, width: 3, height: 1, index: 1 });
    ok("fill_room_tiles: a rectangle running past the layer is an error, not a silent clip", false, "expected an error");
  } catch (e: any) {
    ok("fill_room_tiles: a rectangle running past the layer is an error, not a silent clip",
      e.message.includes("runs past") && e.message.includes("25x25"), e.message);
  }
  try {
    await getRoomTiles(dir, "rmLayers", "L_Tiles", { x: 24, y: 0, width: 5, height: 1 });
    ok("get_room_tiles: an out-of-bounds rect is an error naming the bounds", false, "expected an error");
  } catch (e: any) {
    ok("get_room_tiles: an out-of-bounds rect is an error naming the bounds",
      e.message.includes("25x25") && e.message.includes("valid x 0-24"), e.message);
  }
  try {
    await getRoomTiles(dir, "rmLayers", "L_Effect");
    ok("get_room_tiles: a non-tile layer is rejected, listing the room's real tile layers", false, "expected an error");
  } catch (e: any) {
    ok("get_room_tiles: a non-tile layer is rejected, listing the room's real tile layers",
      e.message.includes("not a tile layer") && e.message.includes("L_Tiles"), e.message);
  }
  await expectThrows("set_room_tiles: rejects a nonexistent layer",
    () => setRoomTiles(dir, "rmLayers", "L_NoSuchLayer", [{ x: 0, y: 0, index: 1 }]));

  // --- Corrupt tile layers: the compressed stream must cover SerialiseWidth *
  // SerialiseHeight, or a write would silently truncate/pad the grid ---
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmCorrupt", { width: 64, height: 64, persistent: false });
  await writeYyp(dir, yyp);
  await addRoomLayer(dir, "rmCorrupt", "Bad", { layerType: "tile", tilesetName: "tsTileLayerTest" });
  const corruptPath = path.join(dir, "rooms/rmCorrupt/rmCorrupt.yy");
  const corruptRoom = JSON.parse(await fs.readFile(corruptPath, "utf8"));
  const badLayer = corruptRoom.layers.find((l: any) => l.name === "Bad");
  badLayer.tiles.SerialiseWidth = 4;
  badLayer.tiles.SerialiseHeight = 3;
  badLayer.tiles.TileCompressedData = [4, 9, 9, 9, 9]; // 5 values, declares 12 cells
  await fs.writeFile(corruptPath, JSON.stringify(corruptRoom, null, 2), "utf8");
  try {
    await getRoomTiles(dir, "rmCorrupt", "Bad");
    ok("get_room_tiles: a layer whose compressed data doesn't cover its grid is refused", false, "expected an error");
  } catch (e: any) {
    ok("get_room_tiles: a layer whose compressed data doesn't cover its grid is refused",
      e.message.includes("refusing to edit a corrupt layer") && e.message.includes("declares 4x3 = 12 tiles"), e.message);
  }
  await expectThrows("set_room_tiles: refuses to write a corrupt layer rather than re-encode it",
    () => setRoomTiles(dir, "rmCorrupt", "Bad", [{ x: 0, y: 0, index: 1 }]));

  // --- Legacy read path: older GameMaker releases spell a layer folder
  // $GMRFolder. Reading and nesting into one must keep working even though the
  // write path only ever emits $GMRLayer. ---
  yyp = await loadYyp(dir);
  yyp = await addRoom(dir, yyp, "rmLegacy", { width: 64, height: 64, persistent: false });
  await writeYyp(dir, yyp);
  await addRoomLayer(dir, "rmLegacy", "Old Folder", { layerType: "folder" });
  const legacyPath = path.join(dir, "rooms/rmLegacy/rmLegacy.yy");
  const legacyRoom = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const oldFolder = legacyRoom.layers.find((l: any) => l.name === "Old Folder");
  delete oldFolder["$GMRLayer"];
  oldFolder["$GMRFolder"] = "";
  oldFolder.resourceType = "GMRFolder";
  await fs.writeFile(legacyPath, JSON.stringify(legacyRoom, null, 2), "utf8");
  ok("list_room_layers: reads a legacy $GMRFolder folder layer",
    (await listRoomLayers(dir, "rmLegacy")).find(l => l.name === "Old Folder")?.type === "GMRFolder");
  await addRoomLayer(dir, "rmLegacy", "Legacy Child", { layerType: "instance", parentLayerName: "Old Folder" });
  const legacyAfter = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const oldFolderAfter = legacyAfter.layers.find((l: any) => l.name === "Old Folder");
  ok("add_room_layer: nests inside a legacy $GMRFolder folder without rewriting it",
    oldFolderAfter.layers.length === 1 && oldFolderAfter.layers[0].name === "Legacy Child"
    && oldFolderAfter.resourceType === "GMRFolder" && typeof oldFolderAfter["$GMRFolder"] === "string"
    && oldFolderAfter["$GMRLayer"] === undefined,
    JSON.stringify(Object.keys(oldFolderAfter)));
  await addRoomLayer(dir, "rmLegacy", "New Folder", { layerType: "folder" });
  const newFolderYy = JSON.parse(await fs.readFile(legacyPath, "utf8")).layers.find((l: any) => l.name === "New Folder");
  ok("add_room_layer: the write path still emits $GMRLayer for a new folder",
    newFolderYy.resourceType === "GMRLayer" && newFolderYy["$GMRLayer"] === "" && newFolderYy["$GMRFolder"] === undefined);

  // --- encodeTileData: the exact inverse of decompressTileData. Several
  // encodings decode to the same buffer, so only the decode direction is
  // pinned here -- never the exact bytes the encoder picks. ---
  const allEmpty = new Array(700).fill(EMPTY_TILE);
  ok("encodeTileData: all-empty buffer round-trips",
    JSON.stringify(decompressTileData(encodeTileData(allEmpty))) === JSON.stringify(allEmpty));
  ok("encodeTileData: an empty buffer round-trips to an empty buffer",
    JSON.stringify(encodeTileData([])) === JSON.stringify([]));
  ok("encodeTileData: a single cell encodes as one literal run and round-trips",
    JSON.stringify(encodeTileData([7])) === JSON.stringify([1, 7])
    && JSON.stringify(decompressTileData(encodeTileData([7]))) === JSON.stringify([7]));
  ok("encodeTileData: a single empty cell round-trips", 
    JSON.stringify(decompressTileData(encodeTileData([EMPTY_TILE]))) === JSON.stringify([EMPTY_TILE]));
  ok("encodeTileData: an all-empty buffer compresses to one repeat run",
    JSON.stringify(encodeTileData(allEmpty)) === JSON.stringify([-700, EMPTY_TILE]));

  // Deterministic pseudo-random buffer (a fixed LCG, so a failure is
  // reproducible) over a tiny alphabet, which forces both repeat and literal
  // runs.
  let seed = 12345;
  const nextRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const randomTiles: number[] = [];
  for (let i = 0; i < 400; i++) randomTiles.push([EMPTY_TILE, 1, 2, 3][nextRandom() % 4]);
  ok("encodeTileData: a random buffer round-trips",
    JSON.stringify(decompressTileData(encodeTileData(randomTiles))) === JSON.stringify(randomTiles));

  const exactlyMaxRun = new Array(MAX_TILE_RUN).fill(5);
  ok("encodeTileData: a run of exactly MAX_TILE_RUN encodes as a single run",
    JSON.stringify(encodeTileData(exactlyMaxRun)) === JSON.stringify([-MAX_TILE_RUN, 5]));
  ok("encodeTileData: a run of exactly MAX_TILE_RUN round-trips",
    JSON.stringify(decompressTileData(encodeTileData(exactlyMaxRun))) === JSON.stringify(exactlyMaxRun));
  const overMaxRun = new Array(MAX_TILE_RUN + 1).fill(5);
  ok("encodeTileData: one cell past MAX_TILE_RUN is split into two runs",
    JSON.stringify(encodeTileData(overMaxRun)) === JSON.stringify([-MAX_TILE_RUN, 5, 1, 5]));
  ok("encodeTileData: one cell past MAX_TILE_RUN round-trips",
    JSON.stringify(decompressTileData(encodeTileData(overMaxRun))) === JSON.stringify(overMaxRun));

  // Both real tile layers of 261103GJ's rm_lv1 (read-only sample), captured
  // verbatim so the round-trip runs even where the sample project isn't.
  const realRoomTileLayers = [
    {
      name: "world_reality_tiles",
      data: [-36, 81, 1, 41, -9, 42, 1, 43, -20, 0, -2, -2147483648, -2, 81, 1, 49, -9, 50, 1, 51, -20, 0, -2, -2147483648, -2, 81, 1, 49, -9, 50, 1, 51, -20, 0, -2, -2147483648, -2, 81, 1, 57, -9, 58, 1, 59, -20, 0, -2, -2147483648, 1, 81, -32, 0, -2, -2147483648, 1, 81, -32, 0, -2, -2147483648, 1, 81, -32, 0, -2, -2147483648, -2, 81, 1, 73, -19, 74, 1, 75, -10, 0, -2, -2147483648, -2, 81, -8, 90, -2, 82, -12, 90, -9, 0, -2, -2147483648, -2, 81, -31, 0, -2, -2147483648, -2, 81, -31, 0, -2, -2147483648, -2, 81, -24, 0, 1, 73, -6, 74, 1, 75, -3, 81, -24, 0, 1, 81, -7, 82, -3, 81, -24, 0, 1, 81, -7, 82, -3, 81, 1, 73, -23, 74, 1, 81, -7, 82, -3, 81, -32, 82, -3, 81, -9, 82, -7, 90, -16, 82, -3, 81, -15, 90, 1, 82, -16, 90, -37, 81],
    },
    {
      name: "world_dream_tiles",
      data: [-2, 18, 1, 10, -30, 18, 16, 10, 18, 18, 10, 18, 18, 10, 18, 18, 10, 18, 18, 10, 18, 18, 27, -18, 25, -6, 18, 3, 10, 18, 10, -6, 18, 1, 27, -18, 0, 8, 25, 18, 10, 19, 18, 10, 18, 10, -3, 18, 5, 10, 18, 10, 18, 19, -20, 0, 4, 17, 19, 19, 27, -3, 25, 1, 10, -6, 25, 1, 27, -20, 0, 3, 17, 10, 19, -26, 0, 9, 9, 10, 10, 11, 0, 0, 17, 19, 19, -25, 0, 10, 9, 18, 11, 18, 18, 27, 0, 17, 19, 19, -25, 0, 1, 25, -4, 26, -2, 0, 3, 17, 19, 19, -22, 10, -10, 0, 3, 17, 19, 10, -7, 26, 1, 10, -14, 26, 1, 10, -9, 0, 1, 17, -3, 19, -31, 0, 1, 17, -3, 19, -31, 0, 4, 17, 19, 19, 10, -24, 0, -7, 10, 1, 18, -3, 19, -24, 0, 2, 17, 18, -5, 26, -3, 18, 1, 19, -24, 0, 1, 17, -7, 18, 3, 10, 18, 18, -21, 11, 3, 9, 10, 10, -5, 18, 1, 10, -8, 18, 1, 10, -19, 18, 4, 26, 18, 18, 10, -8, 18, 1, 10, -11, 18, -4, 25, 6, 18, 25, 25, 18, 10, 10, -10, 18, 3, 11, 17, 10, -4, 18, 3, 10, 18, 18, -4, 10, 9, 18, 11, 9, 11, 18, 18, 11, 9, 10, -12, 18, 1, 11, -4, 18, 1, 10, -31, 18],
    },
  ];
  for (const layer of realRoomTileLayers) {
    const flat = decompressTileData(layer.data);
    ok(`encodeTileData: real rm_lv1 layer "${layer.name}" decodes to 35x20 = 700 cells`,
      flat.length === 700, String(flat.length));
    ok(`encodeTileData: real rm_lv1 layer "${layer.name}" survives a decode/encode/decode round-trip`,
      JSON.stringify(decompressTileData(encodeTileData(flat))) === JSON.stringify(flat));
  }
  const realRoomPath = "E:\\GMprojects\\261103GJ\\rooms\\rm_lv1\\rm_lv1.yy";
  if (await fileExists(realRoomPath)) {
    const realRoom = parseGameMakerJson(await fs.readFile(realRoomPath, "utf8"));
    const liveTileLayers = realRoom.layers.filter((l: any) => l.resourceType === "GMRTileLayer");
    ok("encodeTileData: the captured rm_lv1 arrays still match that real room's two tile layers",
      liveTileLayers.length === 2
      && JSON.stringify(liveTileLayers.map((l: any) => l.tiles.TileCompressedData))
        === JSON.stringify(realRoomTileLayers.map(l => l.data)));

    // The same two modules read against a real project room (read-only): the
    // strong check that the layer walk and the tileset pitch work on files
    // GameMaker itself wrote.
    const realProjectDir = "E:\\GMprojects\\261103GJ";
    const realLayers = await listRoomLayers(realProjectDir, "rm_lv1");
    ok("list_room_layers: reads a real GameMaker room's layers, both tile layers included",
      JSON.stringify(realLayers.filter(l => l.type === "GMRTileLayer").map(l => l.name))
        === JSON.stringify(["world_reality_tiles", "world_dream_tiles"]),
      realLayers.map(l => `${l.name}:${l.type}`).join(", "));
    ok("list_room_layers: a real tile layer's element count is non-zero, its neighbour's layers unaffected",
      (realLayers.find(l => l.name === "world_reality_tiles")?.elementCount ?? 0) > 0
      && realLayers.find(l => l.name === "Instances")?.elementCount === realRoom.layers[0].instances.length);
    const realTiles = await getRoomTiles(realProjectDir, "rm_lv1", "world_reality_tiles");
    ok("get_room_tiles: a real rm_lv1 tile layer reads as 35x20 cells at the tileset's 32px pitch",
      realTiles.width === 35 && realTiles.height === 20 && realTiles.gridX === 32 && realTiles.gridY === 32
      && realTiles.tiles.length === 20 && realTiles.tiles[0].length === 35,
      `${realTiles.width}x${realTiles.height} @ ${realTiles.gridX}`);
  } else {
    skip("encodeTileData: live rm_lv1 comparison (sample project not present on this machine)");
    skip("list_room_layers/get_room_tiles: real rm_lv1 room (sample project not present on this machine)");
  }

  // --- Tool registry. src/index.ts is imported for the real tool list and the
  // real schemas (it only connects a transport when it is the process entry
  // point); the dispatch switch is still asserted as source text, so a
  // commented-out case cannot pass the check. ---
  const indexSource = await fs.readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");
  const readmeSource = await fs.readFile(path.join(process.cwd(), "README.md"), "utf8");
  const newToolNames = ["edit_object", "list_room_layers", "add_room_layer", "remove_room_layer",
    "set_room_layer", "get_room_tiles", "set_room_tiles", "fill_room_tiles"];
  for (const name of newToolNames) {
    ok(`registry: ${name} is in TOOL_DEFS`, TOOL_DEFS.some(d => d.name === name));
    ok(`registry: ${name} has a live dispatchTool case`, indexSource.includes(`case "${name}":`));
  }
  ok("registry: TOOL_DEFS declares exactly 76 tools (68 existing + 6 sprite-frame + 2 read-only sequences/timelines)", TOOL_DEFS.length === 76, String(TOOL_DEFS.length));
  const declaredTools = (indexSource.match(/^  \{ name: "/gm) ?? []).length;
  ok("registry: the source registers exactly 76 TOOL_DEFS entries", declaredTools === 76, String(declaredTools));
  const dispatchCases = (indexSource.match(/^\s*case "[A-Za-z_]+":/gm) ?? []).length;
  ok("registry: dispatchTool has exactly 76 uncommented cases", dispatchCases === 76, String(dispatchCases));
  ok("registry: all 8 new tools are documented in README.md",
    newToolNames.every(n => readmeSource.includes(`\`${n}\``)),
    newToolNames.filter(n => !readmeSource.includes(`\`${n}\``)).join(","));

  // gravityScale must fail where an MCP client meets it: the zod schema, not
  // only the module's runtime check.
  const gravityParsed = EditObjectSchema.safeParse({ projectDir: dir, objectName: "objTest", physics: { gravityScale: 1 } });
  ok("registry: physics.gravityScale is rejected by the tool schema itself, not just the module",
    !gravityParsed.success && /gravityScale cannot be stored/.test(gravityParsed.error?.issues[0]?.message ?? ""),
    gravityParsed.success ? "schema accepted gravityScale" : gravityParsed.error?.issues[0]?.message);
  ok("registry: physics without gravityScale still parses",
    EditObjectSchema.safeParse({ projectDir: dir, objectName: "objTest", physics: { density: 1 } }).success);
  const physicsSchemaSource = indexSource.slice(
    indexSource.indexOf("const ObjectPhysicsSchema"), indexSource.indexOf("const VariableDefinitionSchema"));
  ok("registry: gravityScale stays documented as unsupported in the schema",
    /gravityScale: z[\s\S]{0,400}NOT SUPPORTED/.test(physicsSchemaSource));
  const varDefSchemaSource = indexSource.slice(
    indexSource.indexOf("const VariableDefinitionSchema"), indexSource.indexOf("const EditObjectSchema"));
  ok("registry: variableDefinitions.type is limited to real|asset (the only verified varType encodings)",
    /\.enum\(\["real", "asset"\]\)/.test(varDefSchemaSource));

  // ===== Safety foundation (subproject E: snapshots, read_file/patch_file,
  // undo, atomic writes and the one dispatch-level snapshot hook) =====
  const textOf = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("\n");

  const safetyDir = await makeBareProject();
  let safetyYyp = await loadYyp(safetyDir);
  safetyYyp = await addRoom(safetyDir, safetyYyp, "rmA", { width: 320, height: 240, persistent: false });
  await writeYyp(safetyDir, safetyYyp);
  const roomYyPath = path.join(safetyDir, "rooms/rmA/rmA.yy");
  const roomYyBefore = await fs.readFile(roomYyPath);

  // --- create_snapshot / list_snapshots ---
  const firstSnapText = textOf(await callTool("create_snapshot", { projectDir: safetyDir }));
  const firstSnap = JSON.parse(firstSnapText);
  ok("create_snapshot: returns a dated id, a path inside .gm-forge/backups and a file count",
    /^\d{8}-\d{6}-[a-f0-9]{6}$/.test(firstSnap.snapshotId)
    && firstSnap.path.startsWith(path.join(safetyDir, ".gm-forge", "backups")) && firstSnap.fileCount > 0,
    firstSnapText);
  ok("create_snapshot: copies every included project file and skips nothing in a small project",
    firstSnap.copied === firstSnap.fileCount && firstSnap.skipped.length === 0);
  const firstManifest = await readManifest(safetyDir, firstSnap.snapshotId);
  ok("create_snapshot: an omitted reason is stored as null and the tool name is recorded",
    firstManifest.reason === null && firstManifest.tool === "create_snapshot");
  ok("create_snapshot: an explicit snapshot records no touched files, so undo_last never picks it",
    firstManifest.touched.length === 0);
  await expectThrows("create_snapshot: a directory that does not exist is an error, not an empty snapshot",
    () => createSnapshot(path.join(safetyDir, "no-such-dir"), {}));

  const listed = await listSnapshots(safetyDir);
  ok("list_snapshots: reports the snapshot with keep = 20 and a logical totalBytes",
    listed.snapshots.length === 1 && listed.keep === 20 && listed.totalBytes === firstSnap.totalBytes,
    JSON.stringify(listed));
  ok("list_snapshots: works with only projectDir (no other argument required)",
    JSON.parse(textOf(await callTool("list_snapshots", { projectDir: safetyDir }))).snapshots.length === 1);

  const corruptId = "20260101-000000-abcdef";
  const corruptDir = path.join(safetyDir, ".gm-forge", "backups", corruptId);
  await fs.mkdir(corruptDir, { recursive: true });
  await fs.writeFile(path.join(corruptDir, "manifest.json"), "{ this is not json", "utf8");
  const withCorrupt = await listSnapshots(safetyDir);
  ok("list_snapshots: a corrupt manifest is reported inline instead of failing the whole listing",
    withCorrupt.snapshots.some((s: any) => s.snapshotId === corruptId && s.corrupt === true)
    && withCorrupt.snapshots.some((s: any) => s.snapshotId === firstSnap.snapshotId && !(s as any).corrupt));
  await fs.rm(corruptDir, { recursive: true, force: true });

  // --- read_file: line numbering is part of the contract ---
  const probePath = path.join(safetyDir, "notes", "probe.txt");
  await fs.mkdir(path.dirname(probePath), { recursive: true });
  await fs.writeFile(probePath, ["alpha", "bravo", "charlie", "delta", "echo"].join("\n") + "\n", "utf8");
  const wholeRead = await readFile(safetyDir, "notes/probe.txt");
  ok("read_file: numbers every line from 1 with \": \" and reports from/to/totalLines",
    wholeRead.text === "1: alpha\n2: bravo\n3: charlie\n4: delta\n5: echo"
    && wholeRead.from === 1 && wholeRead.to === 5 && wholeRead.totalLines === 5 && !wholeRead.truncated,
    wholeRead.text);
  const pagedRead = await readFile(safetyDir, "notes/probe.txt", { offset: 2, limit: 2 });
  ok("read_file: offset/limit page lines and set truncated when the page stops short",
    pagedRead.text === "2: bravo\n3: charlie" && pagedRead.from === 2 && pagedRead.to === 3
    && pagedRead.truncated === true);
  const pastEndRead = await readFile(safetyDir, "notes/probe.txt", { offset: 99, limit: 10 });
  ok("read_file: an offset past the end returns an empty page rather than throwing",
    pastEndRead.text === "" && pastEndRead.from === 6 && pastEndRead.to === 5);
  ok("read_file: a manifest inside the store is readable (writes there are what is refused)",
    (await readFile(safetyDir, `.gm-forge/backups/${firstSnap.snapshotId}/manifest.json`)).text.startsWith("1: {"));

  // --- read_file / patch_file containment: realpath, never ".." stripping ---
  await expectThrows("read_file: refuses ../ traversal", () => readFile(safetyDir, "../escape.txt"));
  await expectThrows("read_file: refuses an absolute path", () => readFile(safetyDir, path.join(safetyDir, "notes/probe.txt")));
  await expectThrows("read_file: refuses a drive-letter path", () => readFile(safetyDir, "C:\\Windows\\win.ini"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-mcp-outside-"));
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside\n", "utf8");
  let junctionMade = false;
  try {
    await fs.symlink(outsideDir, path.join(safetyDir, "escape"), "junction");
    junctionMade = true;
  } catch {
    junctionMade = false;
  }
  if (junctionMade) {
    try {
      await readFile(safetyDir, "escape/secret.txt");
      ok("read_file: refuses a junction inside the project that points outside it", false, "the read succeeded");
    } catch (e: any) {
      ok("read_file: refuses a junction inside the project that points outside it",
        e.message.includes(outsideDir), e.message);
    }
    const junctionSnap = await createSnapshot(safetyDir, {});
    ok("snapshot: a junction is skipped, never followed, so the walk cannot leave the project",
      junctionSnap.skipped.some((s) => s.path === "escape" && s.reason === "symlink"));
    await fs.unlink(path.join(safetyDir, "escape"));
  } else {
    skip("read_file: junction escape (this machine cannot create one without elevation)");
    skip("snapshot: junction skipped, not followed");
  }
  await fs.rm(outsideDir, { recursive: true, force: true });

  const binaryPath = path.join(safetyDir, "notes", "binary.bin");
  await fs.writeFile(binaryPath, Buffer.from([0x41, 0x00, 0x42, 0x43]));
  try {
    await readFile(safetyDir, "notes/binary.bin");
    ok("read_file: refuses a binary file and names the NUL offset", false, "the read succeeded");
  } catch (e: any) {
    ok("read_file: refuses a binary file and names the NUL offset",
      e.message.includes("NUL byte at offset 1") && e.message.includes("UTF-16"), e.message);
  }
  await fs.rm(binaryPath, { force: true });

  const bigPath = path.join(safetyDir, "notes", "big.txt");
  await fs.writeFile(bigPath, "x".repeat(READ_MAX_BYTES + 1), "utf8");
  try {
    await readFile(safetyDir, "notes/big.txt");
    ok("read_file: refuses a file over the 2 MiB cap and points at an editor", false, "the read succeeded");
  } catch (e: any) {
    ok("read_file: refuses a file over the 2 MiB cap and points at an editor",
      e.message.includes(String(READ_MAX_BYTES + 1)) && e.message.includes("2 MiB"), e.message);
  }
  await fs.rm(bigPath, { force: true });
  await expectThrows("read_file: refuses a directory", () => readFile(safetyDir, "rooms"));
  await expectThrows("read_file: refuses a path that does not exist", () => readFile(safetyDir, "notes/none.txt"));

  // --- patch_file ---
  const patchPath = path.join(safetyDir, "notes", "patch.txt");
  await fs.writeFile(patchPath, "one\nneedle here\nthree\n", "utf8");
  const patched = await patchFile(safetyDir, "notes/patch.txt", { find: "needle", replace: "thread" });
  ok("patch_file: an exact single match is replaced and the rest of the file is byte-identical",
    (await fs.readFile(patchPath, "utf8")) === "one\nthread here\nthree\n"
    && patched.replacements === 1 && patched.linesChanged === 1, JSON.stringify(patched));
  ok("patch_file: creates its own snapshot before writing",
    typeof patched.snapshotId === "string" && /^\d{8}-\d{6}-[a-f0-9]{6}$/.test(patched.snapshotId!));
  const changesAfterPatch = await listChanges(safetyDir);
  ok("list_changes: reports exactly the patched file as modified against the snapshot it just took",
    changesAfterPatch.files.length === 1
    && changesAfterPatch.files[0].path === "notes/patch.txt"
    && changesAfterPatch.files[0].status === "modified", JSON.stringify(changesAfterPatch.files));

  const twoMatchText = "zero\nneedle one\nneedle two\n";
  await fs.writeFile(patchPath, twoMatchText, "utf8");
  try {
    await patchFile(safetyDir, "notes/patch.txt", { find: "needle", replace: "thread" });
    ok("patch_file: two matches in exact mode fail before writing, naming the count and line numbers", false, "it wrote");
  } catch (e: any) {
    ok("patch_file: two matches in exact mode fail before writing, naming the count and line numbers",
      e.message.includes("occurs 2 times") && e.message.includes("lines 2, 3"), e.message);
  }
  ok("patch_file: the failed 2-match call left the file byte-identical",
    (await fs.readFile(patchPath, "utf8")) === twoMatchText);
  try {
    await patchFile(safetyDir, "notes/patch.txt", { find: "absent", replace: "x" });
    ok("patch_file: zero matches fail before writing and say 0 matches", false, "it wrote");
  } catch (e: any) {
    ok("patch_file: zero matches fail before writing and say 0 matches", e.message.includes("0 matches"), e.message);
  }
  ok("patch_file: the failed 0-match call left the file byte-identical",
    (await fs.readFile(patchPath, "utf8")) === twoMatchText);

  const allApplied = await patchFile(safetyDir, "notes/patch.txt", { find: "needle", replace: "thread", count: "all" });
  ok("patch_file: count \"all\" replaces every occurrence and reports the total",
    allApplied.replacements === 2 && (await fs.readFile(patchPath, "utf8")) === "zero\nthread one\nthread two\n");

  const crlfPath = path.join(safetyDir, "notes", "crlf.txt");
  await fs.writeFile(crlfPath, "a\r\nneedle\r\nb\r\n", "utf8");
  await patchFile(safetyDir, "notes/crlf.txt", { find: "needle", replace: "two\nlines" });
  ok("patch_file: CRLF line endings are preserved and a multi-line replacement adopts them",
    (await fs.readFile(crlfPath, "utf8")) === "a\r\ntwo\r\nlines\r\nb\r\n");
  await fs.rm(crlfPath, { force: true });

  const literalPath = path.join(safetyDir, "notes", "literal.txt");
  await fs.writeFile(literalPath, "a.b.c\n", "utf8");
  const literal = await patchFile(safetyDir, "notes/literal.txt", { find: ".", replace: "-", count: "all" });
  ok("patch_file: find is literal text -- \".\" replaces the two dots, not every character",
    literal.replacements === 2 && (await fs.readFile(literalPath, "utf8")) === "a-b-c\n");
  await fs.rm(literalPath, { force: true });

  await expectThrows("patch_file: a missing target is an error and is never created",
    () => patchFile(safetyDir, "notes/never.txt", { find: "x", replace: "y" }));
  ok("patch_file: the refused missing target did not appear on disk",
    !(await fileExists(path.join(safetyDir, "notes/never.txt"))));
  await expectThrows("patch_file: refuses writing into the snapshot store",
    () => patchFile(safetyDir, `.gm-forge/backups/${firstSnap.snapshotId}/manifest.json`, { find: "{", replace: "{" }));
  await expectThrows("patch_file: an empty find is an error",
    () => patchFile(safetyDir, "notes/patch.txt", { find: "", replace: "x" }));

  // --- list_changes ---
  const freshDir = await makeBareProject();
  const noSnapChanges = await listChanges(freshDir);
  ok("list_changes: a project with no snapshots returns a null id and no files, not an error",
    noSnapChanges.snapshotId === null && noSnapChanges.files.length === 0);
  const cleanSnap = await createSnapshot(freshDir, {});
  const cleanChanges = await listChanges(freshDir);
  ok("list_changes: an untouched project reports no changes against its newest snapshot",
    cleanChanges.snapshotId === cleanSnap.snapshotId && cleanChanges.files.length === 0 && cleanChanges.unchangedCount > 0,
    JSON.stringify(cleanChanges));
  await fs.writeFile(path.join(freshDir, "added.txt"), "new\n", "utf8");
  const addedChanges = await listChanges(freshDir);
  ok("list_changes: a new file is reported as added",
    addedChanges.files.some((f) => f.path === "added.txt" && f.status === "added"));
  await fs.rm(path.join(freshDir, "added.txt"), { force: true });
  await fs.rm(path.join(freshDir, "TestProj.yyp"), { force: true });
  const deletedChanges = await listChanges(freshDir);
  ok("list_changes: a file that is gone but recorded in the snapshot is reported as deleted",
    deletedChanges.files.some((f) => f.path === "TestProj.yyp" && f.status === "deleted"));
  await fs.writeFile(path.join(freshDir, "TestProj.yyp"), "{}\n", "utf8");
  const bigUntracked = path.join(freshDir, "huge.bin");
  await fs.writeFile(bigUntracked, Buffer.alloc(SNAPSHOT_MAX_FILE_BYTES + 1024));
  const untrackedChanges = await listChanges(freshDir);
  ok("list_changes: counts the over-cap files a snapshot would skip, so they are not silently missing",
    untrackedChanges.untrackedCount === 1, String(untrackedChanges.untrackedCount));
  await fs.rm(bigUntracked, { force: true });

  await fs.mkdir(path.join(freshDir, ".git"), { recursive: true });
  await fs.writeFile(path.join(freshDir, ".git", "config"), "[core]\n", "utf8");
  await fs.mkdir(path.join(freshDir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(freshDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
  await fs.mkdir(path.join(freshDir, "dist"), { recursive: true });
  await fs.writeFile(path.join(freshDir, "dist", "bundle.js"), "x\n", "utf8");
  await fs.writeFile(path.join(freshDir, "probe.tmp-deadbeef"), "half-written\n", "utf8");
  const exclusionSnap = await createSnapshot(freshDir, { reason: "exclusions" });
  const recordedPaths = (await readManifest(freshDir, exclusionSnap.snapshotId!)).files.map((f) => f.path);
  ok("create_snapshot: .git, node_modules, dist, the .gm-forge store and an interrupted *.tmp-* file are all excluded",
    !recordedPaths.some((p) => p.startsWith(".git/") || p.startsWith("node_modules/") || p.startsWith("dist/")
      || p.startsWith(".gm-forge/") || p.includes(".tmp-")),
    recordedPaths.join(","));

  // --- restore_snapshot ---
  await addRoomLayer(safetyDir, "rmA", "L_Extra", { layerType: "folder" });
  ok("restore_snapshot setup: the layer mutation really changed the room .yy",
    !(await fs.readFile(roomYyPath)).equals(roomYyBefore));
  const restoredSubset = await restoreSnapshot(safetyDir, { snapshotId: firstSnap.snapshotId, files: ["rooms/rmA/rmA.yy"] });
  ok("restore_snapshot: a single-file subset restores exactly the requested path",
    restoredSubset.restored.length === 1 && restoredSubset.restored[0] === "rooms/rmA/rmA.yy"
    && restoredSubset.lockCleared === true, JSON.stringify(restoredSubset.restored));
  ok("restore_snapshot: the restored room .yy is byte-identical to the pre-mutation file",
    (await fs.readFile(roomYyPath)).equals(roomYyBefore));
  const wholeRestore = await restoreSnapshot(safetyDir, { snapshotId: firstSnap.snapshotId });
  ok("restore_snapshot: no files list restores the whole snapshot, and files created after it are left alone",
    wholeRestore.restored.length === firstSnap.fileCount && await fileExists(probePath),
    JSON.stringify(wholeRestore.restored));
  await expectThrows("restore_snapshot: an unknown path fails the whole call, restoring nothing",
    () => restoreSnapshot(safetyDir, { snapshotId: firstSnap.snapshotId, files: ["rooms/rmA/rmA.yy", "nope.yy"] }));

  const corruptSnap = await createSnapshot(safetyDir, { reason: "corrupt me" });
  const corruptedStored = path.join(safetyDir, ".gm-forge", "backups", corruptSnap.snapshotId, "files", "rooms", "rmA", "rmA.yy");
  const roomBeforeCorruptRestore = await fs.readFile(roomYyPath);
  await fs.writeFile(corruptedStored, "tampered\n", "utf8");
  try {
    await restoreSnapshot(safetyDir, { snapshotId: corruptSnap.snapshotId, files: ["rooms/rmA/rmA.yy"] });
    ok("restore_snapshot: a stored file that does not match its sha256 is refused", false, "it restored");
  } catch (e: any) {
    ok("restore_snapshot: a stored file that does not match its sha256 is refused",
      e.message.includes("corrupted") && e.message.includes("Nothing was restored"), e.message);
  }
  ok("restore_snapshot: the refused corrupted restore left the live room .yy intact",
    (await fs.readFile(roomYyPath)).equals(roomBeforeCorruptRestore));
  await deleteSnapshot(safetyDir, corruptSnap.snapshotId);

  const lockPath = path.join(safetyDir, ".gm-forge", "lock");
  await fs.writeFile(lockPath, JSON.stringify({ pid: 4242, startedAt: new Date().toISOString() }), "utf8");
  try {
    await restoreSnapshot(safetyDir, { snapshotId: firstSnap.snapshotId });
    ok("restore_snapshot: refuses while a restore lock exists, naming the file and pid", false, "it restored");
  } catch (e: any) {
    ok("restore_snapshot: refuses while a restore lock exists, naming the file and pid",
      e.message.includes("lock") && e.message.includes("pid 4242")
      && e.message.includes("never removed automatically"), e.message);
  }
  ok("restore_snapshot: the refusal did not auto-delete the lock", await fileExists(lockPath));
  await expectThrows("create_snapshot: also refuses while the restore lock exists", () => createSnapshot(safetyDir, {}));
  await fs.rm(lockPath, { force: true });

  // --- delete_snapshot ---
  const throwaway = await createSnapshot(safetyDir, { reason: "throwaway" });
  const deletedSnap = await deleteSnapshot(safetyDir, throwaway.snapshotId);
  ok("delete_snapshot: removes the snapshot directory and reports the logical bytes",
    deletedSnap.deleted === true && deletedSnap.freedBytes === throwaway.totalBytes
    && !(await fileExists(path.join(safetyDir, ".gm-forge", "backups", throwaway.snapshotId))));
  await expectThrows("delete_snapshot: refuses an id of the wrong shape",
    () => deleteSnapshot(safetyDir, "../.."));

  // --- the auto-snapshot hook, through the real dispatch path ---
  const undoDir = await makeBareProject();
  let undoYyp = await loadYyp(undoDir);
  undoYyp = await addRoom(undoDir, undoYyp, "rmUndo", { width: 320, height: 240, persistent: false });
  await writeYyp(undoDir, undoYyp);
  const undoRoomPath = path.join(undoDir, "rooms/rmUndo/rmUndo.yy");
  const undoRoomBefore = await fs.readFile(undoRoomPath);
  await createSnapshot(undoDir, { reason: "before the layer removal" });

  const removeText = textOf(await callTool("remove_room_layer", { projectDir: undoDir, roomName: "rmUndo", layerName: "Background" }));
  ok("auto-snapshot hook: a destructive tool through the dispatched path created exactly one snapshot",
    (await listSnapshots(undoDir)).snapshots.length === 2, removeText);
  const autoSnap = (await listSnapshots(undoDir)).snapshots[0] as any;
  ok("auto-snapshot hook: the snapshot is attributed to the tool with an \"auto:\" reason",
    autoSnap.tool === "remove_room_layer" && autoSnap.reason === "auto: remove_room_layer",
    JSON.stringify(autoSnap));
  await expectThrows("delete_snapshot: refuses the snapshot undo_last would currently restore",
    () => deleteSnapshot(undoDir, autoSnap.snapshotId));

  const beforeReadOnly = (await listSnapshots(undoDir)).snapshots.length;
  await callTool("list_resources", { projectDir: undoDir });
  await callTool("list_changes", { projectDir: undoDir });
  ok("auto-snapshot hook: read-only tools create no snapshot at all",
    (await listSnapshots(undoDir)).snapshots.length === beforeReadOnly);
  const missingDir = path.join(os.tmpdir(), `gm-mcp-missing-${process.pid}-${Date.now()}`);
  const missingText = textOf(await callTool("delete_resource", { projectDir: missingDir, category: "objects", resourceName: "objX" }));
  ok("auto-snapshot hook: a projectDir that does not exist passes through, so the handler's own error text is unchanged",
    missingText.startsWith("Error:") && !missingText.includes("Cannot snapshot"), missingText);
  ok("auto-snapshot hook: the pass-through created no store at the missing path",
    !(await fileExists(path.join(missingDir, ".gm-forge"))));
  ok("auto-snapshot hook: every declared auto-snapshot tool is a registered tool, and patch_file/undo_last are not members",
    [...AUTO_SNAPSHOT_TOOLS].every((n) => TOOL_DEFS.some((d) => d.name === n))
    && !AUTO_SNAPSHOT_TOOLS.has("patch_file") && !AUTO_SNAPSHOT_TOOLS.has("undo_last")
    && !AUTO_SNAPSHOT_TOOLS.has("create_snapshot") && !AUTO_SNAPSHOT_TOOLS.has("restore_snapshot"),
    [...AUTO_SNAPSHOT_TOOLS].filter((n) => !TOOL_DEFS.some((d) => d.name === n)).join(","));

  const undoResult = await undoLast(undoDir);
  ok("undo_last: reverts the files the last operation touched and names the snapshot it undid",
    undoResult.restored.includes("rooms/rmUndo/rmUndo.yy") && undoResult.snapshotId === autoSnap.snapshotId,
    JSON.stringify(undoResult));
  ok("undo_last: the room .yy is byte-identical to before the removal",
    (await fs.readFile(undoRoomPath)).equals(undoRoomBefore));
  ok("undo_last: marks the undone snapshot so it is never picked twice",
    ((await listSnapshots(undoDir)).snapshots.find((s: any) => s.snapshotId === autoSnap.snapshotId) as any)?.undoneAt !== null);

  const addLayerText = textOf(await callTool("add_room_layer", { projectDir: undoDir, roomName: "rmUndo", layerName: "L_Undo", layerType: "folder" }));
  ok("auto-snapshot hook: a second destructive call adds exactly one more snapshot",
    (await listSnapshots(undoDir)).snapshots.length === 3, addLayerText);
  const undoSecond = await undoLast(undoDir);
  ok("undo_last: each call peels one operation, so the layer the second call added is gone again",
    undoSecond.restored.includes("rooms/rmUndo/rmUndo.yy")
    && !(await fs.readFile(undoRoomPath, "utf8")).includes("L_Undo"));
  try {
    await undoLast(undoDir);
    ok("undo_last: a third call reports nothing left to undo instead of replaying", false, "it undid something");
  } catch (e: any) {
    ok("undo_last: a third call reports nothing left to undo instead of replaying",
      e.message.includes("nothing to undo"), e.message);
  }

  // --- the hook, skipped cases: explicit opt-out and a project over the limits ---
  const hookDir = await makeBareProject();
  let hookYyp = await loadYyp(hookDir);
  hookYyp = await addRoom(hookDir, hookYyp, "rmHook", { width: 320, height: 240, persistent: false });
  await writeYyp(hookDir, hookYyp);

  const skippedText = textOf(await callTool("remove_room_layer", { projectDir: hookDir, roomName: "rmHook", layerName: "Background", skipSnapshot: true }));
  ok("auto-snapshot hook: skipSnapshot:true writes anyway and says the backup was skipped on request",
    skippedText.includes("⚠ snapshot skipped on request"), skippedText);
  ok("auto-snapshot hook: skipSnapshot:true created no snapshot", (await listSnapshots(hookDir)).snapshots.length === 0);

  await callTool("add_room_layer", { projectDir: hookDir, roomName: "rmHook", layerName: "L_Keep", layerType: "folder" });
  const snapCountAfterAdd = (await listSnapshots(hookDir)).snapshots.length;
  await callTool("set_room_layer", { projectDir: hookDir, roomName: "rmHook", layerName: "L_Keep", depth: 900 });
  const snapCountAfterChange = (await listSnapshots(hookDir)).snapshots.length;
  const noOpAgain = textOf(await callTool("set_room_layer", { projectDir: hookDir, roomName: "rmHook", layerName: "L_Keep", depth: 900 }));
  ok("auto-snapshot hook: a call that changes nothing discards its snapshot instead of spending a retention slot",
    /unchanged/.test(noOpAgain) && snapCountAfterChange === snapCountAfterAdd + 1
    && (await listSnapshots(hookDir)).snapshots.length === snapCountAfterChange,
    `${snapCountAfterAdd}/${snapCountAfterChange} ${noOpAgain}`);

  const bigDir = await makeBareProject();
  const bigYyp = await addRoom(bigDir, await loadYyp(bigDir), "rmBig", { width: 320, height: 240, persistent: false });
  await writeYyp(bigDir, bigYyp);
  for (let i = 0; i < 20_050; i += 500) {
    const batch: Promise<unknown>[] = [];
    for (let j = i; j < Math.min(i + 500, 20_050); j++) batch.push(fs.writeFile(path.join(bigDir, `filler${j}.txt`), ""));
    await Promise.all(batch);
  }
  const overText = textOf(await callTool("remove_room_layer", { projectDir: bigDir, roomName: "rmBig", layerName: "Background" }));
  ok("auto-snapshot hook: an over-threshold project skips the snapshot, still writes, and says so",
    overText.includes("⚠ snapshot skipped:") && overText.includes("20,000-file")
    && overText.includes("without a backup"), overText.slice(0, 240));
  ok("auto-snapshot hook: the skipped snapshot left no store behind",
    !(await fileExists(path.join(bigDir, ".gm-forge", "backups"))));
  ok("auto-snapshot hook: the write itself went through (the tool reports the layer removed)",
    overText.includes('"removed": true') && !(await listRoomLayers(bigDir, "rmBig")).some((l) => l.name === "Background"));
  try {
    await createSnapshot(bigDir, {});
    ok("create_snapshot: an explicit call over the limit throws with the project numbers and both limits", false, "it returned");
  } catch (e: any) {
    ok("create_snapshot: an explicit call over the limit throws with the project numbers and both limits",
      e.message.includes("20,0") && e.message.includes("20,000-file") && e.message.includes("512.0 MB"), e.message);
  }
  await fs.rm(bigDir, { recursive: true, force: true });

  // --- retention ---
  const retentionDir = await makeBareProject();
  const retentionIds: string[] = [];
  for (let i = 0; i < 21; i++) {
    const s = await createSnapshot(retentionDir, { reason: `retention ${i}` });
    retentionIds.push(s.snapshotId!);
    if (i === 20) {
      ok("create_snapshot: retention keeps 20 snapshots and reports the one it pruned",
        s.pruned.length === 1 && s.pruned[0] === retentionIds[0], JSON.stringify(s.pruned));
    }
  }
  const retentionList = await listSnapshots(retentionDir);
  ok("create_snapshot: 21 snapshots leave exactly SNAPSHOT_KEEP (20) on disk",
    retentionList.snapshots.length === SNAPSHOT_KEEP && retentionList.keep === SNAPSHOT_KEEP,
    `${retentionList.snapshots.length} / ${retentionList.keep}`);
  ok("create_snapshot: the pruned snapshot's directory is gone",
    !(await fileExists(path.join(retentionDir, ".gm-forge", "backups", retentionIds[0]))));

  // --- registry: 8 new tools, 61 total ---
  const safetyToolNames = ["create_snapshot", "list_snapshots", "restore_snapshot", "delete_snapshot",
    "read_file", "patch_file", "list_changes", "undo_last"];
  for (const name of safetyToolNames) {
    ok(`registry: ${name} is in TOOL_DEFS`, TOOL_DEFS.some((d) => d.name === name));
    ok(`registry: ${name} has a live dispatchTool case`, indexSource.includes(`case "${name}":`));
    ok(`registry: ${name} is documented in README.md`, readmeSource.includes(`\`${name}\``));
  }
  ok("registry: the eight safety tools answer through the real dispatch path (text, not a throw)",
    typeof (await callTool("list_snapshots", { projectDir: retentionDir })).content?.[0]?.text === "string");
  ok("registry: .gitignore keeps the snapshot store out of this repo",
    (await fs.readFile(path.join(process.cwd(), ".gitignore"), "utf8")).includes(".gm-forge/"));
  ok("registry: README documents the store, its retention and the optional .gitignore line",
    readmeSource.includes(".gm-forge/") && /keeps the newest 20/.test(readmeSource));

  // ===== Audit fix pass (A1-A3, B1-B2, C1, D1, E1-E2, F1-F5, G1-G2) =====
  // Filesystem timestamps can be identical for two writes in the same tick;
  // this forges the recorded mtime back onto a file so the coarse-clock case can
  // be tested on any filesystem.
  const forgeMtime = async (file: string, mtimeMs: number): Promise<boolean> => {
    const want = new Date(mtimeMs);
    for (let attempt = 0; attempt < 4; attempt++) {
      await fs.utimes(file, want, want);
      if ((await fs.stat(file)).mtimeMs === mtimeMs) return true;
    }
    return false;
  };
  const jsonFirstPartPlusWarning = (r: any): boolean => {
    if (!r || !Array.isArray(r.content) || r.content.length !== 2) return false;
    let parses = false;
    try {
      JSON.parse(r.content[0].text);
      parses = true;
    } catch {
      parses = false;
    }
    return parses && r.content[1].type === "text" && r.content[1].text.startsWith("⚠");
  };

  const auditDir = await makeBareProject();
  let auditYyp = await loadYyp(auditDir);
  auditYyp = await addRoom(auditDir, auditYyp, "rmAudit", { width: 320, height: 240, persistent: false });
  auditYyp = await addScript(auditDir, auditYyp, "scrAudit", "function scrAudit() { return 1; }\n");
  auditYyp = await addObject(auditDir, auditYyp, "objAudit", []);
  await writeYyp(auditDir, auditYyp);
  const auditSnapCount = async () => (await listSnapshots(auditDir)).snapshots.length;

  // --- A1: a malformed call costs no snapshot and keeps dispatch's own error ---
  const a1Before = await auditSnapCount();
  const a1Missing = await callTool("edit_room", { projectDir: auditDir });
  ok("A1: a call that fails its own schema creates no snapshot at all",
    (await auditSnapCount()) === a1Before, (await listSnapshots(auditDir)).snapshots.length + " snapshots");
  ok("A1: the malformed call still returns the schema error, not a snapshot error",
    a1Missing.isError === true && a1Missing.content[0].text.startsWith("Error:") && /roomName/.test(a1Missing.content[0].text),
    a1Missing.content[0].text);
  const a1Type = await callTool("set_room_layer", { projectDir: auditDir, roomName: "rmAudit", layerName: "Instances", depth: "deep" });
  ok("A1: a wrong argument type is rejected before any snapshot", a1Type.isError === true && (await auditSnapCount()) === a1Before,
    a1Type.content[0].text);

  // --- A2: a directory that is not a GameMaker project is never snapshotted ---
  const a2Plain = await fs.mkdtemp(path.join(os.tmpdir(), "gm-mcp-notaproject-"));
  await fs.writeFile(path.join(a2Plain, "notes.txt"), "not a project\n", "utf8");
  const a2Res = await callTool("delete_resource", { projectDir: a2Plain, category: "objects", resourceName: "objX" });
  ok("A2: a directory holding no .yyp is not snapshotted",
    !(await fileExists(path.join(a2Plain, ".gm-forge"))), (await fs.readdir(a2Plain)).join(","));
  ok("A2: and the handler's own 'No .yyp found' error comes through unchanged",
    a2Res.isError === true && a2Res.content[0].text.includes("No .yyp found in"), a2Res.content[0].text);
  await fs.rm(a2Plain, { recursive: true, force: true });

  // --- A3 / F5: the warning is a second content part, never appended to JSON ---
  const a3Add = await callTool("add_room_layer", { projectDir: auditDir, roomName: "rmAudit", layerName: "L_A3", layerType: "folder", skipSnapshot: true });
  ok("A3: add_room_layer keeps valid JSON in content[0] and puts the warning in content[1]",
    jsonFirstPartPlusWarning(a3Add), JSON.stringify(a3Add).slice(0, 300));
  const a3Remove = await callTool("remove_room_layer", { projectDir: auditDir, roomName: "rmAudit", layerName: "L_A3", skipSnapshot: true });
  ok("A3: remove_room_layer keeps valid JSON in content[0] and puts the warning in content[1]",
    jsonFirstPartPlusWarning(a3Remove), JSON.stringify(a3Remove).slice(0, 300));
  const a3SetTiles = await callTool("set_room_tiles", {
    projectDir: dir, roomName: "rmLayers", layerName: "L_Tiles",
    tiles: [{ x: 24, y: 0, index: 1 }], skipSnapshot: true,
  });
  ok("A3: set_room_tiles keeps valid JSON in content[0] and puts the warning in content[1]",
    jsonFirstPartPlusWarning(a3SetTiles), JSON.stringify(a3SetTiles).slice(0, 300));
  const a3Fill = await callTool("fill_room_tiles", {
    projectDir: dir, roomName: "rmLayers", layerName: "L_Tiles",
    x: 0, y: 0, width: 1, height: 1, index: 1, skipSnapshot: true,
  });
  ok("A3: fill_room_tiles keeps valid JSON in content[0] and puts the warning in content[1]",
    jsonFirstPartPlusWarning(a3Fill), JSON.stringify(a3Fill).slice(0, 300));
  const a3Plain = await callTool("list_room_layers", { projectDir: auditDir, roomName: "rmAudit" });
  ok("A3: a read-only tool's response is still exactly one content part",
    a3Plain.content.length === 1 && !a3Plain.content[0].text.includes("⚠"));

  // --- F1 / E1: every member of AUTO_SNAPSHOT_TOOLS takes exactly one snapshot ---
  const minimalArgs: Record<string, Record<string, unknown>> = {
    rename_resource: { category: "scripts", oldName: "a", newName: "b" },
    delete_resource: { category: "scripts", resourceName: "a" },
    remove_room_layer: { roomName: "r", layerName: "l" },
    set_room_tiles: { roomName: "r", layerName: "l", tiles: [{ x: 0, y: 0, index: 1 }] },
    fill_room_tiles: { roomName: "r", layerName: "l", x: 0, y: 0, width: 1, height: 1, index: 1 },
    edit_object: { objectName: "o", visible: true },
    edit_room: { roomName: "r", width: 100 },
    edit_script: { scriptName: "s", code: "// x\n" },
    edit_sprite: { spriteName: "s", xorigin: 1 },
    edit_shader: { shaderName: "s", vertexCode: "// x\n" },
    edit_sound: { soundName: "s", volume: 0.5 },
    edit_font: { fontName: "f", size: 12 },
    edit_tileset: { tilesetName: "t", tileWidth: 8 },
    set_room_layer: { roomName: "r", layerName: "l", depth: 1 },
    add_room_layer: { roomName: "r", layerName: "l", layerType: "folder" },
    add_room_instance: { roomName: "r", objectName: "o", x: 0, y: 0 },
    add_object_event: { objectName: "o", eventType: 0, eventNum: 0 },
    reorder_room: { roomName: "r", newIndex: 0 },
    move_room_relative: { roomName: "r", targetRoomName: "t", position: "before" },
    add_included_file: { sourcePath: "stub-file.txt" },
    remove_included_file: { name: "stub-file.txt" },
    add_sprite_frame: { spriteName: "s", sourceImagePath: "stub-frame.png" },
    remove_sprite_frame: { spriteName: "s", index: 0 },
    replace_sprite_frame: { spriteName: "s", index: 0, sourceImagePath: "stub-frame.png" },
    reorder_sprite_frames: { spriteName: "s", order: [0] },
    trim_sprite_frames: { spriteName: "s", from: 0, to: 0 },
  };
  ok("F1: every registered auto-snapshot tool has valid minimal args in this test (none silently uncovered)",
    [...AUTO_SNAPSHOT_TOOLS].every((n) => minimalArgs[n] !== undefined),
    [...AUTO_SNAPSHOT_TOOLS].filter((n) => minimalArgs[n] === undefined).join(","));
  let f1Index = 0;
  for (const name of [...AUTO_SNAPSHOT_TOOLS].sort()) {
    const f1Dir = await makeBareProject();
    f1Index++;
    const schema = TOOL_DEFS.find((d) => d.name === name)!.schema;
    const relPayload = `hook-${f1Index}.txt`;
    const payload = path.join(f1Dir, relPayload);
    const f1Res = await withAutoSnapshot(
      name,
      f1Dir,
      { ...minimalArgs[name], projectDir: f1Dir },
      async () => {
        await atomicWriteFile(payload, `${name}\n`);
        return { content: [{ type: "text", text: "stub-ok" }] };
      },
      schema
    );
    const f1Snaps = (await listSnapshots(f1Dir)).snapshots;
    const f1Manifest = f1Snaps.length === 1 ? await readManifest(f1Dir, (f1Snaps[0] as any).snapshotId) : null;
    ok(`F1: ${name} takes exactly one snapshot, attributed to the tool, with the stub's file recorded as touched`,
      f1Snaps.length === 1 && (f1Snaps[0] as any).tool === name
      && (f1Manifest?.touched.includes(relPayload) ?? false)
      && f1Res.content.length === 1,
      JSON.stringify(f1Snaps));
    await fs.rm(f1Dir, { recursive: true, force: true });
  }
  ok("E1: edit_script/edit_sprite/edit_shader/edit_sound/edit_font/edit_tileset are covered now",
    ["edit_script", "edit_sprite", "edit_shader", "edit_sound", "edit_font", "edit_tileset"]
      .every((n) => AUTO_SNAPSHOT_TOOLS.has(n)));
  ok("E1: the existing object-and-room writers are still covered (add_object_event, add_room_instance)",
    AUTO_SNAPSHOT_TOOLS.has("add_object_event") && AUTO_SNAPSHOT_TOOLS.has("add_room_instance"));
  ok("E1: every auto-snapshot tool's schema accepts skipSnapshot, so the opt-out cannot be missing from one of them",
    [...AUTO_SNAPSHOT_TOOLS].every((n) => {
      const d = TOOL_DEFS.find((def) => def.name === n)!;
      return d.schema.safeParse({ ...minimalArgs[n], projectDir: auditDir, skipSnapshot: true }).success;
    }),
    [...AUTO_SNAPSHOT_TOOLS].filter((n) => {
      const d = TOOL_DEFS.find((def) => def.name === n)!;
      return !d.schema.safeParse({ ...minimalArgs[n], projectDir: auditDir, skipSnapshot: true }).success;
    }).join(","));
  ok("E1: read-only and append-only tools stay out of the list",
    ["lint_project", "compile_project", "list_resources", "get_room_info", "read_file", "list_changes",
      "create_snapshot", "restore_snapshot", "delete_snapshot", "undo_last", "patch_file",
      "add_script", "add_sprite_from_images", "add_note", "create_project"]
      .every((n) => !AUTO_SNAPSHOT_TOOLS.has(n)));

  const f1ReadOnlyBefore = await auditSnapCount();
  await callTool("get_script_info", { projectDir: auditDir, scriptName: "scrAudit" });
  await callTool("list_room_layers", { projectDir: auditDir, roomName: "rmAudit" });
  ok("F1: read-only tools create zero snapshots", (await auditSnapCount()) === f1ReadOnlyBefore);

  // --- F3: undo_last deletes a file the wrapped tool created ---
  const f3Dir = await makeBareProject();
  let f3Yyp = await loadYyp(f3Dir);
  f3Yyp = await addObject(f3Dir, f3Yyp, "objEv", []);
  await writeYyp(f3Dir, f3Yyp);
  const f3ObjBefore = await fs.readFile(path.join(f3Dir, "objects", "objEv", "objEv.yy"));
  const f3CreateEvent = path.join(f3Dir, "objects", "objEv", "Create_0.gml");
  textOf(await callTool("add_object_event", { projectDir: f3Dir, objectName: "objEv", eventType: 0, eventNum: 0, code: "// created\n" }));
  ok("F3: add_object_event created the event file behind its own automatic snapshot",
    (await fileExists(f3CreateEvent)) && (await listSnapshots(f3Dir)).snapshots.length === 1);
  const f3Undo = await undoLast(f3Dir);
  ok("F3: undo_last deletes the file the tool created instead of rewriting it",
    f3Undo.removed.includes("objects/objEv/Create_0.gml") && !(await fileExists(f3CreateEvent)),
    JSON.stringify({ removed: f3Undo.removed, restored: f3Undo.restored }));
  ok("F3: and the object .yy it rewrote is byte-identical to before the call",
    (await fs.readFile(path.join(f3Dir, "objects", "objEv", "objEv.yy"))).equals(f3ObjBefore));

  // --- E2: undo_last says which snapshot-skipped files did not come back ---
  const e2Dir = await makeBareProject();
  let e2Yyp = await loadYyp(e2Dir);
  e2Yyp = await addObject(e2Dir, e2Yyp, "objHeavy", []);
  await writeYyp(e2Dir, e2Yyp);
  await fs.writeFile(path.join(e2Dir, "objects", "objHeavy", "frame.png"), Buffer.alloc(SNAPSHOT_MAX_FILE_BYTES + 1024));
  textOf(await callTool("delete_resource", { projectDir: e2Dir, category: "objects", resourceName: "objHeavy" }));
  const e2Undo = await undoLast(e2Dir);
  ok("E2: undo_last reports the over-cap file the snapshot skipped and that did not come back",
    e2Undo.skippedNotRestored.includes("objects/objHeavy/frame.png"),
    JSON.stringify(e2Undo.skippedNotRestored));
  ok("E2: the object .yy itself was restored, so only the skipped file is reported",
    (await fileExists(path.join(e2Dir, "objects", "objHeavy", "objHeavy.yy"))) && e2Undo.skippedNotRestored.length === 1);
  ok("E2: an undo with nothing skipped reports an empty list",
    Array.isArray(f3Undo.skippedNotRestored) && f3Undo.skippedNotRestored.length === 0);

  // --- D1: link mode is only safe because every write replaces the inode ---
  const d1Dir = await makeBareProject();
  const d1File = path.join(d1Dir, "payload.txt");
  await fs.writeFile(d1File, "ORIGINAL\n", "utf8");
  const d1First = await createSnapshot(d1Dir, { reason: "link baseline" });
  const d1Second = await createSnapshot(d1Dir, { reason: "link dedupe" });
  const d1Manifest = await readManifest(d1Dir, d1Second.snapshotId!);
  const d1Entry = d1Manifest.files.find((f) => f.path === "payload.txt")!;
  ok("D1: the second snapshot hard-links an unchanged file instead of copying it",
    d1Entry.stored === "link" && d1Manifest.dedupe === "link" && d1Second.linked > 0,
    JSON.stringify({ stored: d1Entry.stored, dedupe: d1Manifest.dedupe, linked: d1Second.linked }));
  await atomicWriteFile(d1File, "REPLACED\n");
  const d1Stored = await fs.readFile(path.join(d1Dir, ".gm-forge", "backups", d1First.snapshotId!, "files", "payload.txt"), "utf8");
  ok("D1: an atomic write over a linked file does not touch the snapshot's own copy (shared inode would have been clobbered)",
    d1Stored === "ORIGINAL\n", JSON.stringify(d1Stored));
  await restoreSnapshot(d1Dir, { snapshotId: d1First.snapshotId!, files: ["payload.txt"] });
  ok("D1: restoring that snapshot returns the pre-write bytes",
    (await fs.readFile(d1File, "utf8")) === "ORIGINAL\n");

  // --- B1: the no-op decision is by digest, not by size+mtime ---
  const b1Dir = await makeBareProject();
  const b1File = path.join(b1Dir, "same-size.txt");
  await fs.writeFile(b1File, "AAAA\n", "utf8");
  const b1Snap = await createSnapshot(b1Dir, {});
  const b1Manifest = await readManifest(b1Dir, b1Snap.snapshotId!);
  const b1Entry = b1Manifest.files.find((f) => f.path === "same-size.txt")!;
  await fs.writeFile(b1File, "BBBB\n", "utf8");
  const b1Forged = await forgeMtime(b1File, b1Entry.mtimeMs);
  const b1Plain = await diffAgainstSnapshot(b1Dir, b1Manifest);
  if (b1Forged) {
    ok("B1: size+mtime alone calls a same-size same-mtime edit unchanged (the trap the hook must not fall into)",
      b1Plain.files.length === 0, JSON.stringify(b1Plain.files));
  } else {
    skip("B1: same-tick mtime forgery (this filesystem will not accept the recorded mtime)");
  }
  const b1Strict = await diffAgainstSnapshot(b1Dir, b1Manifest, { rehashSinceMs: Date.parse(b1Manifest.createdAt) - 2000 });
  ok("B1: the auto-snapshot diff re-hashes files written around the snapshot, so that edit is reported",
    b1Strict.files.some((f) => f.path === "same-size.txt" && f.status === "modified"),
    JSON.stringify(b1Strict.files));

  const b1HookDir = await makeBareProject();
  await fs.writeFile(path.join(b1HookDir, "payload.txt"), "AAAA\n", "utf8");
  const b1HookText = textOf(await withAutoSnapshot(
    "edit_script",
    b1HookDir,
    { projectDir: b1HookDir, scriptName: "s", code: "// x\n" },
    async () => {
      const latest = (await listSnapshots(b1HookDir)).snapshots[0] as any;
      const m = await readManifest(b1HookDir, latest.snapshotId);
      const entry = m.files.find((f) => f.path === "payload.txt")!;
      await fs.writeFile(path.join(b1HookDir, "payload.txt"), "BBBB\n", "utf8");
      await forgeMtime(path.join(b1HookDir, "payload.txt"), entry.mtimeMs);
      return { content: [{ type: "text", text: "ok" }] };
    },
    TOOL_DEFS.find((d) => d.name === "edit_script")!.schema
  ));
  const b1HookSnaps = (await listSnapshots(b1HookDir)).snapshots;
  ok("B1: the hook keeps the backup of a same-size same-mtime write instead of discarding it as a no-op",
    b1HookSnaps.length === 1 && (await readManifest(b1HookDir, (b1HookSnaps[0] as any).snapshotId)).touched.includes("payload.txt"),
    `${b1HookText} | ${b1HookSnaps.length} snapshot(s)`);

  // --- B2: a mid-restore failure rolls back and says the tree is not mixed ---
  const b2Dir = await makeBareProject();
  await fs.writeFile(path.join(b2Dir, "a.txt"), "A1\n", "utf8");
  await fs.writeFile(path.join(b2Dir, "b.txt"), "B1\n", "utf8");
  const b2Snap = await createSnapshot(b2Dir, {});
  await atomicWriteFile(path.join(b2Dir, "a.txt"), "A2\n");
  await atomicWriteFile(path.join(b2Dir, "b.txt"), "B2\n");
  await fs.chmod(path.join(b2Dir, "b.txt"), 0o444);
  let b2Message = "";
  try {
    await restoreSnapshot(b2Dir, { snapshotId: b2Snap.snapshotId!, files: ["a.txt", "b.txt"] });
  } catch (e: any) {
    b2Message = e.message;
  }
  ok("B2: a restore that fails partway reports how far it got, which file failed, and the rollback",
    /Restore failed after 1 of 2 files: b\.txt/.test(b2Message) && /Rolled back/.test(b2Message), b2Message);
  ok("B2: the file already replaced is back to its pre-restore bytes and the locked one is untouched",
    (await fs.readFile(path.join(b2Dir, "a.txt"), "utf8")) === "A2\n"
    && (await fs.readFile(path.join(b2Dir, "b.txt"), "utf8")) === "B2\n");
  await fs.chmod(path.join(b2Dir, "b.txt"), 0o666);
  ok("B2: the restore lock is released even when the restore failed",
    !(await fileExists(path.join(b2Dir, ".gm-forge", "lock"))));

  // --- C1: the lock error is actionable on its own ---
  const c1Lock = path.join(b2Dir, ".gm-forge", "lock");
  await fs.writeFile(c1Lock, JSON.stringify({ pid: 777, startedAt: new Date().toISOString() }), "utf8");
  let c1Message = "";
  try {
    await createSnapshot(b2Dir, {});
  } catch (e: any) {
    c1Message = e.message;
  }
  ok("C1: the lock error names the absolute lock file, says when it is safe to delete, and mentions skipSnapshot",
    c1Message.includes(c1Lock) && /ONLY if no restore is still running/.test(c1Message)
    && /skipSnapshot: true/.test(c1Message) && /never removed automatically/.test(c1Message),
    c1Message);
  await fs.rm(c1Lock, { force: true });

  // --- F2: a forced rename failure leaves the original bytes and no temp file ---
  const f2File = path.join(auditDir, "locked.txt");
  await fs.writeFile(f2File, "original-bytes\n", "utf8");
  await fs.chmod(f2File, 0o444);
  let f2Message = "";
  try {
    await atomicWriteFile(f2File, "replacement\n");
  } catch (e: any) {
    f2Message = e.message;
  }
  ok("F2: a refused rename surfaces the shared locked-file message",
    f2Message.includes("Could not replace") && f2Message.includes("EPERM") && f2Message.includes("Close the room in GameMaker"),
    f2Message);
  ok("F2: the original bytes survive the failed atomic write",
    (await fs.readFile(f2File, "utf8")) === "original-bytes\n");
  ok("F2: no *.tmp-* file is left behind",
    !(await fs.readdir(auditDir)).some((f) => f.includes(".tmp-")));
  await fs.chmod(f2File, 0o666);

  // --- G1: writeYyp shares the same atomic path, message included ---
  const g1YypPath = path.join(auditDir, "TestProj.yyp");
  const g1Before = await fs.readFile(g1YypPath);
  await fs.chmod(g1YypPath, 0o444);
  let g1Message = "";
  try {
    await writeYyp(auditDir, await loadYyp(auditDir));
  } catch (e: any) {
    g1Message = e.message;
  }
  await fs.chmod(g1YypPath, 0o666);
  ok("G1: a locked .yyp reports the shared 'close GameMaker' message instead of a raw EPERM",
    g1Message.includes("Could not replace") && g1Message.includes("Close the room in GameMaker"),
    g1Message);
  ok("G1: the .yyp is byte-identical after the refused write",
    (await fs.readFile(g1YypPath)).equals(g1Before));
  ok("G1: and no .tmp-* file is left in the project root",
    !(await fs.readdir(auditDir)).some((f) => f.includes(".tmp-")));

  // --- G2: imported assets go through the atomic helper too ---
  const g2Source = path.join(auditDir, "copy-source.bin");
  const g2Dest = path.join(auditDir, "copy-dest.bin");
  await fs.writeFile(g2Source, "copied-bytes\n", "utf8");
  await atomicCopyFile(g2Source, g2Dest);
  ok("G2: atomicCopyFile reproduces the source bytes exactly",
    (await fs.readFile(g2Dest, "utf8")) === "copied-bytes\n");
  ok("G2: atomicCopyFile leaves no temp file behind",
    !(await fs.readdir(auditDir)).some((f) => f.includes(".tmp-")));
  const spritesSource = await fs.readFile(path.join(process.cwd(), "src", "gm", "sprites.ts"), "utf8");
  const soundsSource = await fs.readFile(path.join(process.cwd(), "src", "gm", "sounds.ts"), "utf8");
  ok("G2: sprite frames and imported audio no longer copy straight onto the project path",
    !spritesSource.includes("fs.copyFile") && !soundsSource.includes("fs.copyFile")
    && spritesSource.includes("atomicCopyFile") && soundsSource.includes("atomicCopyFile"));
  const yypSource = await fs.readFile(path.join(process.cwd(), "src", "gm", "yyp.ts"), "utf8");
  ok("G1: writeYyp no longer hand-rolls its own temp file",
    !/\.tmp-/.test(yypSource) && yypSource.includes("atomicReplaceWith"));

  // ===== Project config (subproject C: options, included files, macros) =====
  const fixturesPath = path.join(process.cwd(), "test", "fixtures");
  const errorOf = async (fn: () => Promise<any>): Promise<string> => {
    try {
      await fn();
      return "";
    } catch (e: any) {
      return e?.message ?? String(e);
    }
  };
  // The ten options/*/options_*.yy of the read-only sample project, captured
  // once into test/fixtures/options/ (option_gameguid is redacted -- the tests
  // only need a string there). Nothing in this block writes to E:.
  const makeOptionsProject = async (): Promise<string> => {
    const projectDir = await makeBareProject();
    for (const platform of await fs.readdir(path.join(fixturesPath, "options"))) {
      const targetDirectory = path.join(projectDir, "options", platform);
      await fs.mkdir(targetDirectory, { recursive: true });
      await fs.copyFile(
        path.join(fixturesPath, "options", platform, `options_${platform}.yy`),
        path.join(targetDirectory, `options_${platform}.yy`)
      );
    }
    return projectDir;
  };
  const readOptionsFile = (projectDir: string, platform: string) =>
    fs.readFile(path.join(projectDir, "options", platform, `options_${platform}.yy`), "utf8");
  const snapshotCount = async (projectDir: string) => (await listSnapshots(projectDir)).snapshots.length;

  // --- get_project_options ---
  const optionsDir = await makeOptionsProject();
  const allOptions = await getProjectOptions(optionsDir);
  const optionFiles = [
    "options/android/options_android.yy", "options/html5/options_html5.yy", "options/ios/options_ios.yy",
    "options/linux/options_linux.yy", "options/mac/options_mac.yy", "options/main/options_main.yy",
    "options/operagx/options_operagx.yy", "options/reddit/options_reddit.yy",
    "options/tvos/options_tvos.yy", "options/windows/options_windows.yy",
  ];
  ok("get_project_options: an omitted platform reads all ten options/*/options_*.yy, sorted by platform directory",
    JSON.stringify(allOptions.options.map(o => o.file)) === JSON.stringify(optionFiles),
    JSON.stringify(allOptions.options.map(o => o.file)));
  ok("get_project_options: the display name comes from the file (macOS / Opera GX / HTML5 / tvOS / iOS / Reddit), never from the directory",
    JSON.stringify(allOptions.options.map(o => o.platform))
      === JSON.stringify(["Android", "HTML5", "iOS", "Linux", "macOS", "Main", "Opera GX", "Reddit", "tvOS", "Windows"]),
    JSON.stringify(allOptions.options.map(o => o.platform)));
  const interpolateValue = (settings: Record<string, unknown>, platform: string) =>
    settings[`option_${platform}_interpolate_pixels`];
  const windowsOptions = allOptions.options.find(o => o.file.includes("windows"))!;
  ok("get_project_options: the sample-shaped fixture has option_windows_interpolate_pixels === false",
    windowsOptions.settings["option_windows_interpolate_pixels"] === false, JSON.stringify(windowsOptions.settings["option_windows_interpolate_pixels"]));
  ok("get_project_options: exactly one platform (windows) is false and the other eight are true -- and main has no such key",
    allOptions.options.filter(o => Object.keys(o.settings).some(k => k.endsWith("_interpolate_pixels"))).length === 9
    && JSON.stringify(allOptions.options
      .filter(o => Object.keys(o.settings).some(k => k.endsWith("_interpolate_pixels") && o.settings[k] === false))
      .map(o => o.file)) === JSON.stringify(["options/windows/options_windows.yy"]),
    JSON.stringify(allOptions.options.map(o => [o.file, interpolateValue(o.settings, path.basename(path.dirname(o.file)))])));
  ok("get_project_options: settings is the parsed file minus the envelope ($GM*, %Name, name, resourceType, resourceVersion)",
    allOptions.options.every(o => Object.keys(o.settings).every(k => k.startsWith("option_"))
      && !Object.keys(o.settings).some(k => k.startsWith("$GM"))
      && OPTION_ENVELOPE_KEYS.every(k => !(k in o.settings))),
    JSON.stringify(Object.keys(allOptions.options[0].settings).slice(0, 3)));
  let settingsKeysExact = true;
  for (const option of allOptions.options) {
    const raw = parseGameMakerJson(await fs.readFile(path.join(optionsDir, option.file), "utf8"));
    const onDisk = Object.keys(raw).filter(k => k.startsWith("option_")).sort();
    if (JSON.stringify(onDisk) !== JSON.stringify(Object.keys(option.settings).sort())) settingsKeysExact = false;
  }
  ok("get_project_options: every settings key list equals that file's option_* list exactly (nothing dropped, nothing invented)",
    settingsKeysExact);
  const macByName = await getProjectOptions(optionsDir, { platform: "macOS" });
  ok("get_project_options: a display name read from one call is accepted back (macOS -> options/mac/)",
    macByName.options.length === 1 && macByName.options[0].file === "options/mac/options_mac.yy",
    JSON.stringify(macByName.options.map(o => o.file)));
  const optionsViaTool = JSON.parse(textOf(await callTool("get_project_options", { projectDir: optionsDir })));
  ok("get_project_options: answering with only projectDir returns all ten platforms as JSON and takes no snapshot",
    optionsViaTool.options.length === 10 && (await snapshotCount(optionsDir)) === 0);
  const unknownPlatform = await errorOf(() => getProjectOptions(optionsDir, { platform: "switch" }));
  ok("get_project_options: an unknown platform is an error listing the platforms that do exist",
    unknownPlatform.includes("Unknown platform") && unknownPlatform.includes("windows (Windows)"), unknownPlatform);
  ok("get_project_options: the error points at the expected file and says the tool only reads what already exists",
    /only reads files that already exist/.test(unknownPlatform)
    && unknownPlatform.includes(path.join("options", "switch", "options_switch.yy")), unknownPlatform);

  // Every options fixture lands in the working tree with whatever core.autocrlf
  // chose for this clone (CRLF on Windows, LF elsewhere), so line-level
  // comparisons normalise the EOL first. The EOL style is then checked
  // separately: a writer that silently converted line endings must still fail.
  const normaliseEol = (text: string) => text.replace(/\r\n/g, "\n");
  const splitNormalisedLines = (text: string) => normaliseEol(text).split("\n");
  const crlfCount = (text: string) => (text.match(/\r\n/g) ?? []).length;

  // --- set_project_option ---
  const optionsBefore = new Map<string, string>();
  for (const platform of await fs.readdir(path.join(optionsDir, "options"))) {
    optionsBefore.set(platform, await readOptionsFile(optionsDir, platform));
  }
  const optionsDirsBefore = (await fs.readdir(path.join(optionsDir, "options"))).sort();
  const windowsText = optionsBefore.get("windows")!;
  const flip = await setProjectOption(optionsDir, { platform: "windows", key: "interpolate_pixels", value: true });
  ok("set_project_option: interpolate_pixels false -> true on windows reports platform, file, resolved onDiskKey and previous value",
    flip.changed === true && flip.previous === false && flip.value === true && flip.platform === "Windows"
    && flip.onDiskKey === "option_windows_interpolate_pixels" && flip.file === "options/windows/options_windows.yy"
    && flip.key === "interpolate_pixels", JSON.stringify(flip));
  const windowsAfter = await readOptionsFile(optionsDir, "windows");
  const beforeLinesOf = splitNormalisedLines(windowsText);
  const afterLinesOf = splitNormalisedLines(windowsAfter);
  const changedLineIndexes = beforeLinesOf.map((line, i) => (line === afterLinesOf[i] ? -1 : i)).filter(i => i >= 0);
  ok("set_project_option: rewrites exactly one line, the one that holds the value",
    changedLineIndexes.length === 1
    && afterLinesOf.length === beforeLinesOf.length
    && crlfCount(windowsAfter) === crlfCount(windowsText)
    && afterLinesOf[changedLineIndexes[0]] === '  "option_windows_interpolate_pixels":true,'
    && beforeLinesOf[changedLineIndexes[0]] === '  "option_windows_interpolate_pixels":false,',
    changedLineIndexes.map(i => `${i}: ${JSON.stringify(beforeLinesOf[i])} -> ${JSON.stringify(afterLinesOf[i])}`).join(" | "));
  ok("set_project_option: the file's byte length moves by exactly the value's length (nothing else re-serialised)",
    windowsAfter.length - windowsText.length === JSON.stringify(true).length - JSON.stringify(false).length,
    String(windowsAfter.length - windowsText.length));
  const windowsParsedBefore = parseGameMakerJson(windowsText);
  const windowsParsedAfter = parseGameMakerJson(windowsAfter);
  ok("set_project_option: every other key keeps its value and its position",
    JSON.stringify(Object.keys(windowsParsedBefore)) === JSON.stringify(Object.keys(windowsParsedAfter))
    && Object.keys(windowsParsedBefore).every(k =>
      k === "option_windows_interpolate_pixels"
        ? windowsParsedAfter[k] === true
        : JSON.stringify(windowsParsedAfter[k]) === JSON.stringify(windowsParsedBefore[k])));
  let otherFilesUntouched = true;
  for (const [platform, text] of optionsBefore) {
    if (platform === "windows") continue;
    if ((await readOptionsFile(optionsDir, platform)) !== text) otherFilesUntouched = false;
  }
  ok("set_project_option: the other nine options files are byte-identical after the call", otherFilesUntouched);
  ok("set_project_option: get_project_options reads the new value back",
    (await getProjectOptions(optionsDir, { platform: "windows" })).options[0].settings["option_windows_interpolate_pixels"] === true);

  const equalSnapshots = await snapshotCount(optionsDir);
  const unchanged = await setProjectOption(optionsDir, { platform: "windows", key: "interpolate_pixels", value: true });
  ok("set_project_option: an already-equal value returns changed: false, writes nothing, takes no snapshot and reports snapshotId null",
    unchanged.changed === false && (await readOptionsFile(optionsDir, "windows")) === windowsAfter
    && unchanged.snapshotId === null && unchanged.snapshotSkippedReason === undefined
    && (await snapshotCount(optionsDir)) === equalSnapshots);

  const writeSnapshots = await snapshotCount(optionsDir);
  const flippedBackTool = await callTool("set_project_option", { projectDir: optionsDir, platform: "windows", key: "interpolate_pixels", value: false });
  const flippedBackResult = JSON.parse(textOf(flippedBackTool));
  ok("set_project_option: a real change takes exactly one snapshot -- it snapshots itself, the dispatch hook does not double it",
    !flippedBackTool.isError && (await snapshotCount(optionsDir)) === writeSnapshots + 1, textOf(flippedBackTool));
  ok("set_project_option: the result names the backup it took (snapshotId), the way patch_file does",
    typeof flippedBackResult.snapshotId === "string" && flippedBackResult.snapshotId.length > 0
    && flippedBackResult.snapshotSkippedReason === undefined, textOf(flippedBackTool));
  ok("set_project_option: set_project_option is not on the auto-snapshot list",
    !AUTO_SNAPSHOT_TOOLS.has("set_project_option"));

  const skipSnapshots = await snapshotCount(optionsDir);
  const skippedOption = await callTool("set_project_option", { projectDir: optionsDir, platform: "windows", key: "interpolate_pixels", value: true, skipSnapshot: true });
  const skippedOptionResult = JSON.parse(textOf(skippedOption));
  ok("set_project_option: skipSnapshot still writes, without a backup",
    (await snapshotCount(optionsDir)) === skipSnapshots
    && (await getProjectOptions(optionsDir, { platform: "windows" })).options[0].settings["option_windows_interpolate_pixels"] === true);
  ok("set_project_option: skipSnapshot is reported, not silent (snapshotId null + snapshotSkippedReason)",
    skippedOptionResult.snapshotId === null && /snapshot skipped on request/.test(skippedOptionResult.snapshotSkippedReason ?? ""),
    textOf(skippedOption));

  // --- the two formatting branches: in place, or a refusal (never a reformat) ---
  const plainDir = await makeBareProject();
  const plainOptionsDir = path.join(plainDir, "options", "windows");
  await fs.mkdir(plainOptionsDir, { recursive: true });
  const plainText = '{\n  "$GMWindowsOptions": "v2",\n  "%Name": "Windows",\n  "name": "Windows",\n  "option_windows_interpolate_pixels": false,\n  "resourceType": "GMWindowsOptions",\n  "resourceVersion": "2.0"\n}\n';
  const plainPath = path.join(plainOptionsDir, "options_windows.yy");
  await fs.writeFile(plainPath, plainText, "utf8");
  await setProjectOption(plainDir, { platform: "windows", key: "interpolate_pixels", value: true });
  ok("set_project_option: a hand-formatted file is edited in place -- no trailing commas added, no spacing changed",
    (await fs.readFile(plainPath, "utf8")) === plainText.replace('"option_windows_interpolate_pixels": false', '"option_windows_interpolate_pixels": true'),
    JSON.stringify(await fs.readFile(plainPath, "utf8")));
  const compactText = JSON.stringify(parseGameMakerJson(plainText));
  await fs.writeFile(plainPath, compactText, "utf8");
  const compactSnapshots = await snapshotCount(plainDir);
  const compactError = await errorOf(() => setProjectOption(plainDir, { platform: "windows", key: "interpolate_pixels", value: true }));
  ok("set_project_option: a compact (one-line) options file is REFUSED rather than re-serialised whole",
    compactError.includes("cannot rewrite options/windows/options_windows.yy in place")
    && compactError.includes('"option_windows_interpolate_pixels" is not on its own line')
    && compactError.includes("refusing to reformat the file") && compactError.includes("Nothing was written."),
    compactError);
  ok("set_project_option: the refused compact file is byte-identical and no snapshot was taken",
    (await fs.readFile(plainPath, "utf8")) === compactText && (await snapshotCount(plainDir)) === compactSnapshots);
  await fs.rm(plainDir, { recursive: true, force: true });

  const authorBefore = await readOptionsFile(optionsDir, "main");
  const authorWrite = await setProjectOption(optionsDir, { platform: undefined, key: "option_author", value: "A Tester" });
  const authorAfterText = await readOptionsFile(optionsDir, "main");
  const authorLines = splitNormalisedLines(authorAfterText);
  const authorBeforeLines = splitNormalisedLines(authorBefore);
  ok("set_project_option: a project-wide key defaults to options/main/ and rewrites only its own line",
    authorWrite.changed === true && authorWrite.platform === "Main" && authorWrite.onDiskKey === "option_author"
    && authorLines.length === authorBeforeLines.length
    && crlfCount(authorAfterText) === crlfCount(authorBefore)
    && authorLines.filter((line, i) => line !== authorBeforeLines[i]).length === 1,
    JSON.stringify(authorWrite));
  const speedWrite = await setProjectOption(optionsDir, { key: "option_game_speed", value: 30 });
  ok("set_project_option: option_game_speed 60 -> 30 is an integer write to the main file",
    speedWrite.changed === true && speedWrite.previous === 60 && speedWrite.value === 30, JSON.stringify(speedWrite));

  const allowlistError = await errorOf(() => setProjectOption(optionsDir, { platform: "windows", key: "option_windows_texture_page", value: "2048x2048" }));
  ok("set_project_option: a key outside the allowlist is refused with the allowlist in the message",
    allowlistError.includes('Unknown option "option_windows_texture_page"')
    && allowlistError.includes("interpolate_pixels (bool) -> option_<platform>_interpolate_pixels")
    && /Rejected as read-only: option_gameguid/.test(allowlistError)
    && /Rejected as unverified: option_speed, option_window_width, option_window_height, option_lastchanged/.test(allowlistError),
    allowlistError);
  for (const key of ["option_speed", "option_window_width", "option_window_height", "option_lastchanged"]) {
    const message = await errorOf(() => setProjectOption(optionsDir, { platform: "windows", key, value: 1 }));
    ok(`set_project_option: "${key}" is refused as unverified, naming the reason`,
      message.includes(`Unverified option "${key}"`) && /no GameMaker 2026\.0\.0\.16 sample defines this key/.test(message)
      && message.includes("option_game_speed (int)"), message);
  }
  const guidError = await errorOf(() => setProjectOption(optionsDir, { key: "option_gameguid", value: "0000" }));
  ok("set_project_option: option_gameguid is read-only and says why",
    guidError.includes('Option "option_gameguid" is read-only') && guidError.includes("save files"), guidError);
  const boolTypeError = await errorOf(() => setProjectOption(optionsDir, { platform: "windows", key: "interpolate_pixels", value: 0 }));
  ok("set_project_option: a bool option rejects 0 rather than writing a falsy number",
    boolTypeError.includes("needs true or false"), boolTypeError);
  const intTypeError = await errorOf(() => setProjectOption(optionsDir, { platform: "windows", key: "option_scale", value: 1.5 }));
  ok("set_project_option: an int option rejects a float", intTypeError.includes("needs a whole number"), intTypeError);
  const rangeError = await errorOf(() => setProjectOption(optionsDir, { key: "option_game_speed", value: 2000 }));
  ok("set_project_option: option_game_speed is bounded 1..1000", rangeError.includes("must be between 1 and 1000"), rangeError);
  const stringTypeError = await errorOf(() => setProjectOption(optionsDir, { key: "option_author", value: 5 }));
  ok("set_project_option: a string option rejects a number", stringTypeError.includes("needs a string"), stringTypeError);
  const mainKeyOnPlatform = await errorOf(() => setProjectOption(optionsDir, { platform: "windows", key: "option_game_speed", value: 30 }));
  ok("set_project_option: a project-wide key with a platform given names the main file and the per-platform alternatives",
    mainKeyOnPlatform.includes("is a project-wide option") && mainKeyOnPlatform.includes("options/main/options_main.yy")
    && mainKeyOnPlatform.includes("interpolate_pixels"), mainKeyOnPlatform);
  const platformKeyOnMain = await errorOf(() => setProjectOption(optionsDir, { platform: "main", key: "interpolate_pixels", value: true }));
  ok("set_project_option: a per-platform key on main is refused and lists the platforms that do define it",
    platformKeyOnMain.includes("is per-platform") && platformKeyOnMain.includes("that define it: android"), platformKeyOnMain);
  const resizeOnReddit = await errorOf(() => setProjectOption(optionsDir, { platform: "reddit", key: "option_resize", value: true }));
  ok("set_project_option: option_resize on reddit is refused (never adds a key GameMaker did not write) and names linux/mac/windows",
    resizeOnReddit.includes("never adds a key GameMaker did not write")
    && resizeOnReddit.includes("linux") && resizeOnReddit.includes("mac") && resizeOnReddit.includes("windows"), resizeOnReddit);
  const versionOnReddit = await errorOf(() => setProjectOption(optionsDir, { platform: "reddit", key: "option_version", value: "2.0" }));
  ok("set_project_option: option_version is absent on reddit (present on the other eight), so reddit is refused",
    versionOnReddit.includes("does not define"), versionOnReddit);
  ok("set_project_option: no call above created an options file or a platform directory",
    JSON.stringify((await fs.readdir(path.join(optionsDir, "options"))).sort()) === JSON.stringify(optionsDirsBefore)
    && !(await fileExists(path.join(optionsDir, "options", "switch", "options_switch.yy")))
    && !(await fileExists(path.join(optionsDir, "options", "windows", "options_switch.yy"))));
  const noOptionsDir = await makeBareProject();
  const noOptionsError = await errorOf(() => setProjectOption(noOptionsDir, { key: "option_author", value: "x" }));
  ok("set_project_option: a project with no options/ says so and creates nothing",
    noOptionsError.includes("this project has no options/*/options_*.yy files")
    && !(await fileExists(path.join(noOptionsDir, "options"))), noOptionsError);
  await fs.rm(noOptionsDir, { recursive: true, force: true });

  // --- included files ---
  const incDir = await makeBareProject();
  const emptyIncluded = await listIncludedFiles(incDir);
  ok("list_included_files: a project with no IncludedFiles entries reports an empty list",
    Array.isArray(emptyIncluded.entries) && emptyIncluded.entries.length === 0);

  await fs.mkdir(path.join(incDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(incDir, "assets", "manifest.json"), '{"v":1}\n', "utf8");
  const addedIncluded = await addIncludedFile(incDir, { sourcePath: "assets/manifest.json" });
  ok("add_included_file: copies to datafiles/<basename-without-extension>/ and reports that directory as filePath",
    addedIncluded.name === "manifest.json" && addedIncluded.filePath === "datafiles/manifest"
    && addedIncluded.copiedTo === "datafiles/manifest/manifest.json" && addedIncluded.added === true,
    JSON.stringify(addedIncluded));
  ok("add_included_file: the copy exists on disk with the source's bytes",
    (await fs.readFile(path.join(incDir, "datafiles", "manifest", "manifest.json"), "utf8")) === '{"v":1}\n');
  ok("add_included_file: the copy leaves no temp file behind",
    !(await fs.readdir(path.join(incDir, "datafiles", "manifest"))).some(f => f.includes(".tmp-")));
  const incYyp = await loadYyp(incDir);
  const incEntry = parseGameMakerJson(await fs.readFile(path.join(incDir, "TestProj.yyp"), "utf8")).IncludedFiles[0];
  ok("add_included_file: the written entry has exactly the captured 7 keys, in the captured order",
    keysMatchRef(incEntry, new Set(INCLUDED_FILE_KEYS))
    && JSON.stringify(Object.keys(incEntry)) === JSON.stringify([...INCLUDED_FILE_KEYS]),
    Object.keys(incEntry).join(","));
  ok("add_included_file: %Name and name are the basename with its extension; CopyToMask -1; resourceVersion 2.0",
    incEntry["%Name"] === "manifest.json" && incEntry.name === "manifest.json" && incEntry.CopyToMask === -1
    && incEntry.resourceVersion === "2.0" && incEntry.resourceType === "GMIncludedFile"
    && incEntry.$GMIncludedFile === "" && incEntry.filePath === "datafiles/manifest");
  ok("add_included_file: adds no Folders entry and no DataFiles folder node",
    ((incYyp as any).Folders ?? []).length === 0, JSON.stringify((incYyp as any).Folders));
  const listedIncluded = await listIncludedFiles(incDir);
  ok("list_included_files: reports existsOnDisk true and the real size for a registered file",
    listedIncluded.entries.length === 1 && listedIncluded.entries[0].existsOnDisk === true
    && listedIncluded.entries[0].size === 8 && listedIncluded.entries[0].filePath === "datafiles/manifest",
    JSON.stringify(listedIncluded.entries));
  const duplicateIncluded = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets/manifest.json" }));
  ok("add_included_file: a second entry with the same name is refused, naming the existing filePath",
    duplicateIncluded.includes('An included file named "manifest.json" is already registered')
    && duplicateIncluded.includes("datafiles/manifest"), duplicateIncluded);
  const dotDotTarget = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets/manifest.json", targetName: ".." }));
  ok("add_included_file: targetName \"..\" is refused (a copy cannot walk out of datafiles/)",
    dotDotTarget.includes('targetName cannot be ".."'), dotDotTarget);
  const separatorTarget = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets/manifest.json", targetName: "a/b" }));
  ok("add_included_file: a targetName with a path separator is refused",
    separatorTarget.includes("must be a single path segment"), separatorTarget);
  const missingSource = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets/nope.json" }));
  ok("add_included_file: a source that does not exist is an error naming the resolved path",
    missingSource.includes("does not exist") && missingSource.includes("nope.json"), missingSource);
  const directorySource = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets" }));
  ok("add_included_file: a directory source is refused", directorySource.includes("is not a file"), directorySource);
  const outsideTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-outside-"));
  const outsideFile = path.join(outsideTmpDir, "outside.json");
  await fs.writeFile(outsideFile, "{}\n", "utf8");
  const outsideError = await errorOf(() => addIncludedFile(incDir, { sourcePath: outsideFile, copy: false }));
  ok("add_included_file: copy: false with a source outside the project is refused ('../x' is not legal project data)",
    /outside the project/.test(outsideError), outsideError);
  await fs.rm(outsideTmpDir, { recursive: true, force: true });
  await fs.mkdir(path.join(incDir, "datafiles", "docs"), { recursive: true });
  await fs.writeFile(path.join(incDir, "datafiles", "docs", "readme.txt"), "hello\n", "utf8");
  const inPlaceAdded = await addIncludedFile(incDir, { sourcePath: "datafiles/docs/readme.txt", copy: false });
  ok("add_included_file: copy: false registers the file in place and nothing is copied",
    inPlaceAdded.copiedTo === null && inPlaceAdded.filePath === "datafiles/docs" && inPlaceAdded.name === "readme.txt",
    JSON.stringify(inPlaceAdded));

  const incRaw = parseGameMakerJson(await fs.readFile(path.join(incDir, "TestProj.yyp"), "utf8"));
  incRaw.IncludedFiles.find((e: any) => e.name === "manifest.json").extraKey = "kept";
  await fs.writeFile(path.join(incDir, "TestProj.yyp"), JSON.stringify(incRaw, null, 2), "utf8");
  await fs.writeFile(path.join(incDir, "assets", "manifest.json"), '{"v":2}\n', "utf8");
  await addIncludedFile(incDir, { sourcePath: "assets/manifest.json", overwrite: true });
  const overwrittenEntries = parseGameMakerJson(await fs.readFile(path.join(incDir, "TestProj.yyp"), "utf8")).IncludedFiles;
  const manifestEntry = overwrittenEntries.find((e: any) => e.name === "manifest.json");
  ok("add_included_file: overwrite: true replaces that entry in place -- still two entries, extra keys kept, no duplicate",
    overwrittenEntries.length === 2 && manifestEntry !== undefined
    && manifestEntry.extraKey === "kept" && manifestEntry.filePath === "datafiles/manifest",
    JSON.stringify(overwrittenEntries, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  ok("add_included_file: overwrite: true replaced the destination file's bytes",
    (await fs.readFile(path.join(incDir, "datafiles", "manifest", "manifest.json"), "utf8")) === '{"v":2}\n');
  const movedOverwrite = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets/manifest.json", targetName: "elsewhere", overwrite: true }));
  ok("add_included_file: overwrite with a different targetName is refused -- it would move the entry, drop its extra keys and orphan the old copy",
    movedOverwrite.includes('"manifest.json" is registered at "datafiles/manifest"')
    && movedOverwrite.includes('remove_included_file { name: "manifest.json" }')
    && !(await fileExists(path.join(incDir, "datafiles", "elsewhere"))), movedOverwrite);

  const removedEntry = await removeIncludedFile(incDir, { name: "readme.txt" });
  ok("remove_included_file: unregisters the entry and leaves the file on disk by default",
    removedEntry.removed === true && removedEntry.fileDeleted === false
    && (await fileExists(path.join(incDir, "datafiles", "docs", "readme.txt")))
    && (await listIncludedFiles(incDir)).entries.length === 1, JSON.stringify(removedEntry));
  const deletedEntry = await removeIncludedFile(incDir, { name: "manifest.json", deleteFile: true });
  ok("remove_included_file: deleteFile: true deletes the file and the now-empty datafiles/<targetName>/ directory",
    deletedEntry.fileDeleted === true && deletedEntry.directoryRemoved === true
    && !(await fileExists(path.join(incDir, "datafiles", "manifest", "manifest.json")))
    && !(await fileExists(path.join(incDir, "datafiles", "manifest"))), JSON.stringify(deletedEntry));
  const unknownIncluded = await errorOf(() => removeIncludedFile(incDir, { name: "nope.txt" }));
  ok("remove_included_file: an unknown name is an error that says what is registered",
    unknownIncluded.includes('No included file named "nope.txt" is registered')
    && unknownIncluded.includes("IncludedFiles is empty"), unknownIncluded);
  const ghostYyp = await loadYyp(incDir);
  (ghostYyp as any).IncludedFiles.push({
    $GMIncludedFile: "", "%Name": "ghost.lnk", CopyToMask: -1, filePath: "datafiles",
    name: "ghost.lnk", resourceType: "GMIncludedFile", resourceVersion: "2.0",
  });
  await writeYyp(incDir, ghostYyp);
  const ghostList = await listIncludedFiles(incDir);
  ok("list_included_files: a registered entry whose file is missing from disk is reported with existsOnDisk false",
    ghostList.entries.length === 1 && ghostList.entries[0].name === "ghost.lnk" && ghostList.entries[0].existsOnDisk === false,
    JSON.stringify(ghostList.entries));

  // --- F10: Windows-illegal characters and reserved device names are refused, not fs-raw EINVAL ---
  const illegalChar = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets/manifest.json", targetName: "what?" }));
  ok("add_included_file: a targetName with a Windows-illegal character (? * : \" < > |) is refused with a clear message",
    illegalChar.includes("contains a character Windows cannot put in a filename"), illegalChar);
  const reservedName = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets/manifest.json", targetName: "CON" }));
  ok("add_included_file: a reserved Windows device name is refused",
    reservedName.includes("is a reserved Windows device name (CON)"), reservedName);
  const reservedStem = await errorOf(() => addIncludedFile(incDir, { sourcePath: "assets/manifest.json", targetName: "lpt1.data" }));
  ok("add_included_file: the reserved-name check ignores the extension (lpt1.data is still LPT1)",
    reservedStem.includes("(LPT1)"), reservedStem);

  // --- F11: a removal that cannot delete the file still reports what happened ---
  await fs.mkdir(path.join(incDir, "datafiles", "docs", "subdir"), { recursive: true });
  const directoryEntryYyp = await loadYyp(incDir);
  (directoryEntryYyp as any).IncludedFiles.push({
    $GMIncludedFile: "", "%Name": "subdir", CopyToMask: -1, filePath: "datafiles/docs",
    name: "subdir", resourceType: "GMIncludedFile", resourceVersion: "2.0",
  });
  await writeYyp(incDir, directoryEntryYyp);
  const directoryRemoval = await callTool("remove_included_file", { projectDir: incDir, name: "subdir", deleteFile: true });
  const directoryResult = JSON.parse(textOf(directoryRemoval));
  ok("remove_included_file: a directory target returns removed:true + fileDeletionSkipped instead of throwing after the manifest changed",
    directoryRemoval.isError !== true && directoryResult.removed === true && directoryResult.fileDeleted === false
    && /is a directory/.test(directoryResult.fileDeletionSkipped ?? ""), textOf(directoryRemoval));
  ok("remove_included_file: the entry is gone from the .yyp and the directory it pointed at is untouched",
    JSON.stringify((await listIncludedFiles(incDir)).entries.map(e => e.name)) === JSON.stringify(["ghost.lnk"])
    && (await fileExists(path.join(incDir, "datafiles", "docs", "subdir"))),
    JSON.stringify((await listIncludedFiles(incDir)).entries.map(e => e.name)));

  // --- macros ---
  const macroDir = await makeBareProject();
  await fs.mkdir(path.join(macroDir, "scripts", "a"), { recursive: true });
  await fs.writeFile(path.join(macroDir, "scripts", "a", "a.gml"), [
    "// leading comment",
    "#macro A_ONE 1",
    '  #macro A_TWO   "not // a comment"  // real comment',
    "#macro TORN",
    "var x = 1;",
  ].join("\n") + "\n", "utf8");
  await fs.mkdir(path.join(macroDir, "scripts", "b"), { recursive: true });
  await fs.writeFile(path.join(macroDir, "scripts", "b", "b.gml"), "#macro A_ONE 2\n#macro B_ONE 3\n", "utf8");
  for (const ignoredDir of [".gm-forge/backups/x", "output", "datafiles", "options"]) {
    await fs.mkdir(path.join(macroDir, ...ignoredDir.split("/")), { recursive: true });
    await fs.writeFile(
      path.join(macroDir, ...ignoredDir.split("/"), "ignored.gml"),
      `#macro IGNORED_${ignoredDir.replace(/[^a-z]/gi, "_").toUpperCase()} 9\n`, "utf8");
  }
  const macroIndex = await listMacros(macroDir);
  ok("list_macros: reports file and 1-based line, sorted by file then line",
    JSON.stringify(macroIndex.macros.map(m => `${m.file}:${m.line}:${m.name}`)) === JSON.stringify([
      "scripts/a/a.gml:2:A_ONE", "scripts/a/a.gml:3:A_TWO", "scripts/a/a.gml:4:TORN",
      "scripts/b/b.gml:1:A_ONE", "scripts/b/b.gml:2:B_ONE",
    ]), JSON.stringify(macroIndex.macros.map(m => `${m.file}:${m.line}:${m.name}`)));
  ok("list_macros: a trailing // comment is stripped, but // inside a quoted value is content",
    macroIndex.macros.find(m => m.name === "A_TWO")?.value === '"not // a comment"',
    JSON.stringify(macroIndex.macros.find(m => m.name === "A_TWO")));
  ok("list_macros: a #macro with no value is reported with value \"\" instead of being skipped",
    macroIndex.macros.find(m => m.name === "TORN")?.value === "" && macroIndex.count === 5, String(macroIndex.count));
  ok("list_macros: duplicates carry every location and the note states GameMaker compiles the last definition",
    macroIndex.duplicates.length === 1 && macroIndex.duplicates[0].name === "A_ONE"
    && macroIndex.duplicates[0].definitions.length === 2
    && macroIndex.duplicates[0].definitions[0].file === "scripts/a/a.gml"
    && macroIndex.duplicates[0].definitions[1].file === "scripts/b/b.gml"
    && macroIndex.note === MACROS_NOTE && /last definition/.test(macroIndex.note),
    JSON.stringify(macroIndex.duplicates));
  ok("list_macros: .gm-forge/, output/, datafiles/ and options/ are never scanned",
    macroIndex.macros.every(m => m.file.startsWith("scripts/")), macroIndex.macros.map(m => m.file).join(","));
  ok("list_macros: takes no snapshot (read-only)", (await snapshotCount(macroDir)) === 0);
  ok("MACRO_LINE_RE: matched against an IDE-authored line shape from the sample project",
    MACRO_LINE_RE.test("#macro L1_CELL 32") && MACRO_LINE_RE.test("\t#macro F(X) (X)") === false);

  const firstMacro = await setMacro(macroDir, { name: "MACRO_ONE", value: "10" });
  ok("set_macro: creates scripts/macros/macros.gml and reports created/file/line 1/lf",
    firstMacro.created?.file === DEFAULT_MACRO_FILE && firstMacro.created?.script === DEFAULT_MACRO_SCRIPT
    && firstMacro.file === DEFAULT_MACRO_FILE && firstMacro.line === 1 && firstMacro.previous === null
    && firstMacro.eol === "lf", JSON.stringify(firstMacro));
  ok("set_macro: the created .gml holds exactly the one definition line",
    (await fs.readFile(path.join(macroDir, DEFAULT_MACRO_FILE), "utf8")) === "#macro MACRO_ONE 10\n");
  const macroYyp = await loadYyp(macroDir);
  ok("set_macro: the default script is registered in the .yyp resources",
    (macroYyp.resources as any[]).some(r => r.id?.name === "macros" && r.id?.path === DEFAULT_MACRO_SCRIPT),
    JSON.stringify(macroYyp.resources));
  const scriptYy = parseGameMakerJson(await fs.readFile(path.join(macroDir, DEFAULT_MACRO_SCRIPT), "utf8"));
  ok("set_macro: the script .yy carries the captured 8-key REF.script shape",
    keysMatchRef(scriptYy, REF.script), Object.keys(scriptYy).join(","));
  ok("set_macro: its parent is the nested folders/Scripts/Macros.yy node",
    scriptYy.parent?.path === "folders/Scripts/Macros.yy" && scriptYy.parent?.name === "Macros", JSON.stringify(scriptYy.parent));
  const macroFolders = parseGameMakerJson(await fs.readFile(path.join(macroDir, "TestProj.yyp"), "utf8")).Folders as any[];
  const macrosFolderNode = macroFolders.find((f: any) => f.folderPath === "folders/Scripts/Macros.yy");
  ok("set_macro: a nested folder node (6 keys, no parent field) plus its folders/Scripts.yy ancestor exist",
    macrosFolderNode !== undefined && Object.keys(macrosFolderNode).length === 6 && !("parent" in macrosFolderNode)
    && macrosFolderNode.$GMFolder === "" && macrosFolderNode.name === "Macros"
    && macroFolders.some((f: any) => f.folderPath === "folders/Scripts.yy"),
    JSON.stringify(macroFolders));
  ok("set_macro: creating the script, its .yy and the .yyp took exactly one snapshot",
    (await snapshotCount(macroDir)) === 1, String(await snapshotCount(macroDir)));

  const updatedMacro = await setMacro(macroDir, { name: "MACRO_ONE", value: "20" });
  ok("set_macro: updating an existing definition rewrites that line and reports the previous value and location",
    updatedMacro.previous?.value === "10" && updatedMacro.previous.line === 1 && updatedMacro.line === 1
    && (await fs.readFile(path.join(macroDir, DEFAULT_MACRO_FILE), "utf8")) === "#macro MACRO_ONE 20\n"
    && updatedMacro.changed === true && typeof updatedMacro.snapshotId === "string",
    JSON.stringify(updatedMacro));

  const richMacroPath = path.join(macroDir, "scripts", "a", "rich.gml");
  const richMacroText = "function f() {\n  #macro RICH_VALUE 3 // keep this comment\n  return RICH_VALUE;\n}\n";
  await fs.writeFile(richMacroPath, richMacroText, "utf8");
  const richMacro = await setMacro(macroDir, { name: "RICH_VALUE", file: "scripts/a/rich.gml", value: "4" });
  ok("set_macro: an in-place update keeps the indentation, the trailing comment and every other byte, changing only the value",
    (await fs.readFile(richMacroPath, "utf8"))
      === "function f() {\n  #macro RICH_VALUE 4 // keep this comment\n  return RICH_VALUE;\n}\n"
    && richMacro.line === 2, JSON.stringify(richMacro));

  const crlfMacroPath = path.join(macroDir, "scripts", "a", "crlf.gml");
  await fs.writeFile(crlfMacroPath, "#macro CRLF_ONE 1\r\n#macro CRLF_TWO 2\r\n", "utf8");
  const crlfMacro = await setMacro(macroDir, { name: "CRLF_TWO", file: "scripts/a/crlf.gml", value: "22" });
  ok("set_macro: a CRLF file stays CRLF and eol reports crlf",
    crlfMacro.eol === "crlf"
    && (await fs.readFile(crlfMacroPath, "utf8")) === "#macro CRLF_ONE 1\r\n#macro CRLF_TWO 22\r\n",
    crlfMacro.eol);

  const noNewlinePath = path.join(macroDir, "scripts", "a", "nonl.gml");
  await fs.writeFile(noNewlinePath, "var keep = 1;", "utf8");
  const appendedMacro = await setMacro(macroDir, { name: "NO_NL_MACRO", file: "scripts/a/nonl.gml", value: "5" });
  ok("set_macro: appending to a file with no trailing newline inserts exactly one separator",
    (await fs.readFile(noNewlinePath, "utf8")) === "var keep = 1;\n#macro NO_NL_MACRO 5" && appendedMacro.line === 2,
    JSON.stringify(appendedMacro));
  await setMacro(macroDir, { name: "NO_NL_MACRO", file: "scripts/a/nonl.gml", value: "6" });
  ok("set_macro: updating that macro again keeps the missing trailing newline",
    (await fs.readFile(noNewlinePath, "utf8")) === "var keep = 1;\n#macro NO_NL_MACRO 6");

  const elsewhereMacro = await errorOf(() => setMacro(macroDir, { name: "CRLF_ONE", value: "9" }));
  ok("set_macro: a name defined in one file is never re-created in the default file -- the error names file:line and asks for file",
    elsewhereMacro.includes('"CRLF_ONE" is already defined at scripts/a/crlf.gml:1')
    && elsewhereMacro.includes('pass file: "scripts/a/crlf.gml"'), elsewhereMacro);
  const secondDefinition = await errorOf(() => setMacro(macroDir, { name: "CRLF_ONE", value: "9", file: "scripts/b/b.gml" }));
  ok("set_macro: an explicit other file with the same name is refused as a shadowing second definition",
    /refusing to create a second definition/.test(secondDefinition), secondDefinition);
  const emptyMacroValue = await errorOf(() => setMacro(macroDir, { name: "X_ONE", value: "   " }));
  ok("set_macro: an empty value is refused", emptyMacroValue.includes("cannot be empty"), emptyMacroValue);
  const multilineMacroValue = await errorOf(() => setMacro(macroDir, { name: "X_TWO", value: "1\n2" }));
  ok("set_macro: a multi-line value is refused", multilineMacroValue.includes("single line"), multilineMacroValue);
  const wrappedMacroValue = await errorOf(() => setMacro(macroDir, { name: "X_THREE", value: "#macro Y 1" }));
  ok("set_macro: a value beginning with #macro is refused (it would double-wrap)",
    wrappedMacroValue.includes('cannot begin with "#macro"'), wrappedMacroValue);
  const commentMacroValue = await errorOf(() => setMacro(macroDir, { name: "X_FOUR", value: "1 // note" }));
  ok("set_macro: a bare trailing // is refused because it would not read back",
    commentMacroValue.includes('must not contain "//"'), commentMacroValue);
  const keywordMacroName = await errorOf(() => setMacro(macroDir, { name: "repeat", value: "1" }));
  ok("set_macro: a GML keyword as the macro name is refused", keywordMacroName.includes("is a GML keyword"), keywordMacroName);
  const badMacroName = await errorOf(() => setMacro(macroDir, { name: "1bad", value: "1" }));
  ok("set_macro: a non-identifier name is refused", badMacroName.includes("Invalid macro name"), badMacroName);
  const outsideMacroFile = await errorOf(() => setMacro(macroDir, { name: "X_FIVE", value: "1", file: "../nope.gml" }));
  ok("set_macro: a file outside the project is refused", /outside the project directory/.test(outsideMacroFile), outsideMacroFile);
  const newMacroFile = await errorOf(() => setMacro(macroDir, { name: "X_SIX", value: "1", file: "scripts/b/new.gml" }));
  ok("set_macro: only the default macro file is ever created -- an arbitrary missing .gml is refused",
    newMacroFile.includes("does not exist") && newMacroFile.includes(DEFAULT_MACRO_FILE), newMacroFile);

  // --- F8: re-setting the value that is already there is a no-op, not a rewrite ---
  const noopSnapshots = await snapshotCount(macroDir);
  const noopMacro = await setMacro(macroDir, { name: "MACRO_ONE", value: "20" });
  ok("set_macro: an identical value returns changed: false, writes no bytes, takes no snapshot and reports snapshotId null",
    noopMacro.changed === false && noopMacro.snapshotId === null && noopMacro.snapshotSkippedReason === undefined
    && noopMacro.previous?.value === "20" && noopMacro.line === 1
    && (await snapshotCount(macroDir)) === noopSnapshots
    && (await fs.readFile(path.join(macroDir, DEFAULT_MACRO_FILE), "utf8")) === "#macro MACRO_ONE 20\n",
    JSON.stringify(noopMacro));

  // --- F12: a #macro inside a /* ... */ block comment is not a definition ---
  const blockCommentPath = path.join(macroDir, "scripts", "a", "blocked.gml");
  await fs.writeFile(blockCommentPath, [
    "/*",
    "#macro DEAD_ONE 1",
    "*/",
    '#macro LIVE_ONE "/* not a comment opener */"',
    "/* #macro DEAD_TWO 2 */ #macro LIVE_TWO 3",
  ].join("\n") + "\n", "utf8");
  const blockIndex = await listMacros(macroDir);
  const blockedNames = blockIndex.macros.filter(m => m.file === "scripts/a/blocked.gml").map(m => `${m.name}=${m.value}`);
  ok("list_macros: a #macro inside a /* */ block comment is not reported as a definition",
    !blockIndex.macros.some(m => m.name === "DEAD_ONE") && !blockIndex.macros.some(m => m.name === "DEAD_TWO"),
    JSON.stringify(blockedNames));
  ok("list_macros: the block-comment scan keeps quoted strings and the code after a one-line /* */ intact",
    JSON.stringify(blockedNames) === JSON.stringify(['LIVE_ONE="/* not a comment opener */"', "LIVE_TWO=3"]),
    JSON.stringify(blockedNames));
  const deadMacro = await setMacro(macroDir, { name: "DEAD_ONE", value: "9", file: "scripts/a/blocked.gml" });
  ok("set_macro: a name that only appears inside a block comment is appended, never rewritten into live code",
    deadMacro.changed === true && deadMacro.previous === null
    && (await fs.readFile(blockCommentPath, "utf8")).startsWith("/*\n#macro DEAD_ONE 1\n*/\n")
    && (await fs.readFile(blockCommentPath, "utf8")).trimEnd().endsWith("#macro DEAD_ONE 9"),
    JSON.stringify(deadMacro));

  // --- F13: build output is never rewritten, even when it defines the name ---
  await fs.mkdir(path.join(macroDir, "output", "scripts"), { recursive: true });
  await fs.writeFile(path.join(macroDir, "output", "scripts", "generated.gml"), "#macro GEN_ONE 1\n", "utf8");
  const outputMacro = await errorOf(() => setMacro(macroDir, { name: "GEN_ONE", value: "2", file: "output/scripts/generated.gml" }));
  ok("set_macro: an in-place update inside output/ is refused (generated build output is not project source)",
    outputMacro.includes('is inside output/') && outputMacro.includes("never writes there"), outputMacro);
  ok("set_macro: the generated file is untouched",
    (await fs.readFile(path.join(macroDir, "output", "scripts", "generated.gml"), "utf8")) === "#macro GEN_ONE 1\n");

  const macroSnapshotsBefore = await snapshotCount(macroDir);
  const macroViaTool = await callTool("set_macro", { projectDir: macroDir, name: "TOOL_MACRO", value: "1" });
  ok("set_macro: the tool path writes and takes exactly one snapshot (self-snapshot, not the dispatch hook)",
    !macroViaTool.isError && (await snapshotCount(macroDir)) === macroSnapshotsBefore + 1, textOf(macroViaTool));
  ok("set_macro: set_macro is not on the auto-snapshot list", !AUTO_SNAPSHOT_TOOLS.has("set_macro"));
  const macroSnapshotsSkip = await snapshotCount(macroDir);
  await callTool("set_macro", { projectDir: macroDir, name: "SKIP_MACRO", value: "2", skipSnapshot: true });
  ok("set_macro: skipSnapshot writes without a backup",
    (await snapshotCount(macroDir)) === macroSnapshotsSkip
    && (await fs.readFile(path.join(macroDir, DEFAULT_MACRO_FILE), "utf8")).includes("#macro SKIP_MACRO 2"));

  const sampleYypPath = "E:\\GMprojects\\261103GJ\\261103GJ.yyp";
  if (await fileExists(sampleYypPath)) {
    // Deliberately not pinned to "42 macros across 7 files": that count changes
    // the moment the user adds a macro in the IDE, and a suite that fails on a
    // user's own edit teaches people to ignore it. What matters is that the scan
    // reads real source, finds no invented duplicates, and never reaches a
    // tool-owned (dotted) directory.
    const realMacros = await listMacros("E:\\GMprojects\\261103GJ");
    const realMacroFiles = new Set(realMacros.macros.map(m => m.file));
    ok("list_macros: the read-only sample yields definitions from real source files, with no duplicate names",
      realMacros.count > 0 && realMacros.count === realMacros.macros.length && realMacros.duplicates.length === 0,
      `${realMacros.count} macros / ${realMacroFiles.size} files / ${realMacros.duplicates.length} duplicates`);
    ok("list_macros: no reported file sits under a dot-directory (its .gamemaker-mcp backups are not scanned)",
      realMacros.macros.every(m => m.file.split("/").every(segment => !segment.startsWith("."))),
      [...realMacroFiles].filter(f => f.split("/").some(s => s.startsWith("."))).join(","));
  } else {
    skip("list_macros: the read-only sample project (sample project not present on this machine)");
  }

  // --- the snapshot asymmetry (one snapshot per write tool, not two) ---
  ok("snapshots: add_included_file and remove_included_file are on the auto-snapshot list",
    AUTO_SNAPSHOT_TOOLS.has("add_included_file") && AUTO_SNAPSHOT_TOOLS.has("remove_included_file"));
  const oneSnapshotDir = await makeBareProject();
  await fs.mkdir(path.join(oneSnapshotDir, "options", "windows"), { recursive: true });
  await fs.copyFile(
    path.join(fixturesPath, "options", "windows", "options_windows.yy"),
    path.join(oneSnapshotDir, "options", "windows", "options_windows.yy"));
  await fs.writeFile(path.join(oneSnapshotDir, "payload.txt"), "one\n", "utf8");
  await fs.writeFile(path.join(oneSnapshotDir, "source.txt"), "src\n", "utf8");
  const writeToolCalls: Array<[string, Record<string, unknown>]> = [
    ["set_project_option", { platform: "windows", key: "interpolate_pixels", value: true }],
    ["set_macro", { name: "ONE_SNAPSHOT", value: "1" }],
    ["add_included_file", { sourcePath: "source.txt" }],
    ["remove_included_file", { name: "source.txt" }],
    ["patch_file", { path: "payload.txt", find: "one", replace: "two" }],
  ];
  for (const [name, extra] of writeToolCalls) {
    const before = await snapshotCount(oneSnapshotDir);
    const response = await callTool(name, { projectDir: oneSnapshotDir, ...extra });
    const snapshotsAfter = (await listSnapshots(oneSnapshotDir)).snapshots;
    ok(`snapshots: ${name} makes exactly one snapshot per successful call (not zero, not two)`,
      !response.isError && snapshotsAfter.length === before + 1 && (snapshotsAfter[0] as any).tool === name,
      `${textOf(response).slice(0, 120)} | ${JSON.stringify(snapshotsAfter.map(s => (s as any).tool))}`);
  }
  await fs.writeFile(path.join(oneSnapshotDir, "second.txt"), "2\n", "utf8");
  const skipAddBefore = await snapshotCount(oneSnapshotDir);
  const skippedAdd = await callTool("add_included_file", { projectDir: oneSnapshotDir, sourcePath: "second.txt", skipSnapshot: true });
  ok("snapshots: skipSnapshot on add_included_file writes without a backup and says the backup was skipped",
    (await snapshotCount(oneSnapshotDir)) === skipAddBefore
    && (await listIncludedFiles(oneSnapshotDir)).entries.some(e => e.name === "second.txt")
    && textOf(skippedAdd).includes("snapshot skipped on request"), textOf(skippedAdd));

  // --- the .yyp $GM* version tags survive a save (see writeYyp) ---
  // Captured shape of a real 261103GJ.yyp: single-line records, trailing
  // commas before ] and }, the `$GM<Class>` tags GameMaker writes, and (for an
  // audio group) `exportDir`. @bscotch/yy's project schema names none of them.
  const sampleShapedYyp = `{
  "$GMProject":"v1",
  "%Name":"TagProbe",
  "AudioGroups":[
    {"$GMAudioGroup":"v1","%Name":"audiogroup_default","exportDir":"","name":"audiogroup_default","resourceType":"GMAudioGroup","resourceVersion":"2.0","targets":-1,},
  ],
  "configs":{
    "children":[],
    "name":"Default",
  },
  "defaultScriptType":1,
  "Folders":[
    {"$GMFolder":"","%Name":"Scripts","folderPath":"folders/Scripts.yy","name":"Scripts","resourceType":"GMFolder","resourceVersion":"2.0",},
  ],
  "ForcedPrefabProjectReferences":[],
  "IncludedFiles":[
    {"$GMIncludedFile":"","%Name":"a.lnk","CopyToMask":-1,"filePath":"datafiles","name":"a.lnk","resourceType":"GMIncludedFile","resourceVersion":"2.0",},
  ],
  "isEcma":false,
  "LibraryEmitters":[],
  "MetaData":{
    "IDEVersion":"2026.0.0.16",
  },
  "name":"TagProbe",
  "resources":[
    {"id":{"name":"obj_a","path":"objects/obj_a/obj_a.yy",},},
  ],
  "resourceType":"GMProject",
  "resourceVersion":"2.0",
  "RoomOrderNodes":[],
  "templateType":"game",
  "TextureGroups":[
    {"$GMTextureGroup":"","%Name":"Default","autocrop":true,"border":2,"compressFormat":"bz2","customOptions":"","directory":"","groupParent":null,"isScaled":true,"loadType":"default","mipsToGenerate":0,"name":"Default","resourceType":"GMTextureGroup","resourceVersion":"2.0","targets":-1,},
  ],
}`;
  const tagDir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-yyp-tags-"));
  const tagYypPath = path.join(tagDir, "TagProbe.yyp");
  await fs.writeFile(tagYypPath, sampleShapedYyp, "utf8");
  await writeYyp(tagDir, await loadYyp(tagDir));
  const tagNoop = await fs.readFile(tagYypPath, "utf8");
  ok("writeYyp: a no-op save of a GameMaker-shaped .yyp is byte-identical (\"$GMAudioGroup\":\"v1\" and exportDir survive)",
    tagNoop === sampleShapedYyp,
    `${sampleShapedYyp.length} -> ${tagNoop.length} bytes`);
  const tagYyp = await loadYyp(tagDir);
  (tagYyp.resources as any[]).push({ id: { name: "scr_z", path: "scripts/scr_z/scr_z.yy" } });
  await writeYyp(tagDir, tagYyp);
  const tagEdited = await fs.readFile(tagYypPath, "utf8");
  const tagNoopLines = sampleShapedYyp.split("\n");
  const tagEditedLines = tagEdited.split("\n");
  ok("writeYyp: a real edit changes only the changed key -- the tag and exportDir are still there",
    tagEdited.includes('"$GMAudioGroup":"v1"') && tagEdited.includes('"exportDir":""')
    && tagEdited.includes('{"id":{"name":"scr_z","path":"scripts/scr_z/scr_z.yy",},},'));
  ok("writeYyp: output line count grows by exactly the one added resource",
    tagEditedLines.length === tagNoopLines.length + 1,
    `${tagNoopLines.length} -> ${tagEditedLines.length}`);
  const survivingYyp = await loadYyp(tagDir);
  (survivingYyp as any).AudioGroups.push({
    $GMAudioGroup: "", "%Name": "audiogroup_b", exportDir: "", name: "audiogroup_b",
    resourceType: "GMAudioGroup", resourceVersion: "2.0", targets: BigInt(-1),
  });
  await writeYyp(tagDir, survivingYyp);
  const afterPush = await loadYyp(tagDir);
  (afterPush as any).AudioGroups = (afterPush as any).AudioGroups.filter((g: any) => g.name === "audiogroup_b");
  await writeYyp(tagDir, afterPush);
  const survivor = parseGameMakerJson(await fs.readFile(tagYypPath, "utf8")).AudioGroups;
  ok("writeYyp: dropping an audio group entry never hands its $GM tag to the entry that takes its place",
    survivor.length === 1 && survivor[0].name === "audiogroup_b" && survivor[0].$GMAudioGroup === "",
    JSON.stringify(survivor));
  await fs.rm(tagDir, { recursive: true, force: true });

  // --- F4: only the keys the schema is known to drop are restored ---
  const restoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-yyp-restore-"));
  const restoreShape = sampleShapedYyp
    .replace('"Folders":[\n    {"$GMFolder":"","%Name":"Scripts"', '"Folders":[\n    {"$GMFolder":"","customTag":"x","%Name":"Scripts"')
    .replace('"configs":{', '"Options":[],\n  "configs":{');
  await fs.writeFile(path.join(restoreDir, "TagProbe.yyp"), restoreShape, "utf8");
  await writeYyp(restoreDir, await loadYyp(restoreDir));
  const restored = parseGameMakerJson(await fs.readFile(path.join(restoreDir, "TagProbe.yyp"), "utf8"));
  ok("writeYyp: the $GM tag is still restored, but an unmodelled key on a folder entry is NOT resurrected",
    restored.Folders[0].$GMFolder === "" && !("customTag" in restored.Folders[0]),
    JSON.stringify(restored.Folders[0]));
  ok("writeYyp: the restoration never re-adds an \"Options\": [] that yypSchema's preprocess deliberately deletes",
    !("Options" in restored), JSON.stringify(Object.keys(restored)));
  await fs.rm(restoreDir, { recursive: true, force: true });

  // --- F5: resourceVersion is @bscotch/yy's migration, pinned so the limit is visible ---
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-yyp-legacy-"));
  const legacyShape = sampleShapedYyp
    .split("\n")
    .map(line => (line.includes('"groupParent":null') ? line.replace('"resourceVersion":"2.0"', '"resourceVersion":"1.3"') : line))
    .join("\n");
  await fs.writeFile(path.join(legacyDir, "TagProbe.yyp"), legacyShape, "utf8");
  await writeYyp(legacyDir, await loadYyp(legacyDir));
  const legacyWritten = await fs.readFile(path.join(legacyDir, "TagProbe.yyp"), "utf8");
  ok("writeYyp: a legacy resourceVersion (1.3 on a texture group) is upgraded to 2.0 by @bscotch/yy -- documented, not restored",
    legacyWritten.includes('"resourceVersion":"2.0","targets":-1,}') && !legacyWritten.includes('"resourceVersion":"1.3"'),
    legacyWritten.split("\n").find(line => line.includes("groupParent")) ?? "");
  ok("writeYyp: that upgrade is the only difference from the game-shaped input at 1.3 (tags/exportDir still preserved)",
    legacyWritten.split("\n").filter((line, i) => line !== legacyShape.split("\n")[i]).length === 1
    && legacyWritten.includes('"$GMAudioGroup":"v1"') && legacyWritten.includes('"exportDir":""'),
    String(legacyWritten.split("\n").filter((line, i) => line !== legacyShape.split("\n")[i]).length));
  await fs.rm(legacyDir, { recursive: true, force: true });

  // --- F6: the fidelity restore is best-effort; it can never block a save ---
  const unreadableDir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-yyp-unreadable-"));
  await fs.writeFile(path.join(unreadableDir, "TagProbe.yyp"), sampleShapedYyp, "utf8");
  const unreadableYyp = await loadYyp(unreadableDir);
  await fs.writeFile(path.join(unreadableDir, "TagProbe.yyp"), "{ this is not json at all", "utf8");
  let unreadableThrew = "";
  try {
    await writeYyp(unreadableDir, unreadableYyp);
  } catch (e: any) {
    unreadableThrew = e?.message ?? String(e);
  }
  ok("writeYyp: an on-disk .yyp that cannot be parsed skips the restore instead of failing the save",
    unreadableThrew === "" && (await fileExists(path.join(unreadableDir, "TagProbe.yyp"))),
    unreadableThrew || "no throw");
  ok("writeYyp: the save still wrote a complete, parseable .yyp",
    JSON.stringify(Object.keys(parseGameMakerJson(await fs.readFile(path.join(unreadableDir, "TagProbe.yyp"), "utf8")))).includes("resources"));
  const yypSourceNow = await fs.readFile(path.join(process.cwd(), "src", "gm", "yyp.ts"), "utf8");
  ok("writeYyp: the restore's read tolerates every error (no ENOENT-only rethrow that could fail a save)",
    /async function readTextIfExists[\s\S]{0,200}catch \{\s*return null;/.test(yypSourceNow)
    && !/async function readTextIfExists[\s\S]{0,200}ENOENT/.test(yypSourceNow));
  await fs.rm(unreadableDir, { recursive: true, force: true });

  if (await fileExists(sampleYypPath)) {
    const realCopyDir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-yyp-sample-"));
    await fs.copyFile(sampleYypPath, path.join(realCopyDir, "261103GJ.yyp"));
    const realBefore = await fs.readFile(path.join(realCopyDir, "261103GJ.yyp"), "utf8");
    await writeYyp(realCopyDir, await loadYyp(realCopyDir));
    const realAfter = await fs.readFile(path.join(realCopyDir, "261103GJ.yyp"), "utf8");
    ok("writeYyp: the real sample .yyp round-trips byte-identically on a temp copy (never in place)",
      realBefore === realAfter, `${realBefore.length} -> ${realAfter.length} bytes`);
    await fs.rm(realCopyDir, { recursive: true, force: true });
  } else {
    skip("writeYyp: the real sample .yyp tag-preserving round-trip (sample project not present on this machine)");
  }

  // --- registry: 7 project-config tools, 68 total ---
  const configToolNames = ["get_project_options", "set_project_option", "list_included_files",
    "add_included_file", "remove_included_file", "list_macros", "set_macro"];
  for (const name of configToolNames) {
    ok(`registry: ${name} is in TOOL_DEFS`, TOOL_DEFS.some(d => d.name === name));
    ok(`registry: ${name} has a live dispatchTool case`, indexSource.includes(`case "${name}":`));
    ok(`registry: ${name} is documented in README.md`, readmeSource.includes(`\`${name}\``));
  }
  ok("registry: every project-config schema requires projectDir",
    configToolNames.every(n => !TOOL_DEFS.find(d => d.name === n)!.schema.safeParse({}).success));
  const setOptionSchemaSource = indexSource.slice(indexSource.indexOf("const SetProjectOptionSchema"), indexSource.indexOf("const ListIncludedFilesSchema"));
  ok("registry: set_project_option.key stays a free string so the module, not zod, explains the read-only/unverified reasons",
    /key: z\.string\(\)/.test(setOptionSchemaSource) && !/key: z\.enum/.test(setOptionSchemaSource)
    && setOptionSchemaSource.includes("option_gameguid") === false);
  ok("registry: the two included-file writers advertise skipSnapshot (the hook's opt-out) like every other auto-snapshot tool",
    ["add_included_file", "remove_included_file"].every(n =>
      TOOL_DEFS.find(d => d.name === n)!.schema.safeParse({ projectDir: dir, skipSnapshot: true, ...(n === "add_included_file" ? { sourcePath: "x.txt" } : { name: "x.txt" }) }).success));
  const includedFilesSource = await fs.readFile(path.join(process.cwd(), "src", "gm", "included_files.ts"), "utf8");
  ok("registry: the included-file module takes no skipSnapshot of its own -- the dispatch hook is the only opt-out, so there is one place to change",
    /export interface AddIncludedFileOptions \{[\s\S]{0,300}\}/.test(includedFilesSource)
    && !/export interface AddIncludedFileOptions \{[\s\S]{0,300}skipSnapshot/.test(includedFilesSource));
  ok("registry: README documents the .gm-forge store, its retention, skipSnapshot and the $GM tag rule",
    readmeSource.includes(".gm-forge/") && /keeps the newest 20/.test(readmeSource)
    && /\$GMAudioGroup/.test(readmeSource) && /exactly one snapshot per successful call/.test(readmeSource));

  await fs.rm(optionsDir, { recursive: true, force: true });
  await fs.rm(incDir, { recursive: true, force: true });
  await fs.rm(macroDir, { recursive: true, force: true });
  await fs.rm(oneSnapshotDir, { recursive: true, force: true });


  // ===== Sprite frames (subproject B: list/add/remove/replace/reorder/trim) =====
  // A frame is TWO pngs -- the composite sprites/<name>/<guid>.png and the
  // per-layer copy sprites/<name>/layers/<guid>/<layerId>.png -- so every
  // assertion below checks both. A sprite missing the second one parses as
  // valid JSON and is still refused by GameMaker, which is exactly the failure
  // a .yy-only test cannot see.
  const sfFixture = (file: string) => path.join(process.cwd(), "test/fixtures/frames", file);
  // frame0.png is the 16x24 fixture the sprite block above already imports; it stays
  // at the top level because one pre-existing test imports that directory wholesale.
  const sfFrame0 = path.join(process.cwd(), "test/fixtures/frame0.png");
  const sfSrcDir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-mcp-sfsrc-"));
  const sfBaseDir = await makeBareProject();
  const sfCopyRoots: string[] = [];

  const sfRead = async (projectDir: string, name = "sprFrames"): Promise<any> =>
    JSON.parse(await fs.readFile(path.join(projectDir, "sprites", name, `${name}.yy`), "utf8"));
  const sfTrack = (sprite: any): any =>
    (sprite.sequence?.tracks ?? []).find((t: any) => t?.name === "frames" && t?.resourceType === "GMSpriteFramesTrack");
  const sfKeyframes = (sprite: any): any[] => sfTrack(sprite)?.keyframes?.Keyframes ?? [];
  // The one invariant every writer must leave behind: the three counts agree and
  // Key[i] === i. Neither condition is visible to a JSON parse or to
  // get_sprite_info.
  const sfInvariantHolds = (sprite: any): boolean => {
    const keyframes = sfKeyframes(sprite);
    return sprite.frames.length === keyframes.length
      && sprite.frames.length === sprite.sequence.length
      && keyframes.every((k: any, i: number) => k.Key === i);
  };
  const sfLayerId = (sprite: any): string => sprite.layers[0].name;
  const sfBothPngs = async (projectDir: string, sprite: any, guid: string, name = "sprFrames"): Promise<boolean> =>
    (await fileExists(path.join(projectDir, "sprites", name, `${guid}.png`)))
    && (await fileExists(path.join(projectDir, "sprites", name, "layers", guid, `${sfLayerId(sprite)}.png`)));
  const sfAllPngsPresent = async (projectDir: string, name = "sprFrames"): Promise<boolean> => {
    const sprite = await sfRead(projectDir, name);
    for (const frame of sprite.frames) {
      if (!(await sfBothPngs(projectDir, sprite, frame.name, name))) return false;
    }
    return true;
  };
  const sfFrameFilesGone = async (projectDir: string, guid: string, name = "sprFrames"): Promise<boolean> =>
    !(await fileExists(path.join(projectDir, "sprites", name, `${guid}.png`)))
    && !(await fileExists(path.join(projectDir, "sprites", name, "layers", guid)));
  // Bytes AND mtime: a writer that re-serialises an unchanged sprite produces an
  // identical file, so only the timestamp proves it never wrote.
  const sfBaseline = async (projectDir: string, name = "sprFrames") => {
    const file = path.join(projectDir, "sprites", name, `${name}.yy`);
    return { bytes: await fs.readFile(file), mtimeMs: (await fs.stat(file)).mtimeMs };
  };
  const sfUntouched = async (projectDir: string, before: { bytes: Buffer; mtimeMs: number }, name = "sprFrames"): Promise<boolean> => {
    const file = path.join(projectDir, "sprites", name, `${name}.yy`);
    const after = await fs.readFile(file);
    return after.equals(before.bytes) && (await fs.stat(file)).mtimeMs === before.mtimeMs;
  };
  const sfExpectError = async (label: string, fn: () => Promise<unknown>, patterns: RegExp[]) => {
    try {
      await fn();
      ok(label, false, "expected an error, none was thrown");
    } catch (e: any) {
      const message = e?.message ?? String(e);
      ok(label, patterns.every((re) => re.test(message)), message);
    }
  };
  // Every mutation test starts from its own copy of the 4-frame fixture project,
  // so a refusal can be proven byte-identical instead of "probably fine".
  const sfCopy = async (): Promise<string> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gm-mcp-sf-"));
    const dst = path.join(root, "proj");
    await fs.cp(sfBaseDir, dst, { recursive: true });
    sfCopyRoots.push(root);
    return dst;
  };

  const sfFourDir = path.join(sfSrcDir, "four");
  const sfOneDir = path.join(sfSrcDir, "one");
  await fs.mkdir(sfFourDir, { recursive: true });
  await fs.mkdir(sfOneDir, { recursive: true });
  await fs.copyFile(sfFrame0, path.join(sfFourDir, "a.png"));
  await fs.copyFile(sfFrame0, path.join(sfFourDir, "b.png"));
  await fs.copyFile(sfFrame0, path.join(sfFourDir, "c.png"));
  await fs.copyFile(sfFixture("frame1.png"), path.join(sfFourDir, "d.png"));
  await fs.copyFile(sfFrame0, path.join(sfOneDir, "a.png"));

  let sfYyp = await loadYyp(sfBaseDir);
  sfYyp = await addSpriteFromImages(sfBaseDir, sfYyp, "sprFrames", sfFourDir);
  sfYyp = await addSpriteFromImages(sfBaseDir, sfYyp, "sprOne", sfOneDir);
  await writeYyp(sfBaseDir, sfYyp);

  const sfStart = await sfRead(sfBaseDir);
  const sfStartGuids: string[] = sfStart.frames.map((f: any) => f.name);
  const sfStartKeyframeIds: string[] = sfKeyframes(sfStart).map((k: any) => k.id);
  ok("sprite frames: the fixture project is a 4-frame sprite whose frames, keyframes and sequence.length all agree",
    sfStartGuids.length === 4 && sfInvariantHolds(sfStart), JSON.stringify({ frames: sfStartGuids.length }));
  ok("sprite frames: the writer's keyframe, its Channels[\"0\"], its Id, the track and the keyframe store all match the real GameMaker key-sets",
    keysMatchRef(sfKeyframes(sfStart)[0], REF.spriteFrameKeyframe)
    && keysMatchRef(sfKeyframes(sfStart)[0].Channels["0"], REF.spriteFrameKeyframeChannel)
    && keysMatchRef(sfKeyframes(sfStart)[0].Channels["0"].Id, REF.spriteFrameKeyframeId)
    && keysMatchRef(sfTrack(sfStart), REF.spriteFramesTrack)
    && keysMatchRef(sfTrack(sfStart).keyframes, REF.spriteFrameKeyframeStore));

  // --- list_sprite_frames: populated ---
  const sfListDir = await sfCopy();
  const sfListBaseline = await sfBaseline(sfListDir);
  const sfList = await listSpriteFrames(sfListDir, "sprFrames");
  ok("list_sprite_frames: reports the sprite's real 16x24 size and 4 frames",
    sfList.width === 16 && sfList.height === 24 && sfList.frameCount === 4 && sfList.frames.length === 4,
    JSON.stringify({ w: sfList.width, h: sfList.height, n: sfList.frameCount }));
  ok("list_sprite_frames: every frame carries its index, guid and project-relative composite path",
    sfList.frames.every((f: any, i: number) => f.index === i && f.guid === sfStartGuids[i]
      && f.file === `sprites/sprFrames/${f.guid}.png`), JSON.stringify(sfList.frames[0]));
  ok("list_sprite_frames: every frame is existsOnDisk because both png copies are there",
    sfList.frames.every((f: any) => f.existsOnDisk === true) && sfList.missingFiles.length === 0);
  ok("list_sprite_frames: reports sequence.length 4, keyframeCount 4 and playbackSpeed from the file",
    sfList.sequence.length === 4 && sfList.sequence.keyframeCount === 4 && typeof sfList.sequence.playbackSpeed === "number",
    JSON.stringify(sfList.sequence));
  ok("list_sprite_frames: verdict is the literal \"ok\" for a consistent sprite", sfList.verdict === "ok", sfList.verdict);
  ok("list_sprite_frames: reads sequence.xorigin/yorigin as the origin pair", sfList.origin.x === 0 && sfList.origin.y === 0);
  ok("list_sprite_frames: is read-only -- the .yy is byte- and mtime-identical after the call", await sfUntouched(sfListDir, sfListBaseline));
  await expectThrows("list_sprite_frames: rejects a sprite that does not exist", () => listSpriteFrames(sfListDir, "sprDoesNotExist"));

  // --- list_sprite_frames: a missing per-layer png is visible without opening the IDE ---
  const sfMissingDir = await sfCopy();
  const sfMissingSprite = await sfRead(sfMissingDir);
  const sfMissingGuid = sfMissingSprite.frames[2].name;
  await fs.rm(path.join(sfMissingDir, "sprites", "sprFrames", "layers", sfMissingGuid), { recursive: true, force: true });
  const sfMissing = await listSpriteFrames(sfMissingDir, "sprFrames");
  ok("list_sprite_frames: a frame whose per-layer copy is gone reports existsOnDisk false",
    sfMissing.frames[2].existsOnDisk === false && sfMissing.frames[0].existsOnDisk === true);
  ok("list_sprite_frames: missingFiles names the absent per-layer path, project-relative",
    sfMissing.missingFiles.length === 1
    && sfMissing.missingFiles[0] === `sprites/sprFrames/layers/${sfMissingGuid}/${sfLayerId(sfMissingSprite)}.png`,
    JSON.stringify(sfMissing.missingFiles));
  ok("list_sprite_frames: the verdict stays \"ok\" for missing files -- the mismatch string is about counts only",
    sfMissing.verdict === "ok", sfMissing.verdict);

  // --- list_sprite_frames: hand-injected 4-vs-3 mismatch ---
  const sfMismatchDir = await sfCopy();
  {
    const file = path.join(sfMismatchDir, "sprites/sprFrames/sprFrames.yy");
    const injected = JSON.parse(await fs.readFile(file, "utf8"));
    sfTrack(injected).keyframes.Keyframes.pop();
    await fs.writeFile(file, JSON.stringify(injected, null, 2), "utf8");
  }
  const sfMismatchList = await listSpriteFrames(sfMismatchDir, "sprFrames");
  ok("list_sprite_frames: a hand-injected mismatch reports 4 frames and 3 keyframes",
    sfMismatchList.frameCount === 4 && sfMismatchList.sequence.keyframeCount === 3);
  ok("list_sprite_frames: the verdict spells the mismatch out as \"frames-vs-sequence mismatch: 4 vs 3\"",
    sfMismatchList.verdict === "frames-vs-sequence mismatch: 4 vs 3", sfMismatchList.verdict);

  // --- add_sprite_frame: omitted index appends ---
  const sfAddDir = await sfCopy();
  const sfAddResult = await addSpriteFrame(sfAddDir, "sprFrames", sfFrame0);
  const sfAddSprite = await sfRead(sfAddDir);
  const sfAddGuids: string[] = sfAddSprite.frames.map((f: any) => f.name);
  const sfNewGuid = sfAddGuids[4];
  ok("add_sprite_frame: an omitted index appends at frameCount and returns index 4 / frameCount 5",
    sfAddResult.index === 4 && sfAddResult.frameCount === 5 && sfAddResult.spriteName === "sprFrames",
    JSON.stringify(sfAddResult));
  ok("add_sprite_frame: frames.length === keyframeCount === sequence.length === 5, Key renumbered 0..4",
    sfInvariantHolds(sfAddSprite) && sfAddSprite.frames.length === 5 && sfAddSprite.sequence.length === 5);
  ok("add_sprite_frame: the appended frame keeps the old 4 frames in order and adds a fifth guid at the end",
    sfStartGuids.every((guid, i) => sfAddGuids[i] === guid) && !sfStartGuids.includes(sfNewGuid));
  ok("add_sprite_frame: the new frame has both png copies with the source bytes",
    (await sfBothPngs(sfAddDir, sfAddSprite, sfNewGuid))
    && (await fs.readFile(path.join(sfAddDir, "sprites/sprFrames", `${sfNewGuid}.png`))).equals(await fs.readFile(sfFrame0)));
  ok("add_sprite_frame: every surviving frame keeps its own keyframe id (no keyframe is regenerated)",
    sfStartGuids.every((guid) => {
      const at = sfAddGuids.indexOf(guid);
      return sfKeyframes(sfAddSprite)[at].id === sfStartKeyframeIds[sfStartGuids.indexOf(guid)];
    }));
  ok("add_sprite_frame: the new keyframe's channel points at the new guid and its id is a fresh guid",
    sfKeyframes(sfAddSprite)[4].Channels["0"].Id.name === sfNewGuid
    && !sfStartKeyframeIds.includes(sfKeyframes(sfAddSprite)[4].id)
    && sfKeyframes(sfAddSprite)[4].Channels["0"].Id.path === "sprites/sprFrames/sprFrames.yy");

  // --- add_sprite_frame: a middle index inserts before that frame ---
  const sfInsertDir = await sfCopy();
  const sfInsertResult = await addSpriteFrame(sfInsertDir, "sprFrames", sfFixture("frame1.png"), 1);
  const sfInsertSprite = await sfRead(sfInsertDir);
  const sfInsertGuids: string[] = sfInsertSprite.frames.map((f: any) => f.name);
  ok("add_sprite_frame: index 1 inserts before the old frame 1 and returns index 1 / frameCount 5",
    sfInsertResult.index === 1 && sfInsertResult.frameCount === 5 && sfInsertGuids[0] === sfStartGuids[0]
    && !sfStartGuids.includes(sfInsertGuids[1]) && sfInsertGuids[2] === sfStartGuids[1],
    JSON.stringify(sfInsertGuids));
  ok("add_sprite_frame: an inserted frame leaves the counts and Key order consistent",
    sfInvariantHolds(sfInsertSprite) && sfKeyframes(sfInsertSprite)[1].Channels["0"].Id.name === sfInsertGuids[1]);
  ok("add_sprite_frame: the inserted frame's keyframe is the only regenerated one; the others keep their ids",
    sfStartGuids.every((guid) => {
      const at = sfInsertGuids.indexOf(guid);
      return sfKeyframes(sfInsertSprite)[at].id === sfStartKeyframeIds[sfStartGuids.indexOf(guid)];
    }));
  ok("add_sprite_frame: both png copies exist for the inserted frame and for every survivor",
    await sfAllPngsPresent(sfInsertDir));

  // --- add_sprite_frame: an explicit index equal to frameCount also appends ---
  const sfExplicitDir = await sfCopy();
  const sfExplicitResult = await addSpriteFrame(sfExplicitDir, "sprFrames", sfFrame0, 4);
  const sfExplicitSprite = await sfRead(sfExplicitDir);
  ok("add_sprite_frame: an explicit index equal to frameCount appends rather than refusing",
    sfExplicitResult.index === 4 && sfExplicitResult.frameCount === 5
    && sfExplicitSprite.frames[4].name !== sfStartGuids[0] && sfInvariantHolds(sfExplicitSprite));

  // --- add_sprite_frame: refusals write nothing ---
  const sfAddErrorDir = await sfCopy();
  const sfAddErrorBaseline = await sfBaseline(sfAddErrorDir);
  await sfExpectError("add_sprite_frame: an out-of-range index is refused naming the valid range and that frameCount appends",
    () => addSpriteFrame(sfAddErrorDir, "sprFrames", sfFrame0, 5),
    [/frame index 5 is out of range/, /4 frames/, /valid range is 0\.\.4/, /4 appends/]);
  await sfExpectError("add_sprite_frame: -1 is refused (there is no last-frame shorthand)",
    () => addSpriteFrame(sfAddErrorDir, "sprFrames", sfFrame0, -1),
    [/frame index -1 is out of range/, /valid range is 0\.\.4/]);
  await sfExpectError("add_sprite_frame: a source file that does not exist is refused by name",
    () => addSpriteFrame(sfAddErrorDir, "sprFrames", path.join(sfSrcDir, "nope.png")),
    [/does not exist/]);
  await sfExpectError("add_sprite_frame: a non-PNG source is refused as not a readable PNG",
    () => addSpriteFrame(sfAddErrorDir, "sprFrames", path.join(process.cwd(), "README.md")),
    [/not a readable PNG/]);
  await sfExpectError("add_sprite_frame: a size mismatch is refused naming both sizes and forbidding implicit resize",
    () => addSpriteFrame(sfAddErrorDir, "sprFrames", sfFixture("frame_wide.png")),
    [/24x24/, /16x24/, /same size/, /no implicit resize/]);
  ok("add_sprite_frame: every refusal leaves the .yy byte- and mtime-identical",
    await sfUntouched(sfAddErrorDir, sfAddErrorBaseline));
  ok("add_sprite_frame: and no extra frame png was left behind by the refused calls",
    (await fs.readdir(path.join(sfAddErrorDir, "sprites/sprFrames"))).filter((f) => f.endsWith(".png")).length === 4);

  // --- remove_sprite_frame: middle ---
  const sfRemoveDir = await sfCopy();
  const sfRemoveResult = await removeSpriteFrame(sfRemoveDir, "sprFrames", 1);
  const sfRemoveSprite = await sfRead(sfRemoveDir);
  ok("remove_sprite_frame: removing index 1 reports the removed guid and frameCount 3",
    sfRemoveResult.removedGuid === sfStartGuids[1] && sfRemoveResult.frameCount === 3, JSON.stringify(sfRemoveResult));
  ok("remove_sprite_frame: the surviving order is 0,2,3 with counts and Key still agreeing",
    JSON.stringify(sfRemoveSprite.frames.map((f: any) => f.name)) === JSON.stringify([sfStartGuids[0], sfStartGuids[2], sfStartGuids[3]])
    && sfInvariantHolds(sfRemoveSprite));
  ok("remove_sprite_frame: the removed frame's composite png AND its layers/<guid>/ directory are gone",
    await sfFrameFilesGone(sfRemoveDir, sfStartGuids[1]));
  ok("remove_sprite_frame: the survivors keep both png copies",
    await sfAllPngsPresent(sfRemoveDir));
  ok("remove_sprite_frame: a clean delete reports an empty leftoverFiles list",
    Array.isArray(sfRemoveResult.leftoverFiles) && sfRemoveResult.leftoverFiles.length === 0,
    JSON.stringify(sfRemoveResult.leftoverFiles));

  // --- remove_sprite_frame: a delete that fails AFTER the .yy has landed ---
  // The .yy change must not be reported as a failure: a user retrying
  // remove_sprite_frame(index) would remove a different frame. The undeletable
  // path is reported instead. (A directory where the composite png belongs is
  // the deterministic stand-in for a file GameMaker is holding open.)
  const sfLeftoverDir = await sfCopy();
  const sfLeftoverGuid = sfStartGuids[1];
  const sfLeftoverPath = path.join(sfLeftoverDir, "sprites/sprFrames", `${sfLeftoverGuid}.png`);
  await fs.rm(sfLeftoverPath, { force: true });
  await fs.mkdir(sfLeftoverPath, { recursive: true });
  const sfLeftoverResult = await removeSpriteFrame(sfLeftoverDir, "sprFrames", 1);
  ok("remove_sprite_frame: an undeletable png does not turn the completed frame-list change into a failure",
    sfLeftoverResult.frameCount === 3 && sfLeftoverResult.leftoverFiles.length === 1,
    JSON.stringify(sfLeftoverResult));
  ok("remove_sprite_frame: the leftover is named project-relative with its error code, and the layer copy was still deleted",
    sfLeftoverResult.leftoverFiles[0] === `sprites/sprFrames/${sfLeftoverGuid}.png (ERR_FS_EISDIR)`
    && !(await fileExists(path.join(sfLeftoverDir, "sprites/sprFrames/layers", sfLeftoverGuid))),
    JSON.stringify(sfLeftoverResult.leftoverFiles));
  ok("remove_sprite_frame: and the .yy it did write is consistent (3 frames, 3 keyframes, length 3)",
    sfInvariantHolds(await sfRead(sfLeftoverDir)));

  const sfLeftoverCallDir = await sfCopy();
  const sfLeftoverCallPath = path.join(sfLeftoverCallDir, "sprites/sprFrames", `${sfStartGuids[2]}.png`);
  await fs.rm(sfLeftoverCallPath, { force: true });
  await fs.mkdir(sfLeftoverCallPath, { recursive: true });
  const sfLeftoverCall = await callTool("remove_sprite_frame", { projectDir: sfLeftoverCallDir, spriteName: "sprFrames", index: 2 });
  const sfLeftoverParts = (sfLeftoverCall as any).content as Array<{ type: string; text: string }>;
  ok("sprite frames: the leftover warning is a SECOND content part, so content[0] stays parseable JSON",
    sfLeftoverParts.length === 2 && /⚠/.test(sfLeftoverParts[1].text)
    && /could not be deleted/.test(sfLeftoverParts[1].text)
    && JSON.parse(sfLeftoverParts[0].text).leftoverFiles.length === 1
    && !(sfLeftoverCall as any).isError,
    JSON.stringify(sfLeftoverParts));

  // --- remove_sprite_frame: last ---
  const sfRemoveLastDir = await sfCopy();
  const sfRemoveLastResult = await removeSpriteFrame(sfRemoveLastDir, "sprFrames", 3);
  const sfRemoveLastSprite = await sfRead(sfRemoveLastDir);
  ok("remove_sprite_frame: removing the last frame (index 3) leaves 3 frames and drops that guid",
    sfRemoveLastResult.removedGuid === sfStartGuids[3] && sfRemoveLastResult.frameCount === 3
    && sfRemoveLastSprite.frames.map((f: any) => f.name).join() === sfStartGuids.slice(0, 3).join());
  ok("remove_sprite_frame: and both of the last frame's png files are gone, the rest intact",
    (await sfFrameFilesGone(sfRemoveLastDir, sfStartGuids[3])) && (await sfAllPngsPresent(sfRemoveLastDir)));

  // --- remove_sprite_frame: the only frame is refused ---
  const sfOnlyDir = await sfCopy();
  const sfOnlyBaseline = await sfBaseline(sfOnlyDir, "sprOne");
  await sfExpectError("remove_sprite_frame: removing the only frame is refused with the delete-the-resource advice",
    () => removeSpriteFrame(sfOnlyDir, "sprOne", 0),
    [/cannot remove the last frame from sprOne/, /delete the resource instead/, /zero-frame sprite/]);
  ok("remove_sprite_frame: that refusal leaves the single-frame sprite byte-identical with its pngs",
    (await sfUntouched(sfOnlyDir, sfOnlyBaseline, "sprOne")) && (await sfAllPngsPresent(sfOnlyDir, "sprOne")));
  const sfRemoveErrorDir = await sfCopy();
  const sfRemoveErrorBaseline = await sfBaseline(sfRemoveErrorDir);
  await sfExpectError("remove_sprite_frame: an out-of-range index on a multi-frame sprite is refused naming the valid range",
    () => removeSpriteFrame(sfRemoveErrorDir, "sprFrames", 4), [/frame index 4 is out of range/, /4 frames/, /valid range is 0\.\.3/]);
  ok("remove_sprite_frame: that refusal leaves the .yy and all four frame png pairs untouched",
    (await sfUntouched(sfRemoveErrorDir, sfRemoveErrorBaseline)) && (await sfAllPngsPresent(sfRemoveErrorDir)));

  // --- replace_sprite_frame: same size swaps the bytes, keeps the guid ---
  const sfReplaceDir = await sfCopy();
  const sfReplaceBaseline = await sfBaseline(sfReplaceDir);
  const sfReplaceSpriteBefore = await sfRead(sfReplaceDir);
  const sfReplaceGuid = sfStartGuids[0];
  const sfReplaceResult = await replaceSpriteFrame(sfReplaceDir, "sprFrames", 0, sfFixture("frame1.png"));
  const sfReplaceSprite = await sfRead(sfReplaceDir);
  const sfReplaceBytes = await fs.readFile(sfFixture("frame1.png"));
  ok("replace_sprite_frame: a same-size replacement reports changed: true and the unchanged dimensions",
    sfReplaceResult.changed === true && sfReplaceResult.index === 0 && sfReplaceResult.width === 16 && sfReplaceResult.height === 24,
    JSON.stringify(sfReplaceResult));
  ok("replace_sprite_frame: the frame guid is kept, so a room imageIndex still points at this frame",
    sfReplaceSprite.frames[0].name === sfReplaceGuid && sfReplaceSprite.frames.length === 4
    && (sfReplaceSprite.sequence.tracks.length === 1));
  ok("replace_sprite_frame: both png copies now hold the replacement bytes",
    (await fs.readFile(path.join(sfReplaceDir, "sprites/sprFrames", `${sfReplaceGuid}.png`))).equals(sfReplaceBytes)
    && (await fs.readFile(path.join(sfReplaceDir, "sprites/sprFrames/layers", sfReplaceGuid, `${sfLayerId(sfReplaceSprite)}.png`))).equals(sfReplaceBytes));
  ok("replace_sprite_frame: the frame list and keyframes are untouched by an image swap",
    sfInvariantHolds(sfReplaceSprite)
    && sfKeyframes(sfReplaceSprite).map((k: any) => k.id).join() === sfStartKeyframeIds.join()
    && sfReplaceSprite.width === sfReplaceSpriteBefore.width);

  // --- replace_sprite_frame: byte-identical source is a no-op ---
  const sfReplaceNoopDir = await sfCopy();
  const sfReplaceNoopBaseline = await sfBaseline(sfReplaceNoopDir);
  const sfReplaceNoopPng = path.join(sfReplaceNoopDir, "sprites/sprFrames", `${sfStartGuids[0]}.png`);
  const sfReplaceNoopPngMtime = (await fs.stat(sfReplaceNoopPng)).mtimeMs;
  const sfReplaceNoopResult = await replaceSpriteFrame(sfReplaceNoopDir, "sprFrames", 0, sfFrame0);
  ok("replace_sprite_frame: a byte-identical source reports changed: false",
    sfReplaceNoopResult.changed === false, JSON.stringify(sfReplaceNoopResult));
  ok("replace_sprite_frame: and writes neither the .yy nor the already-identical png (bytes and mtime unchanged)",
    (await sfUntouched(sfReplaceNoopDir, sfReplaceNoopBaseline))
    && (await fs.stat(sfReplaceNoopPng)).mtimeMs === sfReplaceNoopPngMtime);

  // --- replace_sprite_frame: size mismatch + allowResize on a multi-frame sprite ---
  const sfReplaceErrorDir = await sfCopy();
  const sfReplaceErrorBaseline = await sfBaseline(sfReplaceErrorDir);
  await sfExpectError("replace_sprite_frame: a size mismatch is refused naming both sizes and the frame index",
    () => replaceSpriteFrame(sfReplaceErrorDir, "sprFrames", 1, sfFixture("frame_wide.png")),
    [/24x24/, /16x24/, /frame 1/, /same size/]);
  await sfExpectError("replace_sprite_frame: allowResize on a multi-frame sprite is refused rather than resizing one frame",
    () => replaceSpriteFrame(sfReplaceErrorDir, "sprFrames", 1, sfFixture("frame_wide.png"), true),
    [/refusing to resize sprite "sprFrames"/, /24x24/, /16x24/, /4 frames/, /only one would change size/]);
  ok("replace_sprite_frame: both refusals leave the .yy and the four frame pngs untouched",
    (await sfUntouched(sfReplaceErrorDir, sfReplaceErrorBaseline)) && (await sfAllPngsPresent(sfReplaceErrorDir)));

  // --- replace_sprite_frame: allowResize on a single-frame sprite ---
  // The origin is set to a real 8,12 first: asserting "origin is unchanged"
  // against the fixture's own 0,0 would also pass for a clamp-to-zero bug.
  const sfResizeDir = await sfCopy();
  await editSprite(sfResizeDir, "sprOne", { xorigin: 8, yorigin: 12 });
  const sfResizeGuid = (await sfRead(sfResizeDir, "sprOne")).frames[0].name;
  const sfResizeResult = await replaceSpriteFrame(sfResizeDir, "sprOne", 0, sfFixture("frame_tall.png"), true);
  const sfResizeSprite = await sfRead(sfResizeDir, "sprOne");
  ok("replace_sprite_frame: allowResize on a 1-frame sprite adopts the new 16x32 size and keeps the guid",
    sfResizeResult.changed === true && sfResizeResult.width === 16 && sfResizeResult.height === 32
    && sfResizeSprite.width === 16 && sfResizeSprite.height === 32 && sfResizeSprite.frames[0].name === sfResizeGuid,
    JSON.stringify(sfResizeResult));
  ok("replace_sprite_frame: a full-frame default bbox follows the new size",
    sfResizeSprite.bbox_left === 0 && sfResizeSprite.bbox_top === 0
    && sfResizeSprite.bbox_right === 15 && sfResizeSprite.bbox_bottom === 31,
    JSON.stringify([sfResizeSprite.bbox_left, sfResizeSprite.bbox_top, sfResizeSprite.bbox_right, sfResizeSprite.bbox_bottom]));
  ok("replace_sprite_frame: both copies hold the taller image and the counts stay consistent",
    (await fs.readFile(path.join(sfResizeDir, "sprites/sprOne", `${sfResizeGuid}.png`))).equals(await fs.readFile(sfFixture("frame_tall.png")))
    && (await sfBothPngs(sfResizeDir, sfResizeSprite, sfResizeGuid, "sprOne"))
    && sfInvariantHolds(sfResizeSprite));
  ok("replace_sprite_frame: a real origin (8,12) is preserved across a resize, never clamped to 0,0",
    sfResizeSprite.sequence.xorigin === 8 && sfResizeSprite.sequence.yorigin === 12,
    JSON.stringify([sfResizeSprite.sequence.xorigin, sfResizeSprite.sequence.yorigin]));
  ok("replace_sprite_frame: the resize leaves bboxMode, playbackSpeed and the frame list alone",
    sfResizeSprite.bboxMode === 0 && sfResizeSprite.sequence.playbackSpeed === 30
    && sfResizeSprite.frames.length === 1 && sfResizeSprite.sequence.length === 1);
  ok("replace_sprite_frame: a resize stages the pngs and leaves no .tmp- file behind",
    (await fs.readdir(path.join(sfResizeDir, "sprites/sprOne"))).every((f) => !f.includes(".tmp-")),
    JSON.stringify(await fs.readdir(path.join(sfResizeDir, "sprites/sprOne"))));

  // --- helpers for the hand-edited-.yy cases: every one gets its own copy ---
  const sfEditCopy = async (mutate: (sprite: any) => void, name = "sprFrames"): Promise<string> => {
    const copy = await sfCopy();
    const file = path.join(copy, "sprites", name, `${name}.yy`);
    const sprite = JSON.parse(await fs.readFile(file, "utf8"));
    mutate(sprite);
    await fs.writeFile(file, JSON.stringify(sprite, null, 2), "utf8");
    return copy;
  };
  const sfFileManifest = async (projectDir: string, name = "sprFrames"): Promise<string[]> => {
    const root = path.join(projectDir, "sprites", name);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        out.push(path.relative(root, full).split(path.sep).join("/") + (entry.isDirectory() ? "/" : ""));
        if (entry.isDirectory()) await walk(full);
      }
    };
    await walk(root);
    return out.sort();
  };

  // --- replace_sprite_frame: the resize guards, each isolated ---
  // 16x24 -> 16x32 is the only resize the fixtures ground, so "outside the new
  // frame" cases hand-edit the value that has to stay inside it.
  const sfOriginOutside = await sfEditCopy((s) => { s.sequence.xorigin = 20; s.sequence.yorigin = 0; }, "sprOne");
  const sfOriginOutsideBaseline = await sfBaseline(sfOriginOutside, "sprOne");
  await sfExpectError("replace_sprite_frame: a hand-edited origin outside the new width is refused, not skipped and not clamped",
    () => replaceSpriteFrame(sfOriginOutside, "sprOne", 0, sfFixture("frame_tall.png"), true),
    [/origin 20,0 would fall outside/, /0\.\.16,0\.\.32/, /never clamped/]);
  ok("replace_sprite_frame: that refusal leaves the .yy and the png untouched",
    (await sfUntouched(sfOriginOutside, sfOriginOutsideBaseline, "sprOne"))
    && (await sfBothPngs(sfOriginOutside, await sfRead(sfOriginOutside, "sprOne"), (await sfRead(sfOriginOutside, "sprOne")).frames[0].name, "sprOne")));

  const sfOriginNotNumber = await sfEditCopy((s) => { s.sequence.xorigin = "8"; }, "sprOne");
  const sfOriginNotNumberBaseline = await sfBaseline(sfOriginNotNumber, "sprOne");
  await sfExpectError("replace_sprite_frame: an origin that is not two finite numbers is refused instead of skipping the bounds check",
    () => replaceSpriteFrame(sfOriginNotNumber, "sprOne", 0, sfFixture("frame_tall.png"), true),
    [/sequence origin is "8",0/, /not two finite numbers/]);
  ok("replace_sprite_frame: that refusal also leaves the .yy untouched",
    await sfUntouched(sfOriginNotNumber, sfOriginNotNumberBaseline, "sprOne"));

  const sfManualBbox = await sfEditCopy((s) => { s.bboxMode = 2; s.bbox_left = 0; s.bbox_top = 0; s.bbox_right = 15; s.bbox_bottom = 23; }, "sprOne");
  const sfManualBboxResult = await replaceSpriteFrame(sfManualBbox, "sprOne", 0, sfFixture("frame_tall.png"), true);
  const sfManualBboxSprite = await sfRead(sfManualBbox, "sprOne");
  ok("replace_sprite_frame: a bboxMode 2 mask that merely looks full-frame is NOT rewritten by a resize",
    sfManualBboxResult.width === 16 && sfManualBboxResult.height === 32
    && sfManualBboxSprite.bbox_right === 15 && sfManualBboxSprite.bbox_bottom === 23,
    JSON.stringify([sfManualBboxSprite.bboxMode, sfManualBboxSprite.bbox_right, sfManualBboxSprite.bbox_bottom]));

  const sfCustomBboxOutside = await sfEditCopy((s) => { s.bboxMode = 2; s.bbox_right = 20; }, "sprOne");
  const sfCustomBboxBaseline = await sfBaseline(sfCustomBboxOutside, "sprOne");
  await sfExpectError("replace_sprite_frame: a custom bbox that would fall outside the new frame is refused",
    () => replaceSpriteFrame(sfCustomBboxOutside, "sprOne", 0, sfFixture("frame_tall.png"), true),
    [/its bbox \(0,0,20,23\) would fall outside/, /custom mask is never rewritten/]);
  ok("replace_sprite_frame: that refusal leaves the .yy and the png untouched",
    (await sfUntouched(sfCustomBboxOutside, sfCustomBboxBaseline, "sprOne"))
    && (await sfAllPngsPresent(sfCustomBboxOutside, "sprOne")));

  const sfNineSliceOutside = await sfEditCopy((s) => {
    s.nineSlice = { left: 10, right: 10, top: 0, bottom: 0 };
  }, "sprOne");
  const sfNineSliceBaseline = await sfBaseline(sfNineSliceOutside, "sprOne");
  await sfExpectError("replace_sprite_frame: nine-slice borders that no longer fit the new width are refused, not clipped",
    () => replaceSpriteFrame(sfNineSliceOutside, "sprOne", 0, sfFixture("frame_tall.png"), true),
    [/nine-slice borders need 20x0 px/, /nine-slice data is never rewritten/]);
  ok("replace_sprite_frame: that refusal leaves the .yy and the png untouched",
    (await sfUntouched(sfNineSliceOutside, sfNineSliceBaseline, "sprOne")) && (await sfAllPngsPresent(sfNineSliceOutside, "sprOne")));

  const sfNineSliceFits = await sfEditCopy((s) => {
    s.nineSlice = { left: 4, right: 4, top: 2, bottom: 2, tileMode: 0 };
  }, "sprOne");
  await replaceSpriteFrame(sfNineSliceFits, "sprOne", 0, sfFixture("frame_tall.png"), true);
  const sfNineSliceFitsSprite = await sfRead(sfNineSliceFits, "sprOne");
  ok("replace_sprite_frame: nine-slice data that still fits is preserved verbatim through a resize",
    JSON.stringify(sfNineSliceFitsSprite.nineSlice) === JSON.stringify({ left: 4, right: 4, top: 2, bottom: 2, tileMode: 0 }),
    JSON.stringify(sfNineSliceFitsSprite.nineSlice));

  // --- shape guards: the sequence and the sprite are read, never repaired ---
  const sfNoLayers = await sfEditCopy((s) => { s.layers = []; });
  const sfNoLayersBaseline = await sfBaseline(sfNoLayers);
  await sfExpectError("sprite frames: a sprite with no image layers is refused (the per-layer png path would be ambiguous)",
    () => addSpriteFrame(sfNoLayers, "sprFrames", sfFrame0),
    [/has 0 image layers/, /layers\/<frameGuid>\/<layerId>\.png/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfNoLayers, sfNoLayersBaseline));

  const sfTwoLayers = await sfEditCopy((s) => {
    s.layers = [...s.layers, { ...s.layers[0], name: "second-layer-guid", "%Name": "second-layer-guid" }];
  });
  const sfTwoLayersBaseline = await sfBaseline(sfTwoLayers);
  await sfExpectError("sprite frames: a sprite with two image layers is refused rather than picking one",
    () => removeSpriteFrame(sfTwoLayers, "sprFrames", 0),
    [/has 2 image layers/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfTwoLayers, sfTwoLayersBaseline));

  const sfNoTrack = await sfEditCopy((s) => { s.sequence.tracks[0].name = "frames-renamed"; });
  const sfNoTrackBaseline = await sfBaseline(sfNoTrack);
  await sfExpectError("sprite frames: a sequence with no track named \"frames\" of type GMSpriteFramesTrack is refused",
    () => reorderSpriteFrames(sfNoTrack, "sprFrames", [0, 1, 2, 3]),
    [/has no frames track/, /refusing to edit frames it cannot describe/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfNoTrack, sfNoTrackBaseline));

  const sfTwoTracks = await sfEditCopy((s) => {
    s.sequence.tracks = [...s.sequence.tracks, JSON.parse(JSON.stringify(s.sequence.tracks[0]))];
  });
  const sfTwoTracksBaseline = await sfBaseline(sfTwoTracks);
  await sfExpectError("sprite frames: two frames tracks are refused instead of indexing tracks[0]",
    () => trimSpriteFrames(sfTwoTracks, "sprFrames", 0, 1),
    [/has 2 frames tracks/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfTwoTracks, sfTwoTracksBaseline));

  const sfDuplicateFrame = await sfEditCopy((s) => { s.frames[1].name = s.frames[0].name; s.frames[1]["%Name"] = s.frames[0].name; });
  const sfDuplicateFrameBaseline = await sfBaseline(sfDuplicateFrame);
  await sfExpectError("sprite frames: a duplicated frame guid is refused (two frames would resolve to one png)",
    () => replaceSpriteFrame(sfDuplicateFrame, "sprFrames", 0, sfFixture("frame1.png")),
    [/lists the frame guid .* more than once/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfDuplicateFrame, sfDuplicateFrameBaseline));

  const sfDuplicateKeyframe = await sfEditCopy((s) => {
    s.sequence.tracks[0].keyframes.Keyframes[1].Channels["0"].Id.name = s.frames[0].name;
  });
  const sfDuplicateKeyframeBaseline = await sfBaseline(sfDuplicateKeyframe);
  await sfExpectError("sprite frames: two keyframes for one frame guid are refused",
    () => addSpriteFrame(sfDuplicateKeyframe, "sprFrames", sfFrame0),
    [/more than one keyframe for the frame guid/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfDuplicateKeyframe, sfDuplicateKeyframeBaseline));

  const sfKeyOrder = await sfEditCopy((s) => { s.sequence.tracks[0].keyframes.Keyframes[2].Key = 5; });
  const sfKeyOrderBaseline = await sfBaseline(sfKeyOrder);
  await sfExpectError("sprite frames: pre-state Key numbers that are not 0..N-1 are refused instead of silently renumbered",
    () => reorderSpriteFrames(sfKeyOrder, "sprFrames", [0, 1, 2, 3]),
    [/keyframe 2 has Key 5, not 2/, /out of order/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfKeyOrder, sfKeyOrderBaseline));

  const sfKeyLength = await sfEditCopy((s) => { s.sequence.tracks[0].keyframes.Keyframes[1].Length = 2.0; });
  const sfKeyLengthBaseline = await sfBaseline(sfKeyLength);
  await sfExpectError("sprite frames: a keyframe whose Length is not 1.0 is refused rather than normalising sequence.length",
    () => trimSpriteFrames(sfKeyLength, "sprFrames", 1, 2),
    [/keyframe 1 has Length 2/, /always 1\.0 frame long/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfKeyLength, sfKeyLengthBaseline));

  const sfForeignPath = await sfEditCopy((s) => {
    s.sequence.tracks[0].keyframes.Keyframes[0].Channels["0"].Id.path = "sprites/sprOther/sprOther.yy";
  });
  const sfForeignPathBaseline = await sfBaseline(sfForeignPath);
  await sfExpectError("sprite frames: a channel pointing at another sprite's .yy is refused instead of re-pointed silently",
    () => removeSpriteFrame(sfForeignPath, "sprFrames", 1),
    [/points at "sprites\/sprOther\/sprOther\.yy"/, /belong to another resource/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfForeignPath, sfForeignPathBaseline));

  // --- crafted frame guid: a guid is a path component, so it must not escape ---
  // A hand-edited .yy like {"name":"..\\..\\..\\Users\\me\\Documents"} used to let
  // deleteFramePngs rm -r an arbitrary tree and let replace_sprite_frame write
  // caller-chosen bytes outside the sprite directory.
  for (const [label, crafted, pattern] of [
    ["the parent directory \"..\"", "..", /cannot be "\.\."/],
    ["a forward-separator path", "../evil-frame", /must be a single path segment/],
    ["a back-separator path", "..\\evil-frame", /must be a single path segment/],
    ["a Windows device name", "con", /reserved Windows device name \(CON\)/],
  ] as const) {
    const craftedDir = await sfEditCopy((s) => {
      s.frames[1].name = crafted;
      s.frames[1]["%Name"] = crafted;
    });
    const craftedBaseline = await sfBaseline(craftedDir);
    const craftedManifest = await sfFileManifest(craftedDir);
    await sfExpectError(`sprite frames: a frame guid that is ${label} is refused (never used as a path)`,
      () => removeSpriteFrame(craftedDir, "sprFrames", 1),
      [pattern, /guid/]);
    ok(`sprite frames: ${label} leaves the .yy byte-identical and deletes nothing`,
      (await sfUntouched(craftedDir, craftedBaseline))
      && JSON.stringify(await sfFileManifest(craftedDir)) === JSON.stringify(craftedManifest));
    await expectThrows(`list_sprite_frames: ${label} is refused by the reader too (no path is built from it)`,
      () => listSpriteFrames(craftedDir, "sprFrames"));
  }
  const sfTraversalDir = await sfEditCopy((s) => {
    s.frames[1].name = "../evil-frame";
    s.frames[1]["%Name"] = "../evil-frame";
  });
  const sfTraversalBefore = await sfFileManifest(sfTraversalDir);
  await sfExpectError("replace_sprite_frame: a traversing frame guid is refused before any file outside the sprite is touched",
    () => replaceSpriteFrame(sfTraversalDir, "sprFrames", 1, sfFixture("frame1.png")),
    [/must be a single path segment/]);
  ok("replace_sprite_frame: nothing was written outside the sprite directory (sprites/evil-frame.png does not exist)",
    !(await fileExists(path.join(sfTraversalDir, "sprites", "evil-frame.png")))
    && JSON.stringify(await sfFileManifest(sfTraversalDir)) === JSON.stringify(sfTraversalBefore),
    JSON.stringify(await sfFileManifest(sfTraversalDir)));

  const sfCraftedChannel = await sfEditCopy((s) => {
    s.sequence.tracks[0].keyframes.Keyframes[0].Channels["0"].Id.name = "../evil-frame";
  });
  const sfCraftedChannelBaseline = await sfBaseline(sfCraftedChannel);
  await sfExpectError("sprite frames: a crafted guid in a keyframe channel is refused as well",
    () => trimSpriteFrames(sfCraftedChannel, "sprFrames", 1, 2),
    [/keyframe 0 channel guid "\.\.\/evil-frame" must be a single path segment/]);
  ok("sprite frames: that refusal leaves the .yy byte-identical",
    await sfUntouched(sfCraftedChannel, sfCraftedChannelBaseline));

  // --- reorder_sprite_frames ---
  const sfReorderDir = await sfCopy();
  const sfReorderResult = await reorderSpriteFrames(sfReorderDir, "sprFrames", [3, 2, 1, 0]);
  const sfReorderSprite = await sfRead(sfReorderDir);
  ok("reorder_sprite_frames: reverses the frame order and reports changed: true",
    sfReorderResult.changed === true && sfReorderResult.frameCount === 4
    && JSON.stringify(sfReorderSprite.frames.map((f: any) => f.name)) === JSON.stringify([...sfStartGuids].reverse()),
    JSON.stringify(sfReorderResult));
  ok("reorder_sprite_frames: each keyframe travels with its own frame, so no keyframe id is regenerated",
    sfStartGuids.every((guid) => {
      const at: number = sfReorderSprite.frames.findIndex((f: any) => f.name === guid);
      return sfKeyframes(sfReorderSprite)[at].id === sfStartKeyframeIds[sfStartGuids.indexOf(guid)];
    }));
  ok("reorder_sprite_frames: counts still agree and Key is renumbered 0..3",
    sfInvariantHolds(sfReorderSprite) && sfReorderSprite.sequence.length === 4);
  ok("reorder_sprite_frames: the pngs are not touched by a reorder, so no copy is orphaned",
    await sfAllPngsPresent(sfReorderDir));

  // --- reorder_sprite_frames: identity is a no-op ---
  const sfReorderNoopDir = await sfCopy();
  const sfReorderNoopBaseline = await sfBaseline(sfReorderNoopDir);
  const sfReorderNoopResult = await reorderSpriteFrames(sfReorderNoopDir, "sprFrames", [0, 1, 2, 3]);
  ok("reorder_sprite_frames: the identity permutation reports changed: false", sfReorderNoopResult.changed === false);
  ok("reorder_sprite_frames: and writes nothing at all (bytes and mtime unchanged)",
    await sfUntouched(sfReorderNoopDir, sfReorderNoopBaseline));

  // --- reorder_sprite_frames: refusals ---
  const sfReorderErrorDir = await sfCopy();
  const sfReorderErrorBaseline = await sfBaseline(sfReorderErrorDir);
  await sfExpectError("reorder_sprite_frames: a short order is refused naming the required permutation length",
    () => reorderSpriteFrames(sfReorderErrorDir, "sprFrames", [0, 1, 2]),
    [/3 entries/, /4 frames/, /permutation of 0\.\.3/]);
  await sfExpectError("reorder_sprite_frames: a duplicate index is refused naming the offending value",
    () => reorderSpriteFrames(sfReorderErrorDir, "sprFrames", [0, 1, 1, 3]),
    [/duplicate index 1/, /exactly once/]);
  await sfExpectError("reorder_sprite_frames: an out-of-range index is refused naming it",
    () => reorderSpriteFrames(sfReorderErrorDir, "sprFrames", [0, 1, 2, 4]),
    [/order contains 4/, /valid range is 0\.\.3/]);
  await sfExpectError("reorder_sprite_frames: -1 is refused as not a frame index",
    () => reorderSpriteFrames(sfReorderErrorDir, "sprFrames", [0, 1, 2, -1]),
    [/order contains -1/, /valid range is 0\.\.3/]);
  ok("reorder_sprite_frames: every refusal leaves the .yy byte- and mtime-identical",
    await sfUntouched(sfReorderErrorDir, sfReorderErrorBaseline));

  // --- trim_sprite_frames ---
  const sfTrimDir = await sfCopy();
  const sfTrimResult = await trimSpriteFrames(sfTrimDir, "sprFrames", 1, 2);
  const sfTrimSprite = await sfRead(sfTrimDir);
  ok("trim_sprite_frames: keeps 1..2 and reports frameCount 2 / removed 2",
    sfTrimResult.frameCount === 2 && sfTrimResult.removed === 2
    && JSON.stringify(sfTrimSprite.frames.map((f: any) => f.name)) === JSON.stringify([sfStartGuids[1], sfStartGuids[2]]),
    JSON.stringify(sfTrimResult));
  ok("trim_sprite_frames: counts agree after the trim (2 frames, 2 keyframes, sequence.length 2, Key 0..1)",
    sfInvariantHolds(sfTrimSprite) && sfTrimSprite.sequence.length === 2);
  ok("trim_sprite_frames: the trimmed-away frames' composite pngs and layers/<guid>/ directories are gone",
    (await sfFrameFilesGone(sfTrimDir, sfStartGuids[0])) && (await sfFrameFilesGone(sfTrimDir, sfStartGuids[3])));
  ok("trim_sprite_frames: the kept frames keep both png copies, nothing orphaned",
    await sfAllPngsPresent(sfTrimDir));
  ok("trim_sprite_frames: a clean delete reports an empty leftoverFiles list",
    Array.isArray(sfTrimResult.leftoverFiles) && sfTrimResult.leftoverFiles.length === 0,
    JSON.stringify(sfTrimResult.leftoverFiles));
  ok("trim_sprite_frames: the surviving keyframes keep their own ids",
    sfKeyframes(sfTrimSprite).every((k: any, i: number) => k.id === sfStartKeyframeIds[i + 1]));

  // --- trim_sprite_frames: full range is a no-op ---
  const sfTrimNoopDir = await sfCopy();
  const sfTrimNoopBaseline = await sfBaseline(sfTrimNoopDir);
  const sfTrimNoopResult = await trimSpriteFrames(sfTrimNoopDir, "sprFrames", 0, 3);
  ok("trim_sprite_frames: the full range reports removed: 0 and the same frameCount",
    sfTrimNoopResult.removed === 0 && sfTrimNoopResult.frameCount === 4, JSON.stringify(sfTrimNoopResult));
  ok("trim_sprite_frames: and writes nothing (bytes and mtime unchanged)",
    await sfUntouched(sfTrimNoopDir, sfTrimNoopBaseline));

  // --- trim_sprite_frames: refusals ---
  const sfTrimErrorDir = await sfCopy();
  const sfTrimErrorBaseline = await sfBaseline(sfTrimErrorDir);
  await sfExpectError("trim_sprite_frames: an out-of-bounds range is refused naming the range and the frame count",
    () => trimSpriteFrames(sfTrimErrorDir, "sprFrames", 2, 9),
    [/trim range 2\.\.9 is out of bounds/, /4 frames/, /valid range is 0\.\.3/]);
  await sfExpectError("trim_sprite_frames: to < from is refused as an empty range",
    () => trimSpriteFrames(sfTrimErrorDir, "sprFrames", 3, 1),
    [/trim range 3\.\.1 is empty/, /less than or equal to/]);
  ok("trim_sprite_frames: both refusals leave the .yy and all four frame png pairs untouched",
    (await sfUntouched(sfTrimErrorDir, sfTrimErrorBaseline)) && (await sfAllPngsPresent(sfTrimErrorDir)));

  // --- every writer refuses an already-inconsistent sprite (4 frames vs 3 keyframes) ---
  // The tool cannot know which side is authoritative, so it must refuse rather
  // than rewrite a sequence the user authored in the IDE.
  for (const [label, run] of [
    ["add_sprite_frame", (d: string) => addSpriteFrame(d, "sprFrames", sfFrame0)],
    ["remove_sprite_frame", (d: string) => removeSpriteFrame(d, "sprFrames", 0)],
    ["replace_sprite_frame", (d: string) => replaceSpriteFrame(d, "sprFrames", 0, sfFixture("frame1.png"))],
    ["reorder_sprite_frames", (d: string) => reorderSpriteFrames(d, "sprFrames", [3, 2, 1, 0])],
    ["trim_sprite_frames", (d: string) => trimSpriteFrames(d, "sprFrames", 1, 2)],
  ] as const) {
    const mismatchCopy = await sfCopy();
    const mismatchFile = path.join(mismatchCopy, "sprites/sprFrames/sprFrames.yy");
    {
      const injected = JSON.parse(await fs.readFile(mismatchFile, "utf8"));
      sfTrack(injected).keyframes.Keyframes.pop();
      await fs.writeFile(mismatchFile, JSON.stringify(injected, null, 2), "utf8");
    }
    const mismatchBaseline = await sfBaseline(mismatchCopy);
    await sfExpectError(`${label}: refuses a sprite whose "frames" (4) and keyframes (3) already disagree, naming both counts`,
      () => run(mismatchCopy), [/already inconsistent/, /4 entries in "frames"/, /3 keyframes/]);
    ok(`${label}: that refusal leaves the inconsistent .yy byte-identical and changes no png`,
      (await sfUntouched(mismatchCopy, mismatchBaseline)) && (await sfAllPngsPresent(mismatchCopy)));
  }

  // --- snapshot wiring: five writers on the hook, the reader off it ---
  const sfSnapshotTools = ["add_sprite_frame", "remove_sprite_frame", "replace_sprite_frame", "reorder_sprite_frames", "trim_sprite_frames"];
  ok("sprite frames: the five writers are on AUTO_SNAPSHOT_TOOLS (a .yy AND the user's pngs can be overwritten or deleted)",
    sfSnapshotTools.every((n) => AUTO_SNAPSHOT_TOOLS.has(n)));
  ok("sprite frames: list_sprite_frames is not on AUTO_SNAPSHOT_TOOLS (it never opens a file for writing)",
    !AUTO_SNAPSHOT_TOOLS.has("list_sprite_frames"));

  const sfHookDir = await sfCopy();
  const sfHookBaseline = await sfBaseline(sfHookDir);
  const sfHookResult = await callTool("add_sprite_frame", {
    projectDir: sfHookDir, spriteName: "sprFrames", sourceImagePath: sfFrame0,
  });
  const sfHookJson = JSON.parse(textOf(sfHookResult));
  const sfHookSnaps = (await listSnapshots(sfHookDir)).snapshots;
  const sfHookManifest = sfHookSnaps.length === 1 ? await readManifest(sfHookDir, sfHookSnaps[0].snapshotId) : null;
  ok("sprite frames: an add through callTool returns parseable JSON with the new frameCount",
    sfHookJson.frameCount === 5 && sfHookJson.index === 4 && !(sfHookResult as any).isError, textOf(sfHookResult));
  ok("sprite frames: that call took exactly one snapshot, attributed to add_sprite_frame and not marked failed",
    sfHookSnaps.length === 1 && (sfHookSnaps[0] as any).tool === "add_sprite_frame" && sfHookManifest?.failed === false,
    JSON.stringify(sfHookSnaps.map((s: any) => ({ id: s.snapshotId, tool: s.tool }))));
  ok("sprite frames: the snapshot records the rewritten .yy and the new frame png pair as touched",
    (sfHookManifest?.touched ?? []).includes("sprites/sprFrames/sprFrames.yy")
    && (sfHookManifest?.touched ?? []).filter((p) => p.startsWith("sprites/sprFrames/") && p.endsWith(".png")).length >= 2,
    JSON.stringify(sfHookManifest?.touched));

  const sfRefusedDir = await sfCopy();
  const sfRefusedBaseline = await sfBaseline(sfRefusedDir, "sprOne");
  const sfRefusedResult = await callTool("remove_sprite_frame", { projectDir: sfRefusedDir, spriteName: "sprOne", index: 0 });
  const sfRefusedSnaps = (await listSnapshots(sfRefusedDir)).snapshots;
  const sfRefusedManifest = sfRefusedSnaps.length === 1 ? await readManifest(sfRefusedDir, sfRefusedSnaps[0].snapshotId) : null;
  ok("sprite frames: a refused remove (the only frame) is still reported as an error",
    (sfRefusedResult as any).isError === true && /cannot remove the last frame/.test(textOf(sfRefusedResult)));
  ok("sprite frames: that refused call left exactly one snapshot, recorded as failed and attributed to the tool",
    sfRefusedSnaps.length === 1 && (sfRefusedSnaps[0] as any).tool === "remove_sprite_frame" && sfRefusedManifest?.failed === true,
    JSON.stringify(sfRefusedSnaps.map((s: any) => ({ id: s.snapshotId, tool: s.tool, failed: s.failed }))));
  ok("sprite frames: and the refused call changed nothing on disk",
    await sfUntouched(sfRefusedDir, sfRefusedBaseline, "sprOne"));

  const sfNoopHookDir = await sfCopy();
  const sfNoopHookBaseline = await sfBaseline(sfNoopHookDir);
  const sfNoopHookResult = await callTool("reorder_sprite_frames", { projectDir: sfNoopHookDir, spriteName: "sprFrames", order: [0, 1, 2, 3] });
  ok("sprite frames: an identity reorder through callTool reports changed: false and writes nothing",
    JSON.parse(textOf(sfNoopHookResult)).changed === false && (await sfUntouched(sfNoopHookDir, sfNoopHookBaseline)));
  ok("sprite frames: the hook discards its snapshot when the call changed nothing (no retention slot spent)",
    (await listSnapshots(sfNoopHookDir)).snapshots.length === 0,
    JSON.stringify((await listSnapshots(sfNoopHookDir)).snapshots.map((s: any) => s.snapshotId)));

  // A disk-free argument refusal must cost nothing: like a schema reject, it is
  // dispatched immediately and throws the module's own message, so a repeated
  // `order` entry cannot burn one of the 20 retention slots on a `failed` copy.
  const sfPrevalidateDir = await sfCopy();
  const sfPrevalidateResult = await callTool("reorder_sprite_frames", {
    projectDir: sfPrevalidateDir, spriteName: "sprFrames", order: [0, 1, 1, 3],
  });
  ok("sprite frames: an argument-level refusal (duplicate order entry) still reports the module's own error",
    (sfPrevalidateResult as any).isError === true && /duplicate index 1/.test(textOf(sfPrevalidateResult)),
    textOf(sfPrevalidateResult));
  ok("sprite frames: and it takes no snapshot at all -- prevalidate runs before the project copy",
    (await listSnapshots(sfPrevalidateDir)).snapshots.length === 0,
    JSON.stringify((await listSnapshots(sfPrevalidateDir)).snapshots.map((s: any) => s.snapshotId)));
  const sfNegativeIndexResult = await callTool("remove_sprite_frame", { projectDir: sfPrevalidateDir, spriteName: "sprFrames", index: -1 });
  ok("sprite frames: a negative frame index is also refused with no snapshot (schema-valid, argument-level)",
    (sfNegativeIndexResult as any).isError === true
    && /frame index -1 is out of range/.test(textOf(sfNegativeIndexResult))
    && (await listSnapshots(sfPrevalidateDir)).snapshots.length === 0,
    textOf(sfNegativeIndexResult));

  // --- registry: 6 tools, schemas and README ---
  const sfToolNames = ["list_sprite_frames", "add_sprite_frame", "remove_sprite_frame",
    "replace_sprite_frame", "reorder_sprite_frames", "trim_sprite_frames"];
  for (const name of sfToolNames) {
    ok(`registry: ${name} is in TOOL_DEFS`, TOOL_DEFS.some((d) => d.name === name));
    ok(`registry: ${name} has a live dispatchTool case`, indexSource.includes(`case "${name}":`));
    ok(`registry: ${name} is documented in README.md`, readmeSource.includes(`\`${name}\``));
  }
  ok("registry: the six sprite-frame schemas are ProjectSchema.extend(...) and require projectDir",
    sfToolNames.every((n) => {
      const schema = TOOL_DEFS.find((d) => d.name === n)!.schema;
      return !schema.safeParse({}).success
        && !schema.safeParse({ spriteName: "s" }).success;
    }));
  const sfReplaceSchema = TOOL_DEFS.find((d) => d.name === "replace_sprite_frame")!.schema;
  const sfReplaceParsed = sfReplaceSchema.safeParse({ projectDir: dir, spriteName: "s", index: 0, sourceImagePath: "a.png" });
  ok("registry: replace_sprite_frame defaults allowResize to false, so resize stays opt-in at the tool boundary",
    sfReplaceParsed.success && (sfReplaceParsed as any).data.allowResize === false,
    sfReplaceParsed.success ? JSON.stringify((sfReplaceParsed as any).data.allowResize) : "schema rejected the minimal call");
  ok("registry: add_sprite_frame's index is optional (omitting it is the documented append)",
    TOOL_DEFS.find((d) => d.name === "add_sprite_frame")!.schema
      .safeParse({ projectDir: dir, spriteName: "s", sourceImagePath: "a.png" }).success);
  ok("registry: all six sprite-frame schemas accept skipSnapshot (the auto-snapshot opt-out)",
    sfToolNames.filter((n) => n !== "list_sprite_frames").every((n) =>
      TOOL_DEFS.find((d) => d.name === n)!.schema
        .safeParse({ ...minimalArgs[n], projectDir: dir, skipSnapshot: true }).success));
  ok("registry: the five sprite-frame writers carry a disk-free prevalidate the snapshot hook consults",
    sfToolNames.filter((n) => n !== "list_sprite_frames").every((n) =>
      typeof (TOOL_DEFS.find((d) => d.name === n) as any)?.prevalidate === "function")
    && (TOOL_DEFS.find((d) => d.name === "add_sprite_frame") as any).prevalidate({ spriteName: "s", sourceImagePath: "a.png" }) === null,
    sfToolNames.filter((n) => typeof (TOOL_DEFS.find((d) => d.name === n) as any)?.prevalidate !== "function").join(","));

  // --- read-only smoke on a COPY of the real sample sprite ---
  // Never against E:\GMprojects\261103GJ itself: the live project's counts are
  // the user's business and change by hand.
  const sfSampleSpriteDir = "E:\\GMprojects\\261103GJ\\sprites\\spr_jingling1_walk";
  if (await fileExists(sfSampleSpriteDir)) {
    const sfSampleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gm-mcp-sfsample-"));
    try {
      await fs.mkdir(path.join(sfSampleRoot, "sprites"), { recursive: true });
      await fs.cp(sfSampleSpriteDir, path.join(sfSampleRoot, "sprites", "spr_jingling1_walk"), { recursive: true });
      const sfSample = await listSpriteFrames(sfSampleRoot, "spr_jingling1_walk");
      ok("list_sprite_frames: a copy of the real spr_jingling1_walk reports 64x64 with origin 32,64",
        sfSample.width === 64 && sfSample.height === 64 && sfSample.origin.x === 32 && sfSample.origin.y === 64,
        JSON.stringify({ w: sfSample.width, h: sfSample.height, origin: sfSample.origin }));
      ok("list_sprite_frames: the real sample has 4 frames, length 4 and 4 keyframes",
        sfSample.frameCount === 4 && sfSample.sequence.length === 4 && sfSample.sequence.keyframeCount === 4,
        JSON.stringify(sfSample.sequence));
      ok("list_sprite_frames: the real sample's verdict is ok and it reads playbackSpeed 10",
        sfSample.verdict === "ok" && sfSample.sequence.playbackSpeed === 10, JSON.stringify(sfSample.sequence));
      ok("list_sprite_frames: every real frame's two pngs are present in the copy (existsOnDisk true, no missingFiles)",
        sfSample.frames.every((f: any) => f.existsOnDisk === true) && sfSample.missingFiles.length === 0,
        JSON.stringify(sfSample.missingFiles));
    } finally {
      await fs.rm(sfSampleRoot, { recursive: true, force: true });
    }
  } else {
    skip("list_sprite_frames: read-only smoke on a copy of spr_jingling1_walk (sample project not present on this machine)");
  }

  // ===== Sequences & timelines (subproject D: read-only -- both gates FIRED) =====
  // docs/specs/D-sequences-timelines.md records the gate: no GameMaker-generated
  // `timelines/` or standalone `sequences/` file exists on this machine, so
  // neither type gets a writer. The fixtures below are therefore DELIBERATELY
  // synthetic -- minimal hand-written JSON that exists to prove the readers
  // survive shapes they were not written against (unparseable, missing moments
  // collection, a track type nobody has seen, IDE trailing commas). They are not
  // captures, and no assertion here claims a real timeline or sequence shape.
  const dDir = await makeBareProject();
  const dYypStatBefore = await fs.stat(path.join(dDir, "TestProj.yyp"));

  // --- both readers on a project that has neither directory ---
  const dTlEmpty = await listTimelines(dDir);
  ok("list_timelines: a project with no timelines/ directory lists [] with a note instead of erroring",
    dTlEmpty.kind === "list" && dTlEmpty.timelines.length === 0
    && typeof dTlEmpty.note === "string" && /no timelines/.test(dTlEmpty.note),
    JSON.stringify(dTlEmpty));
  const dSeqEmpty = await listSequences(dDir);
  ok("list_sequences: a project with no sequences/ directory lists [] with a note and a zero sprite count",
    dSeqEmpty.kind === "list" && dSeqEmpty.sequences.length === 0 && dSeqEmpty.spriteEmbedded.count === 0
    && dSeqEmpty.spriteEmbedded.unreadable.length === 0
    && typeof dSeqEmpty.note === "string" && /no sequences/.test(dSeqEmpty.note),
    JSON.stringify(dSeqEmpty));

  const dTlCall = await callTool("list_timelines", { projectDir: dDir });
  ok("list_timelines: answers through the real dispatch path with parseable JSON in content[0] and the note as content[1]",
    dTlCall.content.length === 2 && Array.isArray(JSON.parse(dTlCall.content[0].text))
    && dTlCall.content[1].text.startsWith("⚠"),
    JSON.stringify(dTlCall).slice(0, 300));
  const dSeqCall = await callTool("list_sequences", { projectDir: dDir });
  const dSeqCallJson = JSON.parse(dSeqCall.content[0].text);
  ok("list_sequences: the listing form is { sequences, spriteEmbeddedSequenceCount }, so an empty sequences/ cannot read as 'no sequences anywhere'",
    dSeqCall.content.length === 2 && Array.isArray(dSeqCallJson.sequences)
    && dSeqCallJson.spriteEmbeddedSequenceCount === 0,
    dSeqCall.content[0].text);
  ok("list_timelines/list_sequences: neither reader writes anything, snapshots anything, or touches the .yyp",
    (await listSnapshots(dDir)).snapshots.length === 0
    && !(await fileExists(path.join(dDir, ".gm-forge")))
    && (await fs.stat(path.join(dDir, "TestProj.yyp"))).mtimeMs === dYypStatBefore.mtimeMs,
    (await listSnapshots(dDir)).snapshots.length + " snapshots");

  // --- synthetic fixtures, registered so existsOnDisk is meaningful ---
  const dYyp = await loadYyp(dDir);
  const dRegistered: Array<[string, string]> = [
    ["tlAlpha", "timelines/tlAlpha/tlAlpha.yy"],
    ["tlNoMoments", "timelines/tlNoMoments/tlNoMoments.yy"],
    ["tlBroken", "timelines/tlBroken/tlBroken.yy"],
    ["tlMissing", "timelines/tlMissing/tlMissing.yy"],
    ["seqAlpha", "sequences/seqAlpha/seqAlpha.yy"],
    ["seqNoTracks", "sequences/seqNoTracks/seqNoTracks.yy"],
    ["seqBroken", "sequences/seqBroken/seqBroken.yy"],
    ["seqMissing", "sequences/seqMissing/seqMissing.yy"],
  ];
  for (const [name, resourcePath] of dRegistered) (dYyp as any).resources.push({ id: { name, path: resourcePath } });
  await writeYyp(dDir, dYyp);

  const dWrite = async (rel: string, text: string) => {
    const full = path.join(dDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, text, "utf8");
  };
  // Out-of-order moments, one coded moment, one `code: ""`, an unknown root key
  // and an IDE-style trailing comma: every tolerance the reader claims.
  await dWrite("timelines/tlAlpha/tlAlpha.yy", `{
  "$GMTimeline": "",
  "%Name": "tlAlpha",
  "name": "tlAlpha",
  "resourceType": "GMTimeline",
  "resourceVersion": "2.0",
  "someFutureKey": { "nested": true },
  "moments": [
    { "name": "m2", "step": 4, "code": "show_debug_message(\\"b\\");", },
    { "name": "m0", "step": 0, "code": "", },
    { "name": "m1", "step": 2, "extra": [1, 2, 3], },
  ],
}
`);
  await dWrite("timelines/tlNoMoments/tlNoMoments.yy", `{
  "$GMTimeline": "",
  "%Name": "tlNoMoments",
  "length": 30,
  "name": "tlNoMoments",
  "resourceType": "GMTimeline",
  "resourceVersion": "2.0"
}
`);
  await dWrite("timelines/tlBroken/tlBroken.yy", `{ "name": "tlBroken", "moments": [`);
  await dWrite("sequences/seqAlpha/seqAlpha.yy", `{
  "$GMSequence": "v1",
  "%Name": "seqAlpha",
  "name": "seqAlpha",
  "length": 12,
  "playback": 1,
  "playbackSpeed": 15.5,
  "playbackSpeedType": 0,
  "tracks": [
    { "name": "spriteTrack", "resourceType": "GMSpriteFramesTrack",
      "keyframes": { "Keyframes": [{}, {}, {}], "resourceType": "KeyframeStore<SpriteFrameKeyframe>" } },
    { "name": "neverSeen", "resourceType": "GMFutureTrackType", "keyframes": { "Keyframes": [] } },
    { "name": "noStore", "resourceType": "GMAnimationTrack" },
  ],
  "moments": { "Keyframes": [] },
  "resourceType": "GMSequence",
  "resourceVersion": "2.0",
}
`);
  await dWrite("sequences/seqNoTracks/seqNoTracks.yy", `{
  "name": "seqNoTracks",
  "resourceType": "GMSequence",
  "resourceVersion": "2.0"
}
`);
  await dWrite("sequences/seqBroken/seqBroken.yy", `{ "name": "seqBroken", "tracks": [{ "name":`);
  await dWrite("sprites/sprEmbedded/sprEmbedded.yy", `{
  "name": "sprEmbedded",
  "resourceType": "GMSprite",
  "resourceVersion": "2.0",
  "sequence": {
    "name": "sprEmbedded",
    "length": 1,
    "playbackSpeed": 30,
    "tracks": [],
    "moments": { "Keyframes": [] },
    "events": { "Keyframes": [] },
    "resourceType": "GMSequence",
    "resourceVersion": "2.0"
  }
}
`);

  const dTlAlpha = await listTimelines(dDir, { name: "tlAlpha" });
  const dTlAlphaEntry = dTlAlpha.kind === "one" ? dTlAlpha.timeline : null;
  ok("list_timelines: a named lookup returns the single entry, not a one-element array",
    dTlAlphaEntry !== null && dTlAlphaEntry.name === "tlAlpha", JSON.stringify(dTlAlpha));
  ok("list_timelines: moments are sorted by step regardless of file order, and hasCode tells code from code: \"\"",
    dTlAlphaEntry !== null
    && JSON.stringify(dTlAlphaEntry.moments) === JSON.stringify([
      { step: 0, hasCode: false }, { step: 2, hasCode: false }, { step: 4, hasCode: true },
    ]),
    JSON.stringify(dTlAlphaEntry?.moments));
  ok("list_timelines: an unknown root key and IDE-style trailing commas do not stop the parse",
    dTlAlphaEntry !== null && dTlAlphaEntry.momentCount === 3 && dTlAlphaEntry.momentsKey === "moments"
    && dTlAlphaEntry.existsOnDisk === true && dTlAlphaEntry.parseError === undefined,
    JSON.stringify(dTlAlphaEntry));

  const dTlList = await listTimelines(dDir);
  const dTlEntries = dTlList.kind === "list" ? dTlList.timelines : [];
  const dTlByName = (name: string) => dTlEntries.find((entry) => entry.name === name);
  const dTlBroken = dTlByName("tlBroken");
  ok("list_timelines: a registered timeline whose folder is missing reports existsOnDisk: false and is still listed",
    dTlByName("tlMissing")?.existsOnDisk === false && dTlByName("tlMissing")?.momentCount === 0
    && dTlByName("tlMissing")?.parseError === undefined,
    JSON.stringify(dTlByName("tlMissing")));
  ok("list_timelines: an unparseable file is reported per entry (parseError naming the path) and does not sink the listing",
    dTlEntries.length === 4 && typeof dTlBroken?.parseError === "string"
    && dTlBroken.parseError.includes(path.join(dDir, "timelines", "tlBroken", "tlBroken.yy"))
    && dTlByName("tlAlpha")?.momentCount === 3,
    JSON.stringify(dTlEntries.map((entry) => ({ name: entry.name, parseError: entry.parseError }))));
  ok("list_timelines: when no moments collection exists it reports the root keys it did find instead of a confident zero",
    dTlByName("tlNoMoments")?.momentsKey === null && dTlByName("tlNoMoments")?.momentCount === 0
    && (dTlByName("tlNoMoments")?.foundKeys ?? []).includes("length"),
    JSON.stringify(dTlByName("tlNoMoments")));
  ok("list_timelines: the listing form returns the bare array, with no note when something was found",
    dTlList.kind === "list" && dTlList.note === null);

  const dSeqAlpha = await listSequences(dDir, { name: "seqAlpha" });
  const dSeqAlphaEntry = dSeqAlpha.kind === "one" ? dSeqAlpha.sequence : null;
  ok("list_sequences: a named lookup returns the single entry with length and playbackSpeed passed through unrounded",
    dSeqAlphaEntry !== null && dSeqAlphaEntry.name === "seqAlpha"
    && dSeqAlphaEntry.length === 12 && dSeqAlphaEntry.playbackSpeed === 15.5
    && dSeqAlphaEntry.trackCount === 3,
    JSON.stringify(dSeqAlphaEntry));
  ok("list_sequences: a track type nobody has seen lists verbatim, and keyframeCount is 0 for a missing or empty store",
    dSeqAlphaEntry !== null
    && dSeqAlphaEntry.tracks[1].type === "GMFutureTrackType"
    && JSON.stringify(dSeqAlphaEntry.tracks.map((t) => t.keyframeCount)) === JSON.stringify([3, 0, 0])
    && dSeqAlphaEntry.tracks[0].type === "GMSpriteFramesTrack",
    JSON.stringify(dSeqAlphaEntry?.tracks));

  const dSeqList = await listSequences(dDir);
  const dSeqEntries = dSeqList.kind === "list" ? dSeqList.sequences : [];
  const dSeqByName = (name: string) => dSeqEntries.find((entry) => entry.name === name);
  const dSeqBroken = dSeqByName("seqBroken");
  ok("list_sequences: a registered sequence whose folder is missing reports existsOnDisk: false and is still listed",
    dSeqByName("seqMissing")?.existsOnDisk === false && dSeqByName("seqMissing")?.trackCount === 0
    && dSeqByName("seqMissing")?.parseError === undefined,
    JSON.stringify(dSeqByName("seqMissing")));
  ok("list_sequences: an unparseable file is reported per entry (parseError naming the path) and does not sink the listing",
    dSeqEntries.length === 4 && typeof dSeqBroken?.parseError === "string"
    && dSeqBroken.parseError.includes(path.join(dDir, "sequences", "seqBroken", "seqBroken.yy"))
    && dSeqByName("seqAlpha")?.trackCount === 3,
    JSON.stringify(dSeqEntries.map((entry) => ({ name: entry.name, parseError: entry.parseError }))));
  ok("list_sequences: with no tracks array it reports foundKeys and null (not invented) length/playbackSpeed",
    dSeqByName("seqNoTracks")?.trackCount === 0 && dSeqByName("seqNoTracks")?.length === null
    && dSeqByName("seqNoTracks")?.playbackSpeed === null
    && (dSeqByName("seqNoTracks")?.foundKeys ?? []).includes("resourceType"),
    JSON.stringify(dSeqByName("seqNoTracks")));
  ok("list_sequences: a sprite's own embedded GMSequence is counted, so an empty sequences/ is not reported as 'no sequences anywhere'",
    dSeqList.kind === "list" && dSeqList.spriteEmbedded.count === 1
    && dSeqList.spriteEmbedded.unreadable.length === 0
    && typeof dSeqList.note === "string" && /sprite-embedded/.test(dSeqList.note),
    JSON.stringify(dSeqList));

  // --- real sprite, copied out of the sample project (never read in place) ---
  const dSampleSpriteDir = "E:\\GMprojects\\261103GJ\\sprites\\spr_jingling1_walk";
  const dSampleDir = await makeBareProject();
  if (await fileExists(dSampleSpriteDir)) {
    await fs.mkdir(path.join(dSampleDir, "sprites"), { recursive: true });
    await fs.cp(dSampleSpriteDir, path.join(dSampleDir, "sprites", "spr_jingling1_walk"), { recursive: true });
    const dSample = await listSequences(dSampleDir);
    ok("list_sequences: a copy of the real spr_jingling1_walk is counted as exactly one sprite-embedded sequence",
      dSample.kind === "list" && dSample.spriteEmbedded.count === 1
      && dSample.spriteEmbedded.unreadable.length === 0,
      JSON.stringify(dSample));
  } else {
    skip("list_sequences: sprite-embedded count on a copy of spr_jingling1_walk (sample project not present on this machine)");
  }

  // --- named lookups refuse what is not registered ---
  const dMissingTimeline = await listTimelines(dDir, { name: "tlDoesNotExist" }).then(() => null, (e: any) => e.message);
  ok("list_timelines: a missing name raises the house \"does not exist (expected <abs path>)\" error",
    typeof dMissingTimeline === "string" && dMissingTimeline.includes("does not exist (expected")
    && dMissingTimeline.includes(path.join(dDir, "timelines", "tlDoesNotExist", "tlDoesNotExist.yy")),
    String(dMissingTimeline));
  const dMissingSequence = await listSequences(dDir, { name: "seqDoesNotExist" }).then(() => null, (e: any) => e.message);
  ok("list_sequences: a missing name raises the house \"does not exist (expected <abs path>)\" error",
    typeof dMissingSequence === "string" && dMissingSequence.includes("does not exist (expected")
    && dMissingSequence.includes(path.join(dDir, "sequences", "seqDoesNotExist", "seqDoesNotExist.yy")),
    String(dMissingSequence));
  await expectThrows("list_timelines: a traversal name is refused, not joined into a path",
    () => listTimelines(dDir, { name: "../../evil" }));
  await expectThrows("list_sequences: a traversal name is refused, not joined into a path",
    () => listSequences(dDir, { name: "../../evil" }));

  // --- registry: 2 tools, schemas, README ---
  const dToolNames = ["list_timelines", "list_sequences"];
  for (const name of dToolNames) {
    ok(`registry: ${name} is in TOOL_DEFS`, TOOL_DEFS.some((d) => d.name === name));
    ok(`registry: ${name} has a live dispatchTool case`, indexSource.includes(`case "${name}":`));
    ok(`registry: ${name} is documented in README.md`, readmeSource.includes(`\`${name}\``));
  }
  ok("registry: both read-only tools require projectDir and take an optional name",
    dToolNames.every((n) => {
      const schema = TOOL_DEFS.find((d) => d.name === n)!.schema;
      return !schema.safeParse({}).success && !schema.safeParse({ timelineName: "x" }).success
        && !schema.safeParse({ sequenceName: "x" }).success
        && schema.safeParse({ projectDir: dir }).success;
    }));
  ok("registry: neither read-only tool is on the auto-snapshot list (a listing must not copy the project)",
    dToolNames.every((n) => !AUTO_SNAPSHOT_TOOLS.has(n)));
  ok("registry: no timeline or sequence writer was registered with the gate closed",
    !TOOL_DEFS.some((d) => /^(add_timeline|add_timeline_moment|edit_timeline_moment|remove_timeline_moment|add_sequence|set_sequence_sprite_track)$/.test(d.name))
    && !indexSource.includes(`case "add_timeline"`) && !indexSource.includes(`case "add_sequence"`));
  ok("registry: README carries the read-only note and points at the gate",
    readmeSource.includes("Sequences & timelines (read-only)")
    && readmeSource.includes("docs/specs/D-sequences-timelines.md")
    && /worse than no shape/.test(readmeSource));

  // ===== Fix pass: per-entry stat failures, bounded sprite scan, registry ====
  // --- item 1: an unreadable resource is reported, never thrown ---
  const dStatDir = await makeBareProject();
  const dStatYyp = await loadYyp(dStatDir);
  const dStatRegistered: Array<[string, string]> = [
    ["tlGoodOne", "timelines/tlGoodOne/tlGoodOne.yy"],
    ["tlUnreadable", "timelines/tlUnreadable/tlUnreadable.yy"],
    ["tlGoodTwo", "timelines/tlGoodTwo/tlGoodTwo.yy"],
    ["seqGood", "sequences/seqGood/seqGood.yy"],
    ["seqUnreadable", "sequences/seqUnreadable/seqUnreadable.yy"],
  ];
  for (const [name, resourcePath] of dStatRegistered) (dStatYyp as any).resources.push({ id: { name, path: resourcePath } });
  await writeYyp(dStatDir, dStatYyp);
  const dStatWrite = async (rel: string, text: string) => {
    const full = path.join(dStatDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, text, "utf8");
  };
  await dStatWrite("timelines/tlGoodOne/tlGoodOne.yy", `{ "name": "tlGoodOne", "moments": [{ "step": 1 }] }`);
  await dStatWrite("timelines/tlGoodTwo/tlGoodTwo.yy", `{ "name": "tlGoodTwo", "moments": [{ "step": 2 }] }`);
  await dStatWrite("sequences/seqGood/seqGood.yy", `{ "name": "seqGood", "length": 3, "tracks": [] }`);
  // A DIRECTORY where the .yy belongs is the failure that actually survives
  // `stat` on Windows: `chmod 0o000` there only toggles the read-only attribute
  // and still grants read, so it cannot produce the denial this branch exists
  // for. The entry must be reported and the other entries must still list.
  await fs.mkdir(path.join(dStatDir, "timelines", "tlUnreadable", "tlUnreadable.yy"), { recursive: true });
  await fs.mkdir(path.join(dStatDir, "sequences", "seqUnreadable", "seqUnreadable.yy"), { recursive: true });

  const dStatTl = await listTimelines(dStatDir);
  const dStatTlEntries = dStatTl.kind === "list" ? dStatTl.timelines : [];
  const dStatTlBad = dStatTlEntries.find((entry) => entry.name === "tlUnreadable");
  ok("list_timelines: an unreadable resource is reported in that entry (existsOnDisk false + parseError naming the path), not thrown",
    dStatTlEntries.length === 3 && dStatTlBad?.existsOnDisk === false
    && typeof dStatTlBad.parseError === "string"
    && dStatTlBad.parseError.includes(path.join(dStatDir, "timelines", "tlUnreadable", "tlUnreadable.yy"))
    && /expected a file, found a directory/.test(dStatTlBad.parseError),
    JSON.stringify(dStatTlEntries.map((entry) => ({ name: entry.name, parseError: entry.parseError }))));
  ok("list_timelines: the readable timelines in the same project still list their moments",
    dStatTlEntries.find((entry) => entry.name === "tlGoodOne")?.momentCount === 1
    && dStatTlEntries.find((entry) => entry.name === "tlGoodTwo")?.momentCount === 1);
  const dStatSeq = await listSequences(dStatDir);
  const dStatSeqEntries = dStatSeq.kind === "list" ? dStatSeq.sequences : [];
  const dStatSeqBad = dStatSeqEntries.find((entry) => entry.name === "seqUnreadable");
  ok("list_sequences: an unreadable resource is reported in that entry (existsOnDisk false + parseError naming the path), not thrown",
    dStatSeqEntries.length === 2 && dStatSeqBad?.existsOnDisk === false
    && typeof dStatSeqBad.parseError === "string"
    && dStatSeqBad.parseError.includes(path.join(dStatDir, "sequences", "seqUnreadable", "seqUnreadable.yy"))
    && /expected a file, found a directory/.test(dStatSeqBad.parseError),
    JSON.stringify(dStatSeqEntries.map((entry) => ({ name: entry.name, parseError: entry.parseError }))));
  ok("list_sequences: the readable sequence in the same project still lists", dStatSeqEntries.find((entry) => entry.name === "seqGood")?.length === 3);
  const dStatNamedTl = await listTimelines(dStatDir, { name: "tlUnreadable" });
  ok("list_timelines: a NAMED lookup of an unreadable registered timeline returns the zeroed entry with parseError, not an error",
    dStatNamedTl.kind === "one" && dStatNamedTl.timeline.existsOnDisk === false
    && typeof dStatNamedTl.timeline.parseError === "string");
  const dStatNamedSeq = await listSequences(dStatDir, { name: "seqUnreadable" });
  ok("list_sequences: a NAMED lookup of an unreadable registered sequence returns the zeroed entry with parseError, not an error",
    dStatNamedSeq.kind === "one" && dStatNamedSeq.sequence.existsOnDisk === false
    && typeof dStatNamedSeq.sequence.parseError === "string");

  // --- item 5: a named lookup of a registered-but-vanished resource ---
  const dNamedGoneTl = await listTimelines(dDir, { name: "tlMissing" });
  ok("list_timelines: a NAMED lookup of a registered timeline whose folder is gone answers existsOnDisk false, not \"does not exist\"",
    dNamedGoneTl.kind === "one" && dNamedGoneTl.timeline.existsOnDisk === false
    && dNamedGoneTl.timeline.parseError === undefined && dNamedGoneTl.timeline.momentCount === 0);
  const dNamedGoneSeq = await listSequences(dDir, { name: "seqMissing" });
  ok("list_sequences: a NAMED lookup of a registered sequence whose folder is gone answers existsOnDisk false, not \"does not exist\"",
    dNamedGoneSeq.kind === "one" && dNamedGoneSeq.sequence.existsOnDisk === false
    && dNamedGoneSeq.sequence.parseError === undefined && dNamedGoneSeq.sequence.trackCount === 0);

  // --- item 6: a crafted name is quoted, never joined into a path ---
  const dCraftedTl = await listTimelines(dDir, { name: "../../evil" }).then(() => null, (e: any) => e.message);
  ok("list_timelines: a crafted name appears quoted in the error and is never joined into an \"expected\" path",
    typeof dCraftedTl === "string" && dCraftedTl.includes(`"../../evil"`)
    && dCraftedTl.includes("not a usable resource name") && !dCraftedTl.includes(path.join(dDir, "timelines")),
    String(dCraftedTl));
  const dCraftedSeq = await listSequences(dDir, { name: "../../evil" }).then(() => null, (e: any) => e.message);
  ok("list_sequences: a crafted name appears quoted in the error and is never joined into an \"expected\" path",
    typeof dCraftedSeq === "string" && dCraftedSeq.includes(`"../../evil"`)
    && dCraftedSeq.includes("not a usable resource name") && !dCraftedSeq.includes(path.join(dDir, "sequences")),
    String(dCraftedSeq));

  // --- items 2-4: the sprite scan is bounded and its buckets are explicit ---
  const dScanDir = await makeBareProject();
  const dScanSprites = path.join(dScanDir, "sprites");
  const dScanNames = Array.from({ length: 501 }, (_, i) => `sprScan${String(i + 1).padStart(4, "0")}`);
  for (const [index, name] of dScanNames.entries()) {
    const dir = path.join(dScanSprites, name);
    await fs.mkdir(dir, { recursive: true });
    const body = index < 6
      // unreadable: truncated JSON
      ? `{ "name": "${name}",`
      : index < 8
        // a record-shaped sequence with no resourceType: counted, but unrecognised
        ? `{ "name": "${name}", "sequence": { "name": "${name}", "tracks": [] } }`
        : `{ "name": "${name}", "sequence": { "name": "${name}", "resourceType": "GMSequence", "tracks": [] } }`;
    await fs.writeFile(path.join(dir, `${name}.yy`), body, "utf8");
  }
  const dScan = await scanSpriteEmbeddedSequences(dScanDir);
  ok(`list_sequences: the sprite scan stops at MAX_SPRITE_SCAN (${MAX_SPRITE_SCAN}) and reports scanned/total/truncated`,
    MAX_SPRITE_SCAN === 500 && dScan.scanned === 500 && dScan.total === 501 && dScan.truncated === true
    && dScan.count === 494,
    JSON.stringify({ scanned: dScan.scanned, total: dScan.total, truncated: dScan.truncated, count: dScan.count }));
  ok("list_sequences: a sprite it cannot read is reported with a reason, not just a name",
    dScan.unreadable.length === 6 && dScan.unreadable.every((entry) => typeof entry.reason === "string" && entry.reason.includes(".yy")),
    JSON.stringify(dScan.unreadable.slice(0, 2)));
  ok("list_sequences: a sequence record without resourceType is still counted and named in `unrecognised`",
    dScan.unrecognised.length === 2 && dScan.unrecognised.every((name) => dScanNames.includes(name)),
    JSON.stringify(dScan.unrecognised));
  const dScanListCall = await callTool("list_sequences", { projectDir: dScanDir });
  const dScanNote = dScanListCall.content.length > 1 ? dScanListCall.content[1].text : "";
  ok("list_sequences: a truncated scan says the count is a lower bound",
    /only the first 500 of 501 sprite \.yy files were scanned/.test(dScanNote) && /lower bound/.test(dScanNote),
    dScanNote);
  ok("list_sequences: the note caps the name list at five plus \"and N more\"",
    /sprScan0001, sprScan0002, sprScan0003, sprScan0004, sprScan0005 and 1 more/.test(dScanNote),
    dScanNote);
  ok("list_sequences: the dispatch payload exposes the scan's own numbers, so a truncated count is visible as data too",
    JSON.parse(dScanListCall.content[0].text).spriteEmbeddedSequenceCount === 494);

  // --- item 7: room-order writers are backed up now ---
  ok("auto-snapshot: reorder_room and move_room_relative are on the hook (they rewrite the .yyp's RoomOrderNodes)",
    AUTO_SNAPSHOT_TOOLS.has("reorder_room") && AUTO_SNAPSHOT_TOOLS.has("move_room_relative"));
  const dOrderDir = await makeBareProject();
  let dOrderYyp = await loadYyp(dOrderDir);
  dOrderYyp = await addRoom(dOrderDir, dOrderYyp, "rmOrderA", { width: 320, height: 240, persistent: false });
  dOrderYyp = await addRoom(dOrderDir, dOrderYyp, "rmOrderB", { width: 320, height: 240, persistent: false });
  await writeYyp(dOrderDir, dOrderYyp);
  const dOrderCall = await callTool("reorder_room", { projectDir: dOrderDir, roomName: "rmOrderB", newIndex: 0 });
  const dOrderSnaps = (await listSnapshots(dOrderDir)).snapshots;
  const dOrderManifest = dOrderSnaps.length === 1 ? await readManifest(dOrderDir, (dOrderSnaps[0] as any).snapshotId) : null;
  ok("auto-snapshot: a real reorder_room call takes exactly one snapshot, attributed to reorder_room",
    !(dOrderCall as any).isError && dOrderSnaps.length === 1 && (dOrderSnaps[0] as any).tool === "reorder_room",
    textOf(dOrderCall));
  ok("snapshot: the manifest no longer carries the dead `undoHold` field",
    dOrderManifest !== null && !("undoHold" in (dOrderManifest as any)),
    JSON.stringify(Object.keys(dOrderManifest ?? {})));

  // --- item 8: registry hardening, globally ---
  const dAllNames = TOOL_DEFS.map((d) => d.name);
  const dBadNames = dAllNames.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name));
  ok("registry: every one of the 76 tool names is snake_case", dBadNames.length === 0 && dAllNames.length === 76, dBadNames.join(","));
  ok("registry: tool names are unique", new Set(dAllNames).size === dAllNames.length,
    `${new Set(dAllNames).size} unique of ${dAllNames.length}`);
  const dUndocumented = dAllNames.filter((name) => !readmeSource.includes(`\`${name}\``));
  ok(`registry: all ${dAllNames.length} TOOL_DEFS names are documented in README.md`, dUndocumented.length === 0, dUndocumented.join(","));

  await fs.rm(dStatDir, { recursive: true, force: true });
  await fs.rm(dScanDir, { recursive: true, force: true });
  await fs.rm(dOrderDir, { recursive: true, force: true });
  await fs.rm(dDir, { recursive: true, force: true });
  await fs.rm(dSampleDir, { recursive: true, force: true });

  for (const root of sfCopyRoots) await fs.rm(root, { recursive: true, force: true });
  await fs.rm(sfBaseDir, { recursive: true, force: true });
  await fs.rm(sfSrcDir, { recursive: true, force: true });

  await fs.rm(auditDir, { recursive: true, force: true });
  await fs.rm(f3Dir, { recursive: true, force: true });
  await fs.rm(e2Dir, { recursive: true, force: true });
  await fs.rm(d1Dir, { recursive: true, force: true });
  await fs.rm(b1Dir, { recursive: true, force: true });
  await fs.rm(b1HookDir, { recursive: true, force: true });
  await fs.rm(b2Dir, { recursive: true, force: true });

  await fs.rm(safetyDir, { recursive: true, force: true });
  await fs.rm(freshDir, { recursive: true, force: true });
  await fs.rm(undoDir, { recursive: true, force: true });
  await fs.rm(hookDir, { recursive: true, force: true });
  await fs.rm(retentionDir, { recursive: true, force: true });

  await fs.rm(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (skipped > 0) {
    console.log(`SKIPPED (real-GameMaker checks did not run on this machine):`);
    for (const reason of skippedReasons) console.log(`  - ${reason}`);
  }
  if (failed > 0) process.exit(1);
}

main();
