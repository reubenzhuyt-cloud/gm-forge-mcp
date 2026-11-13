# Plan B — Sprite frame editing

Implements `docs/specs/B-sprite-frames.md`. Work happens in the repo working copy
at `C:\Users\31087\mcp\gm-forge-mcp`; `E:\GMprojects\261103GJ` is a **read-only**
sample project used exclusively for capturing `REF` key-sets and one read-only
smoke test (IDE `2026.0.0.16`, `resourceVersion: "2.0"`).

Branch: `feat/local-tool-discovery` · Upstream fork: `fork` →
`reubenzhuyt-cloud/gm-forge-mcp`.

Baseline: `npm test` → `415 passed, 0 failed, 0 skipped` (run 2026-11-13,
before any B work). Branch `HEAD` is `4f6312c` (subproject A shipped, 53 tools).

## Why waves

`src/index.ts`, `test/verify.ts` and `README.md` are single-file choke points
that every task would otherwise edit, and they already carry subproject A's
changes. Wave 1 produces an unregistered module plus fixtures; wave 2 is one
integrator, serial, so the choke points are touched exactly once.

The six tools share one rewrite routine, so wave 1 cannot be parallelised across
the tools the way A parallelised across resource types — splitting
`src/gm/sprite_frames.ts` between two owners would mean two owners editing one
file. Wave 1 is therefore one owner for code, one for test fixtures.

## Wave 1 — parallel, disjoint files

No edits to `src/index.ts`, `test/verify.ts`, `README.md`, `package.json`,
`docs/` in this wave. Wave-1 code is unregistered and therefore unreachable from
MCP until wave 2.

| ID | Files | Deliverable |
|----|-------|-------------|
| W1 | `src/gm/sprite_frames.ts` (new); additive helpers in `src/gm/sprites.ts` **only if strictly needed** | All six functions (`listSpriteFrames`, `addSpriteFrame`, `removeSpriteFrame`, `replaceSpriteFrame`, `reorderSpriteFrames`, `trimSpriteFrames`), the single sequence-rewrite routine, the pre-write post-conditions, the orphan/mismatch guards, and a local `writeSpriteYy` (temp file + rename, `EPERM`/`EACCES` message copied from `room_layers.ts:52-68`). Reuse `frameEntry`/`frameKeyframe` shapes from `sprites.ts:77-122`, `readPngDimensions` (:14-27) and `parseGameMakerJson`. No dispatch wiring. |
| W2 | `test/fixtures/*.png` only (new binaries) | Three PNGs for the frame cases: `frame1.png` 16x24 (distinct pixels from `frame0.png`), `frame_wide.png` 24x24, `frame_tall.png` 16x32. These are the only source of second/third frames the suite has; `frame0.png` is the only image fixture today. |

W1 is ordered internally — do not jump ahead:

1. Read/validate: sprite path resolution with `assertSafeResourceName`, the
   `fs` read error message shaped like `editSprite` (`sprites.ts:280-285`), the
   track locator (`name === "frames"`, `resourceType === "GMSpriteFramesTrack"`,
   exactly one), and the `frames`↔keyframe guid set check.
2. `listSpriteFrames`, including `missingFiles` and the `verdict` string.
3. `writeSpriteYy` + the rewrite routine + the post-conditions.
4. `add` / `remove`.
5. `replace` / `reorder` / `trim`.
6. A self-check script that builds a 4-frame sprite in a scratch project under
   `%TEMP%` (never `E:\GMprojects\261103GJ`), then exercises every function and
   prints `frames.length`, keyframe count and `length` after each step.

Do **not** add a second png-copy code path: `add` and `replace` must use the
same two-file writer, and `remove`/`trim` the same two-file deleter, or the
`layers/<guid>/<layerGuid>.png` copy will drift out of sync in one of the six
tools.

Self-verification: each coder writes a throwaway script at
`test/_wip_<name>.ts`, runs it with `npx tsx`, and **deletes it before
reporting**. No `test/_wip_*.ts` may survive a wave-1 report; W2's PNG fixtures
are the only intentional additions under `test/`.

Wave-1 gate per coder: `npm run typecheck` clean; the throwaway script
demonstrates the module against a scratch fixture project (all six functions,
including one refusal per guard); `git status --short` (read-only) shows only
the assigned files.

## Wave 2 — single integrator, serial

One agent, sequential steps, no overlap:

1. Register the six schemas (`ProjectSchema.extend`), six `TOOL_DEFS` entries
   and six `dispatchTool` cases in `src/index.ts`. Descriptions must say what
   the tool does *not* do (no pixel editing, no resize) the way
   `edit_sprite`'s does (`index.ts:491`). Tool count lands at **59**.
2. Capture the new `REF` key-sets from
   `E:\GMprojects\261103GJ\sprites\spr_jingling1_walk\spr_jingling1_walk.yy`
   (read-only) and add them next to `REF.spriteSequence`
   (`test/verify.ts:123-128`): `spriteFramesTrack` (15 keys),
   `spriteFrameKeyframeStore` (4), `spriteFrameKeyframe` (10),
   `spriteFrameKeyframeChannel` (4), `spriteFrameKeyframeId` (2). Assert them
   with `keysMatchRef()` on the writer's own output, not only on the sample.
3. Move every regression from the throwaway scripts into `test/verify.ts` as a
   `--- Sprite frames ---` block appended after the existing sprite block
   (:417-444). Populated / omitted / error per write path, the four invariant
   tests, the no-op hash tests and the both-pngs tests, all as listed in the
   spec's acceptance criteria.
4. Update the three tool-count totals (`:1956-1960`) to 59, extend the
   `newToolNames` list at `:1950-1951` with the six names, and confirm the
   README-documentation assertion (`:1961-1963`) passes unchanged.
5. Update `README.md:61` — **Sprites** gains the six tools; nothing else in the
   file changes.
6. Run `npm run typecheck` and `npm test`; report the exact output (pass/fail/
   skip counts). Then run `lint_project` **once** against a scratch project
   under `%TEMP%` containing a mutated sprite, only if GameMaker is installed
   and closed; report the result or the skip.

Wave-2 gate:

```powershell
cd C:\Users\31087\mcp\gm-forge-mcp
npm run typecheck     # clean, no output
npm test              # >= 485 passed, 0 failed, 0 skipped
git status --short    # only the intended files
```

Also: no `test/_wip_*.ts` left; no pre-existing assertion changed except the
three tool-count totals and the `newToolNames` list; `E:\GMprojects\261103GJ`
byte-identical (verify by comparing `git status` inside that project, read-only,
or by file hash of the sprite directory — never by writing to it).

**Wave-2 outcome:** shipped. The six tools are registered (74 total, from 68),
`AUTO_SNAPSHOT_TOOLS` went 19 → 24 with the five writers added and
`list_sprite_frames` deliberately left off, and the suite went from 734 to
**862 passed, 0 failed, 0 skipped** (+128 assertions, all appended in one
`Sprite frames` block; the only pre-existing lines touched are the three
tool-count literals 68 → 74 and five new `minimalArgs` rows).

Deviations from this plan, with reasons:

- Tool count is 74, not 59: subprojects C and E merged before B, so the "59"
  figures were already stale when wave 2 ran.
- The new PNG fixtures live in `test/fixtures/frames/`, not at `test/fixtures/`
  top level: an existing assertion imports that whole directory as one sprite's
  frames (`addSpriteFromImages(dir, …, "test/fixtures")`), and a 24x24 or 16x32
  file there is rejected by the all-frames-same-size rule. Moving the lint test
  was not an option (pre-existing assertion), so the fixtures moved.
- `remove_sprite_frame` refuses "the only frame" before validating the index, so
  the out-of-range test uses a 4-frame sprite. Ordering is documented in the
  spec rather than changed, because the last-frame message is the useful one.
- The real-sample smoke test asserts against a **copy** of `spr_jingling1_walk`
  in `%TEMP%` instead of the live project, so hand edits in
  `E:\GMprojects\261103GJ` cannot break the suite.
- `docs/specs/B-sprite-frames.md` gained a "Shipped" section recording the
  `allowResize` decision, the two-png invariant, the `sequence.length`
  semantics, the exact verdict grammar, and the gaps the single sample could not
  ground.


## Wave 3 — review

One reviewer agent, full audit of the integrated diff. Deliverable: findings
with `file:line`, severity, and a concrete fix each. Blocking findings go back
to the integrator, not to wave-1 owners.

Specific things to check, because they are the ones that pass tests and still
corrupt a project:

- every png write/delete touches both copies;
- no guid is reused, and no keyframe `id` is regenerated for a surviving frame;
- `sequence.length` is `frameCount`, never `frameCount / playbackSpeed`;
- `frames` and `Keyframes` cannot diverge through any of the six entry points,
  including the refusal paths (a refusal must not leave a partially applied
  change);
- an unchanged sprite produces an unchanged file (hash equality);
- no `.yyp` or `textureGroupId` write anywhere in the new module.

## Do not

- No `npm install` (the tree is already provisioned).
- No `git commit`, `git push`, or branch manipulation — only the Chief Agent
  commits.
- No writes of any kind to `E:\GMprojects\261103GJ`: that project is read-only
  for this work and the user edits its rooms by hand.
- No Igor builds, no Runner launches, no MCP screenshots. Exactly one
  `lint_project` call is permitted, on a scratch project, at the wave-2 gate.
- No new tool beyond the six; the tool count must land at exactly 59.
- No re-encode of a sprite that was not changed, no key reordering in
  `spr_*.yy`, no "correction" of the `lockOrigin`/`swfPrecision` divergence in
  the existing writer.
- No repair or migration of an already-inconsistent sprite: refuse and report.
- No resize of a multi-frame sprite, and no `allowResize` bypass from the tool
  schema (the restriction lives in the module, and the schema must not expose a
  flag the module then rejects without a clear message).
- No drawing, no texture-group assignment, no sprite-layer composition, no
  atlas packing.
