# resources

> Router only. Open the one module doc you need.

| Module | Covers | Doc |
|--------|--------|-----|
| rooms | `rooms.ts` + `instances.ts`: room create/edit, room order, instance placement | rooms.md |
| room layers | `room_layers.ts`: layer list/add/remove/edit, nested folders | room-layers.md |
| room tiles | `room_tiles.ts`: tile-layer decode/encode, read/set/fill, region lookup | room-tiles.md |
| objects | `objects.ts`: object create/edit, event stubs, event filenames | objects.md |
| sprites | `sprites.ts`: sprite import from PNGs, origin/collision edits | sprites.md |
| sprite frames | `sprite_frames.ts`: the six frame tools and their invariants | sprite-frames.md |
| scripts & macros | `scripts.ts` + `macros.ts`: GML files and `#macro` definitions | scripts-macros.md |
| audio & fonts | `sounds.ts` + `fonts.ts`: real-metadata import, playback settings | audio-fonts.md |
| other assets | shaders, tilesets, notes, extensions, particle systems, animation curves | other-assets.md |
| project options | `options.ts`: `options/*/options_*.yy` read/write allowlist | project-options.md |
| included files | `included_files.ts`: `.yyp` `IncludedFiles` + `datafiles/` | included-files.md |
| timelines & sequences | `timelines.ts` + `sequences.ts`: read-only listing, no writers | timelines-sequences.md |

## Why (subproject specs)

| Spec | Covers |
|------|--------|
| [A-objects-rooms](../specs/A-objects-rooms.md) | objects, rooms, layers, tiles, `edit_object` |
| [B-sprite-frames](../specs/B-sprite-frames.md) | sprite frame editing |
| [C-project-config](../specs/C-project-config.md) | options, included files, macros |
| [D-sequences-timelines](../specs/D-sequences-timelines.md) | read-only timelines/sequences and the gate |
