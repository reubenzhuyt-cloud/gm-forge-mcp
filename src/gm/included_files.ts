import { promises as fs } from "fs";
import path from "path";
import type { Yyp } from "@bscotch/yy";
import { atomicCopyFile } from "./atomic.js";
import { assertSafePathSegment, type SegmentRules } from "./path_safety.js";
import { resolveInProject } from "./snapshot.js";
import { fileExists, loadRawYyp, loadYyp, writeYyp } from "./yyp.js";

// Captured verbatim from the single IncludedFiles entry in
// E:\GMprojects\261103GJ\261103GJ.yyp (GameMaker 2026.0.0.16):
//   {"$GMIncludedFile":"","%Name":"Adobe After Effects 2025.lnk","CopyToMask":-1,
//    "filePath":"datafiles","name":"Adobe After Effects 2025.lnk",
//    "resourceType":"GMIncludedFile","resourceVersion":"2.0"}
// That file has no DataFiles folder node -- included files are not part of the
// asset tree -- so nothing here touches Folders. Yy.write sorts every object's
// keys this way too, which is why this array is both the emission order and the
// pin the tests compare against.
export const INCLUDED_FILE_KEYS = Object.freeze([
  "$GMIncludedFile",
  "%Name",
  "CopyToMask",
  "filePath",
  "name",
  "resourceType",
  "resourceVersion",
] as const);

const CANONICAL_KEYS = new Set<string>(INCLUDED_FILE_KEYS);

// Included files are not asset resources, so yyp.ts's RESOURCE_VERSIONS (one
// entry per resource .yy type) does not cover them.
export const INCLUDED_FILE_RESOURCE_VERSION = "2.0";
const INCLUDED_FILE_RESOURCE_TYPE = "GMIncludedFile";
// -1 = every platform; the captured entry carries no per-platform config.
const COPY_TO_MASK_ALL_PLATFORMS = -1;
const INCLUDED_FILES_DIR = "datafiles";
const MAX_INCLUDED_NAME_LENGTH = 100;

export interface IncludedFileSummary {
  name: string;
  filePath: string;
  resourceType: string;
  resourceVersion: string;
  existsOnDisk: boolean;
  size?: number;
}

export interface ListIncludedFilesResult {
  entries: IncludedFileSummary[];
}

// `skipSnapshot` is deliberately NOT here: add_included_file is a member of
// AUTO_SNAPSHOT_TOOLS, so the dispatch hook reads args.skipSnapshot itself and
// this module never takes a snapshot (it writes the .yyp through writeYyp).
export interface AddIncludedFileOptions {
  sourcePath: string;
  targetName?: string;
  copy?: boolean;
  overwrite?: boolean;
}

export interface AddIncludedFileResult {
  name: string;
  filePath: string;
  copiedTo: string | null;
  added: true;
}

export interface RemoveIncludedFileOptions {
  name: string;
  deleteFile?: boolean;
}

export interface RemoveIncludedFileResult {
  name: string;
  filePath: string;
  removed: true;
  fileDeleted: boolean;
  fileDeletionSkipped?: string;
  directoryRemoved?: boolean;
}

// `name` is a basename and `targetName` a directory segment, both shown as-is
// in the IDE's Included Files panel, so both allow spaces and dots (the
// captured entry is "Adobe After Effects 2025.lnk"). validateResourceName's
// GML-identifier rule does not apply to either -- what has to hold is that
// neither can walk out of datafiles/ and that the name can actually be created
// on the filesystem GameMaker runs on, so Windows' illegal characters and
// reserved device names are refused here rather than surfacing as a raw EINVAL
// from fs.mkdir/fs.copyFile. The rules themselves live in path_safety.ts because
// sprite frame guids are the same kind of value (a name from a file that becomes
// a filename) and must not drift.
const INCLUDED_SEGMENT_RULES: SegmentRules = {
  maxLength: MAX_INCLUDED_NAME_LENGTH,
  separatorHint: `a separator would place the file outside ${INCLUDED_FILES_DIR}/`,
  illegalCharsHint: "GameMaker ships data files on Windows",
  reservedHint: "the file could not be created on Windows",
};

function assertSafeSegment(value: string, what: string): void {
  assertSafePathSegment(value, what, INCLUDED_SEGMENT_RULES);
}

// Both filePath and name are emitted with forward slashes, matching every
// captured .yyp; on-disk casing is preserved so a case-sensitive target still
// resolves the file.
function posixJoin(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/");
}

// resolveInProject takes project-relative paths only; a copy: false caller may
// reasonably pass an absolute one, so it is made relative first and the
// containment check still happens there (an outside path becomes "../..." or
// stays absolute on another drive, and both are refused).
function toProjectRelative(projectDir: string, requested: string): string {
  if (!path.isAbsolute(requested)) return requested;
  return path.relative(path.resolve(projectDir), path.resolve(requested));
}

function sameProjectPath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function defaultTargetName(basename: string): string {
  const ext = path.extname(basename);
  const stem = ext.length > 0 ? basename.slice(0, -ext.length) : basename;
  return stem.length > 0 ? stem : basename;
}

// Only the seven captured keys, in the captured order; anything else on the
// entry being replaced is kept as-is (the spec allows extra keys and they must
// survive a write).
function includedFileEntry(name: string, filePath: string, previous?: Record<string, unknown>): any {
  const entry: Record<string, unknown> = {
    "$GMIncludedFile": "",
    "%Name": name,
    CopyToMask: COPY_TO_MASK_ALL_PLATFORMS,
    filePath,
    name,
    resourceType: INCLUDED_FILE_RESOURCE_TYPE,
    resourceVersion: INCLUDED_FILE_RESOURCE_VERSION,
  };
  for (const [key, value] of Object.entries(previous ?? {})) {
    if (!CANONICAL_KEYS.has(key) && value !== undefined) entry[key] = value;
  }
  return entry;
}

function includedEntries(yyp: Yyp): any[] {
  const entries = (yyp as any).IncludedFiles;
  return Array.isArray(entries) ? entries : [];
}

export async function listIncludedFiles(projectDir: string): Promise<ListIncludedFilesResult> {
  const yyp = await loadYyp(projectDir);
  const entries: IncludedFileSummary[] = [];
  for (const entry of includedEntries(yyp)) {
    const name = String(entry?.name ?? "");
    const filePath = String(entry?.filePath ?? "");
    let existsOnDisk = false;
    let size: number | undefined;
    try {
      const stat = await fs.stat(path.join(projectDir, filePath, name));
      if (stat.isFile()) {
        existsOnDisk = true;
        size = stat.size;
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
    }
    entries.push({
      name,
      filePath,
      resourceType: String(entry?.resourceType ?? ""),
      resourceVersion: String(entry?.resourceVersion ?? ""),
      existsOnDisk,
      ...(size === undefined ? {} : { size }),
    });
  }
  return { entries };
}

/**
 * Registers a data file in the .yyp's IncludedFiles. With `copy: true` (the
 * default) the source is copied to `datafiles/<targetName>/<basename>` and that
 * directory becomes the entry's `filePath`; with `copy: false` the file is only
 * registered, and must already live inside the project. Refuses a duplicate
 * name and an occupied destination unless `overwrite: true`.
 */
export async function addIncludedFile(
  projectDir: string,
  options: AddIncludedFileOptions
): Promise<AddIncludedFileResult> {
  const sourcePath = options?.sourcePath;
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
    throw new Error("sourcePath is required");
  }
  const copy = options.copy !== false;

  // A copy source is an import path and may be anywhere (like a sprite's
  // framesDir); copy: false must point at a file the project already owns,
  // because a filePath of "../.." is not legal project data.
  const sourceAbs = copy
    ? path.resolve(projectDir, sourcePath)
    : await resolveInProject(projectDir, toProjectRelative(projectDir, sourcePath));
  let sourceStat;
  try {
    sourceStat = await fs.stat(sourceAbs);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(`sourcePath "${sourcePath}" does not exist (resolved to ${sourceAbs})`);
    }
    throw e;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`sourcePath "${sourcePath}" is not a file (${sourceAbs}) -- add_included_file registers single files`);
  }

  const name = path.basename(sourceAbs);
  assertSafeSegment(name, "Included file name");

  let filePath: string;
  let copiedTo: string | null = null;
  if (copy) {
    const targetName = options.targetName === undefined ? defaultTargetName(name) : options.targetName;
    assertSafeSegment(targetName, "targetName");
    filePath = posixJoin(INCLUDED_FILES_DIR, targetName);
  } else {
    const root = await fs.realpath(path.resolve(projectDir));
    const relDir = path
      .relative(root, path.dirname(sourceAbs))
      .split(path.sep)
      .filter((segment) => segment.length > 0)
      .join("/");
    if (relDir.length === 0 || relDir === ".") {
      throw new Error(
        `sourcePath "${sourcePath}" sits at the project root -- GameMaker 2026.0.0.16 has no captured filePath spelling for a root-level included file, so copy: false refuses it; put the file under ${INCLUDED_FILES_DIR}/ or use copy: true`
      );
    }
    if (relDir.split("/").some((segment) => segment === "..")) {
      throw new Error(`sourcePath "${sourcePath}" does not resolve inside the project`);
    }
    filePath = relDir;
  }

  const yyp = await loadYyp(projectDir);
  const entries = includedEntries(yyp);
  // The typed object cannot carry an entry's unmodelled extra keys (the schema
  // drops them on read), so the entry being replaced is read from the raw file
  // instead. writeYyp only restores $GM*/exportDir, by design.
  const rawIncludedFiles = (await loadRawYyp(projectDir)).parsed?.IncludedFiles;
  const rawEntries: any[] = Array.isArray(rawIncludedFiles) ? rawIncludedFiles : [];
  const existingIndex = entries.findIndex(
    (entry) => String(entry?.name ?? "").toLowerCase() === name.toLowerCase()
  );
  const overwrite = options.overwrite === true;
  if (existingIndex >= 0 && !overwrite) {
    throw new Error(
      `An included file named "${name}" is already registered (filePath "${entries[existingIndex]?.filePath}") -- pass overwrite: true to replace that entry`
    );
  }
  // A different filePath is a different registration: replacing in place would
  // move the entry, drop its unmodelled extra keys and leave the old copy
  // orphaned in datafiles/<old>/. Two explicit calls are the honest path.
  const existingFilePath = existingIndex >= 0 ? String(entries[existingIndex]?.filePath ?? "") : null;
  if (existingFilePath !== null && existingFilePath !== filePath) {
    throw new Error(
      `"${name}" is registered at "${existingFilePath}"; overwriting it as "${filePath}" would move the entry and leave ` +
        `${posixJoin(existingFilePath, name)} orphaned on disk. Call remove_included_file { name: "${name}" } first, then add it again. Nothing was written.`
    );
  }

  if (copy) {
    const relDest = posixJoin(filePath, name);
    // Realpath containment: resolveInProject resolves the deepest existing
    // ancestor, so a junction inside datafiles cannot redirect the copy.
    const destAbs = await resolveInProject(projectDir, relDest);
    if ((await fileExists(destAbs)) && !overwrite) {
      throw new Error(`Refusing to overwrite ${relDest}: the file already exists -- pass overwrite: true to replace it`);
    }
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    // The copy lands before the .yyp is touched: a crash leaves an unreferenced
    // file rather than an entry pointing at nothing.
    await atomicCopyFile(sourceAbs, destAbs);
    copiedTo = relDest;
  }

  const entry = includedFileEntry(
    name,
    filePath,
    existingIndex >= 0 ? rawEntries.find((candidate) => String(candidate?.name ?? "") === name) ?? entries[existingIndex] : undefined
  );
  if (existingIndex >= 0) entries[existingIndex] = entry;
  else entries.push(entry);
  (yyp as any).IncludedFiles = entries;
  await writeYyp(projectDir, yyp);

  return { name, filePath, copiedTo, added: true };
}

/**
 * Unregisters an IncludedFiles entry by name. `deleteFile` defaults to false --
 * unregistering must never silently delete user data -- and when true it also
 * removes the now-empty containing directory under datafiles/. Everything is
 * resolved and checked before the .yyp is written.
 */
export async function removeIncludedFile(
  projectDir: string,
  options: RemoveIncludedFileOptions
): Promise<RemoveIncludedFileResult> {
  const requested = options?.name;
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new Error("name is required");
  }

  const yyp = await loadYyp(projectDir);
  const entries = includedEntries(yyp);
  // Exact spelling first, then a unique case-insensitive match (the name is
  // typed from memory). Two entries whose names differ only in case are two
  // entries: each stays addressable, and the shared-path guard below is what
  // protects the bytes they have in common.
  const exact = entries.filter((entry) => String(entry?.name ?? "") === requested);
  const matches =
    exact.length > 0
      ? exact
      : entries.filter((entry) => String(entry?.name ?? "").toLowerCase() === requested.toLowerCase());
  if (matches.length === 0) {
    const registered = entries.map((entry) => `"${entry?.name}" (${entry?.filePath})`);
    throw new Error(
      registered.length === 0
        ? `No included file named "${requested}" is registered -- IncludedFiles is empty`
        : `No included file named "${requested}" is registered -- registered: ${registered.join(", ")}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `"${requested}" is registered ${matches.length} times (filePath ${matches
        .map((entry) => `"${entry?.filePath}"`)
        .join(", ")}) -- refusing to guess which entry to remove`
    );
  }

  const entry = matches[0];
  const name = String(entry.name ?? "");
  const filePath = String(entry.filePath ?? "");
  const relTarget = posixJoin(filePath, name);

  // Containment first: the .yyp is user-editable, so a filePath of ".." must
  // not turn into a delete outside the project, and the check has to happen
  // before the entry disappears from the manifest.
  const targetAbs = await resolveInProject(projectDir, relTarget);
  const stillReferencedBy = entries
    .filter((other) => other !== entry)
    .map((other) => posixJoin(String(other?.filePath ?? ""), String(other?.name ?? "")))
    .find((otherPath) => sameProjectPath(otherPath, relTarget));

  // Every way the delete can fail is decided BEFORE the manifest is written.
  // Removing the entry and then throwing would report a failed call for a
  // project that did change, and would make the dispatch hook mark that call's
  // snapshot failed:true -- the one backup the caller would want.
  let deletionBlockedBy: string | null = null;
  if (options.deleteFile === true && stillReferencedBy === undefined) {
    try {
      const targetStat = await fs.stat(targetAbs);
      if (targetStat.isDirectory()) {
        deletionBlockedBy = `${relTarget} is a directory -- remove_included_file only deletes files`;
      }
    } catch (e: any) {
      deletionBlockedBy = e?.code === "ENOENT"
        ? `${relTarget} was already missing from disk`
        : `could not inspect ${relTarget} (${e?.message ?? String(e)})`;
    }
  }

  (yyp as any).IncludedFiles = entries.filter((other) => other !== entry);
  await writeYyp(projectDir, yyp);

  const result: RemoveIncludedFileResult = { name, filePath, removed: true, fileDeleted: false };
  if (options.deleteFile !== true) return result;

  if (stillReferencedBy !== undefined) {
    result.fileDeletionSkipped = `another IncludedFiles entry still references ${stillReferencedBy}`;
    return result;
  }
  if (deletionBlockedBy !== null) {
    result.fileDeletionSkipped = deletionBlockedBy;
    return result;
  }

  try {
    await fs.unlink(targetAbs);
  } catch (e: any) {
    const detail = e?.code === "EPERM" || e?.code === "EACCES"
      ? `${e.code} -- the file is locked by another program. Close the game (or wait for the antivirus scan) and retry`
      : e?.message ?? String(e);
    result.fileDeletionSkipped =
      `the entry was removed from the .yyp, but ${relTarget} could not be deleted (${detail}). The file is still on disk and no longer registered`;
    return result;
  }
  result.fileDeleted = true;

  // Only a directory the tool itself would have created: nested under
  // datafiles/, and only when nothing else is left in it.
  const parentRel = process.platform === "win32" ? filePath.toLowerCase() : filePath;
  const datafilesRoot = process.platform === "win32" ? INCLUDED_FILES_DIR.toLowerCase() : INCLUDED_FILES_DIR;
  const underDatafiles =
    parentRel === datafilesRoot || parentRel.startsWith(`${datafilesRoot}/`);
  if (underDatafiles && parentRel !== datafilesRoot) {
    try {
      if ((await fs.readdir(path.dirname(targetAbs))).length === 0) {
        await fs.rmdir(path.dirname(targetAbs));
        result.directoryRemoved = true;
      }
    } catch {
      /* housekeeping only */
    }
  }

  return result;
}
