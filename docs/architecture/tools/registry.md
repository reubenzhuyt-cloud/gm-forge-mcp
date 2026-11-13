# registry

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

`src/index.ts` is the MCP surface: one zod schema per tool, the `TOOL_DEFS`
table, the dispatch switch, and the call pipeline. It owns **tool names,
argument schemas, descriptions and response shapes**. It contains no resource
logic — every case parses args and delegates to `src/gm/*`.

## Key Paths

- `src/index.ts` — 1600 lines; 76 tools, 76 dispatch cases.
- `ProjectSchema` (`:76`) — every tool's base: `projectDir` plus
  `skipSnapshot` where the tool is snapshotted.

## Structure

- **Descriptions** (`:64-75`) — `EVENT_TYPE_DESCRIPTION`,
  `EVENT_NUM_DESCRIPTION`, `SKIP_SNAPSHOT_DESCRIPTION` (the last is attached to
  every opt-out schema so the wording cannot drift).
- **Schemas** (`:76-758`) — grouped by area: project/group/script/object/sprite,
  sprite frames (`:204-350`, with `FrameIndexDescription` `:264` and the
  disk-free `spriteFramePrevalidate` map `:224-243`), rooms + layers + tiles,
  snapshots/files, options/included files/macros, timelines/sequences. Every
  field is `.describe()`d; `tools/list` is generated from these schemas.
- **`ToolDef`** (`:777`) — `{name, description, schema, prevalidate?}`.
  `prevalidate` is a disk-free "this call cannot be valid" check read by the
  auto-snapshot hook so a doomed call spends no project copy
  (`auto-snapshot.md`).
- **`TOOL_DEFS`** (`:790-866`) — the single source of truth for both list and
  dispatch. The old hand-written JSON copies were deleted because they had
  drifted once (a tool advertised formats the parser rejected).
- `toInputSchema` (`:869`) / `TOOLS` (`:874`) — zod→JSON Schema, `$schema`
  dropped.

## Tool groups (76)

project setup (3) · scripts (3) · objects (4) · sprites (3 + 6 frame tools) ·
rooms (6 + 4 layer + 4 tile) · shaders (3) · sounds (3) · fonts (3) ·
tilesets (3) · extensions (2) · particle systems (2) · animation curves (2) ·
notes (2) · reference/delete/rename (3) · lint/compile (2) · `list_resources`
(1) · snapshots/changes/undo (6) · `read_file`/`patch_file` (2) · options (2) ·
included files (3) · macros (2) · timelines/sequences (2) = 76.

## Call pipeline (`:1518-1560`)

`callTool(name, args)` = `withProjectLock(projectDir, () =>
withAutoSnapshot(name, projectDir, args, () => dispatchTool(name, args),
{safeParse, prevalidate}))` when `args.projectDir` is a string; otherwise
dispatch runs unguarded. Any thrown error becomes
`{content: [{type: "text", text: "Error: …"}], isError: true}`.

## Response conventions

- Object results are `JSON.stringify(result, null, 2)` in `content[0]`.
- A warning is always a **second** `text` part starting with `⚠` — never merged
  into `content[0]` (`appendWarnings` in `write.ts`; `spriteFrameResponse`
  `:249-262` for `leftoverFiles`; `:1502-1510` for the empty timeline/sequence
  note). Four wrapped tools return pure JSON, so a suffix would make them
  unparseable.
- `list_timelines` emits a bare array; `list_sequences` emits
  `{sequences, spriteEmbeddedSequenceCount}`.

## Import safety

`isEntryPoint()` (`:1572`) compares `argv[1]` with `import.meta.url` (case-folded
on Windows, realpath-compared to survive junctions) and only then opens stdio.
The suite imports `src/index.ts` to assert on the real registry
(`test/verify.ts:33-35`). Exports: `TOOL_DEFS, ObjectPhysicsSchema,
EditObjectSchema, AddRoomLayerSchema, dispatchTool, callTool` (`:1592`).

## Dependencies

- In: every `src/gm/*` module, `@modelcontextprotocol/sdk`, `zod`,
  `zod-to-json-schema`.
- Out: `dist/index.js` (tsup), `test/verify.ts`.
