# Unarchived architecture deltas

Staged edits for the archivist: one block per task, newest last. Each block names
the source, the paths and symbols affected, what actually changed, and the
verification evidence. Canonical area/module docs are NOT edited here; a block
that contradicts one of them says so explicitly so the merge can fix it.

## 2026-11-14 — edit_sprite hardening (validation, no-op guard, formatting fidelity)

Source: bug-fix brief; all six defects were reproduced by a harness against a
pristine copy of `261103GJ/sprites/spr_tp_to_lv1/spr_tp_to_lv1.yy` (3149 bytes).

Affected paths and symbols:
- `src/gm/sprites.ts:249` `SpriteEditOptions` (unchanged shape), `:265`
  `SPRITE_COLLISION_KINDS` = `[0, 1]`, `:270` `SPRITE_BBOX_MODES` = `[0, 1, 2]`,
  `:271` `MANUAL_BBOX_MODE`, `:273` `SPRITE_BBOX_KEYS`, `:276`/`:281`
  `describeSpriteCollisionKinds` / `describeSpriteBboxModes`, `:303`
  `validateSpriteEdit`, `:412` `rewriteScalarInPlace`, `:450` `editSprite`.
- `src/index.ts:193` `SpriteCollisionKindSchema`, `:203` `SpriteBboxModeSchema`,
  `:213` `EditSpriteArgsSchema` (`.strict()`), `:242` `EditSpriteSchema`
  (`refine`: bbox_* requires bboxMode 2), `:253` `parseSpriteEditArgs`, `:276`
  `spriteEditPrevalidate`, `:904` TOOL_DEFS entry, `:1249` dispatch case,
  `:1678` now also exports `EditSpriteSchema`.

What changed:
- `editSprite` returns a message string instead of `void`; the dispatch case
  prints it. Unchanged requests return `already in the requested state` and do
  NOT write (`sprites.ts:517`), so no backup and no mtime bump.
- Schema is `.strict()` (unknown/misspelled args are an error that names the key
  and lists the accepted arguments), `.finite()` everywhere (a non-finite number
  would have been written as JSON `null`), integer bbox edges, collisionKind /
  bboxMode allowlists, and `bboxMode: 2` required with any `bbox_*`.
- Module-side validation (`validateSpriteEdit`): `0 <= bbox_left < bbox_right <=
  width-1` (same vertically, whole numbers), `0 <= xorigin <= width` and
  `0 <= yorigin <= height` (inclusive), allowlists repeated for direct callers.
- Writing: the parsed file is mutated, then only the changed scalars are
  substituted into the ORIGINAL text by `rewriteScalarInPlace` (same in-place
  technique as `options.ts:rewriteOneValueInPlace`), the result is re-parsed and
  compared before `atomicWriteFile`, so untouched lines keep the IDE's formatting
  byte-for-byte. An origin edit also sets `sequence.lockOrigin = false` (`:496`);
  no other edit touches it.
- No shared GM-style serialiser exists in `src/gm` (`writeYyp` delegates to
  `@bscotch/yy`, which reorders keys and prints `100.0` as `100`), so nothing was
  routed through one. `sprite_frames.ts:113 writeSpriteYy` still writes
  `JSON.stringify(sprite, null, 2)` for its structural rewrites; it already had the
  no-op guard (`serialise(sprite) !== doc.before`).

Verification: `npx tsc --noEmit` exit 0; `npx tsx test/verify.ts` 1014 passed,
0 failed. Probe on a copy of the real IDE sprite: empty call stayed at 3149 bytes
with an identical mtime, Infinity/`collisionKind 99`/inverted bbox/`xorigin -5`
were refused with the file untouched, and an origin edit changed exactly four
lines (`origin`, `lockOrigin`, `xorigin`, `yorigin`), 3149 -> 3152 bytes.

Contradicts `docs/architecture/resources/sprites.md:36-37` (editSprite line refs
and `Promise<void>`) and `:43` (`atomicWriteJson` for the sprite .yy).

## 2026-11-14 — edit_object variableDefinitions merges by name

Source: bug-fix brief; evidence `261103GJ/objects/obj_lv3_portal/obj_lv3_portal.yy:33-37`
(`rangeMax` 1.0 / 1344.0 / 800.0 / 255.0 / 999.0, varType 4 and 0).

Affected paths and symbols:
- `src/gm/objects.ts:238` `ObjectEditOptions.removeVariableDefinitions`, `:351`
  `definitionNameOf`, `:371` `mergeVariableDefinitions`, `:478` `editObject`
  (`:519-525` now delegates to the merge; the old whole-array swap is gone).
- `src/index.ts:596` `VariableDefinitionSchema` (`value` and `type` are now
  optional — `.default("real")` would have overwritten a preserved `varType`),
  `:608` `EditObjectSchema` (+ `removeVariableDefinitions`).

What changed:
- `variableDefinitions` merges by `name`: only the fields the caller supplies
  change, every other field of that definition (`rangeEnabled`, `rangeMin`,
  `rangeMax`, `filters`, `listItems`, `multiselect`, `varType`, extra keys) and
  the definition's position are preserved. Definitions not mentioned are
  preserved. `null`/`[]` merge nothing.
- New definitions still use today's defaults (`variableDefinitionEntry`) and need
  a `value`. Unsupported `varType` is still refused.
- Deletion only via `removeVariableDefinitions`; a missing name is an error that
  names it and lists the definitions the object has.
- A removed definition still referenced by `overriddenProperties` (matched by
  `name` or `%Name`, the shape is undocumented and empty in every sample) is
  refused, naming it.
- `edit_object` still rewrites the whole file with `JSON.stringify(obj, null, 2)`,
  so an untouched definition's `1344.0` is re-spelled `1344` and the file is
  restyled. Values are preserved; that textual restyle is a pre-existing limit of
  every `edit_object` write, not introduced here.

Verification: `npx tsc --noEmit` exit 0; `npx tsx test/verify.ts` 1014 passed,
0 failed. Probe on a copy of the real `obj_lv3_portal.yy`: editing only
`target_x.value` kept `rangeMax` 1344/800/255/999 and all five definitions in
order; removing a missing name was refused; removing `door_id` deleted only it.

Contradicts `docs/architecture/resources/objects.md:40-44` ("`null` clears a
reference" now also covers only references, never variable definitions) and
`:42-43` schema line refs.
