# audio & fonts

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Importing sounds with metadata derived from the real audio file, and creating /
editing font resources that reference an installed system font. It owns the
`.wav`/`.ogg` parsers; it does not transcode audio or render fonts.

## Key Paths

- `src/gm/sounds.ts` (239 lines) — `sounds/<name>/<name>.yy` + the imported file.
- `src/gm/fonts.ts` (186 lines) — `fonts/<name>/<name>.yy` (no glyph data).

## sounds.ts

- `ALLOWED_SAMPLE_RATES` (`:12`) — `5512, 11025, 22050, 32000, 44100, 48000`;
  a file whose real rate is outside the list is refused, not rounded.
- `parseWavMetadata(filePath)` (`:28`) — RIFF/WAVE chunks: rate, channels,
  bit depth, size, duration.
- `parseOggMetadata(filePath)` (`:84`) — Vorbis identification header.
- `addSound(projectDir, yyp, name, options)` (`:124`) — imports with
  `atomicCopyFile`, so an interrupted copy cannot leave a truncated file the
  `.yy` already points at; metadata is never taken from the caller.
- `SoundEditOptions` (`:206`) / `editSound(...)` (`:218`) — volume and preload
  only; audio metadata stays whatever the file says.
- `.mp3` is not supported (tool description, `index.ts:829`).

## fonts.ts

- `FontOptions` (`:11`), `checkSystemFontInstalled(systemFontName)` (`:59`) —
  probes the OS font list; returns a diagnosable message instead of silently
  creating a font the IDE cannot resolve.
- `addFont(projectDir, yyp, name, options)` (`:73`) — `$GMFont` record with
  system font name, size, style; registers the resource.
- `FontEditOptions` (`:143`) / `editFont(...)` (`:155`) — system font name, size,
  style.

## Contracts

- `add_sound` / `add_font` are append tools (not auto-snapshotted);
  `edit_sound` / `edit_font` are (`auto-snapshot.md`).
- `get_sound_info` / `get_font_info` live in `graph/introspect.md`, not here.

## Dependencies

- In: `yyp.ts` (registration, versions), `atomic.ts`.
- Out: `lint.ts` (re-parses a sound's real file and compares it with the `.yy`;
  also validates sample rates), `introspect.ts`, `index.ts`.
