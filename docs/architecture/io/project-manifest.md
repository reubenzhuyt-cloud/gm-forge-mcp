# project manifest

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

`yyp.ts` is the project root file: find it, parse GameMaker's JSON, serialise it
without losing the keys no published schema names, hold the per-project lock,
and provide the registration helpers every writer uses (resources, folders,
audio/texture groups). It does not own any single resource's `.yy`.

## Key Paths

- `src/gm/yyp.ts` — 530 lines, imported by nearly every writer.
- Project directory contract: exactly one `*.yyp` (`yypPathIn`, `:192-204`).

## Public API / Key Types

- `RESOURCE_VERSIONS` (`:12-42`) — per-type `resourceVersion` strings captured
  from real GameMaker output; GameMaker versions each sub-structure separately.
- `withProjectLock(projectDir, fn)` (`:59`) — an in-process promise queue keyed
  by resolved (lowercased on Windows) path. Serialises load→mutate→write
  cycles; read-only calls are queued too.
- `parseGameMakerJson(text)` (`:85`) — string-aware trailing-comma stripper,
  then `JSON.parse`. A `,` followed by `]`/`}` inside a quoted value is content.
- `loadYyp` (`:209`) — schema-validated via `Yy.read`; `loadRawYyp` (`:220`) —
  raw text + parsed JSON for readers that must see unmodelled keys.
- `writeYyp(projectDir, yyp)` (`:354`) — see below.
- `registerResource` (`:425`), `ensureFolder` (`:435`), `ensureAudioGroup`
  (`:455`), `ensureTextureGroup` (`:477`), `addTextureGroup` (`:508`),
  `addAudioGroup` (`:522`) — the only catalog-mutation helpers.
- `assertSafeProjectName` (`:386`), `assertSafeResourceName` (`:398`),
  `validateResourceName` (`:415`) — GML-identifier rule + global uniqueness.

## `writeYyp` fidelity contract

`Yy.populate` runs the project schema first; zod drops every key it does not
name, including the `"$GM<Class>"` tags and an audio group's `exportDir`. So
`writeYyp` reads the file on disk, calls `restoreDroppedKeys` (`:276`) — only
`$GM*` + `exportDir` (`RESTORABLE_KEYS`, `:261`), matched by record identity
(`folderPath`, `id.path`, `roomId.path`, `filePath/name`, `name`; `:267-274`),
never by index — plus `restoreIncludedFileExtras` (`:310`) for IncludedFiles
entries, then `Yy.stringify` into `atomicReplaceWith`.

Stated limits:

- Only absent keys are filled, and only those two shapes; a key a tool removed
  stays removed, and a top-level `"Options": []` is not re-added.
- `Yy.stringify` forces `resourceVersion: "2.0"` on every typed record, and that
  key is schema-named, so the byte-identical claim holds **only for a project
  already at 2.0** (`:256-260`, `:348-353`).
- `readTextIfExists` (`:333`) swallows every read error: fidelity can never
  block a save.

## Known gap in the scaffold

`ensureProjectScaffold` (`:118-188`) writes its default audio group **without** a
`"$GMAudioGroup"` tag (`:146-153`), unlike `ensureAudioGroup` (`:460`, `"v1"`) and
IDE-authored projects. A project created by `create_project` therefore has no
tag to restore, because no original file exists for `restoreDroppedKeys` to read.

## Dependencies

- In: `@bscotch/yy`, `atomic.ts`.
- Out: every writer module, `index.ts`, `test/verify.ts`.
