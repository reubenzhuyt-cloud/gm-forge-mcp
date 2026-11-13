# project options

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Reading and rewriting `options/<platform>/options_<platform>.yy` as a flat
`option_*` map with the GameMaker envelope stripped. It owns the curated
writable allowlist and the in-place single-line rewrite; it does not create
options files and never adds a key GameMaker did not write.

## Key Paths

- `src/gm/options.ts` (552 lines).
- Ten platform directories captured from `261103GJ/options` (2026-11-13,
  GameMaker 2026.0.0.16): `android, html5, ios, linux, mac, main, operagx,
  reddit, tvos, windows` (`OPTION_PLATFORMS`, `:32-43`). Display names must never
  be derived from the directory (`mac` is "macOS", `operagx` is "Opera GX").
- Envelope keys: `$GM*` + `%Name`, `name`, `resourceType`, `resourceVersion`
  (`OPTION_ENVELOPE_KEYS`, `:11-16`).

## Public API / Key Types

- `OPTION_ALLOWLIST` (`:70`) — `OptionSpec {key, type, scope, status, onDiskKey,
  min?, max?}`. Only names read out of a real options file are `verified`; a
  handful of `unverified` entries exist so a caller gets an explanation instead of
  "unknown key". `option_gameguid` is `read-only`.
- `getProjectOptions(projectDir, platform?)` (`:372`) — read-only; omit platform
  for all ten.
- `setProjectOption(projectDir, {key, value, platform?, skipSnapshot?})`
  (`:471`):
  - project-wide keys only exist in `options/main`; per-platform keys cannot be
    set on `main` — both cases throw with the platforms that do define the key
    (`:484-501`);
  - a key absent from the target file is refused, never added (`:504-511`);
  - an identical value returns `changed: false` and writes nothing (`:516-527`);
  - the rewrite is `rewriteOneValueInPlace` (`:424-469`): the line is replaced in
    the original text and the whole file is re-parsed and compared; any
    difference → `cannot rewrite <file> in place: replacing "<key>" would change
    other keys too; refusing to reformat the file`.
- `SetProjectOptionResult` (`:402`) carries `previous`, `value`, `changed`,
  `snapshotId`, `snapshotSkippedReason`.

## Contracts

- Only the one option line changes; a file where the key is not on its own line is
  refused rather than re-serialised (this was the fix-pass rule — a
  `JSON.stringify` fallback silently reformatted the whole file).
- `set_project_option` snapshots itself through `writeWithSnapshot`
  (`:535-539`) and is therefore deliberately not on `AUTO_SNAPSHOT_TOOLS`.
- Fixtures: `test/fixtures/options/<platform>/options_<platform>.yy` (ten files,
  `option_gameguid` redacted).

## Dependencies

- In: `yyp.ts` (`fileExists`, `parseGameMakerJson`), `write.ts`.
- Out: `index.ts` (`SET_PROJECT_OPTION_KEY_DESCRIPTION` is built from the
  allowlist), `test/verify.ts`.
