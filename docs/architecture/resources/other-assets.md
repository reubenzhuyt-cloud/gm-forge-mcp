# other assets

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

The small single-purpose asset writers: shaders, tile sets, notes, extensions,
particle systems and animation curves. Each creates a resource shell with
GameMaker's own defaults and registers it; none of them edits frame/pixel data or
runs a GameMaker tool.

## Key Paths

| Module | Path | Main API |
|--------|------|----------|
| shaders | `src/gm/shaders.ts` (98) | `addShader` `:37`, `editShader` `:84`, `ShaderEditOptions` `:74` |
| tile sets | `src/gm/tilesets.ts` (168) | `addTileset` `:100`, `editTileset` `:138`, `TilesetOptions` `:7`, `TilesetEditOptions` `:124` |
| notes | `src/gm/notes.ts` (41) | `addNote` `:9` |
| extensions | `src/gm/extensions.ts` (93) | `addExtension` `:82` |
| particle systems | `src/gm/particle_systems.ts` (125) | `addParticleSystem` `:114` |
| animation curves | `src/gm/animation_curves.ts` (61) | `addAnimCurve` `:50` |

## Per-module notes

- **shaders** — writes the `.yy` plus a GLSL ES vertex/fragment pair; `editShader`
  rewrites one or both sources. Code is stored verbatim, no compilation.
- **tilesets** — a tile set references an existing sprite; tile width/height,
  spacing and offset are the inputs, while `out_columns` / tile count are
  computed from the **sprite's real dimensions**, never from the caller
  (`editTileset` recomputes after a dimension change).
- **notes** — a note is plain project documentation, never compiled; `addNote`
  writes the `.yy` and its text.
- **extensions** — the created shell matches `File > New Extension` before any
  function/constant/file is added; it deliberately does not invent extension
  content.
- **particle systems / animation curves** — one default emitter, and one
  straight-line channel from `(0,0)` to `(1,1)`, respectively. These are scaffolds,
  not editors; the `get_*_info` readers are in `graph/introspect.md`.

## Contracts

- All six `add_*` tools only append a new resource to the catalog, so none is on
  `AUTO_SNAPSHOT_TOOLS`; `edit_shader` and `edit_tileset` are (they rewrite an
  existing `.yy`).
- None of these tools changes an existing resource's name or parent folder.

## Dependencies

- In: `yyp.ts` (registration, versions, folder helpers), `atomic.ts`,
  `sprites.ts` (tile-set dimensions only).
- Out: `introspect.ts` (the matching `get_*_info`), `lint.ts` (orphan/missing
  checks), `index.ts`.
