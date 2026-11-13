# objects

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Object resources: create a `$GMObject` with optional event stubs, append one
event with its own GML, and edit sprite/mask/parent/flags/physics/variable
definitions in place. It owns event **filenames**, which GameMaker silently
requires; it does not own reference rewriting (`graph/delete-rename.md`).

## Key Paths

- `src/gm/objects.ts` (420 lines) — `objects/<name>/<name>.yy`, event code in
  `objects/<name>/<EventName>_<num>.gml`.
- `src/gm/types.ts:5` — `EventDefinition`.

## Event filenames (the silent-failure rule)

GameMaker only reads `Create_0.gml`, `Step_1.gml`, …; a collision event uses the
**target object's name** (`Collision_objPlayer.gml`). A wrong name is ignored with
no error: the eventList entry loads and the event is empty. Verified by an Igor
A/B compile (`:19-25`).

- `EVENT_FILE_NAMES` (`:26-41`) — eventType 0-13 → `Create, Destroy, Alarm, Step,
  Collision, Keyboard, Mouse, Other, Draw, KeyPress, KeyRelease, Trigger,
  CleanUp, Gesture`.
- `eventFileNameFromListEntry(entry)` (`:47`) — the lint-facing, non-throwing
  derivation; collision reads `collisionObjectId.name`.

## Public API / Key Types

- `addObject(projectDir, yyp, name, events)` (`:146`) — validates every event
  filename (and resolves the collision target) before touching disk (`:150-156`),
  writes the `.yy` then `// Event code here\n` stubs (`:161`), ensures the
  `Objects` folder and registers the resource. Append-only → not auto-snapshotted.
- `addObjectEvent(projectDir, name, event)` (`:186`) — touches only the object's
  own `.yy` (appends to `eventList`) plus the new stub `.gml`; no catalog change.
  Auto-snapshotted (it rewrites existing content).
- `ObjectEditOptions` (`:212`) / `editObject(...)` (`:357`) — omitted fields left
  alone, `null` clears a reference; sprite, sprite mask, parent, solid/visible/
  persistent, physics (`ObjectPhysicsSchema` in `index.ts:496`) and variable
  definitions (`VariableDefinitionSchema`, `index.ts:517`). A referenced sprite or
  parent that does not exist is refused before the write (`:294`).
- `newObjectYy` (`:140`) carries `"$GMObject": ""` and the type's
  `resourceVersion` from `RESOURCE_VERSIONS`.

## Contracts

- `edit_object` validates a parent chain / missing references before writing and
  is auto-snapshotted; `add_object` only appends.
- Event type/num validity is checked before any write, so a bad event cannot
  leave a half-created object.

## Dependencies

- In: `yyp.ts` (registration, parsing, versions), `atomic.ts`, `types.ts`.
- Out: `lint.ts` (`eventFileNameFromListEntry`), `introspect.ts` (object info),
  `delete.ts` / `rename.ts` (generic), `index.ts`.
