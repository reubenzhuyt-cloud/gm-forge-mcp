# verify

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

`test/verify.ts` is the entire automated suite: one hand-rolled script (4811
lines) that builds throwaway projects in `os.tmpdir()`, drives the real writers
and the real MCP dispatch path, and prints `N passed, M failed, K skipped`. It
owns the `REF` key sets — the captured shapes that define "a file GameMaker can
load".

## Key Paths

- `test/verify.ts` — the script (`npm test` → `tsx test/verify.ts`).
- `test/fixtures/` — `frame0.png`, `beep.wav`, `beep.ogg`, `badrate.wav`,
  `badrate.ogg`.
- `test/fixtures/frames/` — `frame1.png` (16×24), `frame_wide.png` (24×24),
  `frame_tall.png` (16×32). In a sub-directory on purpose: an existing assertion
  imports **every** top-level PNG in `test/fixtures/` as one sprite's frames, so a
  differently-sized file there would break the all-frames-same-size rule.
- `test/fixtures/options/<platform>/options_<platform>.yy` — ten real options
  files, `option_gameguid` redacted.

## Gates (`package.json`)

- `npm run typecheck` → `tsc --noEmit`.
- `npm test` → this script; exit code 1 when `failed > 0`.

## Conventions

- `ok(label, condition, detail?)` (`:65`) — one assertion, prints
  `PASS:`/`FAIL:`; `expectThrows` (`:75`) for refusals.
- `skip(label)` (`:59`) — its own counter and a summary section, because the
  skipped checks are the GameMaker-authoritative ones (ProjectTool, Igor) and a
  plain "N passed" would hide that they did not run.
- Each scenario does `fs.mkdtemp(path.join(os.tmpdir(), "gm-mcp-…"))` (e.g.
  `:264`) and every temp dir is removed at the end of `main()`; the summary line
  is printed last.
- `src/index.ts` is imported directly (`:33-35`) to assert on the real
  `TOOL_DEFS`, dispatch cases and schemas — safe because the module only opens
  stdio when it is the process entry point.
- Registry pins: `TOOL_DEFS.length === 76`, 76 declared entries in the source,
  76 uncommented dispatch cases (`:1982-1986`), every name snake_case, unique and
  mentioned in `README.md` (`:4771`). Adding a tool means updating those literals
  and the README in the same change.

## `REF` key sets (`:102-240`)

Captured from real GameMaker-authored files (Convoy, 2026-07-17); if the format
changes, refresh from a real export rather than editing a set to make a test
pass. Covers room, room instance/background/tile/asset/path/effect layers and
folder layers, script, object + event + object property, sprite + frame + layer +
sequence + frames track + keyframe store/keyframe/channel/id, shader, sound, font,
tileset, extension, particle system/emitter, animation curve/channel. Frame sets
were extended from `261103GJ/sprites/spr_jingling1_walk/*.yy`.

## Live-sample discipline

`E:\GMprojects\261103GJ` is **read-only** for the suite: the `.yyp` round-trip
test copies it to a temp dir first (`:3510`), sprite work copies
`spr_jingling1_walk` into `%TEMP%` (`:4346-4350`), and the timeline/sequence smoke
uses a bare synthetic project with a copied sprite (`:4578-4582`) — the live
project's counts are never pinned.

## Coverage shape (not exhaustive)

Per tool: populated + default + error cases; byte-identical files after a refused
call; one snapshot per wrapped call and a discarded no-op snapshot; atomic-write
and restore/rollback paths; path traversal (`../../`, `..\..`, `con`); tile
encode/decode round-trip and run splitting; `writeYyp` tag restoration and the
`resourceVersion` 1.3→2.0 pin; synthetic timeline/sequence fixtures and the
501-sprite scan cap.

**Not re-run while writing these docs** — the recorded state in
`docs/plans/` is the authority for pass counts.
