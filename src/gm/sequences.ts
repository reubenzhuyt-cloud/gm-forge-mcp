import { promises as fs } from "fs";
import path from "path";
import { assertSafeResourceName, loadYyp, parseGameMakerJson } from "./yyp.js";

// Read-only sequence listing, and NOTHING else in this module.
//
// docs/specs/D-sequences-timelines.md's gate FIRED for sequences: no standalone
// `sequences/<n>/<n>.yy` exists on this machine to capture (searched
// 2026-11-13). The only real GMSequence on disk is the one embedded in a
// sprite's GMSprite record (src/gm/sprites.ts:124-190), which has no `parent`,
// no resource registration and no standalone resourceVersion -- the spec's
// sub-gate names it explicitly as insufficient. add_sequence and
// set_sequence_sprite_track are therefore not in the server at all.
//
// Reading is what is left, and it stays tolerant for the same reason as
// timelines.ts: a track type we have never seen must still list, and a file that
// disagrees with our expectations is reported (parseError / foundKeys), never
// repaired and never turned into a confident empty list.
//
// The one thing this module can say for certain is what does NOT need a capture:
// how many sprite-embedded sequences the project already has. That count is
// reported alongside the resource list so an empty `sequences/` does not read as
// "this project has no sequences at all".

const SEQUENCES_DIR = "sequences";
const SPRITES_DIR = "sprites";

export interface SequenceTrackSummary {
  /** The track's own name, or null when the file does not give one. */
  name: string | null;
  /** The track's `resourceType` verbatim (e.g. "GMSpriteFramesTrack"), never a normalised enum. */
  type: string | null;
  /** Keyframes present in the track's store; 0 when there is no store or no `Keyframes` array. */
  keyframeCount: number;
}

export interface SequenceSummary {
  name: string;
  /** Passed through as found -- never rounded, coerced or defaulted. */
  length: number | null;
  playbackSpeed: number | null;
  trackCount: number;
  tracks: SequenceTrackSummary[];
  existsOnDisk: boolean;
  /** Present only when the root has no `tracks` array: the root keys the file really has. */
  foundKeys?: string[];
  /** Set when the file exists but could not be read/parsed/inspected. The entry is still listed. */
  parseError?: string;
}

export interface UnreadableSprite {
  /** The `sprites/<name>/` directory. */
  name: string;
  /** Why its `.yy` could not be read, e.g. "EACCES: permission denied ...". */
  reason: string;
}

export interface SpriteSequenceScan {
  /** `sprites/<n>/<n>.yy` files whose root carries a record-shaped `sequence`. */
  count: number;
  /** How many sprite `.yy` files were actually opened (== `total` unless truncated). */
  scanned: number;
  /** How many sprite directories the project has. */
  total: number;
  /** True when `total > MAX_SPRITE_SCAN`, which makes `count` a lower bound. */
  truncated: boolean;
  /** Sprites that could not be read/parsed, so the count is a lower bound. */
  unreadable: UnreadableSprite[];
  /** Counted, but the `sequence` record does not say `resourceType: "GMSequence"`. */
  unrecognised: string[];
}

export type ListSequencesResult =
  | { kind: "list"; sequences: SequenceSummary[]; spriteEmbedded: SpriteSequenceScan; note: string | null }
  | { kind: "one"; sequence: SequenceSummary; note: string | null };

// One integer is not worth 5,000 file reads. A listing is interactive, and a
// project with thousands of sprites is exactly where a per-call full scan would
// stall the IDE-adjacent workflow; the scan stops at this many sprite `.yy`
// files and says so (`truncated`, and a note calling the count a lower bound)
// rather than lying with an exact-looking number. 500 is comfortably above the
// sprite count of any project this server has been used against (the sample has
// ~40) while keeping one listing to a fraction of a second.
export const MAX_SPRITE_SCAN = 500;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Same rule as timelines.ts: a caller-supplied name only becomes a path in an
// error message once it is known to be a resource name; otherwise it is quoted
// as-is.
function expectedResourcePath(projectDir: string, folder: string, name: string): string | null {
  try {
    assertSafeResourceName(name);
  } catch {
    return null;
  }
  return path.join(projectDir, folder, name, `${name}.yy`);
}

// Note text is prose, not data: cap the name list so a project with 400 broken
// sprites produces one readable sentence instead of 400 names.
function nameList(names: string[], cap: number = 5): string {
  if (names.length <= cap) return names.join(", ");
  return `${names.slice(0, cap).join(", ")} and ${names.length - cap} more`;
}

function registeredSequenceNames(yyp: any): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const resource of (yyp?.resources ?? []) as any[]) {
    const resourcePath = resource?.id?.path;
    if (typeof resourcePath !== "string" || !resourcePath.startsWith(`${SEQUENCES_DIR}/`)) continue;
    const name = typeof resource?.id?.name === "string" && resource.id.name.length > 0
      ? resource.id.name
      : resourcePath.slice(SEQUENCES_DIR.length + 1).split("/")[0];
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

// Grounded in the captured sprite-embedded GMSequence: `keyframes` is a
// KeyframeStore whose `Keyframes` array holds the records
// (src/gm/sprites.ts:127-135). A track with no store, or a store with no such
// array, is 0 -- not an error, because a track type we have not seen is exactly
// what this tool exists to report.
function trackSummary(track: any): SequenceTrackSummary {
  const store = isRecord(track) ? track.keyframes : undefined;
  const keyframes = isRecord(store) && Array.isArray(store.Keyframes) ? store.Keyframes : [];
  return {
    name: isRecord(track) && typeof track.name === "string" ? track.name : null,
    type: isRecord(track) && typeof track.resourceType === "string" ? track.resourceType : null,
    keyframeCount: keyframes.length,
  };
}

async function summariseSequence(projectDir: string, name: string): Promise<SequenceSummary> {
  const yyPath = path.join(projectDir, SEQUENCES_DIR, name, `${name}.yy`);
  const empty = (): SequenceSummary => ({
    name,
    length: null,
    playbackSpeed: null,
    trackCount: 0,
    tracks: [],
    existsOnDisk: false,
  });

  try {
    assertSafeResourceName(name);
  } catch (e: any) {
    return { ...empty(), parseError: `registered name is not usable as a path component: ${e.message}` };
  }

  let stat: any;
  try {
    stat = await fs.stat(yyPath);
  } catch (e: any) {
    // Same rule as timelines.ts: every stat failure is per-entry reporting, not
    // a thrown listing. A missing folder is the ordinary case; EACCES/EPERM/
    // ELOOP/EBUSY name the path and the reason.
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return empty();
    return { ...empty(), parseError: `${yyPath}: ${e?.message ?? String(e)}` };
  }
  if (!stat.isFile()) {
    return {
      ...empty(),
      parseError: `${yyPath}: expected a file, found a ${stat.isDirectory() ? "directory" : "non-file"}`,
    };
  }

  let root: any;
  try {
    root = parseGameMakerJson(await fs.readFile(yyPath, "utf8"));
  } catch (e: any) {
    return { ...empty(), existsOnDisk: true, parseError: `${yyPath}: ${e.message}` };
  }
  if (!isRecord(root)) {
    return {
      ...empty(),
      existsOnDisk: true,
      parseError: `${yyPath}: expected a JSON object at the root, found ${root === null ? "null" : Array.isArray(root) ? "an array" : typeof root}`,
    };
  }

  const rawTracks = Array.isArray(root.tracks) ? root.tracks : [];
  const tracks = rawTracks.map(trackSummary);
  return {
    name,
    length: typeof root.length === "number" && Number.isFinite(root.length) ? root.length : null,
    playbackSpeed:
      typeof root.playbackSpeed === "number" && Number.isFinite(root.playbackSpeed) ? root.playbackSpeed : null,
    trackCount: tracks.length,
    tracks,
    existsOnDisk: true,
    ...(Array.isArray(root.tracks) ? {} : { foundKeys: Object.keys(root) }),
  };
}

/**
 * Counts the sprite-embedded sequences under `sprites/`. Best effort by design:
 * this is a side count for the listing, so a sprite file that will not parse is
 * named (with its reason) in `unreadable` instead of failing the call -- and the
 * caller says so, because an undercount presented as a count would be misleading.
 *
 * Bounded by `maxSprites` (`MAX_SPRITE_SCAN` by default): an interactive listing
 * must not read thousands of files for one integer. When the cap bites, the
 * result reports `truncated`/`scanned`/`total` so the number is visibly a lower
 * bound instead of an exact-looking lie.
 */
export async function scanSpriteEmbeddedSequences(
  projectDir: string,
  options: { maxSprites?: number } = {}
): Promise<SpriteSequenceScan> {
  const limit = options.maxSprites ?? MAX_SPRITE_SCAN;
  const empty: SpriteSequenceScan = {
    count: 0,
    scanned: 0,
    total: 0,
    truncated: false,
    unreadable: [],
    unrecognised: [],
  };

  const spritesDir = path.join(projectDir, SPRITES_DIR);
  let entries;
  try {
    entries = await fs.readdir(spritesDir, { withFileTypes: true });
  } catch (e: any) {
    // No sprites/ folder is a normal project state, not a failure of the listing.
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return empty;
    return { ...empty, unreadable: [{ name: SPRITES_DIR, reason: `${spritesDir}: ${e?.message ?? String(e)}` }] };
  }

  // Sorted so a truncated scan examines the same sprites on every call (readdir
  // order is filesystem-defined).
  const spriteNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const total = spriteNames.length;
  const truncated = total > limit;
  const toScan = truncated ? spriteNames.slice(0, limit) : spriteNames;

  let count = 0;
  const unreadable: UnreadableSprite[] = [];
  const unrecognised: string[] = [];
  for (const name of toScan) {
    const yyPath = path.join(spritesDir, name, `${name}.yy`);
    let root: any;
    try {
      root = parseGameMakerJson(await fs.readFile(yyPath, "utf8"));
    } catch (e: any) {
      // No .yy is not a problem (layers/, pngs); a .yy that will not read or
      // parse is, and it is reported with the reason so it is actionable.
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
      unreadable.push({ name, reason: `${yyPath}: ${e?.message ?? String(e)}` });
      continue;
    }
    if (!isRecord(root)) {
      unreadable.push({ name, reason: `${yyPath}: expected a JSON object at the root` });
      continue;
    }
    // A record-shaped `sequence` is the sprite-embedded form; a missing
    // `resourceType` does not make it stop being one, so it is counted and named
    // separately instead of silently dropping out of the count.
    if (!isRecord(root.sequence)) continue;
    count++;
    if (root.sequence.resourceType !== "GMSequence") unrecognised.push(name);
  }

  return { count, scanned: toScan.length, total, truncated, unreadable, unrecognised };
}

/**
 * Lists the `sequences/` resources the .yyp registers, plus how many sequences
 * are embedded in sprites. Strictly read-only: no snapshot, no write path, no
 * registration. `name` selects one sequence and raises the usual "does not
 * exist (expected <abs path>)" error when the .yyp does not register it;
 * omitting it returns every sequence, which is `[]` (plus a note) for a project
 * that has none.
 *
 * A registered name whose file is missing or unreadable is NOT that error: it
 * returns the zeroed summary with `existsOnDisk: false` and (for an unreadable
 * file) a `parseError`, because "the .yyp lists it and disk disagrees" is more
 * useful than "does not exist".
 */
export async function listSequences(
  projectDir: string,
  options: { name?: string } = {}
): Promise<ListSequencesResult> {
  const yyp = await loadYyp(projectDir);
  const registered = registeredSequenceNames(yyp);

  if (options.name !== undefined) {
    const requested = options.name;
    const exact = registered.filter((candidate) => candidate === requested);
    const matches = exact.length > 0
      ? exact
      : registered.filter((candidate) => candidate.toLowerCase() === requested.toLowerCase());
    if (matches.length === 0) {
      const expected = expectedResourcePath(projectDir, SEQUENCES_DIR, requested);
      const where = expected === null
        ? ` ("${requested}" is not a usable resource name, so there is no path to expect)`
        : ` (expected ${expected})`;
      throw new Error(
        registered.length === 0
          ? `Sequence "${requested}" does not exist${where} -- the .yyp registers no sequences at all`
          : `Sequence "${requested}" does not exist${where} -- registered: ${registered.join(", ")}`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `"${requested}" matches ${matches.length} registered sequences (${matches.join(", ")}) -- refusing to guess which one you mean`
      );
    }
    return { kind: "one", sequence: await summariseSequence(projectDir, matches[0]), note: null };
  }

  const sequences: SequenceSummary[] = [];
  for (const name of registered) sequences.push(await summariseSequence(projectDir, name));
  const spriteEmbedded = await scanSpriteEmbeddedSequences(projectDir);

  const notes: string[] = [];
  if (sequences.length === 0) {
    const dirExists = await fs
      .stat(path.join(projectDir, SEQUENCES_DIR))
      .then((s) => s.isDirectory())
      .catch(() => false);
    notes.push(
      dirExists
        ? `the .yyp registers no sequences (a ${SEQUENCES_DIR}/ directory exists on disk, but GameMaker only loads resources the .yyp lists)`
        : `no sequences: the .yyp registers none and there is no ${SEQUENCES_DIR}/ directory (GameMaker creates both with the first sequence)`
    );
  }
  if (spriteEmbedded.truncated) {
    notes.push(
      `only the first ${spriteEmbedded.scanned} of ${spriteEmbedded.total} sprite .yy files were scanned (MAX_SPRITE_SCAN = ${MAX_SPRITE_SCAN}), so the sprite-embedded count is a lower bound`
    );
  }
  if (spriteEmbedded.count > 0) {
    notes.push(
      `${spriteEmbedded.count} sprite-embedded sequence(s) exist in ${SPRITES_DIR}/*.yy -- those are part of a sprite, not sequence resources`
    );
  }
  if (spriteEmbedded.unrecognised.length > 0) {
    notes.push(
      `${spriteEmbedded.unrecognised.length} sprite(s) carry a sequence record without resourceType "GMSequence" (${nameList(spriteEmbedded.unrecognised)}) -- counted, but not a recognised sequence type`
    );
  }
  if (spriteEmbedded.unreadable.length > 0) {
    notes.push(
      `could not read ${spriteEmbedded.unreadable.length} sprite file(s) (${nameList(spriteEmbedded.unreadable.map((entry) => entry.name))}); the sprite-embedded count is a lower bound`
    );
  }

  return { kind: "list", sequences, spriteEmbedded, note: notes.length === 0 ? null : notes.join("; ") };
}
