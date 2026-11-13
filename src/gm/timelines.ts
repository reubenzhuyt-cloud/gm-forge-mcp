import { promises as fs } from "fs";
import path from "path";
import { assertSafeResourceName, loadYyp, parseGameMakerJson } from "./yyp.js";

// Read-only timeline listing, and NOTHING else in this module.
//
// docs/specs/D-sequences-timelines.md's gate FIRED for timelines: no
// GameMaker-generated `timelines/<n>/<n>.yy` exists on this machine to capture a
// key set from (searched 2026-11-13: every project root, the IDE install, its
// project templates and prefab bundles, and @bscotch/yy). A writer written
// against a guessed shape is still valid JSON, so nothing fails loudly here --
// the IDE simply refuses the project. The gate therefore keeps add_timeline,
// add_timeline_moment, edit_timeline_moment and remove_timeline_moment out of
// the server entirely: no template, no dispatch case, not even a disabled one.
//
// What is safe without a capture is *reading*: this parser asserts nothing about
// the file's shape. It reports the moments it can find, and when the collection
// it expects is not there it reports the root keys the file actually has instead
// of a confident `momentCount: 0` (see the spec's "Risks" section -- a silent
// zero is the one wrong answer a tolerant reader can still give). It never
// throws for a bad file: an unparseable or unexpected entry is reported in that
// entry's `parseError`, so one corrupt timeline cannot hide the other nineteen.

const TIMELINES_DIR = "timelines";

// No capture exists, so the accepted spellings below are not a schema -- they
// are a search order, and an entry that matches none of them is reported as
// `momentsKey: null` with its real root keys, never as "zero moments".
// `moments` as an array is the flat shape the spec describes; the
// `{ Keyframes: [...] }` store is the one shape that IS grounded, from the
// sprite-embedded GMSequence in src/gm/sprites.ts:174-179.
const MOMENTS_KEYS = ["moments", "Moments"] as const;
const STEP_KEYS = ["step", "time"] as const;

export interface TimelineMomentSummary {
  /** The moment's numeric position, or null when the entry carries no number we recognise. */
  step: number | null;
  /** Whether a non-empty *code* string is present on the moment. Never emits or edits that code. */
  hasCode: boolean;
}

export interface TimelineSummary {
  name: string;
  momentCount: number;
  moments: TimelineMomentSummary[];
  existsOnDisk: boolean;
  /** The root key the moments were read from; null when no recognised key held a collection. */
  momentsKey: string | null;
  /** Present only when `momentsKey` is null: the root keys the file really has. */
  foundKeys?: string[];
  /** Set when the file exists but could not be read/parsed/inspected. The entry is still listed. */
  parseError?: string;
}

// `kind` keeps the two shapes apart so the caller can emit a bare array for the
// listing form (the contract's shape) and a single object for a named lookup,
// without inspecting the payload.
export type ListTimelinesResult =
  | { kind: "list"; timelines: TimelineSummary[]; note: string | null }
  | { kind: "one"; timeline: TimelineSummary; note: string | null };

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The expected path in a "does not exist" message is built from a caller-supplied
// name, so it is only joined once the name is known to be a resource name. A
// crafted value ("../../etc") is quoted as-is instead of producing a nonsense
// path -- and is never passed to path.join.
function expectedResourcePath(projectDir: string, folder: string, name: string): string | null {
  try {
    assertSafeResourceName(name);
  } catch {
    return null;
  }
  return path.join(projectDir, folder, name, `${name}.yy`);
}


// Names come out of the .yyp, which is hand-editable text, and become path
// components below.
function registeredTimelineNames(yyp: any): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const resource of (yyp?.resources ?? []) as any[]) {
    const resourcePath = resource?.id?.path;
    if (typeof resourcePath !== "string" || !resourcePath.startsWith(`${TIMELINES_DIR}/`)) continue;
    const name = typeof resource?.id?.name === "string" && resource.id.name.length > 0
      ? resource.id.name
      // `timelines/<name>/<name>.yy` -- the folder segment is the resource name.
      : resourcePath.slice(TIMELINES_DIR.length + 1).split("/")[0];
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function numericField(record: Record<string, any>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    // No Number(), no rounding: a string "3" is not the number 3, and a float
    // stays a float. A value we do not recognise is null, not zero.
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

// A "code payload" is any *code* key holding a non-empty string. Nothing is
// written from it, and `code: ""` (or an absent key) counts as no code -- the
// distinction the gated edit_timeline_moment contract would have to preserve.
//
// Caveat, and it is why this stays a boolean and not a string: "carries code"
// may mean "carries a GML *path*" (a hypothetical `codeFile`/`eventCodeFile` a
// timeline moment points at) rather than inline GML. No GameMaker-authored
// timeline exists on this machine to settle which spelling a real moment uses,
// so a key naming a file counts as code too. A capture would replace this with
// the real key and its real meaning.
function hasCodePayload(record: Record<string, any>): boolean {
  for (const key of Object.keys(record)) {
    if (!/code/i.test(key)) continue;
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  return false;
}

function momentsOf(root: Record<string, any>): { key: string | null; entries: any[] } {
  for (const key of MOMENTS_KEYS) {
    const value = root[key];
    if (Array.isArray(value)) return { key, entries: value };
    if (isRecord(value) && Array.isArray(value.Keyframes)) return { key, entries: value.Keyframes };
  }
  return { key: null, entries: [] };
}

async function summariseTimeline(projectDir: string, name: string): Promise<TimelineSummary> {
  const yyPath = path.join(projectDir, TIMELINES_DIR, name, `${name}.yy`);
  const missing = (parseError?: string): TimelineSummary => ({
    name,
    momentCount: 0,
    moments: [],
    existsOnDisk: false,
    momentsKey: null,
    ...(parseError === undefined ? {} : { parseError }),
  });

  // The name arrives from the .yyp, so it is validated before it reaches
  // path.join -- but only for this entry, so one unsafe registration cannot
  // take the whole listing down.
  try {
    assertSafeResourceName(name);
  } catch (e: any) {
    return missing(`registered name is not usable as a path component: ${e.message}`);
  }

  let stat: any;
  try {
    stat = await fs.stat(yyPath);
  } catch (e: any) {
    // EVERY failure, not just ENOENT: EACCES/EPERM/ELOOP/EBUSY on one resource
    // must not take the other nineteen out of the listing (the module header's
    // promise). A missing folder is the common, unremarkable case and reads as
    // plain "not on disk"; anything else names the path and the reason so the
    // problem is visible instead of silent.
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return missing();
    return missing(`${yyPath}: ${e?.message ?? String(e)}`);
  }
  // A directory where the .yy belongs is the one shape that survives `stat` and
  // still cannot be read as a resource -- reported, never repaired.
  if (!stat.isFile()) {
    return missing(`${yyPath}: expected a file, found a ${stat.isDirectory() ? "directory" : "non-file"}`);
  }

  let root: any;
  try {
    root = parseGameMakerJson(await fs.readFile(yyPath, "utf8"));
  } catch (e: any) {
    return { ...missing(), existsOnDisk: true, parseError: `${yyPath}: ${e.message}` };
  }
  if (!isRecord(root)) {
    return {
      ...missing(),
      existsOnDisk: true,
      parseError: `${yyPath}: expected a JSON object at the root, found ${root === null ? "null" : Array.isArray(root) ? "an array" : typeof root}`,
    };
  }

  const { key, entries } = momentsOf(root);
  const moments: TimelineMomentSummary[] = entries.map((entry: any) => {
    if (!isRecord(entry)) return { step: null, hasCode: false };
    return { step: numericField(entry, STEP_KEYS), hasCode: hasCodePayload(entry) };
  });
  // Ascending by step regardless of file order, as the contract requires; an
  // entry with no numeric position keeps its relative position at the end
  // rather than being given an invented one.
  moments.sort((a, b) => {
    if (a.step === null && b.step === null) return 0;
    if (a.step === null) return 1;
    if (b.step === null) return -1;
    return a.step - b.step;
  });

  return {
    name,
    momentCount: moments.length,
    moments,
    existsOnDisk: true,
    momentsKey: key,
    ...(key === null ? { foundKeys: Object.keys(root) } : {}),
  };
}

/**
 * Lists the `timelines/` resources the .yyp registers. Strictly read-only: no
 * snapshot, no write path, no registration. `name` selects one timeline and
 * raises the usual "does not exist (expected <abs path>)" error when the .yyp
 * does not register it; omitting it returns every timeline, which is `[]` (plus
 * a note) for a project that has none.
 *
 * A registered name whose file is missing or unreadable is NOT that error: it
 * returns the zeroed summary with `existsOnDisk: false` and (for an unreadable
 * file) a `parseError`, because "the .yyp lists it and disk disagrees" is more
 * useful than "does not exist".
 */
export async function listTimelines(
  projectDir: string,
  options: { name?: string } = {}
): Promise<ListTimelinesResult> {
  const yyp = await loadYyp(projectDir);
  const registered = registeredTimelineNames(yyp);

  if (options.name !== undefined) {
    const requested = options.name;
    const exact = registered.filter((candidate) => candidate === requested);
    const matches = exact.length > 0
      ? exact
      : registered.filter((candidate) => candidate.toLowerCase() === requested.toLowerCase());
    if (matches.length === 0) {
      const expected = expectedResourcePath(projectDir, TIMELINES_DIR, requested);
      const where = expected === null
        ? ` ("${requested}" is not a usable resource name, so there is no path to expect)`
        : ` (expected ${expected})`;
      throw new Error(
        registered.length === 0
          ? `Timeline "${requested}" does not exist${where} -- the .yyp registers no timelines at all`
          : `Timeline "${requested}" does not exist${where} -- registered: ${registered.join(", ")}`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `"${requested}" matches ${matches.length} registered timelines (${matches.join(", ")}) -- refusing to guess which one you mean`
      );
    }
    return { kind: "one", timeline: await summariseTimeline(projectDir, matches[0]), note: null };
  }

  const timelines: TimelineSummary[] = [];
  for (const name of registered) timelines.push(await summariseTimeline(projectDir, name));

  const timelinesDir = path.join(projectDir, TIMELINES_DIR);
  let note: string | null = null;
  if (timelines.length === 0) {
    const dirExists = await fs.stat(timelinesDir).then((s) => s.isDirectory()).catch(() => false);
    note = dirExists
      ? `the .yyp registers no timelines (a ${TIMELINES_DIR}/ directory exists on disk, but GameMaker only loads resources the .yyp lists)`
      : `no timelines: the .yyp registers none and there is no ${TIMELINES_DIR}/ directory (GameMaker creates both with the first timeline)`;
  }
  return { kind: "list", timelines, note };
}
