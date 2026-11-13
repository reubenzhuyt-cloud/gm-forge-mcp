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
import { TOOL_DEFS, EditObjectSchema } from "../src/index.js";

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
  ok("registry: TOOL_DEFS declares exactly 53 tools (45 existing + 8 new)", TOOL_DEFS.length === 53, String(TOOL_DEFS.length));
  const declaredTools = (indexSource.match(/^  \{ name: "/gm) ?? []).length;
  ok("registry: the source registers exactly 53 TOOL_DEFS entries", declaredTools === 53, String(declaredTools));
  const dispatchCases = (indexSource.match(/^\s*case "[A-Za-z_]+":/gm) ?? []).length;
  ok("registry: dispatchTool has exactly 53 uncommented cases", dispatchCases === 53, String(dispatchCases));
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

  await fs.rm(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (skipped > 0) {
    console.log(`SKIPPED (real-GameMaker checks did not run on this machine):`);
    for (const reason of skippedReasons) console.log(`  - ${reason}`);
  }
  if (failed > 0) process.exit(1);
}

main();
