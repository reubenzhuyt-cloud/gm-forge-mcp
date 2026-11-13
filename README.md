<p align="center">
  <img src="assets/logo.svg" width="120" alt="gm-forge-mcp logo" />
</p>

<h1 align="center">gm-forge-mcp</h1>

<p align="center">
  <a href="https://github.com/nicklesimba/gm-forge-mcp/actions/workflows/ci.yml"><img src="https://github.com/nicklesimba/gm-forge-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nicklesimba/gm-forge-mcp" alt="License"></a>
</p>

gm-forge-mcp is an MCP server that lets an AI assistant create and edit GameMaker projects: scripts, objects, rooms, sprites, sounds, and the rest of the `.yyp` catalog. In practice that means you can ask Claude to scaffold a new project, import a folder of sprite frames, or rename an object everywhere it's referenced, and the project still opens in the IDE afterwards.

> Early stage (0.1.0) - back up your project before letting anything write to it.

GameMaker's file format punishes sloppy edits quietly. A room missing its `creationCodeFile` field, or a sound whose declared sample rate doesn't match the real `.wav`, can look fine right up until the IDE fails to open the project or crashes. Every writer here is modeled on files GameMaker itself produced, and two tools use GameMaker's own tooling directly: `lint_project` runs the official headless validator (ProjectTool) and `compile_project` runs the real compiler (Igor), which catches actual GML errors.

## Requirements

- Node.js 20+
- GameMaker (Windows) for `lint_project`'s ProjectTool check and for `compile_project`. Both skip with a clear message when GameMaker isn't installed; everything else works cross-platform.

## Install

```bash
git clone https://github.com/nicklesimba/gm-forge-mcp.git
cd gm-forge-mcp
npm install
npm run build
```

## Configure

Add to your MCP client config (e.g. Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gm-forge": {
      "command": "node",
      "args": ["/absolute/path/to/gm-forge-mcp/dist/index.js"]
    }
  }
}
```

## Tools

**Projects** -- `create_project`, `list_resources`, `find_references`, `delete_resource`, `rename_resource`, `lint_project`, `compile_project`

**Groups** -- `add_texture_group`, `add_audio_group`

**Scripts** -- `add_script`, `edit_script`, `get_script_info`

**Objects** -- `add_object`, `add_object_event`, `edit_object`, `get_object_info`

**Rooms** -- `add_room`, `edit_room`, `add_room_instance`, `reorder_room`, `move_room_relative`, `get_room_info`, `find_tile_region`, `list_room_layers`, `add_room_layer`, `remove_room_layer`, `set_room_layer`

**Room tiles** -- `get_room_tiles`, `set_room_tiles`, `fill_room_tiles`

**Sprites** -- `add_sprite_from_images`, `edit_sprite`, `get_sprite_info`, `list_sprite_frames`, `add_sprite_frame`, `remove_sprite_frame`, `replace_sprite_frame`, `reorder_sprite_frames`, `trim_sprite_frames`

**Tilesets** -- `add_tileset`, `edit_tileset`, `get_tileset_info`

**Sounds** -- `add_sound`, `edit_sound`, `get_sound_info`

**Shaders** -- `add_shader`, `edit_shader`, `get_shader_info`

**Fonts** -- `add_font`, `edit_font`, `get_font_info`

**Notes** -- `add_note`, `get_note_info`

**Extensions** -- `add_extension`, `get_extension_info`

**Particle systems** -- `add_particle_system`, `get_particle_system_info`

**Animation curves** -- `add_anim_curve`, `get_anim_curve_info`

**Timelines (read-only)** -- `list_timelines`

**Sequences (read-only)** -- `list_sequences`

**Project settings** -- `get_project_options`, `set_project_option`, `list_included_files`, `add_included_file`, `remove_included_file`, `list_macros`, `set_macro`

**Safety** -- `create_snapshot`, `list_snapshots`, `restore_snapshot`, `delete_snapshot`, `read_file`, `patch_file`, `list_changes`, `undo_last`

`delete_resource` and `rename_resource` search the whole project for references before touching anything.

`set_project_option` writes only a curated allowlist of options (`interpolate_pixels` -- the switch behind pixel-art fringing -- `option_game_speed`, `option_author`, `option_version`, `option_scale`, `option_fullscreen`, `option_resize`) and rewrites exactly the one line that holds the value, so every other key in `options/<platform>/options_<platform>.yy` keeps its value, its order and its formatting. If that key is not alone on its own line -- a compact or hand-flattened file -- the call is **refused** rather than re-serialised: a whole-file rewrite would restyle every line and strip GameMaker's trailing commas, so the file is left byte-identical and the error says to let the IDE resave it. `option_gameguid` is read-only (a new GUID breaks save files and achievements), and the four names whose spelling no real GameMaker 2026.0.0.16 file backs (`option_speed`, `option_window_width`, `option_window_height`, `option_lastchanged`) are refused rather than guessed. Callers pass the logical name; the result reports the real `onDiskKey` it resolved to (e.g. `option_windows_start_fullscreen` for `option_fullscreen`), so an alias can never quietly write something else, plus `snapshotId` -- or `snapshotSkippedReason` when the backup was skipped -- and `changed: false` when the value was already there. No tool here creates an `options/` directory or a platform: open the platform in the IDE once first.

`add_included_file` copies the file to `datafiles/<targetName>/` by default and registers it in the `.yyp`'s `IncludedFiles`, keeping any extra keys an existing entry carried; `overwrite: true` replaces that entry in place, and a different `targetName` is refused (it would move the entry and orphan the old copy -- remove the entry first). Names Windows cannot create (`< > : " | ? *`, `CON`/`NUL`/`COM1`...) are refused up front. `remove_included_file` unregisters an entry and leaves the file on disk unless `deleteFile: true`; when the manifest entry is gone but the file cannot be deleted (a directory, a lock), the call still reports `removed: true` with a `fileDeletionSkipped` reason instead of erroring for a change it made. `set_macro` updates one `#macro` line in place (or appends it, creating `scripts/macros/macros.gml` and its script resource the first time) and refuses to create a second definition of a name that already exists -- GameMaker compiles the last one silently, which is exactly the bug `list_macros` reports as `duplicates`. A `#macro` inside a `/* */` block comment is not a definition and is never rewritten into live code; `output/`, `datafiles/` and `options/` are never written to; re-setting the value that is already there reports `changed: false` and costs no backup.

`list_sprite_frames` reports each frame's guid, composite png path and whether **both** copies exist — `sprites/<name>/<frameGuid>.png` and the per-layer copy `sprites/<name>/layers/<frameGuid>/<layerId>.png` — plus `sequence.length`, the keyframe count and a `verdict` -- the literal `ok`, or `frames-vs-sequence mismatch: N vs M`. The five writers keep `frames.length === keyframeCount === sequence.length` (a frame's `sequence.length` counts frames, never seconds -- `playbackSpeed` is preserved, not derived) and every referenced guid has both pngs; a sprite that already disagrees is **refused** with both counts rather than repaired, because only the user knows which side is authoritative. A frame guid is used as a filename and as the `layers/<guid>/` directory a removal deletes, so a guid or image-layer name that is not a single safe path component (`..`, a separator, a Windows device name) is refused instead of being joined into a path. `add_sprite_frame` and `replace_sprite_frame` copy a PNG from disk verbatim -- no drawing, no pixel editing, no re-encoding -- and its size must equal the sprite's, except `replace_sprite_frame` with `allowResize: true` on a single-frame sprite (a multi-frame sprite is refused: one frame at a different size is unloadable; a mask or nine-slice border that would fall outside the new frame is refused rather than shrunk, and texture-page repacking stays the IDE's job). `replace_sprite_frame` keeps the frame guid, so every room `imageIndex` stays valid; `remove_sprite_frame` and `trim_sprite_frames` delete both png copies of each dropped frame, and if one of those files cannot be deleted *after* the sprite was updated they report it as `leftoverFiles` plus a `⚠` line instead of failing the call (a failure would invite a retry that removes a different frame). Indices are 0-based: `add_sprite_frame` appends when `index` is omitted, and no tool accepts `-1` as a last-frame shorthand.

### Sequences & timelines (read-only)

`list_timelines` and `list_sequences` read the `timelines/` and `sequences/` resources the `.yyp` registers. **Writing them is not supported, on purpose.** Neither type has a real, GameMaker-generated file on this machine to copy a key set from -- `sprites/*.yy` does carry a `GMSequence`, but it is embedded in a sprite (no `parent`, no resource registration), which the gate in [`docs/specs/D-sequences-timelines.md`](docs/specs/D-sequences-timelines.md) rules insufficient. A `.yy` invented at that depth is still valid JSON, so nothing here would fail loudly: the IDE would simply refuse to open the project, and this repo would ship the guess as a passing test. A guessed shape is worse than no shape, so no `add_timeline`/`add_sequence`/keyframe tool exists -- not disabled, not behind a flag.

What the readers do instead: report what is in the file and never assert what should be. `list_timelines` gives each timeline's moment count and, per moment, its numeric step and whether a code payload is present, sorted by step; when it cannot find the moments collection it reports the root keys the file actually has rather than a confident zero. **Those field names are provisional -- no GameMaker-authored timeline exists on this machine to confirm them** (`step`/`hasCode` are read from whatever numeric/`*code*` key a moment has, and "carries code" may turn out to mean "carries a GML path"). `list_sequences` passes each track's `resourceType` through verbatim (a track type it has never seen still lists), reports `null` for a missing `length`/`playbackSpeed` rather than a default, and counts `keyframeCount` defensively. Both report an unreadable, unparseable or missing file in that entry (`parseError` / `existsOnDisk: false`) and keep listing the rest -- one bad file never sinks the listing -- and both answer `[]` plus a note when the project has none; a *named* lookup of a registered name whose folder is gone returns that zeroed entry rather than an error, because "the .yyp lists it and disk disagrees" is the more useful answer. Since only a sprite can carry a sequence today, `list_sequences` also reports `spriteEmbeddedSequenceCount` so an empty `sequences/` does not read as "no sequences anywhere"; that scan is capped at `MAX_SPRITE_SCAN` (500) sprite `.yy` files per call and says `truncated` plus "lower bound" in the note when a project has more, and every sprite it cannot read, or whose `sequence` record lacks `resourceType: "GMSequence"`, is named in the note instead of quietly vanishing from the count. `find_references`, `delete_resource` and `rename_resource` do **not** follow timeline or sequence references yet.

## Backups (`.gm-forge/`)

Every tool that can overwrite or remove content you already had takes a snapshot of the project *before* it writes, inside the project lock, so two writes can never interleave: every `edit_*` tool (`edit_script`, `edit_object`, `edit_room`, `edit_sprite`, `edit_shader`, `edit_sound`, `edit_font`, `edit_tileset`), `delete_resource`, `rename_resource`, `remove_room_layer`, `set_room_layer`, `set_room_tiles`, `fill_room_tiles`, `add_room_layer`, `add_room_instance`, `add_object_event`, `reorder_room`, `move_room_relative` (both rewrite the `.yyp`'s existing `RoomOrderNodes`), `add_included_file`, `remove_included_file`, the sprite-frame writers (`add_sprite_frame`, `remove_sprite_frame`, `replace_sprite_frame`, `reorder_sprite_frames`, `trim_sprite_frames`), and `patch_file`. Tools that only append a brand-new resource to the project (`add_script`, `add_object`, `add_sprite_from_images`, `add_room`, `add_note`, ...) and the read-only tools take none, so a create never pays for a backup. `skipSnapshot: true` on any of the tools above opts out for that one call.

Three tools take their own snapshot rather than letting the dispatch hook do it: `patch_file`, `set_project_option` and `set_macro` call the same helper directly, so they are deliberately *not* on the hook's list -- listing them would copy the project twice for one call and spend two of the 20 retention slots on the same change. Every write tool therefore produces exactly one snapshot per successful call.

The store lives in `<project>/.gm-forge/`:

```
<project>/.gm-forge/
  backups/<YYYYMMDD>-<HHmmss>-<6 hex>/{manifest.json, files/...}
  lock            (only while a restore or undo is running)
  journal.jsonl   (append-only audit log)
```

Snapshots are plain byte copies: no git commands, no re-serialised `.yy` files, nothing outside the project directory. A file whose content did not change since the previous snapshot is hard-linked instead of copied, so a snapshot of a 4,000-file project costs the changed files only -- which is why `list_snapshots` labels `totalBytes` *logical* size: the bytes may be shared on disk. (A filesystem that cannot hard-link, or an antivirus refusing the link, falls back to a copy per file, and each manifest records which mode it used.)

A snapshot keeps the newest 20; older ones are pruned. Two exceptions are never pruned or deletable: the snapshot `undo_last` would restore, and the one just written -- so a project that keeps writing with an old undo point still on disk can end up with 21 snapshot directories. Files over 8 MiB, and anything in a dotted directory, `node_modules` or `dist`, are left out and listed as `skipped` so you can see what a restore would not bring back; `undo_last` reports those paths separately when a deletion took them with it. On a project over 20,000 files / 512 MB the automatic backup is skipped and the tool says so (`⚠ snapshot skipped: ...`, as a second content block so a JSON response stays parseable) instead of stalling -- the write still happens.

Saving the `.yyp` is a schema round-trip, and GameMaker's project file carries fields no published schema names: the `"$GM<Class>"` version tag on each record (`"$GMProject":"v1"`, `"$GMAudioGroup":"v1"`, `"$GMWindowsOptions":"v2"`) and, for an audio group, `exportDir`. A plain load-then-save used to drop them -- `"$GMAudioGroup":"v1"` came back as `""`, i.e. the record declared itself a legacy one -- so every `.yyp` write quietly downgraded the file. The writer now copies back exactly those keys (`$GM*` tags and `exportDir`, plus any extra keys an `IncludedFiles` entry carried), matched per record, before serialising: for a project already at `resourceVersion` 2.0 a save with no real change reproduces the file byte for byte, and a save with one change touches only the keys that changed. Two limits, stated rather than hidden: a key the schema never named and this list does not cover (anything else a hand-edit may have added) is not resurrected, so nothing an edit removed comes back; and `resourceVersion` is normalised to `"2.0"` on every typed record by `@bscotch/yy` itself, so a legacy record still at `1.0`/`1.3` is upgraded on write -- every file GameMaker 2026.0.0.16 writes already says 2.0, and a test pins the upgrade so it cannot be mistaken for a regression.

The store is **not** added to your `.gitignore` automatically. If you do not want backups committed, add the line `.gm-forge/` to your project's `.gitignore` yourself.

Restoring is not a redo point and it is not a mirror: it puts the snapshot's files back, leaves files the snapshot never recorded alone, and refuses while a lock exists, naming the lock file, the pid that wrote it, and when it is safe to delete. A restore that fails partway (a file the IDE still holds open) rolls back the files it already replaced and says whether the tree is consistent or mixed. **Close GameMaker before restoring** -- the IDE holds `.yy` files open on Windows and will save over a restore it never noticed. `read_file` and `patch_file` are the escape hatch for a field no other tool exposes; matching is literal string replacement only (never a regex), and `lint_project` is how you check the result.

## Testing

```bash
npm test
```

The suite checks every writer's output against reference schemas captured from real GameMaker files, simulates files GameMaker has resaved (trailing commas and all), and runs live ProjectTool/Igor checks when those are installed. CI runs on a Windows runner without GameMaker, so the live checks skip there and the summary reports the skip count. Every resource type has also been loaded in the actual IDE, including a project created from scratch by `create_project`.

## See also

[GameMaker](https://gamemaker.io) is required to use any of this. Thanks to YoYo Games for making game-making more accessible for two decades and counting!

[@petah/gamemaker-mcp](https://www.npmjs.com/package/@petah/gamemaker-mcp)  <img width="40" height="37" alt="image" src="https://github.com/user-attachments/assets/a8f0c4ef-8906-4135-a292-0aeb87856579" />
covers GML function/API reference lookup, which this project doesn't.

## License

MIT - see [LICENSE](LICENSE).
