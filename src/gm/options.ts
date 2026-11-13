import { promises as fs } from "fs";
import path from "path";
import { fileExists, parseGameMakerJson } from "./yyp.js";
import { writeWithSnapshot } from "./write.js";

// Every options/<platform>/options_<platform>.yy is a flat map wrapped in the
// same envelope: a `$GM<Name>Options` tag, then %Name/name, then the option_*
// keys, then resourceType/resourceVersion. Captured from the ten files in
// E:\GMprojects\261103GJ\options on 2026-11-13 (GameMaker 2026.0.0.16).
export const OPTION_ENVELOPE_PREFIX = "$GM";
export const OPTION_ENVELOPE_KEYS: ReadonlyArray<string> = Object.freeze([
  "%Name",
  "name",
  "resourceType",
  "resourceVersion",
]);

export function isOptionEnvelopeKey(key: string): boolean {
  return key.startsWith(OPTION_ENVELOPE_PREFIX) || OPTION_ENVELOPE_KEYS.includes(key);
}

export interface OptionPlatform {
  dir: string;
  displayName: string;
}

// Directory name -> the %Name/name GameMaker actually writes. Captured from the
// ten directories under E:\GMprojects\261103GJ\options (2026-11-13, GameMaker
// 2026.0.0.16): `main` is the project-wide file, the other nine are export
// targets. Display names must never be derived from the directory -- mac is
// "macOS", operagx is "Opera GX", html5 is "HTML5", reddit is "Reddit".
export const OPTION_PLATFORMS: ReadonlyArray<OptionPlatform> = Object.freeze([
  { dir: "android", displayName: "Android" },
  { dir: "html5", displayName: "HTML5" },
  { dir: "ios", displayName: "iOS" },
  { dir: "linux", displayName: "Linux" },
  { dir: "mac", displayName: "macOS" },
  { dir: "main", displayName: "Main" },
  { dir: "operagx", displayName: "Opera GX" },
  { dir: "reddit", displayName: "Reddit" },
  { dir: "tvos", displayName: "tvOS" },
  { dir: "windows", displayName: "Windows" },
]);

export const OPTION_MAIN_PLATFORM = "main";

export type OptionValueType = "bool" | "int" | "string";
export type OptionScope = "main" | "platform";
export type OptionStatus = "verified" | "read-only" | "unverified";

// Stands for the platform directory inside an on-disk key: assigning
// `option_<platform>_interpolate_pixels` on windows writes
// `option_windows_interpolate_pixels`.
export const OPTION_PLATFORM_TOKEN = "<platform>";

export interface OptionSpec {
  key: string;
  type: OptionValueType;
  scope: OptionScope;
  status: OptionStatus;
  /** The real spelling in the file; null when nothing on disk backs the name. */
  onDiskKey: string | null;
  min?: number;
  max?: number;
}

// The only writable option names, with the spelling each one resolves to.
// Everything here was read out of a real options file; the four `unverified`
// entries exist so a caller gets an explanation instead of "unknown key".
export const OPTION_ALLOWLIST: ReadonlyArray<OptionSpec> = Object.freeze([
  {
    key: "interpolate_pixels",
    type: "bool",
    scope: "platform",
    status: "verified",
    onDiskKey: `option_${OPTION_PLATFORM_TOKEN}_interpolate_pixels`,
  },
  {
    key: "option_game_speed",
    type: "int",
    scope: "main",
    status: "verified",
    onDiskKey: "option_game_speed",
    min: 1,
    max: 1000,
  },
  {
    key: "option_author",
    type: "string",
    scope: "main",
    status: "verified",
    onDiskKey: "option_author",
  },
  {
    key: "option_version",
    type: "string",
    scope: "platform",
    status: "verified",
    onDiskKey: `option_${OPTION_PLATFORM_TOKEN}_version`,
  },
  {
    key: "option_scale",
    type: "int",
    scope: "platform",
    status: "verified",
    onDiskKey: `option_${OPTION_PLATFORM_TOKEN}_scale`,
    min: 0,
    max: 10,
  },
  {
    key: "option_fullscreen",
    type: "bool",
    scope: "platform",
    status: "verified",
    onDiskKey: `option_${OPTION_PLATFORM_TOKEN}_start_fullscreen`,
  },
  {
    key: "option_resize",
    type: "bool",
    scope: "platform",
    status: "verified",
    onDiskKey: `option_${OPTION_PLATFORM_TOKEN}_resize_window`,
  },
  {
    key: "option_gameguid",
    type: "string",
    scope: "main",
    status: "read-only",
    onDiskKey: null,
  },
  {
    key: "option_speed",
    type: "int",
    scope: "main",
    status: "unverified",
    onDiskKey: null,
  },
  {
    key: "option_window_width",
    type: "int",
    scope: "platform",
    status: "unverified",
    onDiskKey: null,
  },
  {
    key: "option_window_height",
    type: "int",
    scope: "platform",
    status: "unverified",
    onDiskKey: null,
  },
  {
    key: "option_lastchanged",
    type: "string",
    scope: "main",
    status: "unverified",
    onDiskKey: null,
  },
]);

const OPTION_BY_KEY = new Map(OPTION_ALLOWLIST.map((spec) => [spec.key, spec]));

const MAX_OPTION_STRING_LENGTH = 1024;

// One message for every rejection: a caller who guessed a key should leave with
// the whole list, not with a second round-trip per guess.
function optionAllowlistHelp(): string {
  const writable = OPTION_ALLOWLIST.filter((spec) => spec.status === "verified")
    .map((spec) => `  ${spec.key} (${spec.type}) -> ${spec.onDiskKey}`)
    .join("\n");
  const readOnly = OPTION_ALLOWLIST.filter((spec) => spec.status === "read-only")
    .map((spec) => spec.key)
    .join(", ");
  const unverified = OPTION_ALLOWLIST.filter((spec) => spec.status === "unverified")
    .map((spec) => spec.key)
    .join(", ");
  return (
    `set_project_option writes only these options:\n${writable}\n` +
    `Rejected as read-only: ${readOnly}. ` +
    `Rejected as unverified: ${unverified} (no backing key could be verified in a real options file -- ` +
    `no GameMaker 2026.0.0.16 sample defines it). Nothing was written.`
  );
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function assertOptionValue(spec: OptionSpec, value: unknown): void {
  const label = `"${spec.key}" (${spec.type})`;
  if (spec.type === "bool") {
    if (typeof value !== "boolean") {
      throw new Error(`${label} needs true or false, got ${describeValue(value)}. Nothing was written.`);
    }
    return;
  }
  if (spec.type === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`${label} needs a whole number, got ${describeValue(value)}. Nothing was written.`);
    }
    const bounded =
      (spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max);
    if (bounded) {
      throw new Error(
        `${label} must be between ${spec.min} and ${spec.max}, got ${value}. Nothing was written.`
      );
    }
    return;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} needs a string, got ${describeValue(value)}. Nothing was written.`);
  }
  if (value.length > MAX_OPTION_STRING_LENGTH) {
    throw new Error(
      `${label} is ${value.length} characters, over the ${MAX_OPTION_STRING_LENGTH}-character limit. Nothing was written.`
    );
  }
}

function optionSpecFor(key: string): OptionSpec {
  const spec = typeof key === "string" ? OPTION_BY_KEY.get(key) : undefined;
  if (!spec) {
    throw new Error(`Unknown option ${describeValue(key)}.\n${optionAllowlistHelp()}`);
  }
  if (spec.status === "read-only") {
    throw new Error(
      `Option "${spec.key}" is read-only: a new GUID would break existing save files and achievements, ` +
        `so set_project_option never writes it.\n${optionAllowlistHelp()}`
    );
  }
  if (spec.status === "unverified" || spec.onDiskKey === null) {
    throw new Error(
      `Unverified option "${spec.key}": no backing key could be verified in a real options file -- ` +
        `no GameMaker 2026.0.0.16 sample defines this key.\n${optionAllowlistHelp()}`
    );
  }
  return spec;
}

interface PlatformFile {
  dir: string;
  displayName: string;
  file: string;
  rel: string;
}

function displayNameFor(dir: string): string {
  return OPTION_PLATFORMS.find((p) => p.dir === dir)?.displayName ?? dir;
}

function byDir(a: PlatformFile, b: PlatformFile): number {
  return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0;
}

async function scanPlatforms(projectDir: string): Promise<PlatformFile[]> {
  const optionsDir = path.join(projectDir, "options");
  let entries;
  try {
    entries = await fs.readdir(optionsDir, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const found: PlatformFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = entry.name;
    const file = path.join(optionsDir, dir, `options_${dir}.yy`);
    if (!(await fileExists(file))) continue;
    found.push({ dir, displayName: displayNameFor(dir), file, rel: `options/${dir}/options_${dir}.yy` });
  }
  return found.sort(byDir);
}

function unknownPlatformError(
  tool: "get_project_options" | "set_project_option",
  projectDir: string,
  requested: string,
  existing: PlatformFile[]
): Error {
  const expected = path.join(projectDir, "options", requested, `options_${requested}.yy`);
  const listed =
    existing.length === 0
      ? "this project has no options/*/options_*.yy files"
      : `this project has options for ${existing.map((p) => `${p.dir} (${p.displayName})`).join(", ")}`;
  const creates =
    tool === "set_project_option"
      ? "set_project_option never creates an options file or a new platform; open it once in GameMaker first."
      : "get_project_options only reads files that already exist; open the platform once in GameMaker first.";
  return new Error(`Unknown platform ${describeValue(requested)}: ${listed}. Expected ${expected} -- ${creates}`);
}

// Accepts the directory name, the display name, or either in a different case:
// callers read "macOS" out of get_project_options and must be able to paste it
// straight back into set_project_option.
async function resolvePlatform(
  tool: "get_project_options" | "set_project_option",
  projectDir: string,
  requested: string | undefined,
  existing: PlatformFile[]
): Promise<PlatformFile> {
  if (typeof requested !== "string" || requested.length === 0) {
    throw unknownPlatformError(tool, projectDir, String(requested), existing);
  }
  const lower = requested.toLowerCase();
  const hit =
    existing.find((p) => p.dir === requested) ??
    existing.find((p) => p.dir.toLowerCase() === lower) ??
    existing.find((p) => p.displayName.toLowerCase() === lower);
  if (!hit) throw unknownPlatformError(tool, projectDir, requested, existing);
  return hit;
}

async function readOptions(platform: PlatformFile): Promise<{ parsed: any; text: string }> {
  let text: string;
  try {
    text = await fs.readFile(platform.file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(`No options file for platform "${platform.dir}" (expected ${platform.file})`);
    }
    throw new Error(`Failed to read ${platform.rel} (${platform.file}): ${e.message}`);
  }
  try {
    return { parsed: parseGameMakerJson(text), text };
  } catch (e: any) {
    throw new Error(`Failed to parse ${platform.rel} (${platform.file}): ${e.message}`);
  }
}

function optionSettings(parsed: any): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isOptionEnvelopeKey(key)) settings[key] = value;
  }
  return settings;
}

function resolveOnDiskKey(spec: OptionSpec, platformDir: string): string {
  return (spec.onDiskKey as string).split(OPTION_PLATFORM_TOKEN).join(platformDir);
}

// Which files in this project actually carry the resolved key. Only used in
// error text, where naming the platforms that do define it is the whole point.
async function platformsDefining(projectDir: string, template: string): Promise<string[]> {
  const names: string[] = [];
  for (const platform of await scanPlatforms(projectDir)) {
    const key = template.split(OPTION_PLATFORM_TOKEN).join(platform.dir);
    try {
      const { parsed } = await readOptions(platform);
      if (Object.prototype.hasOwnProperty.call(parsed, key)) names.push(platform.dir);
    } catch {
      // A file that will not parse cannot vouch for the key either way.
    }
  }
  return names;
}

export interface ProjectOptionFile {
  /** Display name from the file's %Name (macOS, Opera GX), not the directory. */
  platform: string;
  file: string;
  settings: Record<string, unknown>;
}

export interface GetProjectOptionsResult {
  options: ProjectOptionFile[];
}

export async function getProjectOptions(
  projectDir: string,
  opts: { platform?: string } = {}
): Promise<GetProjectOptionsResult> {
  const existing = await scanPlatforms(projectDir);
  const targets =
    opts.platform === undefined
      ? existing
      : [await resolvePlatform("get_project_options", projectDir, opts.platform, existing)];

  const options: ProjectOptionFile[] = [];
  for (const target of targets) {
    const { parsed } = await readOptions(target);
    const declared = parsed["%Name"];
    options.push({
      platform: typeof declared === "string" && declared.length > 0 ? declared : target.displayName,
      file: target.rel,
      settings: optionSettings(parsed),
    });
  }
  return { options };
}

export interface SetProjectOptionArgs {
  platform?: string;
  key: string;
  value: boolean | number | string;
  skipSnapshot?: boolean;
}

export interface SetProjectOptionResult {
  platform: string;
  file: string;
  key: string;
  onDiskKey: string;
  previous: unknown;
  value: boolean | number | string;
  changed: boolean;
  /** The backup this call took, or null when it wrote nothing / skipped the backup. */
  snapshotId: string | null;
  /** Set when the write proceeded without a backup (skipSnapshot, excluded path, size limit). */
  snapshotSkippedReason?: string;
}

// GameMaker writes each option as its own `  "key":value,` line in a
// trailing-comma style of its own, so the resolved value is replaced in place
// and every other byte of the file survives. Spec rule 2 forbids reformatting
// anything else, so a file whose key is not alone on its own line is REFUSED
// rather than re-serialised: `JSON.stringify(parsed, null, 2)` would restyle
// every line and strip GameMaker's trailing commas, which is a silent
// whole-file rewrite of an IDE-owned file (and it only ever showed up on a file
// GameMaker had not formatted, i.e. the case no fixture covered).
function rewriteOneValueInPlace(
  text: string,
  parsed: any,
  onDiskKey: string,
  value: boolean | number | string,
  rel: string
): string {
  const escaped = onDiskKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(
    `^([ \\t]*"${escaped}"[ \\t]*:[ \\t]*)(("(?:[^"\\\\]|\\\\.)*")|true|false|null|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)([ \\t]*,?[ \\t]*\\r?)$`,
    "gm"
  );
  const matches: RegExpExecArray[] = [];
  for (let m = line.exec(text); m !== null; m = line.exec(text)) {
    matches.push(m);
    if (matches.length > 1) break;
  }
  if (matches.length !== 1) {
    const found =
      matches.length === 0
        ? `"${onDiskKey}" is not on its own line`
        : `"${onDiskKey}" appears on more than one line`;
    throw new Error(
      `cannot rewrite ${rel} in place: ${found}; refusing to reformat the file. ` +
        `set_project_option only replaces the value's own line -- a whole-file rewrite would restyle every other line and drop ` +
        `GameMaker's trailing commas. Open the platform once in the IDE so it resaves the file, then retry. Nothing was written.`
    );
  }
  const [match] = matches;
  const start = match.index + match[1].length;
  const inPlace = text.slice(0, start) + JSON.stringify(value) + text.slice(start + match[2].length);
  let reparsed: any;
  try {
    reparsed = parseGameMakerJson(inPlace);
  } catch (e: any) {
    throw new Error(
      `cannot rewrite ${rel} in place: the edited text no longer parses (${e.message ?? e}); refusing to reformat the file. Nothing was written.`
    );
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(parsed)) {
    throw new Error(
      `cannot rewrite ${rel} in place: replacing "${onDiskKey}" would change other keys too; refusing to reformat the file. Nothing was written.`
    );
  }
  return inPlace;
}

export async function setProjectOption(
  projectDir: string,
  args: SetProjectOptionArgs
): Promise<SetProjectOptionResult> {
  const spec = optionSpecFor(args.key);
  assertOptionValue(spec, args.value);

  const existing = await scanPlatforms(projectDir);
  const target =
    args.platform === undefined
      ? await resolvePlatform("set_project_option", projectDir, OPTION_MAIN_PLATFORM, existing)
      : await resolvePlatform("set_project_option", projectDir, args.platform, existing);

  if (spec.scope === "main" && target.dir !== OPTION_MAIN_PLATFORM) {
    const perPlatform = OPTION_ALLOWLIST.filter((s) => s.scope === "platform" && s.status === "verified")
      .map((s) => s.key)
      .join(", ");
    throw new Error(
      `"${spec.key}" is a project-wide option: it exists only in options/${OPTION_MAIN_PLATFORM}/options_${OPTION_MAIN_PLATFORM}.yy, ` +
        `not in ${target.rel}. Pass platform "${OPTION_MAIN_PLATFORM}" (the default), or use a per-platform option: ${perPlatform}.`
    );
  }

  const onDiskKey = resolveOnDiskKey(spec, target.dir);
  if (spec.scope === "platform" && target.dir === OPTION_MAIN_PLATFORM) {
    const defining = await platformsDefining(projectDir, spec.onDiskKey as string);
    throw new Error(
      `"${spec.key}" is per-platform (${spec.onDiskKey}): options/${OPTION_MAIN_PLATFORM}/options_${OPTION_MAIN_PLATFORM}.yy has no global equivalent. ` +
        `Platforms in this project that define it: ${defining.length > 0 ? defining.join(", ") : "none"}. Nothing was written.`
    );
  }

  const { parsed, text } = await readOptions(target);
  if (!Object.prototype.hasOwnProperty.call(parsed, onDiskKey)) {
    const defining = await platformsDefining(projectDir, spec.onDiskKey as string);
    throw new Error(
      `"${spec.key}" resolves to ${onDiskKey}, which ${target.rel} does not define -- set_project_option never adds a key ` +
        `GameMaker did not write. Platforms in this project that do define it: ${defining.length > 0 ? defining.join(", ") : "none"}. ` +
        `Nothing was written.`
    );
  }

  const previous = parsed[onDiskKey];
  const declared = parsed["%Name"];
  const platform = typeof declared === "string" && declared.length > 0 ? declared : target.displayName;
  if (previous === args.value) {
    return {
      platform,
      file: target.rel,
      key: spec.key,
      onDiskKey,
      previous,
      value: args.value,
      changed: false,
      snapshotId: null,
    };
  }

  parsed[onDiskKey] = args.value;
  const written = rewriteOneValueInPlace(text, parsed, onDiskKey, args.value, target.rel);
  // The outcome is reported, never dropped: an automatic backup that was
  // skipped (skipSnapshot, the size cap, an excluded path) has to reach the
  // caller, or a project over the limit would write new options with no warning
  // and no way back. Same fields as patch_file.
  const outcome = await writeWithSnapshot(projectDir, target.file, written, {
    tool: "set_project_option",
    reason: `set_project_option: ${target.rel} ${onDiskKey} ${describeValue(previous)} -> ${describeValue(args.value)}`,
    skipSnapshot: args.skipSnapshot === true,
  });

  return {
    platform,
    file: target.rel,
    key: spec.key,
    onDiskKey,
    previous,
    value: args.value,
    changed: true,
    snapshotId: outcome.snapshotId ?? null,
    ...(outcome.snapshotSkippedReason ? { snapshotSkippedReason: outcome.snapshotSkippedReason } : {}),
  };
}
