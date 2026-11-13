import { promises as fs } from "fs";
import path from "path";
import type { Yyp } from "@bscotch/yy";
import type { EventDefinition } from "./types.js";
import { atomicWriteFile, atomicWriteJson } from "./atomic.js";
import { ensureFolder, registerResource, validateResourceName, parseGameMakerJson, assertSafeResourceName, RESOURCE_VERSIONS, fileExists } from "./yyp.js";

interface ObjectFiles {
  dir: string;
  yyFile: string;
  catalogPath: string;
}

function objectFiles(projectDir: string, name: string): ObjectFiles {
  const dir = path.join(projectDir, "objects", name);
  return { dir, yyFile: path.join(dir, `${name}.yy`), catalogPath: `objects/${name}/${name}.yy` };
}

// GameMaker only reads event code from files named <EventName>_<num>.gml
// (Create_0.gml, Step_1.gml, ...), with Collision using the target object's
// name instead of a number (Collision_objPlayer.gml). Anything else is
// silently ignored -- the eventList entry loads fine, but the event shows
// up empty. Verified against a real project and by an Igor A/B compile
// (invalid GML in a wrong-named file compiles "successfully"; the same file
// under the real name fails).
const EVENT_FILE_NAMES: Record<number, string> = {
  0: "Create",
  1: "Destroy",
  2: "Alarm",
  3: "Step",
  4: "Collision",
  5: "Keyboard",
  6: "Mouse",
  7: "Other",
  8: "Draw",
  9: "KeyPress",
  10: "KeyRelease",
  11: "Trigger",
  12: "CleanUp",
  13: "Gesture",
};

// For lint: derive the expected filename from an eventList entry as it
// appears in a .yy (collision target lives in collisionObjectId there).
// Returns null rather than throwing for entries it can't map -- lint wants
// to report, not crash.
export function eventFileNameFromListEntry(entry: { eventType: number; eventNum: number; collisionObjectId?: { name?: string } | null }): string | null {
  const typeName = EVENT_FILE_NAMES[entry.eventType];
  if (!typeName) return null;
  if (entry.eventType === 4) {
    return entry.collisionObjectId?.name ? `Collision_${entry.collisionObjectId.name}.gml` : null;
  }
  if (!Number.isInteger(entry.eventNum) || entry.eventNum < 0) return null;
  return `${typeName}_${entry.eventNum}.gml`;
}

function eventFileName(event: EventDefinition): string {
  const typeName = EVENT_FILE_NAMES[event.eventType];
  if (!typeName) {
    throw new Error(`Unknown eventType ${event.eventType} -- valid types are 0-13`);
  }
  if (!Number.isInteger(event.eventNum) || event.eventNum < 0) {
    throw new Error(`Invalid eventNum ${event.eventNum} -- must be a non-negative integer`);
  }
  if (event.eventType === 4) {
    if (!event.collisionTargetName) {
      throw new Error("Collision events (eventType 4) require collisionTargetName");
    }
    return `Collision_${event.collisionTargetName}.gml`;
  }
  return `${typeName}_${event.eventNum}.gml`;
}

/**
 * Resolves a Collision event's target into a real {name,path} reference,
 * verified against an object that actually exists -- collisionObjectId
 * being wrong or dangling means GameMaker can't resolve the collision at
 * runtime.
 */
async function resolveCollisionTarget(projectDir: string, event: EventDefinition): Promise<{ name: string; path: string } | null> {
  if (!event.collisionTargetName) return null;
  if (event.eventType !== 4) {
    throw new Error(`collisionTargetName is only valid for Collision events (eventType 4), got eventType ${event.eventType}`);
  }
  assertSafeResourceName(event.collisionTargetName);
  const targetYyFile = objectFiles(projectDir, event.collisionTargetName).yyFile;
  if (!(await fileExists(targetYyFile))) {
    throw new Error(`Collision target object "${event.collisionTargetName}" does not exist (expected ${targetYyFile})`);
  }
  return { name: event.collisionTargetName, path: `objects/${event.collisionTargetName}/${event.collisionTargetName}.yy` };
}

function eventEntry(event: EventDefinition, collisionObjectId: { name: string; path: string } | null = null) {
  return {
    isDnD: false,
    eventType: event.eventType,
    eventNum: event.eventNum,
    collisionObjectId,
    name: "",
    resourceType: "GMEvent",
    resourceVersion: RESOURCE_VERSIONS.event,
    "$GMEvent": "v1",
    "%Name": ""
  };
}

// A freshly-placed object with no physics behavior configured -- matches
// what GameMaker's own "New Object" flow produces before physics is enabled.
const NO_PHYSICS = {
  physicsObject: false,
  physicsSensor: false,
  physicsShape: 1,
  physicsGroup: 1,
  physicsDensity: 0.5,
  physicsRestitution: 0.1,
  physicsLinearDamping: 0.1,
  physicsAngularDamping: 0.1,
  physicsFriction: 0.2,
  physicsStartAwake: true,
  physicsKinematic: false,
  physicsShapePoints: [] as any[]
};

function newObjectYy(name: string, eventList: ReturnType<typeof eventEntry>[]) {
  return {
    name,
    spriteId: null,
    spriteMaskId: null,
    parentObjectId: null,
    solid: false,
    visible: true,
    managed: true,
    persistent: false,
    ...NO_PHYSICS,
    eventList,
    properties: [],
    overriddenProperties: [],
    parent: { name: "Objects", path: "folders/Objects.yy" },
    resourceType: "GMObject",
    resourceVersion: RESOURCE_VERSIONS.object,
    "$GMObject": "",
    "%Name": name
  };
}

export async function addObject(projectDir: string, yyp: Yyp, name: string, events: EventDefinition[]): Promise<Yyp> {
  validateResourceName(yyp, name);
  const files = objectFiles(projectDir, name);

  // Validate every event (filename derivation throws on bad type/num/missing
  // collision target) before anything touches disk.
  const stubFileNames = events.map(event => eventFileName(event));
  const eventList = [];
  for (const event of events) {
    eventList.push(eventEntry(event, await resolveCollisionTarget(projectDir, event)));
  }

  await fs.mkdir(files.dir, { recursive: true });
  await atomicWriteJson(files.yyFile, newObjectYy(name, eventList));
  for (const stubFileName of stubFileNames) {
    await atomicWriteFile(path.join(files.dir, stubFileName), "// Event code here\n");
  }

  ensureFolder(yyp, "Objects");
  registerResource(yyp, name, files.catalogPath);

  return yyp;
}

async function readObjectYy(yyFile: string, name: string): Promise<any> {
  try {
    return parseGameMakerJson(await fs.readFile(yyFile, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new Error(`Object "${name}" does not exist (expected ${yyFile})`);
    }
    throw new Error(`Failed to read object "${name}" at ${yyFile}: ${e.message}`);
  }
}

/**
 * Only touches the object's own .yy (appends to eventList) and writes the
 * event's stub .gml -- no catalog change, since no new top-level resource
 * is created.
 */
export async function addObjectEvent(
  projectDir: string,
  name: string,
  event: EventDefinition,
  code: string = "// Event code here\n"
): Promise<void> {
  assertSafeResourceName(name);
  const stubFileName = eventFileName(event);
  const files = objectFiles(projectDir, name);
  const obj = await readObjectYy(files.yyFile, name);

  // Collision events all share (type 4, num 0) legitimately -- one per
  // target object -- so their duplicate identity is the target, not the num.
  const duplicate = obj.eventList.some((e: any) =>
    e.eventType === event.eventType &&
    e.eventNum === event.eventNum &&
    (event.eventType !== 4 || e.collisionObjectId?.name === event.collisionTargetName));
  if (duplicate) {
    throw new Error(`Object "${name}" already has an event with type ${event.eventType}, num ${event.eventNum}${event.eventType === 4 ? ` targeting "${event.collisionTargetName}"` : ""}`);
  }

  obj.eventList.push(eventEntry(event, await resolveCollisionTarget(projectDir, event)));
  await atomicWriteJson(files.yyFile, obj);
  await atomicWriteFile(path.join(files.dir, stubFileName), code);
}

export interface ObjectEditOptions {
  spriteName?: string | null;
  spriteMaskName?: string | null;
  parentObjectName?: string | null;
  solid?: boolean;
  visible?: boolean;
  persistent?: boolean;
  physics?: {
    enabled?: boolean;
    density?: number;
    friction?: number;
    restitution?: number;
    collisionGroup?: number;
    kinematic?: boolean;
    sensor?: boolean;
    shape?: number;
    startAwake?: boolean;
    angularDamping?: number;
    linearDamping?: number;
    gravityScale?: number;
  };
  variableDefinitions?: Array<{
    name: string;
    value: string;
    type?: "real" | "string" | "boolean" | "expression" | "asset";
  }> | null;
}

// Option names map onto the physics_* keys GameMaker actually writes (see
// NO_PHYSICS) -- the friendly name never reaches the .yy.
const PHYSICS_FIELDS = {
  density: "physicsDensity",
  friction: "physicsFriction",
  restitution: "physicsRestitution",
  collisionGroup: "physicsGroup",
  kinematic: "physicsKinematic",
  sensor: "physicsSensor",
  shape: "physicsShape",
  startAwake: "physicsStartAwake",
  angularDamping: "physicsAngularDamping",
  linearDamping: "physicsLinearDamping"
} as const;

function restoreDefaultPhysics(obj: any, changes: string[]): void {
  for (const [key, value] of Object.entries(NO_PHYSICS)) {
    const next = key === "physicsShapePoints" ? [] : value;
    if (JSON.stringify(obj[key]) !== JSON.stringify(next)) {
      obj[key] = next;
      changes.push(`${key}=${JSON.stringify(next)}`);
    }
  }
}

function applyPhysics(obj: any, physics: NonNullable<ObjectEditOptions["physics"]>, changes: string[]): void {
  // A GMObject stores no gravity scale -- GameMaker's gravity is a room
  // instance setting, so there is no key here to write to.
  if (physics.gravityScale !== undefined) {
    throw new Error("physics.gravityScale cannot be stored: a GMObject .yy has no gravity-scale key (GameMaker keeps gravity per room instance)");
  }
  if (physics.enabled === false) {
    restoreDefaultPhysics(obj, changes);
  } else if (physics.enabled === true && obj.physicsObject !== true) {
    obj.physicsObject = true;
    changes.push("physicsObject=true");
  }
  for (const [optionKey, yyKey] of Object.entries(PHYSICS_FIELDS)) {
    const next = (physics as any)[optionKey];
    if (next === undefined || obj[yyKey] === next) continue;
    obj[yyKey] = next;
    changes.push(`${yyKey}=${String(next)}`);
  }
}

async function resourceRef(
  projectDir: string,
  folder: "sprites" | "objects",
  name: string,
  label: string
): Promise<{ name: string; path: string }> {
  assertSafeResourceName(name);
  const expected = path.join(projectDir, folder, name, `${name}.yy`);
  if (!(await fileExists(expected))) {
    throw new Error(`${label} "${name}" does not exist (expected ${expected})`);
  }
  return { name, path: `${folder}/${name}/${name}.yy` };
}

async function applyRefField(
  obj: any,
  key: string,
  name: string | null,
  projectDir: string,
  folder: "sprites" | "objects",
  label: string,
  changes: string[]
): Promise<void> {
  const next = name === null ? null : await resourceRef(projectDir, folder, name, label);
  if (JSON.stringify(obj[key]) === JSON.stringify(next)) return;
  obj[key] = next;
  changes.push(`${key}=${name ?? "null"}`);
}

// Key set and varType integers copied from a real IDE-authored object
// (obj_transit_trigger in the 261103GJ project). Only varType 0 (real) and
// 4 (asset) appear in any GMObject on this machine, so the other types have
// no verified encoding to write and are rejected instead of guessed at.
function variableDefinitionVarType(type: string | undefined): number {
  switch (type ?? "real") {
    case "real":
      return 0;
    case "asset":
      return 4;
    default:
      throw new Error(`Variable definition type "${type}" is not supported: no real GameMaker sample available to verify its .yy encoding`);
  }
}

function variableDefinitionEntry(def: NonNullable<ObjectEditOptions["variableDefinitions"]>[number]) {
  assertSafeResourceName(def.name);
  return {
    $GMObjectProperty: "v2",
    "%Name": def.name,
    filters: [] as any[],
    listItems: [] as any[],
    multiselect: false,
    name: def.name,
    rangeEnabled: false,
    rangeMax: 10,
    rangeMin: 0,
    resourceType: "GMObjectProperty",
    resourceVersion: RESOURCE_VERSIONS.object,
    value: def.value,
    varType: variableDefinitionVarType(def.type)
  };
}

/**
 * Edits one existing object's own .yy in place: sprite/mask/parent refs,
 * solidity/visibility/persistence, the physics block, and object variable
 * definitions. Nothing in the YYP changes, and keys this function does not
 * touch keep their original order and values.
 *
 * undefined leaves a field alone, null clears a reference (spriteMaskId,
 * parentObjectId) or empties the variable definitions.
 */
export async function editObject(
  projectDir: string,
  objectName: string,
  opts: ObjectEditOptions
): Promise<string> {
  assertSafeResourceName(objectName);
  if (!Object.values(opts).some(value => value !== undefined)) {
    throw new Error(`Nothing to change on object "${objectName}": no editable fields were provided`);
  }

  const files = objectFiles(projectDir, objectName);
  const obj = await readObjectYy(files.yyFile, objectName);
  const changes: string[] = [];

  if (opts.spriteName !== undefined) {
    await applyRefField(obj, "spriteId", opts.spriteName, projectDir, "sprites", "Sprite", changes);
  }
  if (opts.spriteMaskName !== undefined) {
    await applyRefField(obj, "spriteMaskId", opts.spriteMaskName, projectDir, "sprites", "Sprite mask", changes);
  }
  if (opts.parentObjectName !== undefined) {
    if (opts.parentObjectName === objectName) {
      throw new Error(`Object "${objectName}" cannot be its own parent`);
    }
    await applyRefField(obj, "parentObjectId", opts.parentObjectName, projectDir, "objects", "Parent object", changes);
  }
  if (opts.solid !== undefined && obj.solid !== opts.solid) {
    obj.solid = opts.solid;
    changes.push(`solid=${opts.solid}`);
  }
  if (opts.visible !== undefined && obj.visible !== opts.visible) {
    obj.visible = opts.visible;
    changes.push(`visible=${opts.visible}`);
  }
  if (opts.persistent !== undefined && obj.persistent !== opts.persistent) {
    obj.persistent = opts.persistent;
    changes.push(`persistent=${opts.persistent}`);
  }
  if (opts.physics !== undefined) {
    applyPhysics(obj, opts.physics, changes);
  }
  if (opts.variableDefinitions !== undefined) {
    const next = opts.variableDefinitions === null ? [] : opts.variableDefinitions.map(variableDefinitionEntry);
    const seen = new Set<string>();
    for (const entry of next) {
      if (seen.has(entry.name)) {
        throw new Error(`Duplicate variable definition "${entry.name}" on object "${objectName}"`);
      }
      seen.add(entry.name);
    }
    // `properties` is always an array -- GameMaker has no null form of it,
    // so clearing means an empty list.
    if (JSON.stringify(obj.properties ?? null) !== JSON.stringify(next)) {
      obj.properties = next;
      changes.push(`properties=${next.length} definition${next.length === 1 ? "" : "s"}`);
    }
  }

  if (changes.length === 0) {
    return `✓ Object "${objectName}" unchanged -- no field differed from the requested values`;
  }
  await atomicWriteJson(files.yyFile, obj);
  return `✓ Updated object "${objectName}": ${changes.join(", ")}`;
}
