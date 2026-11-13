# path safety

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

One validator for "this hand-editable string is about to become exactly one path
component". Two callers turn names read out of a GameMaker file into filenames —
`IncludedFiles` entries (`datafiles/<name>`) and sprite frame guids
(`sprites/<s>/<guid>.png`, `sprites/<s>/layers/<guid>/<layer>.png`). It does not
join paths, and it does not validate GML resource names (that is
`assertSafeResourceName` in `project-manifest.md`).

## Key Paths

- `src/gm/path_safety.ts` — 79 lines, no imports.

## Public API / Key Types

- `assertSafePathSegment(value, what, rules)` (`:41`) — throws unless the value
  is a non-empty string that is: not `.`/`..`; free of `\` and `/`; free of
  control characters; free of `<>:"|?*`; untrimmed-different from itself
  (leading/trailing whitespace); not ending in `.`; and not a Windows device
  name. Complex rules are refused rather than sanitised — the created filename
  must equal the string GameMaker will look for.
- `WINDOWS_ILLEGAL_CHARS` (`:14`), `WINDOWS_RESERVED_NAMES` (`:15`, `con`, `prn`,
  `aux`, `nul`, `clock$`, `com1-9`, `lpt1-9`; extension ignored, so `CON.txt` is
  refused), `MAX_PATH_SEGMENT_LENGTH = 255` (`:22`).
- `SegmentRules` (`:24`) — `maxLength` plus three message fragments, so each
  caller keeps its own wording byte-for-byte.

## Why a separate module

`included_files.ts:100` is now a two-line delegate, and `sprite_frames.ts` did not
have to depend on the IncludedFiles module to reuse the rule. A value that
escapes its directory once would escape it everywhere.

## Dependencies

- In: none.
- Out: `included_files.ts` (file names, `targetName`), `sprite_frames.ts`
  (frame guids, layer ids, sprite file names).
