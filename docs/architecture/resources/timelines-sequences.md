# timelines & sequences

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Two **read-only** listings: registered timelines (`timelines/<n>/<n>.yy`) and
registered sequences (`sequences/<n>/<n>.yy`), plus a count of sequences embedded
in sprites' own `.yy` files. There is no writer for either type, and that is a
decision, not a gap in progress.

## Key Paths

- `src/gm/timelines.ts` (270 lines) — `listTimelines`.
- `src/gm/sequences.ts` (360 lines) — `listSequences`,
  `scanSpriteEmbeddedSequences`, `MAX_SPRITE_SCAN = 500` (`:84`).

## Why writing is refused

The spec's gate fired for both types (re-run 2026-11-13: no `"GMTimeline"` hit
anywhere under `E:\GMprojects`; the `"GMSequence"` hits are all
`sprites/*.yy`; neither sample project has a `timelines/` or `sequences/`
directory). A writer built on a guessed shape is still valid JSON — nothing fails
loudly here, the **IDE** rejects the project. So `add_timeline`,
`add_timeline_moment`, `edit_timeline_moment`, `remove_timeline_moment`,
`add_sequence` and `set_sequence_sprite_track` are absent from the server
entirely: no schema, no dispatch case, not even a disabled one. The only grounded
`GMSequence` is the sprite-embedded one (`sprites.ts:125-191`), which has no
`parent`, no resource registration and no standalone `resourceVersion` — the
spec's sub-gate names it insufficient.

## Public API / Key Types

- Timeline (`:226`): per entry `{name, momentCount, moments: [{step, hasCode}],
  existsOnDisk, momentsKey, foundKeys?, parseError?}`. Moments sort ascending by
  numeric step, `null` steps last.
- Sequence (`:290`): per entry `{name, length, playbackSpeed, trackCount, tracks:
  [{name, type, keyframeCount}], existsOnDisk, foundKeys?, parseError?}` —
  `type` is the track's `resourceType` verbatim, `keyframeCount` counts
  `track.keyframes.Keyframes`, and `length`/`playbackSpeed` are `null` when absent,
  never coerced.
- `SpriteSequenceScan` (`:58`) — `{count, scanned, total, truncated, unreadable[],
  unrecognised[]}`; directories are sorted before slicing so a truncated scan is
  deterministic, and a record-shaped `sequence` without
  `resourceType: "GMSequence"` is counted **and named** rather than dropped.

## The no-throw contract

`summariseTimeline` / `summariseSequence` catch every `fs.stat` failure: missing
folder → the zeroed entry (`existsOnDisk: false`, no `parseError`); any other code
(`EACCES`/`EPERM`/`ELOOP`/`EBUSY`) → `parseError: "<abs path>: <message>"`. A
directory where `<name>.yy` belongs is reported as
`"<abs path>: expected a file, found a directory"`. One corrupt entry can never
hide the other nineteen, and one unreadable sprite cannot fail the sequence list.

## Contracts

- A named lookup of a **registered** name that is missing on disk returns the
  zeroed entry, not an error. An unregistered name errors with
  `expectedResourcePath` (`timelines.ts:70`, `sequences.ts:93`), which only joins
  a name that passes `assertSafeResourceName` — a crafted `../../evil` is quoted
  and never reaches `path.join`.
- Nothing here writes: no snapshot, no `.gm-forge/` creation, no `RESOURCE_VERSIONS`
  entry (a version constant with no capture behind it is what the spec forbids).
- `list_timelines` emits a bare array (single object for a named lookup);
  `list_sequences` emits `{sequences, spriteEmbeddedSequenceCount}`. A "nothing
  here" note is a `⚠` second content part (`index.ts:1502-1510`).
- **Provisional:** timeline field names are unconfirmed — no GameMaker-authored
  timeline exists on this machine. `hasCodePayload`'s comment admits a non-empty
  `*code*` string may be a GML *path* (`codeFile`) until a capture exists.
- Fixtures for these types are deliberately synthetic (`test/verify.ts`), and
  assert the defensive path rather than claiming a real shape.

## Dependencies

- In: `yyp.ts` (`loadYyp`, `parseGameMakerJson`, `assertSafeResourceName`).
- Out: `index.ts` (two dispatch cases), `test/verify.ts`.
