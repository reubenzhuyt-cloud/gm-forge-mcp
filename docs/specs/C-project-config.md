# Spec C — Project-level configuration

Status: implemented (wave 2 integrated 2026-11-13) · Scope: subproject C · Repo: `gm-forge-mcp`

## Goal

Three whole areas of a GameMaker project are currently invisible to the server:

1. `options/` is never read or written. Every `options/<platform>/options_<platform>.yy`
   — including `option_<platform>_interpolate_pixels`, the switch behind the
   pixel-art magenta fringing in the reference project — can only be changed by
   hand in the IDE. The server cannot even report what they currently say.
2. `IncludedFiles` in the `.yyp` is scaffolded empty (`src/gm/yyp.ts:171`) and
   never touched again, so a data file cannot be registered or removed and a
   project that ships a manifest, a font, or a `.lnk` has no tooling for it.
3. `#macro` definitions live inside `.gml` files with no index and no writer:
   nothing can list them (or notice that a name is defined twice, where
   GameMaker silently takes the last definition), and nothing can add one
   without hand-editing GML.

Deliver seven new MCP tools that close those three gaps. All seven are additive;
no existing tool changes arguments, output or errors. `interpolate_pixels` is the
highest-value target: it is the only item here that changes what the user
actually sees on screen, and the reference project currently has it `false` on
Windows but `true` on the other eight platforms.

## Non-goals

- `option_gameguid` is **read-only** (a new GUID would break save files and
  achievements); no licence, signing, Steam, or installer changes
  (`option_spine_licence`, `option_windows_license`, `option_windows_enable_steam`,
  `option_steam_app_id`).
- No platform / export-target generation: never create an `options/<platform>/`
  directory, never add a platform to the `.yyp`, never touch icons, splash
  screens, installer art, or NSIS config.
- No `configs` management (`src/gm/yyp.ts:180-183` stays scaffold-only). No
  creation, selection, or per-config overrides.
- No texture-group or audio-group editing. That is a later subproject, and it
  also owns `option_<platform>_texture_page` — so the page-size half of the
  fringing fix is explicitly **not** here, and the allowlist must reject it
  rather than quietly accept it.
- No arbitrary `.yy` key injection: unknown keys are a hard error, never a
  best-effort write.
- No GML parsing beyond `#macro` lines; no macro deletion in this subproject
  (list + upsert only), no macro dependency analysis.
- Backup / snapshot / rollback is subproject E's; this spec only calls it.

## Format facts (verified, do not re-derive)

Reference project: `E:\GMprojects\261103GJ`, **read-only**, `MetaData.IDEVersion`
= `"2026.0.0.16"` (GameMaker 2026 LTS). Every key set below was read out of it on
2026-11-13; anything not captured there is marked unverified.

- **Nothing in the codebase touches these areas.** `src/gm/yyp.ts:171` scaffolds
  `IncludedFiles: []`; `:180-183` scaffolds `configs`; nothing reads or writes
  either afterwards. `grep -r "options/" src/` has exactly one hit — the comment
  at `src/gm/yyp.ts:134-137` ("Options/isDnDProject/tutorialPath are legitimately
  absent"). `IncludedFiles` appears once in `src/`, `macro` once, both in
  scaffolding.
- `.yyp` IO goes through `@bscotch/yy` (`src/gm/yyp.ts:124,205,217`). `.yy` IO
  uses `parseGameMakerJson` (`src/gm/yyp.ts:85-113`, string-aware trailing-comma
  strip) and `JSON.stringify(v, null, 2)`. `writeYyp` is atomic (temp file +
  rename, `:208-223`).
- **Options layout**: `options/<platform-dir>/options_<platform-dir>.yy`, ten in
  the sample: `android, html5, ios, linux, mac, main, operagx, reddit, tvos,
  windows`. `main` is the global file and is shaped differently:
  `{"$GMMainOptions":"v5", "%Name":"Main", name:"Main", resourceType:"GMMainOptions",
  resourceVersion:"2.0", ...}`. Every platform file is
  `{"$GM<Platform>Options":"v2", "%Name":..., name:..., resourceType:"GM<Platform>Options",
  resourceVersion:"2.0", ...}`.
- **Directory name ≠ `name` field.** `mac` → `"macOS"`, `operagx` → `"Opera GX"`,
  `html5` → `"HTML5"`, `ios` → `"iOS"`, `tvos` → `"tvOS"`. The display name must
  be read from the file, never derived from the directory.
- **Option keys are platform-prefixed.** Platform files carry
  `option_<platform>_*` (`option_windows_interpolate_pixels`,
  `option_linux_scale`, `option_windows_version`, `option_linux_start_fullscreen`,
  `option_linux_allow_fullscreen`, `option_windows_resize_window`); `main` carries
  the unprefixed globals (`option_game_speed`, `option_gameguid`, `option_gameid`,
  `option_author`, `option_remove_unused_assets`, ...). So the allowlist is a
  **logical name → on-disk key** mapping that resolves per platform, not a list
  of strings to write blindly.
- `interpolate_pixels` exists in **all nine** platform files and in **none** of
  `main`. Sample values: `windows` = `false`, the other eight = `true`.
- The sample has **no** `option_speed`, `option_window_width`,
  `option_window_height`, `option_lastchanged`, `option_fullscreen`,
  `option_resize`, or `option_scale` key anywhere. The captured spellings for
  those concepts are the prefixed ones above. A key that exists in neither the
  sample nor a future captured fixture must be rejected, not written.
  (Shipped spelling, re-checked against all ten files: `option_fullscreen` →
  `option_<platform>_start_fullscreen` exists on **windows, mac, linux**;
  `option_resize` → `option_<platform>_resize_window` exists on the same three;
  `option_<platform>_scale` and `option_<platform>_interpolate_pixels` exist on
  all nine platform files; `option_<platform>_version` exists on eight --
  **reddit has none**, so `option_version` on reddit is an error, not a write.)
- **`.yyp` write degradation (found in wave 2, fixed centrally).** A no-op
  `loadYyp → writeYyp` on the real sample changed
  `AudioGroups[0]."$GMAudioGroup"` from `"v1"` to `""` **and dropped that
  entry's `exportDir`**. Cause: `@bscotch/yy`'s project schema names neither
  field, and zod object parsing silently drops unnamed keys; its stringifier
  then re-adds `$<resourceType>` as `""`. The `$GM*` tags are real
  schema-version markers, not decoration: in that one project they are
  `$GMProject`/`$GMAudioGroup`/`$GMFolder`… `"v1"`/`""`, `$GMSound` and
  `$GMObjectProperty` `"v2"`, `$GMRInstance` `"v4"`, `$GMMainOptions` `"v5"`,
  `$GMWindowsOptions`/`$GMRedditOptions` `"v2"` -- and `@bscotch/yy` itself
  rewrites `$GMScript`/`$GMSound`/`$GMRoom`/`$GMRInstance`/`$GMEvent` per
  `MetaData.IDEVersion`. This degraded **every** existing `.yyp` writer
  (`add_object`, `add_room`, `add_sprite_from_images`, …), so it is fixed in
  `writeYyp`, not in C's modules. See "Shipped deviations" below.
- **`IncludedFiles` entry, exact key set (7)**, captured from
  `E:\GMprojects\261103GJ\261103GJ.yyp:23`:

  ```json
  {"$GMIncludedFile":"","%Name":"Adobe After Effects 2025.lnk","CopyToMask":-1,
   "filePath":"datafiles","name":"Adobe After Effects 2025.lnk",
   "resourceType":"GMIncludedFile","resourceVersion":"2.0"}
  ```

  `filePath` is the **containing directory** relative to the project root
  (`"datafiles"`, no trailing slash, no filename); `name` and `%Name` are both
  the basename; `CopyToMask` is an int bitmask (`-1` = all platforms);
  `resourceVersion` is `"2.0"`.
- **There is no `DataFiles` folder node.** The sample's `Folders` array contains
  only asset-tree folders (`folders/Objects.yy`, `folders/Sounds/Scripts.yy`, ...),
  and a search for `DataFiles` in the `.yyp` matches only the `"datafiles"`
  string. Creating a folder node for included files would be this subproject's
  `$GMRFolder` — the real format does not have one, so the tool must not make one.
- **Script resource shape is already captured and in use.** `REF.script` in
  `test/verify.ts:99-100` is the same 8-key set `newScriptYy`
  (`src/gm/scripts.ts:23-34`) emits: `$GMScript, %Name, isCompatibility, isDnD,
  name, parent, resourceType, resourceVersion`. `addScript` (`:36-48`) writes
  `scripts/<name>/<name>.gml` + `.yy`, then `ensureFolder(yyp, "Scripts")` and
  `registerResource(yyp, name, "scripts/<name>/<name>.yy")`. **`ensureFolder`
  (`src/gm/yyp.ts:281-300`) only creates top-level folders** — a
  `folders/Scripts/Macros.yy` node needs a path-aware variant.
- Nested folder nodes carry no `parent` field: the sample stores them as
  `{"$GMFolder":"","%Name":"Scripts","folderPath":"folders/Sounds/Scripts.yy",
  "name":"Scripts","resourceType":"GMFolder","resourceVersion":"2.0"}` — the
  parent is encoded in `folderPath` only.
- **Macros**: 42 real `#macro` definitions across 7 `scripts/*/*.gml` files, no
  duplicate names today. Syntax is `#macro NAME value`; the value is the rest of
  the line and may be an expression; a trailing `// comment` is legal
  (`scripts/scr_l1_data/scr_l1_data.gml:36`). Sample `.gml` files are LF and
  `.gitattributes` forces `eol=lf` for `*.gml`, but the writer must detect the
  file's own endings rather than assume.
- **Scan trap**: `.gamemaker-mcp/backups/**` holds a copy of every `.gml` from
  past edits, so a naive recursive macro scan reports every macro two or three
  times and invents duplicates. Excluded roots: dot-directories (`.git`,
  `.gamemaker-mcp`, `.opencode`), `output/`, `datafiles/`, `options/`.
- Tests are one hand-rolled script, `test/verify.ts` (1811 lines) run by `tsx`,
  with `ok()` (:55), `expectThrows()` (:65), `keysMatchRef()` (:217) and `REF`
  key-sets captured from real GameMaker files (:92). `tsconfig.json` has
  `strict: true`; no ESLint. Registry: `src/index.ts`, 53 dispatch cases,
  import-safe (stdio opens only when it is the entry point).

## Tool contracts

Common shape: `projectDir` is the first argument, names are `snake_case`, each
schema built as `ProjectSchema.extend({...})` (`src/index.ts:57`). Every write
path validates everything before touching disk, writes atomically, goes through
subproject E's `writeWithSnapshot`, and mutates only the fields named in the
arguments.

**Snapshot asymmetry, on purpose.** `set_project_option` and `set_macro` call
`writeWithSnapshot` themselves and are therefore *not* members of
`AUTO_SNAPSHOT_TOOLS`; `add_included_file` and `remove_included_file` rewrite the
`.yyp` through `writeYyp`, which takes no snapshot of its own, so they *are*
members and are backed up by E's dispatch hook. Adding the first pair to the hook
would copy the project twice for one call and burn two of the 20 retention slots;
listing the second pair nowhere would leave them with no backup at all. The
acceptance test is one snapshot per successful call, for all five write tools
(the fifth is `patch_file`, which also self-snapshots).

### 1. `get_project_options`

`{ platform? }` → `{ options: [{ platform, file, settings }] }`.

- `platform` omitted = every `options/*/options_*.yy` in the project, sorted by
  platform directory. Named platform with no directory → error listing the
  platforms that exist.
- `settings` is the parsed file **minus** `$GM*`, `%Name`, `name`,
  `resourceType`, `resourceVersion` (the envelope), so it is a pure map of
  `option_*` keys to values.
- Read via `parseGameMakerJson`; never writes. Reports what is on disk, so it
  doubles as the before/after evidence for every `set_project_option` call.
- `file` is relative to the project root, forward slashes
  (`options/windows/options_windows.yy`).
- Returns the resolved value for `interpolate_pixels` even though the on-disk key
  is prefixed — resolution happens in exactly one place (see contract 2).

### 2. `set_project_option`

`{ platform?, key, value }` → `{ platform, file, key, onDiskKey, previous, value,
changed }`.

Curated allowlist — the **only** writable logical names, each with a fixed type:

| logical `key` | type | resolves to (2026.0.0.16) | status |
|---|---|---|---|
| `interpolate_pixels` | bool | `option_<platform>_interpolate_pixels` | verified, all 9 |
| `option_game_speed` | int | `option_game_speed` (main only) | verified |
| `option_author` | string | `option_author` (main only) | verified |
| `option_version` | string | `option_<platform>_version` | verified on 8 of 9 (reddit has no such key) |
| `option_scale` | int | `option_<platform>_scale` | verified |
| `option_fullscreen` | bool | `option_<platform>_start_fullscreen` (windows, mac, linux) | verified (alias) |
| `option_resize` | bool | `option_<platform>_resize_window` (windows, mac, linux) | verified (alias) |
| `option_gameguid` | string | `option_gameguid` (main only) | **read-only — always rejected** |
| `option_speed` | int | — | **no captured key: rejected** |
| `option_window_width` | int | — | **no captured key: rejected** |
| `option_window_height` | int | — | **no captured key: rejected** |
| `option_lastchanged` | string | — | **no captured key: rejected** |

- Everything outside the table errors with the allowlist in the message and the
  reason it is unavailable (`unknown option`, `read-only`,
  `unverified: no GameMaker 2026.0.0.16 sample defines this key`). Nothing is
  written on error.
- One shared `OPTION_ALLOWLIST` table drives schema validation, resolution, the
  error text and the tests — no second copy of the list.
- `platform` defaults to `main`. A `main`-only key with a platform given, or a
  platform key with `platform: "main"`, errors and names the platforms that
  actually define that key. No "apply to all platforms" mode: a silent
  nine-file write is not a thing this tool does.
- Type is enforced before resolution: bool keys reject `0`/`"false"`; int keys
  reject floats and booleans; string keys reject numbers and cap at 1024 chars.
  `option_game_speed` is bounded `1..1000`, `option_scale` `0..10`.
- Write path: `parseGameMakerJson` → assign `obj[onDiskKey]` → **replace that one
  line's value in the original text**, never re-serialise. The replacement is
  verified by re-parsing the edited text and comparing it to the intended object;
  if `onDiskKey` is not alone on its own line (a compact or hand-flattened file),
  the call is **refused** (`cannot rewrite … in place: "<key>" is not on its own
  line; refusing to reformat the file`) with the file left byte-identical. Spec
  rule 2 forbids reformatting anything else, and the earlier `JSON.stringify(v,
  null, 2)` fallback did exactly that, silently, on the one case no fixture
  covered. A `changed: false` call (value already equal) returns without
  rewriting the file at all.
- Every write reports `snapshotId: string | null` and, when the backup was
  skipped, `snapshotSkippedReason` — the same fields `patch_file` returns. It is
  never dropped: `set_project_option` is not an `AUTO_SNAPSHOT_TOOLS` member (it
  snapshots itself), so the result is the only place a skipped backup can reach
  the caller.
- Never adds a key that was not already present in that file. A verified key on
  a platform whose file lacks it (e.g. `option_resize` on reddit) is an error, not
  an insertion.
- `previous` is the value read before the write; `onDiskKey` is the resolved
  spelling, so the caller can see through the alias.
- `option_gameguid` is *listed* (the CLI can explain why) and *always rejected*
  with `read-only`, never written under any flag.

### 3. `list_included_files`

`{}` → `{ entries: [{ name, filePath, resourceType, resourceVersion,
existsOnDisk }] }`.

- Reads `yyp.IncludedFiles` only; never writes.
- `filePath` is returned verbatim (the directory, as stored). `existsOnDisk`
  stats `path.join(projectDir, filePath, name)` and is `false` when the
  registered file is missing — the reference project is in exactly that state
  (one entry, empty `datafiles/`), which is why this flag exists.
- Preserves the `.yyp`'s array order (GameMaker's own order is not alphabetical
  and must not be "fixed").
- Extra keys on an entry are passed through untouched on read and preserved on
  every write.

### 4. `add_included_file`

`{ sourcePath, targetName?, copy?: boolean, overwrite? }` → `{ name, filePath,
copiedTo, added: true }`.

- Default `copy: true`: copy `sourcePath` to `datafiles/<targetName>/<basename>`
  and register `{ filePath: "datafiles/<targetName>", name: <basename> }`.
- `targetName` defaults to the basename without its extension, so
  `assets/manifest.json` lands in `datafiles/manifest/manifest.json`. It is a
  single path segment: no `/`, `\`, `..`, control characters, or the characters
  Windows cannot create (`< > : " | ? *`), and no reserved device name (`CON`,
  `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`, extension or not) — those are
  refused with a message rather than surfacing as a raw `EINVAL` from
  `fs.mkdir`; ≤ 100 chars.
- `name` and `%Name` are the **basename with its extension**, because that is
  what the captured entry does; `targetName` only chooses the directory. This is
  the one place a guess would be tempting and is therefore pinned by a `REF`.
- `copy: false` registers the file in place: `sourcePath` must resolve inside
  `projectDir`, `filePath` becomes its containing directory relative to the root
  with forward slashes, and nothing is copied. A source outside the project is an
  error (a `filePath` of `../..` is not legal project data).
- Existing entry with the same `name` → error unless `overwrite: true`; overwrite
  replaces that entry in place (same index, same extra keys) rather than
  appending a second one. Existing target file → error unless `overwrite: true`.
  The extra keys come from a **raw** read of the `.yyp` (`loadRawYyp`), because
  the typed object cannot carry keys the schema does not model; `writeYyp` also
  restores them per entry, so they survive either path.
- Overwrite with a **different `filePath`** (a different `targetName`, or
  `copy: false` after `copy: true`) is refused: it would move the entry, drop its
  extra keys and orphan the old copy in `datafiles/<old>/`. The error names
  `remove_included_file` as the two-step path instead. (Wave-2 fix: the first cut
  silently moved the entry.)
- The entry is emitted with the exact 7-key set above, in that order, and
  appended to `IncludedFiles`. No `Folders` change, no `DataFiles` node, no
  reordering of existing entries. Then `writeYyp` (atomic) writes the `.yyp`.
- Two-file write (copy, then `.yyp`): the copy lands first so a crash leaves an
  unreferenced file rather than a reference to a missing file. E's snapshot
  covers the `.yyp`; the copied-in file is new and needs none.
- Refusal rule: if the captured 7-key set is unavailable (no sample project, no
  fixture), the tool refuses with `unverified format: GMIncludedFile` instead of
  writing a plausible-looking entry.

### 5. `remove_included_file`

`{ name, deleteFile? }` → `{ name, filePath, removed: true, fileDeleted: boolean }`.

- Removes exactly the matching `IncludedFiles` entry (by `name`; two entries with
  the same `name` is an error naming both filePaths, not a silent first-match).
- `deleteFile` defaults **`false`**: unregistering must not silently delete user
  data. With `true`, delete `filePath/name` and then the `datafiles/<targetName>`
  directory if it is now empty. Refuses (`fileDeleted: false`, entry removed) when
  another entry still references the same path.
- A delete that cannot happen (the target is a directory, the file is locked, it
  was already missing) is decided **before** the manifest is written and reported
  as `fileDeletionSkipped`, never thrown: the entry is gone either way, and a
  throw would report a failed call for a project that did change — and make the
  dispatch hook mark that call's snapshot `failed: true`, losing the one backup
  the caller needs. (Wave-2 fix: the first cut removed the entry and then threw.)
- Unknown name → error listing the names that do exist.

### 6. `list_macros`

`{}` → `{ macros: [{ name, value, file, line }], duplicates: [{ name,
definitions: [{ file, line }] }] }`.

- Walks the project for `*.gml`, skipping dot-directories, `output/`,
  `datafiles/`, `options/`. Sorted by `file`, then `line`.
- Line match: `^[ \t]*#macro[ \t]+([A-Za-z_]\w*)[ \t]+(.+?)[ \t]*$`, applied to
  the line's **code**, not its raw text: every line is reduced by blanking
  `/* … */` regions (string-aware, block state carried across lines) so a
  `#macro` inside a block comment is not a definition — and `set_macro` therefore
  can never resurrect one as live code. `value` is the remainder with a trailing
  `// ...` comment removed (string-aware: `//` inside a quoted value is content).
  `#macro` with no value or a malformed name is reported as a definition with
  `value: ""` rather than skipped silently.
- `duplicates` lists every name defined more than once, with all locations, and
  states in the tool's `note` that GameMaker compiles the **last** definition —
  the reason this exists is that the winner is otherwise invisible.
- Read-only; no caching, no index file.

### 7. `set_macro`

`{ name, value, file? }` → `{ name, value, file, line, created: { file, script }
| null, previous: { value, file, line } | null, eol: "lf" | "crlf", changed: boolean,
snapshotId: string | null, snapshotSkippedReason? }`.

- `file` defaults to `scripts/macros/macros.gml`. Any path is allowed only if it
  is project-relative, inside the project, under `scripts/`, and ends in `.gml`
  (plus the macro's own target file if it already exists elsewhere — the tool may
  *update* a macro in an existing file, but only ever *creates* the default one).
  `output/`, `datafiles/` and `options/` are refused outright for updates too
  (build output and shipped data are not project source), not just for creation.
- Existing definition of `name` in the target file: rewrite that one line in
  place; every other line, the file's EOL sequence, and the presence/absence of a
  trailing newline are preserved byte-for-byte. `previous` reports the old value
  and location.
- Re-setting the value that is already there is a **no-op**: `changed: false`,
  `snapshotId: null`, no bytes written, no backup taken (the same rule
  `set_project_option` follows). Every real write reports `snapshotId` /
  `snapshotSkippedReason` — the fields `patch_file` returns — because this tool
  snapshots itself and is not on the dispatch hook's list.
- Existing definition of `name` in a **different** file while `file` was omitted:
  error naming that `file:line` and telling the caller to pass it explicitly.
  Never creates a second definition — that is the silent-shadowing bug this tool
  exists to prevent.
- No definition anywhere: append `#macro NAME value` at the end, preceded by a
  newline only if the file does not already end with one.
- Creating the default file also creates the script resource: the 8-key
  `REF.script` shape via `newScriptYy`-equivalent, `parent` =
  `{ name: "Macros", path: "folders/Scripts/Macros.yy" }`, a
  `folders/Scripts/Macros.yy` folder node (6 keys, no `parent` field), the parent
  `folders/Scripts.yy` node if absent, and a `.yyp` `resources` entry
  `{ id: { name: "macros", path: "scripts/macros/macros.yy" } }`. Order: `.gml`,
  `.yy`, folder nodes, resource entry, then `writeYyp`.
- `value` validation: non-empty after trim, single line (no `\r`/`\n`), ≤ 1024
  chars, must not begin with `#macro` (that would double-wrap) and must not
  contain a bare trailing `//` (ambiguous: it would be read back as a comment).
  Macro *names* must be GML identifiers and must not collide with a keyword.
- `name` is matched case-sensitively (GML macros are case-sensitive).

## Format discipline — REF pins and the refuse rule

The lesson from A: one invented field (`$GMRFolder` vs `$GMRLayer`) cost a real
bug. Here the equivalent traps are the included-file entry, the nested folder
node, and the script resource. Therefore:

| Shape | Pin | Captured from |
|---|---|---|
| `GMIncludedFile` entry (7 keys) | `REF.includedFile` | `261103GJ.yyp:23` |
| Nested folder node (6 keys, no `parent`) | `REF.folderNode` | `261103GJ.yyp:15-17` |
| Script resource (8 keys) | `REF.script` — reuse, do not add a second set | already in `test/verify.ts:99` |
| `.yyp` `resources` entry (`id` only) | `REF.projectResource` | `261103GJ.yyp:74` |
| Option file envelope + key set | fixture copy of the ten `options/*.yy`; assert the **untouched** key list is identical before/after a write, and the resolved key changed | sample project |
| `#macro` line | textual round-trip, not a key set | `scripts/scr_l1_data/scr_l1_data.gml:35-40` |

Rules:

1. No shape is written from memory. If a `REF` cannot be captured, the tool
   throws `unverified format: <shape>` and the test asserts that throw.
2. Option writes may not add, remove, reorder, or reformat any key other than the
   one resolved key. The test compares the full parsed key list before and after
   plus the byte length delta implied by the value change.
3. Every shape is verified with **GameMaker's own ProjectTool** on a scratch
   project (never on `E:\GMprojects\261103GJ`). If ProjectTool resaves a file
   with a different key set or spelling — e.g. it rewrites `filePath` to include
   the filename — GameMaker's spelling wins, the `REF` is recaptured from the
   resaved file, and the contract above is amended before ship.
4. The sample project is read-only: fixtures are copied into `test/fixtures/`
   once and pinned; no test writes into `E:`.

## Acceptance criteria

- `npm run typecheck` (`tsc --noEmit`) clean.
- `npm test` green; the 577 pre-existing assertions untouched (only appended
  to), plus new assertions for all seven tools — shipped at **734 passed, 0
  failed, 0 skipped** on a machine with GameMaker installed (+131).
- Every write path has three cases in `test/verify.ts`: a populated case, an
  omitted/default case, and an error case.
- The curated allowlist is enforced and tested by rejection: at least one
  `expectThrows` for an unknown key, one for `option_gameguid`, one for a key
  whose spelling has no captured sample (`option_window_width`), and one for a
  wrong value type.
- `set_project_option { platform: "windows", key: "interpolate_pixels", value:
  false }` round-trips: `get_project_options` reads it back as `false`, all other
  keys in `options_windows.yy` are unchanged in value and order, and ProjectTool
  still passes on the scratch project. Same test proves the other eight platforms
  are untouched by that call.
- `add_included_file` + `list_included_files` + `remove_included_file` round-trip
  on a scratch project: the entry's key set equals `REF.includedFile`, the copy
  exists at `datafiles/<targetName>/<basename>`, `existsOnDisk` is `true`, and
  the `.yyp` gains no `Folders` entry.
- `list_macros` on the read-only sample finds definitions in real source files
  with **zero** duplicates and no file under a dot-directory (the
  `.gamemaker-mcp` backups must not be scanned); the same test with a duplicated
  macro reports it. (Wave-2 fix: the first cut pinned "42 across 7 files", which
  breaks the first time the user adds a macro in the IDE.)
- `set_macro` round-trips: create the default `scripts/macros/macros.gml` in a
  scratch project (script registered, folder node present, ProjectTool passes),
  then update the same macro and assert byte-identical output apart from the
  value, including a CRLF fixture and a no-trailing-newline fixture.
- `README.md:47-79` gains a **Project config** group listing the seven tools; no
  existing tool's behaviour changes and the tool count is exactly 68 (61 before
  this subproject).
- Read-only smoke test on the sample project: `get_project_options` reports ten
  platforms with display names `macOS` / `Opera GX` / `HTML5` (not `mac` /
  `operagx` / `html5`), and exactly one platform (`windows`) has
  `interpolate_pixels: false`. The same assertions run hermetically against the
  `test/fixtures/options/` copy.

## Shipped deviations (wave 2, 2026-11-13)

- **`writeYyp` normalisation — fixed, not documented away.** The tag/`exportDir`
  loss above is a real file degradation (`"$GMAudioGroup":"v1"` is the current
  spelling in every GameMaker 2026.0.0.16 save and in every older
  gamemaker-mcp backup of the sample), so `writeYyp` now parses the schema
  itself, restores the keys the parse *dropped* from the file already on disk
  (matched per record by `folderPath` / `id.path` / `roomId.path` /
  `filePath/name` / `name`, never by index), and only then stringifies. A no-op
  save of the real 261103GJ `.yyp` (161 lines) is now byte-identical; an edit
  touches only the changed keys. Pinned by tests in `test/verify.ts`
  (sample-shaped fixture + the real sample's `.yyp` copied to temp).
  **Scope, narrowed in the fix pass:** only the `$GM*` tags and `exportDir` are
  restored (plus, separately, any extra key on an `IncludedFiles` entry, which
  the tool contract promises to keep). Filling *every* absent key resurrected
  keys a tool deliberately removed and re-added a top-level `"Options": []` that
  `yypSchema`'s own preprocess deletes; both are now refused by construction and
  pinned by tests.
  **`resourceVersion` is the library's, not ours:** `Yy.stringify` sets
  `resourceVersion: "2.0"` on every typed record and that key *is* schema-named,
  so a legacy record at `1.0`/`1.3` is upgraded on write and the restore cannot
  (and must not) fight it. The byte-identical claim is therefore
  "byte-identical for projects already at `resourceVersion` 2.0", which is every
  file GameMaker 2026.0.0.16 writes; a test pins the 1.3 → 2.0 upgrade so it is
  visible rather than surprising.
  **Best-effort by construction:** a `.yyp` that cannot be read back or parsed
  skips the restore and the save proceeds — fidelity must never be able to block
  a write that used to succeed.
  Known limit, deliberately not "fixed": a *newly scaffolded* record has no
  on-disk value to restore, so `create_project` still emits
  `"$GMAudioGroup":""` (what `@bscotch/yy` produces; ProjectTool accepts it, and
  the IDE's first resave writes `"v1"`).
- **Snapshot outcomes are reported, not swallowed.** `set_project_option` and
  `set_macro` return `snapshotId` / `snapshotSkippedReason` (and `changed`), the
  way `patch_file` does. Wave-2's first cut discarded the `writeWithSnapshot`
  result, so `skipSnapshot` was silent and an over-threshold project wrote with
  no backup and no warning — a break in E's invariant. Both are also
  no-ops-before-write: an already-equal value reports `changed: false`, writes
  nothing and takes no snapshot.
- **`set_project_option` never reformats.** The whole-file `JSON.stringify`
  fallback is gone; a key that is not alone on its own line is a refusal with the
  file left byte-identical. Tests cover both branches (a hand-spaced multi-line
  file edited in place with no trailing commas introduced; a compact one-line
  file refused, unchanged, no snapshot).
- **`set_project_option.key` is `z.string()`, not a `z.enum`.** The writable set
  is platform- and version-dependent (`option_resize` is on windows/mac/linux
  only; `option_version` is on eight of nine), and three rejected names must
  reach the module to get their own reason. The description is generated from
  `OPTION_ALLOWLIST` (no second copy of the list); the module produces the
  allowlist error, and a test asserts the schema still leaves `key` a free
  string.
- **`option_version` on reddit** is an error (`does not define`) rather than a
  write; captured from the fixture, pinned by test.
- **Two pre-existing test edits were unavoidable**: the three tool-count
  literals (61 → 68) and the two new entries in the F1 `minimalArgs` table,
  without which the existing "every auto-snapshot tool is covered" assertion
  fails by construction.
- **Fixtures**: the ten `options/*/options_*.yy` are copied once into
  `test/fixtures/options/` (only `option_gameguid` redacted); the `.yyp` shape
  and the ProjectTool evidence live inline in `test/verify.ts` as a captured
  string, like the A-subproject room arrays.
- **ProjectTool confirmed the extrapolated shapes** (scratch project under
  `%TEMP%`, never `E:`): `IncludedFiles` `filePath: "datafiles/manifest"` for a
  nested copy and the `folders/Scripts/Macros.yy` nested node both load --
  `ProjectTool Successful`, exit 0, `lintProject` no issues.
- **Fix pass (audit, same day) — what changed after integration.**
  1. `set_project_option` and `set_macro` report `changed` / `snapshotId` /
     `snapshotSkippedReason`; no write path discards the snapshot outcome.
  2. `set_project_option` refuses instead of reformatting (fallback removed);
     both branches tested.
  3. The live-sample macro assertion is no longer a pinned count.
  4. The `.yyp` restore is scoped to `$GM*` + `exportDir` (+ `IncludedFiles`
     extras); `"Options": []` is not re-added and unmodelled keys are not
     resurrected.
  5. `resourceVersion` normalisation is documented (README + here) and pinned by
     a 1.3 → 2.0 test.
  6. The restore's read tolerates every error; a save can never be blocked by it.
  7. `add_included_file` refuses an `overwrite` that changes `filePath` (no more
     moved entry / orphaned copy), and reads the replaced entry's extra keys from
     the raw `.yyp`.
  8. `set_macro` short-circuits an identical value (`changed: false`, no
     snapshot).
  9. `AddIncludedFileOptions.skipSnapshot` deleted (it was dead; the dispatch hook
     owns the opt-out).
  10. `assertSafeSegment` refuses Windows-illegal characters and reserved device
      names.
  11. `remove_included_file` decides the delete before writing and reports
      `fileDeletionSkipped` instead of throwing after the manifest changed.
  12. `#macro` inside `/* … */` is not a definition (block state carried across
      lines, strings respected).
  13. `set_macro` refuses `output/`, `datafiles/` and `options/` for in-place
      updates as well as creation.

## Risks

- **Option files differ per platform and per GameMaker version.** The captured
  set is 2026.0.0.16; key names and presence vary by version and by licensed
  export modules, and four allowlisted names have no captured key at all. The
  mapping table plus the `unverified` rejection is the mitigation; a future
  version adds keys by capturing a fixture, not by editing a list from memory.
- **Aliases are a real risk of quiet wrongness.** `option_fullscreen` →
  `option_<platform>_start_fullscreen` and `option_resize` →
  `option_<platform>_resize_window` are *our* names for GameMaker's keys. Both
  directions are pinned by tests, `get_project_options` always reports the
  on-disk key set, and `set_project_option` returns `onDiskKey`, so a caller can
  never be fooled about what changed.
- **`IncludedFiles` paths are relative and case-sensitive on some targets.**
  Registration stores the directory as text; a mismatch in case registers a file
  GameMaker will not find. The tool normalises separators to `/` and refuses a
  path whose on-disk casing does not match, rather than "fixing" it silently.
- **`filePath` semantics for a nested layout — confirmed, not extrapolated any
  more.** The only captured entry sits at the `datafiles` root. The nested case
  (`datafiles/<targetName>/<basename>` → `filePath: "datafiles/<targetName>"`)
  was accepted unchanged by ProjectTool 2024.14.165 on a scratch project
  (`ProjectTool Successful`, exit 0, `.yyp` hash unchanged), so the contract's
  default layout is the shipped one.
- **Macros are a text edit, not a JSON edit.** `set_macro` must respect CRLF vs
  LF, trailing-newline presence, and must not reflow the file; a regex replace
  over the whole file would corrupt a macro whose value contains the name.
  Rewrite exactly one line and assert the rest is byte-identical.
- **Creating a script resource is a multi-step `.yyp` edit** (resource entry plus
  a nested folder node plus possibly the parent node). Doing it halfway leaves a
  `.gml` no resource points at. Order the writes and rely on E's snapshot;
  ProjectTool on the scratch project is the gate.
- **Concurrency**: wave 1 contends on nothing; wave 2 contends on `src/index.ts`,
  `test/verify.ts`, `README.md`. See `docs/plans/C-project-config.md`.
- **Not byte-fidelity with an IDE resave.** `JSON.stringify(v, null, 2)` drops
  trailing commas and normalises float spelling, exactly as in A. Key order is
  preserved by in-place assignment; on-disk formatting is not. (This applies to
  `.yy` files written as JSON. The `.yyp` path is different: `writeYyp` restores
  the listed keys the schema parse dropped -- `$GM*` tags, `exportDir`, and an
  `IncludedFiles` entry's extras -- so a no-op save is byte-identical for a
  project already at `resourceVersion` 2.0; a legacy record's `resourceVersion`
  is upgraded by the library. See "Shipped deviations" and Format facts.)
