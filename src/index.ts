#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  loadYyp,
  writeYyp,
  ensureProjectScaffold,
  withProjectLock,
  addTextureGroup,
  addAudioGroup,
  fileExists,
} from "./gm/yyp.js";
import path from "path";
import { fileURLToPath } from "url";
import { realpathSync } from "fs";
import { addScript, editScript } from "./gm/scripts.js";
import { addObject, addObjectEvent, editObject } from "./gm/objects.js";
import { addSpriteFromImages, editSprite } from "./gm/sprites.js";
import {
  listSpriteFrames,
  addSpriteFrame,
  removeSpriteFrame,
  replaceSpriteFrame,
  reorderSpriteFrames,
  trimSpriteFrames,
} from "./gm/sprite_frames.js";
import { addRoom, editRoom, reorderRoom, moveRoomRelativeTo } from "./gm/rooms.js";
import { addRoomInstance } from "./gm/instances.js";
import { addShader, editShader } from "./gm/shaders.js";
import { addSound, editSound } from "./gm/sounds.js";
import { addFont, editFont } from "./gm/fonts.js";
import { addNote } from "./gm/notes.js";
import { addTileset, editTileset } from "./gm/tilesets.js";
import { addExtension } from "./gm/extensions.js";
import { addParticleSystem } from "./gm/particle_systems.js";
import { addAnimCurve } from "./gm/animation_curves.js";
import { getObjectInfo, getRoomInfo, getSpriteInfo, getScriptInfo, getShaderInfo, getSoundInfo, getFontInfo, getNoteInfo, getTilesetInfo, getExtensionInfo, getParticleSystemInfo, getAnimCurveInfo } from "./gm/introspect.js";
import { findReferences } from "./gm/references.js";
import { deleteResource } from "./gm/delete.js";
import { renameResource } from "./gm/rename.js";
import { lintProject } from "./gm/lint.js";
import { compileProject } from "./gm/build.js";
import { getRoomTileLayers, findTileRegion, getRoomTiles, setRoomTiles, fillRoomTiles } from "./gm/room_tiles.js";
import { listRoomLayers, addRoomLayer, removeRoomLayer, setRoomLayer } from "./gm/room_layers.js";
import { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, undoLast } from "./gm/snapshot.js";
import { readFile, patchFile, listChanges } from "./gm/files.js";
import { withAutoSnapshot } from "./gm/write.js";
import { getProjectOptions, setProjectOption, OPTION_ALLOWLIST } from "./gm/options.js";
import { listIncludedFiles, addIncludedFile, removeIncludedFile } from "./gm/included_files.js";
import { listMacros, setMacro } from "./gm/macros.js";
import { listTimelines } from "./gm/timelines.js";
import { listSequences } from "./gm/sequences.js";

// Schema definitions
const EVENT_TYPE_DESCRIPTION =
  "GameMaker event type number: 0=Create, 1=Destroy, 2=Alarm, 3=Step, 4=Collision, 5=Keyboard, " +
  "6=Mouse, 7=Other, 8=Draw, 9=KeyPress, 10=KeyRelease, 11=Trigger, 12=CleanUp, 13=Gesture";
const EVENT_NUM_DESCRIPTION =
  "Sub-number within the event type -- meaning depends on eventType. For most types (Create, " +
  "Destroy, Draw) this is 0. For Alarm: which alarm, 0-11. For Step: 0=Step, 1=Begin Step, " +
  "2=End Step. For Collision: use 0 -- set collisionTargetName separately to specify the other " +
  "object. For Keyboard/KeyPress/KeyRelease: a virtual key code (e.g. vk_space=32, ord('A')=65).";
const SKIP_SNAPSHOT_DESCRIPTION =
  "Skip the automatic backup this tool otherwise takes in <projectDir>/.gm-forge/ (default false). " +
  "Only for CI or a slow disk: a skipped snapshot means undo_last cannot bring this change back";

const ProjectSchema = z.object({
  projectDir: z.string().describe("Absolute path to the GameMaker project directory"),
});

const CreateProjectSchema = ProjectSchema.extend({
  name: z.string().describe("Project name for the YYP"),
});

const AddTextureGroupSchema = ProjectSchema.extend({
  groupName: z.string().describe("Name of the new texture group to create"),
});

const AddAudioGroupSchema = ProjectSchema.extend({
  groupName: z.string().describe("Name of the new audio group to create"),
});

const AddScriptSchema = ProjectSchema.extend({
  scriptName: z.string().describe("Name of the script to create"),
  code: z.string().default("// TODO").describe("GML code for the script"),
});

const AddObjectSchema = ProjectSchema.extend({
  objectName: z.string().describe("Name of the object to create"),
  events: z
    .array(
      z.object({
        eventType: z.number().describe(EVENT_TYPE_DESCRIPTION),
        eventNum: z.number().describe(EVENT_NUM_DESCRIPTION),
        collisionTargetName: z.string().optional().describe("For Collision events (eventType 4) only: name of the existing object this collides with"),
      })
    )
    .default([])
    .describe("Array of event definitions to create"),
});

const AddSpriteSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the sprite to create"),
  framesDir: z.string().describe("Directory containing PNG frames"),
});

const AddRoomSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the room to create"),
  width: z.number().int().positive().default(1366).describe("Room width in pixels"),
  height: z.number().int().positive().default(768).describe("Room height in pixels"),
  persistent: z.boolean().default(false).describe("Whether the room is persistent"),
  creationCode: z.string().optional().describe("GML room creation code"),
});

const EditScriptSchema = ProjectSchema.extend({
  scriptName: z.string().describe("Name of the existing script to edit"),
  code: z.string().describe("GML code to write"),
  mode: z.enum(["replace", "append"]).default("append").describe("replace overwrites the whole file; append adds to the end"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const AddObjectEventSchema = ProjectSchema.extend({
  objectName: z.string().describe("Name of the existing object to add an event to"),
  eventType: z.number().describe(EVENT_TYPE_DESCRIPTION),
  eventNum: z.number().describe(EVENT_NUM_DESCRIPTION),
  collisionTargetName: z.string().optional().describe("For Collision events (eventType 4) only: name of the existing object this collides with"),
  code: z.string().default("// Event code here\n").describe("GML code for the new event"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const EditRoomSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room to edit"),
  width: z.number().int().positive().optional().describe("New room width in pixels"),
  height: z.number().int().positive().optional().describe("New room height in pixels"),
  persistent: z.boolean().optional().describe("New persistent flag"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const ReorderRoomSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the room to move"),
  newIndex: z.number().int().min(0).describe("New 0-based position in the room order"),
});

const MoveRoomRelativeSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the room to move"),
  targetRoomName: z.string().describe("Room to position it relative to"),
  position: z.enum(["before", "after"]).describe("Whether to place it before or after the target room"),
});

const AddNoteSchema = ProjectSchema.extend({
  noteName: z.string().describe("Name of the note to create"),
  content: z.string().default("").describe("Plain-text content of the note"),
});

const GetNoteInfoSchema = ProjectSchema.extend({
  noteName: z.string().describe("Name of the note to inspect"),
});

const AddRoomInstanceSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room to place the instance into"),
  objectName: z.string().describe("Name of the existing object to place"),
  x: z.number().describe("X position in the room"),
  y: z.number().describe("Y position in the room"),
  rotation: z.number().default(0).describe("Instance rotation in degrees"),
  scaleX: z.number().default(1.0).describe("Horizontal scale"),
  scaleY: z.number().default(1.0).describe("Vertical scale"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const GetObjectInfoSchema = ProjectSchema.extend({
  objectName: z.string().describe("Name of the object to inspect"),
});

const GetRoomInfoSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the room to inspect"),
});

const GetSpriteInfoSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the sprite to inspect"),
});

const EditSpriteSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the existing sprite to edit"),
  xorigin: z.number().optional().describe("New origin X coordinate in pixels (also sets the origin preset to Custom)"),
  yorigin: z.number().optional().describe("New origin Y coordinate in pixels (also sets the origin preset to Custom)"),
  collisionKind: z.number().int().optional().describe("New collision mask kind (0=Precise, 1=Rectangle, 2=Ellipse, 3=Diamond, ...)"),
  bboxMode: z.number().int().optional().describe("New bounding box mode (0=Automatic, 1=Full Image, 2=Manual)"),
  bbox_left: z.number().optional().describe("New bounding box left edge (used when bboxMode=2)"),
  bbox_top: z.number().optional().describe("New bounding box top edge (used when bboxMode=2)"),
  bbox_right: z.number().optional().describe("New bounding box right edge (used when bboxMode=2)"),
  bbox_bottom: z.number().optional().describe("New bounding box bottom edge (used when bboxMode=2)"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

// --- Sprite frames (subproject B) ---
// A frame is two pngs (the composite and the per-layer copy), so every writer
// below rewrites the sprite .yy AND those image pairs; none of them draws,
// resizes a multi-frame sprite, or touches the .yyp / texture group.

// Disk-free argument refusals for the auto-snapshot hook. `frameCount` lives on
// disk, so only the parts that do not need it are checked here -- but a call that
// cannot be valid at all (a negative index, a repeated order entry, an inverted
// trim range) must not pay for a project copy that is then kept as
// `failed: true`. The module re-validates everything against the real sprite.
const nonNegativeFrameIndex = (args: any): string | null =>
  Number.isInteger(args?.index) && args.index >= 0 ? null : "index must be a 0-based frame index";

// `index` is optional on add_sprite_frame (omitted = append), so only a present,
// unusable value disqualifies the call.
const optionalNonNegativeFrameIndex = (args: any): string | null =>
  args?.index === undefined || (Number.isInteger(args.index) && args.index >= 0)
    ? null
    : "index must be a 0-based frame index (omit it to append)";

const spriteFramePrevalidate: Record<string, (args: any) => string | null> = {
  add_sprite_frame: optionalNonNegativeFrameIndex,
  remove_sprite_frame: nonNegativeFrameIndex,
  replace_sprite_frame: nonNegativeFrameIndex,
  reorder_sprite_frames: (args: any) => {
    const order = args?.order;
    if (!Array.isArray(order) || order.length === 0) return "order must be a non-empty array of frame indices";
    const seen = new Set<number>();
    for (const value of order) {
      if (!Number.isInteger(value) || value < 0) return "order must contain only 0-based frame indices";
      if (seen.has(value)) return `order repeats the frame index ${value}`;
      seen.add(value);
    }
    return null;
  },
  trim_sprite_frames: (args: any) =>
    Number.isInteger(args?.from) && Number.isInteger(args?.to) && args.from >= 0 && args.from <= args.to
      ? null
      : "trim needs 0 <= from <= to",
};

// The two tools that delete frame pngs report what they could NOT delete rather
// than throwing after the .yy was written. The warning goes out as a SECOND
// content part so content[0] stays pure JSON (the same rule the auto-snapshot
// hook follows for its own warnings).
function spriteFrameResponse(result: { leftoverFiles?: string[] }): { content: Array<{ type: string; text: string }> } {
  const content: Array<{ type: string; text: string }> = [{ type: "text", text: JSON.stringify(result, null, 2) }];
  const leftovers = result.leftoverFiles ?? [];
  if (leftovers.length > 0) {
    content.push({
      type: "text",
      text:
        `⚠ the sprite .yy no longer references ${leftovers.length} of these file(s), but they could not be deleted ` +
        `(${leftovers.join(", ")}). Close the sprite in GameMaker (or wait for the antivirus scan) and remove them by hand: ` +
        `the sprite still loads, the leftover is just unreferenced`,
    });
  }
  return { content };
}

const FrameIndexDescription =
  "0-based frame index, counted in the sprite's frames[] order. There is no last-frame shorthand: " +
  "-1 is refused, and only the tools that say so treat an omitted index as append";

const ListSpriteFramesSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the existing sprite whose frame list and sequence to read"),
});

const AddSpriteFrameSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the existing sprite to add a frame to"),
  sourceImagePath: z
    .string()
    .describe(
      "Absolute path to a PNG that is copied into the sprite verbatim (never moved, never re-encoded, never resized). " +
        "Its pixel size must equal the sprite's current width x height, because GameMaker cannot load a sprite whose frames differ in size"
    ),
  index: z
    .number()
    .int()
    .optional()
    .describe(
      `${FrameIndexDescription}. Omitted (or an index equal to the current frameCount) appends the frame at the end; ` +
        "0..frameCount-1 inserts it before that frame and shifts the rest along. The new frame always gets a fresh guid"
    ),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const RemoveSpriteFrameSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the existing sprite to remove a frame from"),
  index: z
    .number()
    .int()
    .describe(
      `${FrameIndexDescription}. Removing the only frame is refused -- a zero-frame sprite cannot be loaded; delete the resource instead`
    ),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const ReplaceSpriteFrameSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the existing sprite holding the frame to replace"),
  index: z
    .number()
    .int()
    .describe(
      `${FrameIndexDescription}. The frame guid is kept, so every imageIndex a room already points at stays valid -- only the png bytes change`
    ),
  sourceImagePath: z
    .string()
    .describe("Absolute path to the replacement PNG; both of the frame's png copies are overwritten with its bytes"),
  allowResize: z
    .boolean()
    .default(false)
    .describe(
      "false (default) refuses a source PNG whose size differs from the sprite's, naming both sizes and the frame index. " +
        "true accepts the new size only on a single-frame sprite (it then rewrites a full-frame bbox to match); " +
        "on a multi-frame sprite it is refused, because one frame at a different size makes the sprite unloadable"
    ),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const ReorderSpriteFramesSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the existing sprite whose frames to permute"),
  order: z
    .array(z.number())
    .describe(
      "New frame order as 0-based source indices: order[k] is the index of the frame that becomes frame k. " +
        "Must be a permutation of 0..frameCount-1 -- same length, every value an integer in range, no duplicates, no -1. " +
        "The identity permutation [0,1,2,...] is a no-op that writes nothing"
    ),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const TrimSpriteFramesSchema = ProjectSchema.extend({
  spriteName: z.string().describe("Name of the existing sprite to trim the frame list of"),
  from: z
    .number()
    .int()
    .describe(`${FrameIndexDescription}. First frame to KEEP (inclusive); must be 0 <= from <= to`),
  to: z
    .number()
    .int()
    .describe(
      `${FrameIndexDescription}. Last frame to KEEP (inclusive); must be <= frameCount-1. ` +
        "Trim keeps from..to and deletes everything outside it, so 0..frameCount-1 is a no-op"
    ),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const GetScriptInfoSchema = ProjectSchema.extend({
  scriptName: z.string().describe("Name of the script to inspect"),
});


const AddShaderSchema = ProjectSchema.extend({
  shaderName: z.string().describe("Name of the shader to create"),
  vertexCode: z.string().optional().describe("Vertex shader GLSL ES code (defaults to a passthrough shader)"),
  fragmentCode: z.string().optional().describe("Fragment shader GLSL ES code (defaults to a passthrough shader)"),
});

const GetShaderInfoSchema = ProjectSchema.extend({
  shaderName: z.string().describe("Name of the shader to inspect"),
});

const EditShaderSchema = ProjectSchema.extend({
  shaderName: z.string().describe("Name of the existing shader to edit"),
  vertexCode: z.string().optional().describe("New vertex shader GLSL ES code"),
  fragmentCode: z.string().optional().describe("New fragment shader GLSL ES code"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const AddSoundSchema = ProjectSchema.extend({
  soundName: z.string().describe("Name of the sound to create"),
  sourceFile: z.string().describe("Absolute path to a .wav or .ogg (Vorbis) file to import (.mp3 is not supported yet)"),
  volume: z.number().min(0).max(1).default(1.0).describe("Playback volume (0-1)"),
  preload: z.boolean().default(true).describe("Whether to preload the sound"),
});

const GetSoundInfoSchema = ProjectSchema.extend({
  soundName: z.string().describe("Name of the sound to inspect"),
});

const EditSoundSchema = ProjectSchema.extend({
  soundName: z.string().describe("Name of the existing sound to edit"),
  volume: z.number().min(0).max(1).optional().describe("New playback volume (0-1)"),
  preload: z.boolean().optional().describe("New preload flag"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const AddFontSchema = ProjectSchema.extend({
  fontName: z.string().describe("Name of the font to create"),
  systemFontName: z.string().describe("Name of an installed system font (e.g. \"Arial\")"),
  size: z.number().positive().default(12).describe("Font size in points"),
  bold: z.boolean().default(false).describe("Bold style"),
  italic: z.boolean().default(false).describe("Italic style"),
});

const GetFontInfoSchema = ProjectSchema.extend({
  fontName: z.string().describe("Name of the font to inspect"),
});

const EditFontSchema = ProjectSchema.extend({
  fontName: z.string().describe("Name of the existing font to edit"),
  systemFontName: z.string().optional().describe("New installed system font name"),
  size: z.number().positive().optional().describe("New font size in points"),
  bold: z.boolean().optional().describe("New bold style"),
  italic: z.boolean().optional().describe("New italic style"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const AddTilesetSchema = ProjectSchema.extend({
  tilesetName: z.string().describe("Name of the tile set to create"),
  spriteName: z.string().describe("Name of an existing sprite to use as the tile source image (add one first with add_sprite_from_images)"),
  tileWidth: z.number().int().positive().describe("Width of one tile in pixels"),
  tileHeight: z.number().int().positive().describe("Height of one tile in pixels"),
  tilehsep: z.number().int().nonnegative().default(0).describe("Horizontal spacing between tiles in the source sprite, in pixels"),
  tilevsep: z.number().int().nonnegative().default(0).describe("Vertical spacing between tiles in the source sprite, in pixels"),
  tilexoff: z.number().int().nonnegative().default(0).describe("Horizontal offset from the left edge of the source sprite before the first tile, in pixels"),
  tileyoff: z.number().int().nonnegative().default(0).describe("Vertical offset from the top edge of the source sprite before the first tile, in pixels"),
});

const GetTilesetInfoSchema = ProjectSchema.extend({
  tilesetName: z.string().describe("Name of the tile set to inspect"),
});

const EditTilesetSchema = ProjectSchema.extend({
  tilesetName: z.string().describe("Name of the existing tile set to edit"),
  tileWidth: z.number().int().positive().optional().describe("New tile width in pixels"),
  tileHeight: z.number().int().positive().optional().describe("New tile height in pixels"),
  tilehsep: z.number().int().nonnegative().optional().describe("New horizontal spacing between tiles, in pixels"),
  tilevsep: z.number().int().nonnegative().optional().describe("New vertical spacing between tiles, in pixels"),
  tilexoff: z.number().int().nonnegative().optional().describe("New horizontal offset before the first tile, in pixels"),
  tileyoff: z.number().int().nonnegative().optional().describe("New vertical offset before the first tile, in pixels"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const AddExtensionSchema = ProjectSchema.extend({
  extensionName: z.string().describe("Name of the extension to create"),
});

const GetExtensionInfoSchema = ProjectSchema.extend({
  extensionName: z.string().describe("Name of the extension to inspect"),
});

const AddParticleSystemSchema = ProjectSchema.extend({
  particleSystemName: z.string().describe("Name of the particle system to create"),
});

const GetParticleSystemInfoSchema = ProjectSchema.extend({
  particleSystemName: z.string().describe("Name of the particle system to inspect"),
});

const AddAnimCurveSchema = ProjectSchema.extend({
  animCurveName: z.string().describe("Name of the animation curve to create"),
});

const GetAnimCurveInfoSchema = ProjectSchema.extend({
  animCurveName: z.string().describe("Name of the animation curve to inspect"),
});

const FindTileRegionSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the room to inspect"),
  x: z.number().describe("World X coordinate to query"),
  y: z.number().describe("World Y coordinate to query"),
});

const ResourceCategoryEnum = z.enum(["rooms", "objects", "scripts", "sprites", "shaders", "sounds", "fonts", "notes", "tilesets", "extensions", "particles", "animcurves"]);

const FindReferencesSchema = ProjectSchema.extend({
  resourceName: z.string().min(1, "resourceName cannot be empty").describe("Name of the resource to search for references to"),
});

const DeleteResourceSchema = ProjectSchema.extend({
  category: ResourceCategoryEnum.describe("Resource category (rooms/objects/scripts/sprites/shaders/sounds/fonts/notes/tilesets/extensions/particles/animcurves)"),
  resourceName: z.string().describe("Name of the resource to delete"),
  force: z.boolean().default(false).describe("Delete even if still referenced elsewhere in the project"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const RenameResourceSchema = ProjectSchema.extend({
  category: ResourceCategoryEnum.describe("Resource category (rooms/objects/scripts/sprites/shaders/sounds/fonts/notes/tilesets/extensions/particles/animcurves)"),
  oldName: z.string().describe("Current name of the resource"),
  newName: z.string().describe("New name for the resource"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const ListResourcesSchema = ProjectSchema.extend({
  kind: z
    .enum(["rooms", "objects", "scripts", "sprites", "shaders", "sounds", "fonts", "notes", "tilesets", "extensions", "particles", "animcurves"])
    .optional()
    .describe("Type of resources to list (optional)"),
});

const ObjectPhysicsSchema = z.object({
  enabled: z.boolean().optional().describe("Turn physics on (true) or reset every physics field below to GameMaker's defaults (false). Omitted leaves it alone"),
  density: z.number().optional().describe("Physics density (physicsDensity)"),
  friction: z.number().optional().describe("Physics friction (physicsFriction)"),
  restitution: z.number().optional().describe("Physics restitution/bounciness (physicsRestitution)"),
  collisionGroup: z.number().int().optional().describe("Physics collision group (physicsGroup)"),
  kinematic: z.boolean().optional().describe("Whether the object is kinematic (physicsKinematic)"),
  sensor: z.boolean().optional().describe("Whether the object is a sensor (physicsSensor)"),
  shape: z.number().int().optional().describe("Physics collision shape (physicsShape; 1=circle, 2=box, 3=convex/concave points)"),
  startAwake: z.boolean().optional().describe("Whether the object starts awake (physicsStartAwake)"),
  angularDamping: z.number().optional().describe("Angular damping (physicsAngularDamping)"),
  linearDamping: z.number().optional().describe("Linear damping (physicsLinearDamping)"),
  gravityScale: z
    .number()
    .optional()
    .describe("NOT SUPPORTED: a GMObject .yy has no gravity-scale key (GameMaker keeps gravity per room instance), so there is nothing to write -- passing this is an error, not a silently dropped field"),
}).refine(v => v.gravityScale === undefined, {
  message: "physics.gravityScale cannot be stored: a GMObject .yy has no gravity-scale key (GameMaker keeps gravity per room instance)",
  path: ["gravityScale"],
});

const VariableDefinitionSchema = z.object({
  name: z.string().describe("Variable name as declared in the object's Variable Definitions panel"),
  value: z.string().describe("Initial value as written in the panel (strings are unquoted)"),
  type: z
    .enum(["real", "asset"])
    .default("real")
    .describe("value type: \"real\" (varType 0) or \"asset\" (varType 4). Only these two have a verified .yy encoding, so any other type is rejected rather than guessed at"),
});

const EditObjectSchema = ProjectSchema.extend({
  objectName: z.string().describe("Name of the existing object to edit"),
  spriteName: z.string().nullable().optional().describe("Sprite to assign; null clears the sprite, omitted leaves it unchanged. The sprite must already exist"),
  spriteMaskName: z.string().nullable().optional().describe("Collision-mask sprite to assign; null clears it (falls back to the sprite's own mask), omitted leaves it unchanged"),
  parentObjectName: z.string().nullable().optional().describe("Parent object to assign; null clears the parent, omitted leaves it unchanged"),
  solid: z.boolean().optional().describe("Solid flag"),
  visible: z.boolean().optional().describe("Visible flag"),
  persistent: z.boolean().optional().describe("Persistent flag (survives room changes)"),
  physics: ObjectPhysicsSchema.optional().describe("Physics settings; each field is optional and maps onto GameMaker's physics* keys"),
  variableDefinitions: z
    .array(VariableDefinitionSchema)
    .nullable()
    .optional()
    .describe("Object variable definitions; [] or null empties the list, omitted leaves it unchanged"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const ListRoomLayersSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room to inspect"),
});

const AddRoomLayerSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room to add the layer to"),
  layerName: z.string().describe("Free-text layer name, as GameMaker's editor allows it (spaces and hyphens are fine). It must be unique in the room, non-empty, at most 255 characters, and cannot contain \"/\", \"\\\", \":\" or \".\""),
  layerType: z
    .enum(["instance", "asset", "tile", "path", "background", "effect", "folder"])
    .describe("Layer kind to create: instance, asset, tile, path, background, effect, or folder"),
  depth: z.number().int().optional().describe("Layer depth; higher draws further back. Omitted = 100 behind the room's deepest existing layer"),
  visible: z.boolean().default(true).describe("Whether the layer starts visible (default true)"),
  parentLayerName: z.string().optional().describe("Name of an existing folder layer to nest this one inside; omitted adds it at the top level"),
  tilesetName: z.string().optional().describe("Required for layerType \"tile\": the existing tile set whose tile size sizes the layer's grid"),
  spriteName: z.string().optional().describe("For layerType \"asset\": an existing sprite to place as the layer's single graphic"),
  color: z.number().int().optional().describe("Colour as an ABGR integer (background layers default to opaque black 4278190080; asset/path layers to 4294967295)"),
  tiled: z.boolean().optional().describe("Background layers: tile the sprite both horizontally and vertically"),
  stretch: z.boolean().optional().describe("Background layers: stretch the sprite to the room"),
  horizontalTile: z.boolean().optional().describe("Background layers: tile the sprite horizontally"),
  verticalTile: z.boolean().optional().describe("Background layers: tile the sprite vertically"),
  xscale: z.number().optional().describe("Asset layers: horizontal scale of the placed graphic (default 1.0)"),
  yscale: z.number().optional().describe("Asset layers: vertical scale of the placed graphic (default 1.0)"),
  hspeed: z.number().optional().describe("Background layers: horizontal scroll speed (default 0.0)"),
  vspeed: z.number().optional().describe("Background layers: vertical scroll speed (default 0.0)"),
  x: z.number().optional().describe("Background layers: layer X offset in pixels (default 0)"),
  y: z.number().optional().describe("Background layers: layer Y offset in pixels (default 0)"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
}).refine(v => v.layerType !== "tile" || v.tilesetName !== undefined, {
  message: "layerType \"tile\" requires tilesetName -- create one with add_tileset first",
  path: ["tilesetName"],
});

const RemoveRoomLayerSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room to remove the layer from"),
  layerName: z.string().describe("Name of the layer to remove"),
  force: z.boolean().default(false).describe("Delete even if the layer still holds elements or sub-layers (default false refuses)"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const SetRoomLayerSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room holding the layer"),
  layerName: z.string().describe("Name of the layer to change (layers cannot be renamed -- GameMaker resolves them by name at runtime)"),
  visible: z.boolean().optional().describe("New visibility"),
  depth: z.number().int().optional().describe("New depth; higher draws further back"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const GetRoomTilesSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room holding the tile layer"),
  layerName: z.string().describe("Name of the tile layer to read"),
  x: z.number().int().nonnegative().optional().describe("First column to read (default 0)"),
  y: z.number().int().nonnegative().optional().describe("First row to read (default 0)"),
  width: z.number().int().positive().optional().describe("Number of columns to read (default: to the layer's right edge)"),
  height: z.number().int().positive().optional().describe("Number of rows to read (default: to the layer's bottom edge)"),
});

const SetRoomTilesSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room holding the tile layer"),
  layerName: z.string().describe("Name of the tile layer to write"),
  tiles: z
    .array(
      z.object({
        x: z.number().int().nonnegative().describe("Column of the cell (0-based)"),
        y: z.number().int().nonnegative().describe("Row of the cell (0-based)"),
        index: z.number().int().min(-1).describe("Tile index to store; -1 clears the cell"),
      })
    )
    .describe("Cells to write; each cell is validated before anything is written"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const FillRoomTilesSchema = ProjectSchema.extend({
  roomName: z.string().describe("Name of the existing room holding the tile layer"),
  layerName: z.string().describe("Name of the tile layer to write"),
  x: z.number().int().nonnegative().describe("Left column of the rectangle (0-based)"),
  y: z.number().int().nonnegative().describe("Top row of the rectangle (0-based)"),
  width: z.number().int().positive().describe("Rectangle width in cells; must stay inside the layer"),
  height: z.number().int().positive().describe("Rectangle height in cells; must stay inside the layer"),
  index: z.number().int().min(-1).describe("Tile index to fill with; -1 clears the rectangle"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

// --- Safety (subproject E) ---

const CreateSnapshotSchema = ProjectSchema.extend({
  reason: z
    .string()
    .max(500)
    .optional()
    .describe("Free-text note stored in the snapshot's manifest, never interpreted (max 500 chars)"),
});

const RestoreSnapshotSchema = ProjectSchema.extend({
  snapshotId: z.string().describe("Snapshot id from list_snapshots, shaped <YYYYMMDD>-<HHmmss>-<6 hex>"),
  files: z
    .array(z.string())
    .optional()
    .describe("Project-relative paths to restore (omit for the whole snapshot). Every path must be in the snapshot's manifest; one unknown path restores nothing. Paths the snapshot skipped (over the per-file size cap, or a symlink) are reported in missingFromSnapshot instead"),
});

const DeleteSnapshotSchema = ProjectSchema.extend({
  snapshotId: z.string().describe("Snapshot id from list_snapshots. The snapshot undo_last would currently restore is refused"),
});

const ReadFileSchema = ProjectSchema.extend({
  path: z
    .string()
    .describe("Project-relative file path (e.g. objects/obj_player/Create_0.gml). Absolute paths, drive letters and anything resolving outside the project are refused"),
  offset: z.number().int().positive().optional().describe("1-based first line to return (default 1)"),
  limit: z.number().int().positive().optional().describe("Number of lines to return (default 2000, capped at 5000)"),
});

const PatchFileSchema = ProjectSchema.extend({
  path: z
    .string()
    .describe("Project-relative file path of an existing file. A path inside .gm-forge/ is refused, and so is anything resolving outside the project"),
  find: z
    .string()
    .min(1)
    .describe("Literal text to find -- never a regular expression or a pattern, so regex metacharacters match themselves"),
  replace: z.string().describe("Literal replacement text; an empty string deletes the match. Line endings are normalised to the file's own"),
  count: z
    .enum(["exact", "all"])
    .default("exact")
    .describe("exact (default) succeeds only when find occurs exactly once; all replaces every non-overlapping occurrence. Writes nothing in either case if find occurs zero times"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

// --- Project config (subproject C) ---

const PLATFORM_DESCRIPTION =
  "Options platform directory name: android, html5, ios, linux, mac, main, operagx, reddit, tvos or windows. " +
  "The display name from the options file (\"macOS\", \"Opera GX\", \"HTML5\") is accepted too. " +
  "A platform this project has no options/ directory for is an error -- these tools never create one";

const GetProjectOptionsSchema = ProjectSchema.extend({
  platform: z.string().optional().describe(`Omitted reads every options/*/options_*.yy in the project, sorted by platform. ${PLATFORM_DESCRIPTION}`),
});

// `key` is a plain string on purpose: the writable set depends on the platform
// (option_resize exists on windows and linux, not on reddit) and on the
// GameMaker version, and three of the rejected names have to reach the module to
// get their own reason ("read-only" / "unverified: no GameMaker 2026.0.0.16
// sample defines this key"). A z.enum would turn both into one zod message.
const SET_PROJECT_OPTION_KEY_DESCRIPTION =
  "Logical option name. Writable (the module resolves the real on-disk spelling, e.g. " +
  `option_<platform>_interpolate_pixels): ${OPTION_ALLOWLIST.filter(s => s.status === "verified").map(s => s.key).join(", ")}. ` +
  `Rejected with its own reason: ${OPTION_ALLOWLIST.filter(s => s.status !== "verified").map(s => `${s.key} (${s.status})`).join(", ")}`;

const SetProjectOptionSchema = ProjectSchema.extend({
  platform: z.string().optional().describe(`Defaults to "main", the project-wide options file. ${PLATFORM_DESCRIPTION}`),
  key: z.string().describe(SET_PROJECT_OPTION_KEY_DESCRIPTION),
  value: z
    .union([z.boolean(), z.number(), z.string()])
    .describe("New value, typed by the option: bool options need true/false, int options a whole number, string options a string. Type is checked before anything is written"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const ListIncludedFilesSchema = ProjectSchema.extend({});

const AddIncludedFileSchema = ProjectSchema.extend({
  sourcePath: z
    .string()
    .describe("File to register. With copy (the default) an absolute path or a project-relative one; with copy: false it must already live inside the project"),
  targetName: z
    .string()
    .optional()
    .describe("Directory under datafiles/ the file is copied into -- one path segment, no separators. Defaults to the basename without its extension (assets/manifest.json -> datafiles/manifest/)"),
  copy: z
    .boolean()
    .optional()
    .describe("true (default) copies the file to datafiles/<targetName>/<basename> and registers it there; false registers the source in place, which must be inside the project"),
  overwrite: z
    .boolean()
    .optional()
    .describe("Replace an existing IncludedFiles entry with the same name (in place, keeping its extra keys) and an existing destination file, instead of refusing"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const RemoveIncludedFileSchema = ProjectSchema.extend({
  name: z.string().describe("Name of the registered included file (the basename with its extension, as list_included_files reports it)"),
  deleteFile: z
    .boolean()
    .optional()
    .describe("false (default) only unregisters the entry. true also deletes the file, and the datafiles/ directory if that leaves it empty -- never when another entry still references the same path"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

const ListMacrosSchema = ProjectSchema.extend({});

const SetMacroSchema = ProjectSchema.extend({
  name: z.string().describe("Macro name -- a GML identifier, matched case-sensitively"),
  value: z.string().describe("Replacement value: one line, no bare trailing // (it would read back as a comment)"),
  file: z
    .string()
    .optional()
    .describe("Project-relative .gml file to write. Defaults to scripts/macros/macros.gml, which is the only file this tool ever creates; an existing file elsewhere can be updated by naming it"),
  skipSnapshot: z.boolean().optional().describe(SKIP_SNAPSHOT_DESCRIPTION),
});

// Read-only. Timelines and sequences have no writer here: no GameMaker-generated
// file of either type exists on this machine to capture a shape from, so a writer
// would be a guess the IDE rejects (docs/specs/D-sequences-timelines.md).
const ListTimelinesSchema = ProjectSchema.extend({
  timelineName: z
    .string()
    .optional()
    .describe("Name of one timeline to summarise. Omit to list every timeline the .yyp registers"),
});

const ListSequencesSchema = ProjectSchema.extend({
  sequenceName: z
    .string()
    .optional()
    .describe("Name of one sequence to summarise. Omit to list every sequence the .yyp registers, plus the count of sequences embedded in sprites"),
});

// Create MCP server instance
const server = new Server(
  {
    name: "gm-forge-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Single source of truth for every tool: the same zod schema that parses
// arguments at dispatch time also generates the MCP inputSchema. The
// previous hand-written JSON copies drifted from the zod definitions once
// (add_sound advertising formats the parser rejects), so they're gone.
interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  /**
   * Optional disk-free argument check used by the auto-snapshot hook: returning a
   * message means "this call cannot be valid, do not spend a project copy on it".
   * The handler still runs and throws its own error, so there is one copy of
   * every validation rule.
   */
  prevalidate?: (args: any) => string | null;
}

const TOOL_DEFS: ToolDef[] = [
  { name: "create_project", description: "Create a new GameMaker YYP project at the specified directory if it does not exist", schema: CreateProjectSchema },
  { name: "add_texture_group", description: "Create a new, additional texture group in the project (beyond the default one auto-provisioned for sprites/fonts)", schema: AddTextureGroupSchema },
  { name: "add_audio_group", description: "Create a new, additional audio group in the project (beyond the default one auto-provisioned for sounds)", schema: AddAudioGroupSchema },
  { name: "add_script", description: "Create a new GML script and register it in the YYP", schema: AddScriptSchema },
  { name: "edit_script", description: "Edit an existing script's GML code, either replacing it entirely or appending to it", schema: EditScriptSchema },
  { name: "add_object", description: "Create a GameMaker object .yy file with optional event stubs and register it in the project", schema: AddObjectSchema },
  { name: "add_object_event", description: "Add a new event to an existing object, with its own GML code", schema: AddObjectEventSchema },
  { name: "edit_object", description: "Edit an existing object in place: sprite, sprite mask, parent, solid/visible/persistent, physics settings, and object variable definitions -- omitted fields are left alone, null clears a reference", schema: EditObjectSchema },
  { name: "add_sprite_from_images", description: "Import frames from a directory into a new sprite and register it in the project", schema: AddSpriteSchema },
  { name: "add_room", description: "Create a GameMaker room with default instance and background layers, register it in the project and room order", schema: AddRoomSchema },
  { name: "edit_room", description: "Edit an existing room's width, height, and/or persistent flag", schema: EditRoomSchema },
  { name: "add_room_instance", description: "Place an instance of an existing object into an existing room at a given position", schema: AddRoomInstanceSchema },
  { name: "reorder_room", description: "Move a room to an absolute position in the game's room order (what room_goto_next/previous follow at runtime)", schema: ReorderRoomSchema },
  { name: "move_room_relative", description: "Move a room immediately before or after another named room in the room order", schema: MoveRoomRelativeSchema },
  { name: "add_note", description: "Create a new Notes resource (plain-text project documentation, never compiled into the game) and register it in the project", schema: AddNoteSchema },
  { name: "get_note_info", description: "Get an existing note's content", schema: GetNoteInfoSchema },
  { name: "get_object_info", description: "Get detailed info about an existing object: sprite, parent, physics, and its full event list with human-readable event names", schema: GetObjectInfoSchema },
  { name: "get_room_info", description: "Get detailed info about an existing room: dimensions, persistence, layers, and every placed instance with its position", schema: GetRoomInfoSchema },
  { name: "find_tile_region", description: "Check whether a world point in a room sits on a real tile, decoding GameMaker's compressed tile layer data (invisible to get_room_info's instance list). If occupied, reports the connected region of tiles it belongs to -- use this to confirm a spot is actually inside tile-drawn geometry (a building, a floor) before placing something there, not just clear of instances.", schema: FindTileRegionSchema },
  { name: "list_room_layers", description: "List every layer in a room in layer-editor order, recursing into folder layers: name, type, depth, visibility, and element count", schema: ListRoomLayersSchema },
  { name: "add_room_layer", description: "Add a layer of any kind (instance, asset, tile, path, background, effect, folder) to an existing room, including nested under a folder. A tile layer is created room-sized and all-empty, gridded by its tile set.", schema: AddRoomLayerSchema },
  { name: "remove_room_layer", description: "Remove a layer from a room. Refuses a layer that still holds instances/tiles or sub-layers unless force=true", schema: RemoveRoomLayerSchema },
  { name: "set_room_layer", description: "Change an existing layer's visibility and/or depth (layers cannot be renamed)", schema: SetRoomLayerSchema },
  { name: "get_room_tiles", description: "Read a tile layer's cells as a row-major grid of tile indices, -1 meaning empty (translated from GameMaker's int32 empty sentinel). Omitted rect reads the whole layer.", schema: GetRoomTilesSchema },
  { name: "set_room_tiles", description: "Write individual tile cells (index -1 clears a cell). Every cell is validated before anything is written; a call that changes nothing leaves the file untouched.", schema: SetRoomTilesSchema },
  { name: "fill_room_tiles", description: "Fill an axis-aligned rectangle of a tile layer with one tile index, inclusive of its origin cell. Rectangles that run past the layer are errors, not silent clips.", schema: FillRoomTilesSchema },
  { name: "get_sprite_info", description: "Get detailed info about an existing sprite: real dimensions, frame count, origin, collision settings", schema: GetSpriteInfoSchema },
  { name: "edit_sprite", description: "Edit an existing sprite's origin, collision kind, and/or bounding box -- not its frame data", schema: EditSpriteSchema },
  { name: "list_sprite_frames", description: "Read a sprite's frame list and its frames sequence: per-frame guid, png path and whether both copies exist, plus the sequence length, playback speed, keyframe count and a verdict (\"ok\" or \"frames-vs-sequence mismatch: N vs M\"). Read-only -- it reports a broken sprite instead of repairing it", schema: ListSpriteFramesSchema },
  { name: "add_sprite_frame", description: "Append or insert one frame from a PNG on disk (omitted index appends, 0..frameCount-1 inserts before that frame). The PNG must match the sprite's size -- there is no resize and no pixel editing -- and the new frame gets a fresh guid plus both png copies GameMaker expects. Never touches the .yyp or texture group", schema: AddSpriteFrameSchema, prevalidate: spriteFramePrevalidate.add_sprite_frame },
  { name: "remove_sprite_frame", description: "Remove one frame and delete both of its png copies, renumbering the remaining keyframes. Refuses the only frame of a sprite (delete the resource instead). Not a pixel edit: nothing else in the sprite changes", schema: RemoveSpriteFrameSchema, prevalidate: spriteFramePrevalidate.remove_sprite_frame },
  { name: "replace_sprite_frame", description: "Replace one frame's image in place, keeping its guid so every room imageIndex stays valid. The source PNG must match the sprite's size unless allowResize is set, which only works on a single-frame sprite. Image bytes only -- no pixel editing, no bbox/origin change beyond a full-frame default following an allowResize", schema: ReplaceSpriteFrameSchema, prevalidate: spriteFramePrevalidate.replace_sprite_frame },
  { name: "reorder_sprite_frames", description: "Permute a sprite's frames with an order array that must be a permutation of 0..frameCount-1; each keyframe travels with its frame, so no guid or keyframe id is regenerated. The identity permutation writes nothing. No packing, no drawing", schema: ReorderSpriteFramesSchema, prevalidate: spriteFramePrevalidate.reorder_sprite_frames },
  { name: "trim_sprite_frames", description: "Keep the inclusive frame range from..to and delete the frames outside it (both png copies each), the usual cleanup after importing a strip that begins with padding frames. The full range 0..frameCount-1 is a no-op. Not a strip importer and not a splitter", schema: TrimSpriteFramesSchema, prevalidate: spriteFramePrevalidate.trim_sprite_frames },
  { name: "get_script_info", description: "Get an existing script's current GML code", schema: GetScriptInfoSchema },
  { name: "add_shader", description: "Create a new vertex+fragment shader pair (GLSL ES) and register it in the project", schema: AddShaderSchema },
  { name: "get_shader_info", description: "Get an existing shader's vertex and fragment code", schema: GetShaderInfoSchema },
  { name: "edit_shader", description: "Edit an existing shader's vertex and/or fragment code", schema: EditShaderSchema },
  { name: "add_sound", description: "Import a .wav or .ogg (Vorbis) file as a new sound and register it in the project. Metadata (sample rate, channels, duration) is derived from the real file; .mp3 isn't supported yet", schema: AddSoundSchema },
  { name: "get_sound_info", description: "Get an existing sound's file, volume, and playback settings", schema: GetSoundInfoSchema },
  { name: "edit_sound", description: "Edit an existing sound's volume and/or preload flag (not its audio metadata, which is always derived from the real file)", schema: EditSoundSchema },
  { name: "add_font", description: "Create a new font referencing an installed system font by name and register it in the project", schema: AddFontSchema },
  { name: "get_font_info", description: "Get an existing font's system font name, size, and style", schema: GetFontInfoSchema },
  { name: "edit_font", description: "Edit an existing font's system font name, size, and/or style", schema: EditFontSchema },
  { name: "add_tileset", description: "Create a new tile set from an existing sprite (add the sprite first with add_sprite_from_images) and register it in the project. Column/row/tile counts are computed from the sprite's real dimensions.", schema: AddTilesetSchema },
  { name: "get_tileset_info", description: "Get an existing tile set's source sprite, tile dimensions, and tile count", schema: GetTilesetInfoSchema },
  { name: "edit_tileset", description: "Edit an existing tile set's dimensions, spacing, or offset -- column/tile counts are recomputed from the real source sprite", schema: EditTilesetSchema },
  { name: "add_extension", description: "Create a new, empty extension shell (matches File > New Extension before any functions/constants/files are added in the IDE) and register it in the project", schema: AddExtensionSchema },
  { name: "get_extension_info", description: "Get an existing extension's version and file count", schema: GetExtensionInfoSchema },
  { name: "add_particle_system", description: "Create a new particle system with one default emitter and register it in the project", schema: AddParticleSystemSchema },
  { name: "get_particle_system_info", description: "Get an existing particle system's emitter count and names", schema: GetParticleSystemInfoSchema },
  { name: "add_anim_curve", description: "Create a new animation curve with one straight-line channel from (0,0) to (1,1) and register it in the project", schema: AddAnimCurveSchema },
  { name: "get_anim_curve_info", description: "Get an existing animation curve's channel count, names, and point counts", schema: GetAnimCurveInfoSchema },
  { name: "find_references", description: "Find every place a resource is referenced across the whole project (rooms placing instances, other objects parenting to it, GML code calling it, etc.) -- use before deleting or renaming anything", schema: FindReferencesSchema },
  { name: "delete_resource", description: "Delete an existing resource. Refuses if it's still referenced elsewhere in the project unless force=true", schema: DeleteResourceSchema },
  { name: "rename_resource", description: "Rename an existing resource, rewriting every reference to it across the whole project (other resources' name/path references, GML code) so nothing is left dangling", schema: RenameResourceSchema },
  { name: "lint_project", description: "Validate a whole project for dangling references, orphaned resources, missing folder registrations, missing event code files, and sound/sprite metadata that doesn't match the real underlying file -- run this before trusting a project is safe to open", schema: ProjectSchema },
  { name: "compile_project", description: "Actually compile the project with GameMaker's real build tool (Igor) to catch real GML errors -- duplicate function names, syntax errors -- that structural checks like lint_project can't see. NOTE: a successful compile briefly LAUNCHES the built game (then kills it immediately), so the project's own code runs; only compile projects you trust. Requires the GameMaker runtime to be installed (skips gracefully with a clear message if not). Windows only.", schema: ProjectSchema },
  { name: "list_resources", description: "List resource names by type from the YYP file", schema: ListResourcesSchema },
  { name: "create_snapshot", description: "Back up the whole project into <projectDir>/.gm-forge/backups/ and return its snapshot id. Refuses (rather than writing a partial backup) when the project is over the snapshot size limits. Snapshots are plain files, never a git operation", schema: CreateSnapshotSchema },
  { name: "list_snapshots", description: "List the snapshots in <projectDir>/.gm-forge/backups/, newest first, with the tool that made each one and whether it has already been undone. A corrupt manifest is reported inline instead of failing the listing. totalBytes is logical size: identical files may share disk space", schema: ProjectSchema },
  { name: "restore_snapshot", description: "Restore files from a snapshot, either the whole snapshot or a list of project-relative paths. Every stored file is checked against its recorded sha256 first, so a corrupted snapshot fails without changing anything. This is not a redo point: create_snapshot first if you want one. Close GameMaker before restoring -- it holds .yy files open and saves over restores silently", schema: RestoreSnapshotSchema },
  { name: "delete_snapshot", description: "Delete one snapshot directory. The snapshot undo_last would currently restore is refused, as is any id that does not resolve inside the store", schema: DeleteSnapshotSchema },
  { name: "read_file", description: "Read any text file in the project (.gml, .yy, .yyp, .json, notes) with 1-based line numbers, 'N: ' prefixed, so a follow-up can name an exact line. Pages by lines with offset/limit; refuses binary/UTF-16 files, directories, and files over 2 MiB", schema: ReadFileSchema },
  { name: "patch_file", description: "Replace literal text in an existing project file and back it up first. Matching is exact-string (no regex, no fuzzy match), and the call writes nothing unless find occurs exactly once, or at least once with count: \"all\". The file's line endings, BOM and trailing newline are preserved. JSON is not validated afterwards -- run lint_project to check the result", schema: PatchFileSchema },
  { name: "list_changes", description: "Compare the project on disk against the newest snapshot: files added, modified or deleted since it was taken, plus how many large files snapshots do not cover. Files whose size and mtime both match are not re-hashed", schema: ProjectSchema },
  { name: "undo_last", description: "Revert the files the most recent un-undone operation touched, deleting files it created. Safe to call repeatedly: each call peels one operation, and it says so when there is nothing left to undo", schema: ProjectSchema },
  { name: "get_project_options", description: "Read the project's options/*/options_*.yy files as plain option_* maps with the GameMaker envelope stripped. Read-only; omit platform for all of them. This is the before/after evidence for set_project_option", schema: GetProjectOptionsSchema },
  { name: "set_project_option", description: "Change one project option (the interpolate_pixels switch behind pixel-art fringing, game speed, author, per-platform scale/fullscreen/resize/version) in place, rewriting only that line. Only the curated, captured allowlist is writable; unknown, read-only (option_gameguid) and unverified names are refused with the reason, and a key GameMaker did not write is never added. A file where the option is not on its own line is refused rather than reformatted, and the result reports the backup it took (snapshotId) or why it took none", schema: SetProjectOptionSchema },
  { name: "list_included_files", description: "List the project's IncludedFiles (the files GameMaker ships as data, from the .yyp) in the order GameMaker stored them, flagging any registered entry whose file is missing from disk", schema: ListIncludedFilesSchema },
  { name: "add_included_file", description: "Register a data file in the project's IncludedFiles, copying it to datafiles/<targetName>/ by default, and refuse a duplicate name, an occupied destination, or a path that would leave the project", schema: AddIncludedFileSchema },
  { name: "remove_included_file", description: "Unregister an IncludedFiles entry by name, leaving the file on disk unless deleteFile: true (unregistering must not silently delete user data)", schema: RemoveIncludedFileSchema },
  { name: "list_macros", description: "Index every #macro definition in the project's .gml files with file and line, including the duplicate names GameMaker silently resolves to the last definition. A #macro inside a /* */ block comment is not a definition. Skips the snapshot/backup, output, datafiles and options directories", schema: ListMacrosSchema },
  { name: "set_macro", description: "Set a #macro to a value, creating scripts/macros/macros.gml (plus its script resource and folder node) when nothing defines it yet, or rewriting exactly that one line in place. Never creates a second definition of a name that already exists, never writes into output/, datafiles/ or options/, and reports changed: false plus the backup it took (snapshotId) or skipped", schema: SetMacroSchema },
  { name: "list_timelines", description: "List the timelines the .yyp registers with each one's moment count, per-moment step and whether it carries code. Read-only, and tolerant by construction: it reports the moments key it found (or the root keys the file actually has) instead of a confident zero, and a file it cannot read or parse is reported in that entry's parseError rather than failing the listing. Field names are provisional -- no GameMaker-authored timeline exists on this machine to confirm them. There is no timeline writer: a shape guessed at this depth would be rejected by the IDE, not by us", schema: ListTimelinesSchema },
  { name: "list_sequences", description: "List the sequences the .yyp registers with length, playback speed, track count and each track's verbatim type and keyframe count, plus how many sequences are embedded in sprites' own .yy files. Read-only, and tolerant by construction: a track type it has never seen still lists, and a file it cannot parse is reported in that entry's parseError rather than failing the listing. There is no sequence writer -- only sprite-embedded GMSequences exist on this machine, which the gate in docs/specs/D-sequences-timelines.md rules insufficient", schema: ListSequencesSchema },
];

function toInputSchema(schema: z.ZodType): Tool["inputSchema"] {
  const { $schema: _dropped, ...json } = zodToJsonSchema(schema) as Record<string, unknown>;
  return json as Tool["inputSchema"];
}

const TOOLS: Tool[] = TOOL_DEFS.map(d => ({
  name: d.name,
  description: d.description,
  inputSchema: toInputSchema(d.schema),
}));

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS,
  };
});

// Call tool handler
async function dispatchTool(name: string, args: unknown) {
  switch (name) {
      case "create_project": {
        const { projectDir, name: projectName } = CreateProjectSchema.parse(args);
        // If the project already exists, leave its manifest byte-for-byte
        // alone (a load/write round-trip isn't guaranteed to be lossless)
        // and say so instead of claiming to have created it.
        if (await fileExists(path.join(projectDir, `${projectName}.yyp`))) {
          return {
            content: [
              {
                type: "text",
                text: `Project "${projectName}" already exists at ${projectDir} -- left unchanged`,
              },
            ],
          };
        }
        const yyp = await ensureProjectScaffold(projectDir, projectName);
        await writeYyp(projectDir, yyp);
        return {
          content: [
            {
              type: "text",
              text: `✓ Created GameMaker project "${projectName}" at ${projectDir}`,
            },
          ],
        };
      }

      case "add_texture_group": {
        const { projectDir, groupName } = AddTextureGroupSchema.parse(args);
        const yyp = await loadYyp(projectDir);
        addTextureGroup(yyp, groupName);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Texture group "${groupName}" created` }] };
      }

      case "add_audio_group": {
        const { projectDir, groupName } = AddAudioGroupSchema.parse(args);
        const yyp = await loadYyp(projectDir);
        addAudioGroup(yyp, groupName);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Audio group "${groupName}" created` }] };
      }

      case "add_script": {
        const { projectDir, scriptName, code } = AddScriptSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addScript(projectDir, yyp, scriptName, code);
        await writeYyp(projectDir, yyp);
        return {
          content: [
            {
              type: "text",
              text: `✓ Script "${scriptName}" added to project`,
            },
          ],
        };
      }

      case "edit_script": {
        const { projectDir, scriptName, code, mode } = EditScriptSchema.parse(args);
        await editScript(projectDir, scriptName, code, mode);
        return {
          content: [
            {
              type: "text",
              text: `✓ Script "${scriptName}" ${mode === "replace" ? "replaced" : "appended to"}`,
            },
          ],
        };
      }

      case "add_object": {
        const { projectDir, objectName, events } = AddObjectSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addObject(projectDir, yyp, objectName, events);
        await writeYyp(projectDir, yyp);
        return {
          content: [
            {
              type: "text",
              text: `✓ Object "${objectName}" added to project with ${events.length} event(s)`,
            },
          ],
        };
      }

      case "add_object_event": {
        const { projectDir, objectName, eventType, eventNum, collisionTargetName, code } = AddObjectEventSchema.parse(args);
        await addObjectEvent(projectDir, objectName, { eventType, eventNum, collisionTargetName }, code);
        return {
          content: [
            {
              type: "text",
              text: `✓ Event (type ${eventType}, num ${eventNum}) added to object "${objectName}"`,
            },
          ],
        };
      }

      case "edit_object": {
        const { projectDir, objectName, spriteName, spriteMaskName, parentObjectName, solid, visible, persistent, physics, variableDefinitions } =
          EditObjectSchema.parse(args);
        const text = await editObject(projectDir, objectName, {
          spriteName, spriteMaskName, parentObjectName, solid, visible, persistent, physics, variableDefinitions,
        });
        return { content: [{ type: "text", text }] };
      }

      case "add_sprite_from_images": {
        const { projectDir, spriteName, framesDir } = AddSpriteSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addSpriteFromImages(projectDir, yyp, spriteName, framesDir);
        await writeYyp(projectDir, yyp);
        return {
          content: [
            {
              type: "text",
              text: `✓ Sprite "${spriteName}" imported from ${framesDir}`,
            },
          ],
        };
      }

      case "add_room": {
        const { projectDir, roomName, width, height, persistent, creationCode } =
          AddRoomSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addRoom(projectDir, yyp, roomName, { width, height, persistent, creationCode });
        await writeYyp(projectDir, yyp);
        return {
          content: [
            {
              type: "text",
              text: `✓ Room "${roomName}" (${width}x${height}) added to project`,
            },
          ],
        };
      }

      case "edit_room": {
        const { projectDir, roomName, width, height, persistent } = EditRoomSchema.parse(args);
        await editRoom(projectDir, roomName, { width, height, persistent });
        return {
          content: [
            {
              type: "text",
              text: `✓ Room "${roomName}" updated`,
            },
          ],
        };
      }

      case "add_room_instance": {
        const { projectDir, roomName, objectName, x, y, rotation, scaleX, scaleY } =
          AddRoomInstanceSchema.parse(args);
        const { instanceName } = await addRoomInstance(projectDir, roomName, objectName, x, y, {
          rotation, scaleX, scaleY
        });
        return {
          content: [
            {
              type: "text",
              text: `✓ Instance "${instanceName}" of "${objectName}" placed in "${roomName}" at (${x}, ${y})`,
            },
          ],
        };
      }

      case "reorder_room": {
        const { projectDir, roomName, newIndex } = ReorderRoomSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = reorderRoom(yyp, roomName, newIndex);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Room "${roomName}" moved to position ${newIndex}` }] };
      }

      case "move_room_relative": {
        const { projectDir, roomName, targetRoomName, position } = MoveRoomRelativeSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = moveRoomRelativeTo(yyp, roomName, targetRoomName, position);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Room "${roomName}" moved ${position} "${targetRoomName}"` }] };
      }

      case "add_note": {
        const { projectDir, noteName, content } = AddNoteSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addNote(projectDir, yyp, noteName, content);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Note "${noteName}" added to project` }] };
      }

      case "get_note_info": {
        const { projectDir, noteName } = GetNoteInfoSchema.parse(args);
        const info = await getNoteInfo(projectDir, noteName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "get_object_info": {
        const { projectDir, objectName } = GetObjectInfoSchema.parse(args);
        const info = await getObjectInfo(projectDir, objectName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "get_room_info": {
        const { projectDir, roomName } = GetRoomInfoSchema.parse(args);
        const info = await getRoomInfo(projectDir, roomName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "find_tile_region": {
        const { projectDir, roomName, x, y } = FindTileRegionSchema.parse(args);
        const layers = await getRoomTileLayers(projectDir, roomName);
        const results = findTileRegion(layers, x, y);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "list_room_layers": {
        const { projectDir, roomName } = ListRoomLayersSchema.parse(args);
        const layers = await listRoomLayers(projectDir, roomName);
        return { content: [{ type: "text", text: JSON.stringify(layers, null, 2) }] };
      }

      case "add_room_layer": {
        const {
          projectDir, roomName, layerName, layerType, depth, visible, parentLayerName,
          tilesetName, spriteName, color, tiled, stretch, horizontalTile, verticalTile,
          xscale, yscale, hspeed, vspeed, x, y,
        } = AddRoomLayerSchema.parse(args);
        const result = await addRoomLayer(projectDir, roomName, layerName, {
          layerType, depth, visible, parentLayerName, tilesetName, spriteName, color,
          tiled, stretch, horizontalTile, verticalTile, xscale, yscale, hspeed, vspeed, x, y,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "remove_room_layer": {
        const { projectDir, roomName, layerName, force } = RemoveRoomLayerSchema.parse(args);
        const result = await removeRoomLayer(projectDir, roomName, layerName, { force });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "set_room_layer": {
        const { projectDir, roomName, layerName, visible, depth } = SetRoomLayerSchema.parse(args);
        const text = await setRoomLayer(projectDir, roomName, layerName, { visible, depth });
        return { content: [{ type: "text", text }] };
      }

      case "get_room_tiles": {
        const { projectDir, roomName, layerName, x, y, width, height } = GetRoomTilesSchema.parse(args);
        const result = await getRoomTiles(projectDir, roomName, layerName, { x, y, width, height });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "set_room_tiles": {
        const { projectDir, roomName, layerName, tiles } = SetRoomTilesSchema.parse(args);
        const result = await setRoomTiles(projectDir, roomName, layerName, tiles);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "fill_room_tiles": {
        const { projectDir, roomName, layerName, x, y, width, height, index } = FillRoomTilesSchema.parse(args);
        const result = await fillRoomTiles(projectDir, roomName, layerName, { x, y, width, height, index });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_sprite_info": {
        const { projectDir, spriteName } = GetSpriteInfoSchema.parse(args);
        const info = await getSpriteInfo(projectDir, spriteName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "edit_sprite": {
        const { projectDir, spriteName, xorigin, yorigin, collisionKind, bboxMode, bbox_left, bbox_top, bbox_right, bbox_bottom } = EditSpriteSchema.parse(args);
        await editSprite(projectDir, spriteName, { xorigin, yorigin, collisionKind, bboxMode, bbox_left, bbox_top, bbox_right, bbox_bottom });
        return { content: [{ type: "text", text: `✓ Sprite "${spriteName}" updated` }] };
      }

      case "list_sprite_frames": {
        const { projectDir, spriteName } = ListSpriteFramesSchema.parse(args);
        const result = await listSpriteFrames(projectDir, spriteName);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "add_sprite_frame": {
        const { projectDir, spriteName, sourceImagePath, index } = AddSpriteFrameSchema.parse(args);
        const result = await addSpriteFrame(projectDir, spriteName, sourceImagePath, index);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "remove_sprite_frame": {
        const { projectDir, spriteName, index } = RemoveSpriteFrameSchema.parse(args);
        const result = await removeSpriteFrame(projectDir, spriteName, index);
        return spriteFrameResponse(result);
      }

      case "replace_sprite_frame": {
        const { projectDir, spriteName, index, sourceImagePath, allowResize } = ReplaceSpriteFrameSchema.parse(args);
        const result = await replaceSpriteFrame(projectDir, spriteName, index, sourceImagePath, allowResize);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "reorder_sprite_frames": {
        const { projectDir, spriteName, order } = ReorderSpriteFramesSchema.parse(args);
        const result = await reorderSpriteFrames(projectDir, spriteName, order);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "trim_sprite_frames": {
        const { projectDir, spriteName, from, to } = TrimSpriteFramesSchema.parse(args);
        const result = await trimSpriteFrames(projectDir, spriteName, from, to);
        return spriteFrameResponse(result);
      }

      case "get_script_info": {
        const { projectDir, scriptName } = GetScriptInfoSchema.parse(args);
        const info = await getScriptInfo(projectDir, scriptName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "add_shader": {
        const { projectDir, shaderName, vertexCode, fragmentCode } = AddShaderSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addShader(projectDir, yyp, shaderName, vertexCode, fragmentCode);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Shader "${shaderName}" added to project` }] };
      }

      case "get_shader_info": {
        const { projectDir, shaderName } = GetShaderInfoSchema.parse(args);
        const info = await getShaderInfo(projectDir, shaderName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "edit_shader": {
        const { projectDir, shaderName, vertexCode, fragmentCode } = EditShaderSchema.parse(args);
        await editShader(projectDir, shaderName, { vertexCode, fragmentCode });
        return { content: [{ type: "text", text: `✓ Shader "${shaderName}" updated` }] };
      }

      case "add_sound": {
        const { projectDir, soundName, sourceFile, volume, preload } = AddSoundSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addSound(projectDir, yyp, soundName, sourceFile, { volume, preload });
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Sound "${soundName}" imported from ${sourceFile}` }] };
      }

      case "get_sound_info": {
        const { projectDir, soundName } = GetSoundInfoSchema.parse(args);
        const info = await getSoundInfo(projectDir, soundName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "edit_sound": {
        const { projectDir, soundName, volume, preload } = EditSoundSchema.parse(args);
        await editSound(projectDir, soundName, { volume, preload });
        return { content: [{ type: "text", text: `✓ Sound "${soundName}" updated` }] };
      }

      case "add_font": {
        const { projectDir, fontName, systemFontName, size, bold, italic } = AddFontSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        const result = await addFont(projectDir, yyp, fontName, systemFontName, { size, bold, italic });
        yyp = result.yyp;
        await writeYyp(projectDir, yyp);
        const text = `✓ Font "${fontName}" (${systemFontName}, ${size}pt) added to project`
          + (result.warning ? `\n⚠ ${result.warning}` : "");
        return { content: [{ type: "text", text }] };
      }

      case "get_font_info": {
        const { projectDir, fontName } = GetFontInfoSchema.parse(args);
        const info = await getFontInfo(projectDir, fontName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "edit_font": {
        const { projectDir, fontName, systemFontName, size, bold, italic } = EditFontSchema.parse(args);
        const result = await editFont(projectDir, fontName, { systemFontName, size, bold, italic });
        const text = `✓ Font "${fontName}" updated` + (result.warning ? `\n⚠ ${result.warning}` : "");
        return { content: [{ type: "text", text }] };
      }

      case "add_tileset": {
        const { projectDir, tilesetName, spriteName, tileWidth, tileHeight, tilehsep, tilevsep, tilexoff, tileyoff } = AddTilesetSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addTileset(projectDir, yyp, tilesetName, spriteName, tileWidth, tileHeight, { tilehsep, tilevsep, tilexoff, tileyoff });
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Tile set "${tilesetName}" created from sprite "${spriteName}" (${tileWidth}x${tileHeight} tiles)` }] };
      }

      case "get_tileset_info": {
        const { projectDir, tilesetName } = GetTilesetInfoSchema.parse(args);
        const info = await getTilesetInfo(projectDir, tilesetName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "edit_tileset": {
        const { projectDir, tilesetName, tileWidth, tileHeight, tilehsep, tilevsep, tilexoff, tileyoff } = EditTilesetSchema.parse(args);
        await editTileset(projectDir, tilesetName, { tileWidth, tileHeight, tilehsep, tilevsep, tilexoff, tileyoff });
        return { content: [{ type: "text", text: `✓ Tile set "${tilesetName}" updated` }] };
      }

      case "add_extension": {
        const { projectDir, extensionName } = AddExtensionSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addExtension(projectDir, yyp, extensionName);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Extension "${extensionName}" created` }] };
      }

      case "get_extension_info": {
        const { projectDir, extensionName } = GetExtensionInfoSchema.parse(args);
        const info = await getExtensionInfo(projectDir, extensionName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "add_particle_system": {
        const { projectDir, particleSystemName } = AddParticleSystemSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addParticleSystem(projectDir, yyp, particleSystemName);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Particle system "${particleSystemName}" created` }] };
      }

      case "get_particle_system_info": {
        const { projectDir, particleSystemName } = GetParticleSystemInfoSchema.parse(args);
        const info = await getParticleSystemInfo(projectDir, particleSystemName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "add_anim_curve": {
        const { projectDir, animCurveName } = AddAnimCurveSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await addAnimCurve(projectDir, yyp, animCurveName);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ Animation curve "${animCurveName}" created` }] };
      }

      case "get_anim_curve_info": {
        const { projectDir, animCurveName } = GetAnimCurveInfoSchema.parse(args);
        const info = await getAnimCurveInfo(projectDir, animCurveName);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "find_references": {
        const { projectDir, resourceName } = FindReferencesSchema.parse(args);
        const refs = await findReferences(projectDir, resourceName);
        const text = refs.length === 0
          ? `No references to "${resourceName}" found elsewhere in the project -- safe to delete.`
          : `Found ${refs.length} reference(s) to "${resourceName}":\n` +
            refs.map(r => `  ${r.file}:${r.line}  ${r.context}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "delete_resource": {
        const { projectDir, category, resourceName, force } = DeleteResourceSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await deleteResource(projectDir, yyp, category, resourceName, force);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ ${category.slice(0, -1)} "${resourceName}" deleted` }] };
      }

      case "rename_resource": {
        const { projectDir, category, oldName, newName } = RenameResourceSchema.parse(args);
        let yyp = await loadYyp(projectDir);
        yyp = await renameResource(projectDir, yyp, category, oldName, newName);
        await writeYyp(projectDir, yyp);
        return { content: [{ type: "text", text: `✓ ${category.slice(0, -1)} "${oldName}" renamed to "${newName}"` }] };
      }

      case "lint_project": {
        const { projectDir } = ProjectSchema.parse(args);
        const issues = await lintProject(projectDir);
        const errors = issues.filter(i => i.severity === "error");
        const warnings = issues.filter(i => i.severity === "warning");
        const text = issues.length === 0
          ? "No issues found -- project looks clean."
          : `${errors.length} error(s), ${warnings.length} warning(s):\n` +
            issues.map(i => `[${i.severity.toUpperCase()}] ${i.message}${i.file ? ` (${i.file})` : ""}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "compile_project": {
        const { projectDir } = ProjectSchema.parse(args);
        const result = await compileProject(projectDir);
        if (!result.available) {
          return { content: [{ type: "text", text: result.message }] };
        }
        const text = result.success
          ? "Compile succeeded -- GameMaker's real build tool compiled this project with no errors."
          : `Compile FAILED:\n${result.message}`;
        return { content: [{ type: "text", text }] };
      }

      case "list_resources": {
        const { projectDir, kind } = ListResourcesSchema.parse(args);
        const yyp = await loadYyp(projectDir);
        const filtered = yyp.resources.filter((r: any) => !kind || r.id?.path?.startsWith(`${kind}/`));
        const list = filtered.map((r: any) => r.id?.name || "unknown");
        return {
          content: [
            {
              type: "text",
              text: `Resources${kind ? ` (${kind})` : ""}:\n${JSON.stringify(list, null, 2)}`,
            },
          ],
        };
      }

      case "create_snapshot": {
        const { projectDir, reason } = CreateSnapshotSchema.parse(args);
        const result = await createSnapshot(projectDir, { reason, tool: "create_snapshot" });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_snapshots": {
        const { projectDir } = ProjectSchema.parse(args);
        const result = await listSnapshots(projectDir);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "restore_snapshot": {
        const { projectDir, snapshotId, files } = RestoreSnapshotSchema.parse(args);
        const result = await restoreSnapshot(projectDir, { snapshotId, files });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "delete_snapshot": {
        const { projectDir, snapshotId } = DeleteSnapshotSchema.parse(args);
        const result = await deleteSnapshot(projectDir, snapshotId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "read_file": {
        const { projectDir, path: filePath, offset, limit } = ReadFileSchema.parse(args);
        const result = await readFile(projectDir, filePath, { offset, limit });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "patch_file": {
        const { projectDir, path: filePath, find, replace, count, skipSnapshot } = PatchFileSchema.parse(args);
        const result = await patchFile(projectDir, filePath, { find, replace, count, skipSnapshot });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_changes": {
        const { projectDir } = ProjectSchema.parse(args);
        const result = await listChanges(projectDir);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "undo_last": {
        const { projectDir } = ProjectSchema.parse(args);
        const result = await undoLast(projectDir);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_project_options": {
        const { projectDir, platform } = GetProjectOptionsSchema.parse(args);
        const result = await getProjectOptions(projectDir, { platform });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "set_project_option": {
        const { projectDir, platform, key, value, skipSnapshot } = SetProjectOptionSchema.parse(args);
        const result = await setProjectOption(projectDir, { platform, key, value, skipSnapshot });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_included_files": {
        const { projectDir } = ListIncludedFilesSchema.parse(args);
        const result = await listIncludedFiles(projectDir);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "add_included_file": {
        const { projectDir, sourcePath, targetName, copy, overwrite } = AddIncludedFileSchema.parse(args);
        const result = await addIncludedFile(projectDir, { sourcePath, targetName, copy, overwrite });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "remove_included_file": {
        const { projectDir, name, deleteFile } = RemoveIncludedFileSchema.parse(args);
        const result = await removeIncludedFile(projectDir, { name, deleteFile });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_macros": {
        const { projectDir } = ListMacrosSchema.parse(args);
        const result = await listMacros(projectDir);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "set_macro": {
        const { projectDir, name, value, file, skipSnapshot } = SetMacroSchema.parse(args);
        const result = await setMacro(projectDir, { name, value, file, skipSnapshot });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_timelines": {
        const { projectDir, timelineName } = ListTimelinesSchema.parse(args);
        const result = await listTimelines(projectDir, { name: timelineName });
        const payload = result.kind === "one" ? result.timeline : result.timelines;
        const content: any[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
        // A note is a second content part, like every other warning in this
        // server: content[0] stays parseable JSON.
        if (result.note !== null) content.push({ type: "text", text: `⚠ ${result.note}` });
        return { content };
      }

      case "list_sequences": {
        const { projectDir, sequenceName } = ListSequencesSchema.parse(args);
        const result = await listSequences(projectDir, { name: sequenceName });
        const payload = result.kind === "one"
          ? result.sequence
          : { sequences: result.sequences, spriteEmbeddedSequenceCount: result.spriteEmbedded.count };
        const content: any[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
        if (result.note !== null) content.push({ type: "text", text: `⚠ ${result.note}` });
        return { content };
      }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// The one place a tool call becomes a text response: the project lock wraps the
// auto-snapshot wrapper, which wraps the dispatch. Every destructive tool is
// therefore backed up inside the same lock, before its handler runs, and no
// handler body contains snapshot code.
async function callTool(name: string, args: unknown) {
  const projectDir = (args as any)?.projectDir;
  const def = TOOL_DEFS.find((d) => d.name === name);

  try {
    return typeof projectDir === "string"
      ? await withProjectLock(projectDir, () =>
          withAutoSnapshot(
            name,
            projectDir,
            args,
            () => dispatchTool(name, args),
            // The registered schema (plus its disk-free prevalidation), not a
            // second copy: a malformed call is dispatched straight away so
            // dispatch throws its own error and no project copy is spent on a
            // call that cannot write.
            def
              ? { safeParse: (value: unknown) => def.schema.safeParse(value), prevalidate: def.prevalidate }
              : undefined
          )
        )
      : await dispatchTool(name, args);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return callTool(request.params.name, request.params.arguments);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GameMaker MCP server running on stdio");
}

// Only open the stdio transport when this file is what node was launched with.
// Importing it (the test suite asserts the schemas reject what the tools reject)
// must not connect a transport and hijack stdin.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // Windows paths are case-insensitive; a case-differing argv names the same file.
  const same = (a: string, b: string) =>
    (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  try {
    const entryPath = path.resolve(entry);
    const selfPath = fileURLToPath(import.meta.url);
    if (same(entryPath, selfPath)) return true;
    // A directory junction or symlink anywhere in the install path makes the two
    // differ textually while naming the same file. Compare real targets before
    // giving up: a false negative here exits 0 with no output, and the client
    // sees a silent death.
    return same(realpathSync.native(entryPath), realpathSync.native(selfPath));
  } catch {
    return false;
  }
}

export { TOOL_DEFS, ObjectPhysicsSchema, EditObjectSchema, AddRoomLayerSchema, dispatchTool, callTool };

if (isEntryPoint()) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}

