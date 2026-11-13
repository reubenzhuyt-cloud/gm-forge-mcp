// One set of rules for "this string is about to become a single path
// component". Two modules turn a *name read out of a GameMaker file* into a
// filename -- IncludedFiles entries (datafiles/<name>) and sprite frame guids
// (sprites/<sprite>/<guid>.png and sprites/<sprite>/layers/<guid>/<layer>.png)
// -- and both values are hand-editable text in a .yyp/.yy. The rules must not
// drift between them: a value that escapes its directory once escapes it
// everywhere.
//
// The check is deliberately stricter than "no separator": Windows device names,
// control characters, a trailing dot and surrounding whitespace are all
// rejected too, because each one makes the created filename differ from the
// string GameMaker will look for.

export const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*]/;
export const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul", "clock$",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Longest single filename most filesystems (and Windows' legacy APIs) accept. */
export const MAX_PATH_SEGMENT_LENGTH = 255;

export interface SegmentRules {
  /** Longer values are refused; the message quotes this number. */
  maxLength: number;
  /** Completes "must be a single path segment -- <this>". */
  separatorHint: string;
  /** Completes "contains a character Windows cannot put in a filename ... -- <this>". */
  illegalCharsHint: string;
  /** Completes "is a reserved Windows device name (CON) -- <this>". */
  reservedHint: string;
}

/**
 * Throws unless `value` is a safe single path component. `what` names the thing
 * being validated and starts the message ("Included file name", `sprite
 * "sprX" frame 2 guid`), so the caller decides the context and this decides the
 * rule.
 */
export function assertSafePathSegment(value: unknown, what: string, rules: SegmentRules): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${what} cannot be empty`);
  }
  if (value.length > rules.maxLength) {
    throw new Error(
      `${what} "${value.slice(0, 40)}..." is ${value.length} characters -- longer than the ${rules.maxLength}-character limit`
    );
  }
  if (value === "." || value === "..") {
    throw new Error(`${what} cannot be "${value}"`);
  }
  if (/[\\/]/.test(value)) {
    throw new Error(`${what} "${value}" must be a single path segment -- ${rules.separatorHint}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${what} "${value}" contains a control character`);
  }
  if (WINDOWS_ILLEGAL_CHARS.test(value)) {
    throw new Error(
      `${what} "${value}" contains a character Windows cannot put in a filename (< > : " | ? *) -- ${rules.illegalCharsHint}`
    );
  }
  if (value !== value.trim()) {
    throw new Error(`${what} "${value}" must not start or end with whitespace`);
  }
  // Windows silently drops a trailing dot when creating the file, so GameMaker
  // would then look for a name that is not on disk.
  if (value.endsWith(".")) {
    throw new Error(`${what} "${value}" must not end with a dot -- Windows truncates it when creating the file`);
  }
  // "CON.txt" is still the CON device: Windows ignores the extension.
  const stem = value.split(".")[0].toLowerCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    throw new Error(
      `${what} "${value}" is a reserved Windows device name (${stem.toUpperCase()}) -- ${rules.reservedHint}`
    );
  }
}
