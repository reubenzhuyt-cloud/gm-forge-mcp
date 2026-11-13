import { promises as fs } from "fs";
import { execFileSync } from "child_process";
import path from "path";

/**
 * GameMaker is installed in one of several layouts depending on channel and
 * storefront, and the two headless tools this server shells out to live in
 * different roots:
 *
 *   ProjectTool (official validator) -> inside the IDE install directory
 *   Igor        (compiler)          -> inside the active runtime directory
 *
 * The old code assumed a single default-install layout
 * (`C:\Program Files\GameMaker\...` and `C:\ProgramData\GameMakerStudio2\
 * runtime.json`). An LTS install keeps its manifest under
 * `GameMakerStudio2-LTS2026\` instead, and a Steam install keeps the IDE
 * under `<library>\steamapps\common\GameMaker Studio 2\`, so nothing was
 * found and both tools reported "not available". Every candidate below is
 * probed in order, and each can be overridden explicitly with an
 * environment variable for nonstandard installs.
 */
const PROJECT_TOOL_RELATIVE = path.join(
  "packages",
  "gm-tools",
  "project-tool-win-x64",
  "ProjectTool.exe"
);

const PROGRAM_DATA = process.env.ProgramData ?? "C:\\ProgramData";
const PROGRAM_FILES = process.env.ProgramFiles ?? "C:\\Program Files";
const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Steam keeps a list of library folders (one drive per entry) in
 * libraryfolders.vdf. Parsing the "path" values is enough to find a
 * non-default install without walking every drive. Steam itself can live on
 * any drive too, so its own location comes from the registry rather than
 * from a guessed path.
 */
function registryValue(key: string, value: string): string | null {
  try {
    const out = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8" });
    const match = out.match(new RegExp(`${value}\\s+REG_SZ\\s+(.+)`));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function steamInstallRoots(): string[] {
  const roots = new Set<string>();
  const fromHkcu = registryValue("HKCU\\Software\\Valve\\Steam", "SteamPath");
  if (fromHkcu) roots.add(fromHkcu.replace(/\//g, "\\"));
  const fromHklm = registryValue("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath");
  if (fromHklm) roots.add(fromHklm.replace(/\//g, "\\"));
  roots.add(path.join(PROGRAM_FILES_X86, "Steam"));
  roots.add(path.join(PROGRAM_FILES, "Steam"));
  return [...roots];
}

async function steamLibraryRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const steamRoot of steamInstallRoots()) {
    const vdf = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
    let text: string;
    try {
      text = await fs.readFile(vdf, "utf8");
    } catch {
      continue;
    }
    roots.add(steamRoot);
    for (const match of text.matchAll(/"path"\s*"([^"]+)"/g)) {
      // VDF escapes backslashes ("D:\\steam"); normalize both forms.
      roots.add(match[1].replace(/\\\\/g, "\\"));
    }
  }
  return [...roots];
}

async function projectToolCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const override = process.env.GAMEMAKER_PROJECT_TOOL;
  if (override) candidates.push(override);

  candidates.push(path.join(PROGRAM_FILES, "GameMaker", PROJECT_TOOL_RELATIVE));
  candidates.push(path.join(PROGRAM_FILES_X86, "GameMaker", PROJECT_TOOL_RELATIVE));
  candidates.push(path.join(PROGRAM_FILES, "GameMaker Studio 2", PROJECT_TOOL_RELATIVE));

  for (const root of await steamLibraryRoots()) {
    candidates.push(
      path.join(root, "steamapps", "common", "GameMaker Studio 2", PROJECT_TOOL_RELATIVE)
    );
  }
  return candidates;
}

async function runtimeJsonCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const override = process.env.GAMEMAKER_RUNTIME_JSON;
  if (override) candidates.push(override);

  candidates.push(path.join(PROGRAM_DATA, "GameMakerStudio2", "runtime.json"));

  // Per-channel ProgramData folders: GameMakerStudio2, GameMakerStudio2-LTS,
  // GameMakerStudio2-LTS2026, GameMakerStudio2-Beta, ...
  let entries: string[] = [];
  try {
    entries = await fs.readdir(PROGRAM_DATA);
  } catch {
    entries = [];
  }
  for (const entry of entries.sort().reverse()) {
    if (!entry.startsWith("GameMakerStudio2")) continue;
    candidates.push(path.join(PROGRAM_DATA, entry, "runtime.json"));
  }
  return candidates;
}

/**
 * GameMaker's official headless project validator ships with the IDE
 * install. Explicitly gated to win32 rather than relying on the literal
 * backslash path simply not existing on other platforms -- that happens to
 * work today but is an accident of POSIX treating "\\" as a literal
 * filename character, not a guarantee.
 */
export async function findProjectTool(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  for (const candidate of await projectToolCandidates()) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Locates Igor via whichever runtime GameMaker currently has active
 * (runtime.json's "active" field), rather than a hardcoded version -- the
 * exact runtime differs per machine and changes as GameMaker updates. Null
 * just means no runtime has been downloaded yet (normal on a project that's
 * never been run from the IDE). Also gated to win32: the runtime.json
 * location and the igorPath's "windows/x64" segment below are both
 * Windows-specific, and this project has no Mac/Linux GameMaker install to
 * verify the equivalent paths against -- returning null here rather than
 * guessing an unverified path.
 */
export async function findIgor(): Promise<{ igorPath: string; runtimePath: string } | null> {
  if (process.platform !== "win32") return null;

  for (const runtimeJson of await runtimeJsonCandidates()) {
    if (!(await fileExists(runtimeJson))) continue;

    let manifest: any;
    try {
      manifest = JSON.parse(await fs.readFile(runtimeJson, "utf8"));
    } catch {
      continue;
    }

    const activeVersion: string | undefined = manifest.active;
    const entry: string | undefined = activeVersion ? manifest[activeVersion] : undefined;
    if (!entry) continue;

    // Entry looks like "<runtimePath>&<rss feed url>" -- we only want the path.
    const runtimePath = entry.split("&")[0].replace(/\//g, "\\");
    const igorPath = path.join(runtimePath, "bin", "igor", "windows", "x64", "Igor.exe");
    if (await fileExists(igorPath)) return { igorPath, runtimePath };
  }

  return null;
}
