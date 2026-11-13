# scripts & macros

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Two adjacent things that both produce `.gml`: creating/editing a script resource
(`scripts.ts`) and indexing/rewriting `#macro` definitions anywhere in the
project (`macros.ts`). Neither parses GML structurally — macros are found by a
line pattern with block-comment state.

## Key Paths

- `src/gm/scripts.ts` (90 lines) — `scripts/<name>/<name>.gml` + `.yy`.
- `src/gm/macros.ts` (528 lines) — scans project `.gml` files;
  `DEFAULT_MACRO_FILE = "scripts/macros/macros.gml"`,
  `DEFAULT_MACRO_SCRIPT = "scripts/macros/macros.yy"` (`:8-9`).

## Public API / Key Types

- `addScript(projectDir, yyp, name, code)` (`scripts.ts:37`) — validates the
  name, writes the `.gml` and `$GMScript` `.yy`, ensures the `Scripts` folder,
  registers the resource. Append-only.
- `editScript(...)` (`:66`) — replaces or appends; a whitespace-only append is
  refused with an explicit message (`test/verify.ts:1221`).
- `MacroDefinition` (`:14`), `MacroDuplicate` (`:21`), `ListMacrosResult`
  (`:26`), `SetMacroResult` (`:40`).
- `MACRO_LINE_RE` (`:61`) — `^[ \t]*#macro[ \t]+(<ident>)[ \t]+(.+?)[ \t]*$`,
  captured from a real IDE-authored macro; a trailing `// comment` is not part of
  the value.
- `MACROS_NOTE` (`:69`) — GameMaker compiles the *last* definition of a duplicate
  name, so earlier ones are silently shadowed; the listing is the only place that
  is surfaced.
- `listMacros(projectDir)` (`:211`) — every definition with file and line,
  duplicates grouped. `/* … */` state is carried across lines and is
  string-aware (`:152-168`), so a commented-out `#macro` is neither a definition
  nor rewritten into live code. Skips `output/`, `datafiles/`, `options/` and
  excluded (dot) directories — `IGNORED_TOP_LEVEL_DIRS` (`:83`).
- `setMacro(projectDir, {name, value, file?})` (`:365`) — rewrites exactly the
  one line in place; when nothing defines the name it creates
  `scripts/macros/macros.gml` + its script resource + folder node. An identical
  value short-circuits to `changed: false` with no write and no snapshot
  (`:473-485`). Refuses `output/`, `datafiles/`, `options/` for both in-place
  updates and creation (`:374-380`). Returns `changed`, `snapshotId`,
  `snapshotSkippedReason`, `eol`.

## Contracts

- Macros are project source; build output that happens to contain a `#macro` must
  never be rewritten, hence the directory refusals.
- `set_macro` and `patch_file` snapshot themselves via `writeWithSnapshot` and are
  deliberately **not** on `AUTO_SNAPSHOT_TOOLS` (`auto-snapshot.md`).
- `add_script` only appends; `edit_script` is auto-snapshotted.

## Dependencies

- In: `yyp.ts` (registration, versions, `loadYyp`), `atomic.ts`, `write.ts`.
- Out: `index.ts`, `test/verify.ts`, `lint.ts` (script existence checks).
