import { promises as fs } from "fs";
import crypto from "crypto";
import path from "path";
import {
  atomicWriteFile,
  exceedsSnapshotLimits,
  isExcludedFromSnapshot,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_FILE_BYTES,
  SNAPSHOT_MAX_FILES,
  snapshotLimitDetail,
  SnapshotTooLargeError,
} from "./atomic.js";

// Snapshot store for every destructive tool. Everything the server owns lives
// in one dotted directory inside the project:
//
//   <project>/.gm-forge/
//     backups/<YYYYMMDD>-<HHmmss>-<6 hex>/{manifest.json,files/...}
//     lock            # present only while a restore/undo runs
//     journal.jsonl   # append-only audit log
//
// The store is never added to the user's .gitignore automatically -- a server
// that edits a file nobody asked it to edit is exactly what these snapshots
// exist to prevent. If you do not want `.gm-forge/` tracked, add the line
// `.gm-forge/` to your project's .gitignore yourself. Snapshots never include
// the store: the walk skips every dotted directory, so `.gm-forge` (and
// `.git`, `.gamemaker-mcp`, `.opencode`) can never contain itself.
//
// Dedupe: hard-linking an unchanged file from the previous snapshot is safe
// while *every* write replaces the inode (temp + rename) rather than truncating
// it, because a link shares one inode. That invariant now holds for every
// project file -- writers go through atomicWriteFile/atomicWriteJson, imported
// assets through atomicCopyFile, the .yyp through atomicReplaceWith, snapshots
// themselves are immutable and a restore replaces inodes too -- so link mode is
// on. `test/verify.ts` pins it: a snapshot, an atomic write over a file it
// recorded, and a restore must return the pre-write bytes (a shared inode would
// have been clobbered). A filesystem that cannot hard-link (EXDEV, FAT/exFAT,
// EMLINK, antivirus) falls back to a copy per file, and each manifest records
// which mode the snapshot used.

export const SNAPSHOT_KEEP = 20;
export { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_FILE_BYTES, SNAPSHOT_MAX_FILES };
export const DEDUPE_MODE: "copy" | "link" = "link";

const STORE_DIR_NAME = ".gm-forge";
const SNAPSHOT_ID_RE = /^\d{8}-\d{6}-[a-f0-9]{6}$/;
const MANIFEST_NAME = "manifest.json";
const FILES_DIR_NAME = "files";

export interface SnapshotSkip {
  path: string;
  reason: "size" | "symlink";
}

export interface SnapshotFileEntry {
  path: string;
  size: number;
  sha256: string;
  mtimeMs: number;
  stored: "link" | "copy";
}

export interface SnapshotManifest {
  id: string;
  schema: 1;
  createdAt: string;
  tool: string | null;
  reason: string | null;
  projectName: string;
  previous: string | null;
  // Which dedupe this snapshot actually used. "copy" means every file was
  // written fresh; "link" means unchanged files were hard-linked from
  // `previous` (a per-file fallback to copy still happens when a filesystem or
  // antivirus refuses the link, and `stored` on each entry records which).
  dedupe: "copy" | "link";
  files: SnapshotFileEntry[];
  touched: string[];
  skipped: SnapshotSkip[];
  fileCount: number;
  totalBytes: number;
  failed: boolean;
  undoneAt: string | null;
}

export interface CreateSnapshotOptions {
  reason?: string;
  tool?: string;
  touched?: string[];
  // "throw" is what an explicit create_snapshot call needs: the caller believes
  // it has a backup, so a silent partial one would be a lie. The automatic path
  // passes "skip" -- blocking every write tool on a 30,000-file project is worse
  // than writing without a backup, as long as it says so.
  onOverThreshold?: "throw" | "skip";
}

export interface CreateSnapshotResult {
  snapshotId: string | null;
  path: string | null;
  fileCount: number;
  totalBytes: number;
  copied: number;
  linked: number;
  skipped: SnapshotSkip[];
  pruned: string[];
  warnings: string[];
}

export interface SnapshotSummary {
  snapshotId: string;
  createdAt: string | null;
  tool: string | null;
  reason: string | null;
  fileCount: number;
  totalBytes: number;
  failed: boolean;
  undoneAt: string | null;
}

export interface CorruptSnapshotSummary {
  snapshotId: string;
  corrupt: true;
  error: string;
}

export interface ListSnapshotsResult {
  snapshots: Array<SnapshotSummary | CorruptSnapshotSummary>;
  totalBytes: number;
  keep: number;
}

export interface RestoreSnapshotOptions {
  snapshotId: string;
  files?: string[];
}

export interface RestoreSnapshotResult {
  snapshotId: string;
  restored: string[];
  missingFromSnapshot: string[];
  removed: string[];
  bytes: number;
  lockCleared: true;
}

export interface DeleteSnapshotResult {
  snapshotId: string;
  deleted: true;
  freedBytes: number;
}

export interface UndoResult {
  snapshotId: string;
  restored: string[];
  removed: string[];
  undoneAt: string;
  // Entries the snapshot could not store (over the size cap, or a symlink) that
  // are absent from disk after the undo: they cannot be brought back. Empty in
  // the normal case.
  skippedNotRestored: string[];
}

export interface SnapshotChange {
  path: string;
  status: "modified" | "added" | "deleted";
  sizeDelta?: number;
}

export interface SnapshotDiff {
  files: SnapshotChange[];
  unchangedCount: number;
  untrackedCount: number;
}

export interface WalkEntry {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

export interface WalkResult {
  files: WalkEntry[];
  skipped: SnapshotSkip[];
  totalBytes: number;
}

export function storeDir(projectDir: string): string {
  return path.join(path.resolve(projectDir), STORE_DIR_NAME);
}

export function backupsDir(projectDir: string): string {
  return path.join(storeDir(projectDir), "backups");
}

export function snapshotDir(projectDir: string, snapshotId: string): string {
  assertSnapshotId(snapshotId);
  const resolved = path.join(backupsDir(projectDir), snapshotId);
  // Ids come from a model, so "../.." must never reach path.join's output.
  if (path.dirname(resolved) !== path.resolve(backupsDir(projectDir))) {
    throw new Error(`Invalid snapshot id "${snapshotId}" -- it does not resolve inside ${backupsDir(projectDir)}`);
  }
  return resolved;
}

export function lockFile(projectDir: string): string {
  return path.join(storeDir(projectDir), "lock");
}

function journalFile(projectDir: string): string {
  return path.join(storeDir(projectDir), "journal.jsonl");
}

export function assertSnapshotId(snapshotId: string): void {
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_RE.test(snapshotId)) {
    throw new Error(
      `Invalid snapshot id "${String(snapshotId)}" -- expected <YYYYMMDD>-<HHmmss>-<6 hex>, e.g. 20261113-142501-a3f9c1 (use list_snapshots to see the ids that exist)`
    );
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch (e: any) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

function isInside(root: string, target: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const r = norm(root).replace(/[\\/]+$/, "");
  const t = norm(target);
  return t === r || t.startsWith(r + path.sep);
}

// realpath that tolerates a target that does not exist yet: the deepest
// existing ancestor is resolved and the missing tail re-appended. Symlinks in
// the middle of the path are still resolved, which is the whole point.
async function realpathAllowMissing(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (e: any) {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await realpathAllowMissing(parent), path.basename(target));
  }
}

/**
 * Every path-taking tool funnels through this. Containment is realpath-based,
 * never string-based: a symlink *inside* the project that points outside it
 * passes every lexical check (no ".." involved) and fails this one.
 */
export async function resolveInProject(projectDir: string, requested: string): Promise<string> {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new Error("path is required");
  }
  if (path.isAbsolute(requested) || /^[A-Za-z]:/.test(requested) || /^[\\/]/.test(requested)) {
    throw new Error(`Refusing absolute path "${requested}" -- paths are project-relative (project root: ${path.resolve(projectDir)})`);
  }
  const root = await fs.realpath(path.resolve(projectDir));
  const lexical = path.resolve(root, requested);
  const target = await realpathAllowMissing(lexical);
  if (!isInside(root, target)) {
    throw new Error(`Refusing "${requested}": it resolves to ${target}, outside the project ${root}`);
  }
  return target;
}

function isTempFileName(name: string): boolean {
  return name.includes(".tmp-");
}

// Excluded from every snapshot: dotted directories (the store itself, .git,
// .gamemaker-mcp, .opencode), node_modules, dist, interrupted-write temps and
// anything over the per-file cap. Symlinks are not followed at all -- the walk
// must not be able to reach outside the project.
async function walkProject(projectDir: string): Promise<WalkResult> {
  const files: WalkEntry[] = [];
  const skipped: SnapshotSkip[] = [];
  let totalBytes = 0;

  const visit = async (absDir: string, relDir: string): Promise<void> => {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedFromSnapshot(rel)) continue;
        await visit(abs, rel);
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "symlink" });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedFromSnapshot(rel)) continue;
      if (isTempFileName(entry.name)) continue;
      const stat = await fs.stat(abs);
      if (stat.size > SNAPSHOT_MAX_FILE_BYTES) {
        skipped.push({ path: rel, reason: "size" });
        continue;
      }
      files.push({ rel, abs, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      totalBytes += stat.size;
    }
  };

  await visit(path.resolve(projectDir), "");
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped, totalBytes };
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function newSnapshotId(now: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

// Restores go through atomicWriteFile (temp in the target's own directory +
// rename), so there is one implementation of an atomic replace and one
// locked-file message in the tree -- the one in atomic.ts.
async function atomicReplace(dest: string, data: Buffer): Promise<void> {
  await atomicWriteFile(dest, data);
}

interface LockInfo {
  raw: string;
  pid: string;
  ageSeconds: number;
}

async function readLock(projectDir: string): Promise<LockInfo | null> {
  const file = lockFile(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  let ago = 0;
  try {
    const stat = await fs.stat(file);
    ago = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000));
  } catch {
    ago = 0;
  }
  let pid = "unknown";
  try {
    pid = String(JSON.parse(raw)?.pid ?? "unknown");
  } catch {
    pid = "unparseable";
  }
  return { raw, pid, ageSeconds: ago };
}

async function assertNoLock(projectDir: string, action: string): Promise<void> {
  const lock = await readLock(projectDir);
  if (!lock) return;
  const file = lockFile(projectDir);
  throw new Error(
    `Cannot ${action} while a restore is in progress: ${file} exists (pid ${lock.pid}, written ${lock.ageSeconds}s ago). ` +
      `Delete it ONLY if no restore is still running -- a restore that crashed leaves it behind precisely so a half-restored project is not silently overwritten. ` +
      `It is never removed automatically. Destructive tools still run with skipSnapshot: true, because that skips this snapshot step entirely.`
  );
}

async function acquireLock(projectDir: string, action: string): Promise<void> {
  await assertNoLock(projectDir, action);
  await fs.mkdir(storeDir(projectDir), { recursive: true });
  const file = lockFile(projectDir);
  try {
    // "wx" -- never clobber another instance's lock.
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      await assertNoLock(projectDir, action);
    }
    throw e;
  }
}

async function releaseLock(projectDir: string): Promise<void> {
  await fs.rm(lockFile(projectDir), { force: true }).catch(() => {});
}

// The journal is an audit aid, never a correctness dependency: a failed append
// must not fail an otherwise complete restore.
async function appendJournal(projectDir: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(storeDir(projectDir), { recursive: true });
    await fs.appendFile(journalFile(projectDir), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    /* audit only */
  }
}

async function listSnapshotIds(projectDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(backupsDir(projectDir), { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((e) => e.isDirectory() && SNAPSHOT_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

export async function readManifest(projectDir: string, snapshotId: string): Promise<SnapshotManifest> {
  const dir = snapshotDir(projectDir, snapshotId);
  const file = path.join(dir, MANIFEST_NAME);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(`Snapshot ${snapshotId} not found in ${backupsDir(projectDir)}`);
    }
    throw new Error(`Could not read snapshot ${snapshotId} manifest at ${file}: ${e.message}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Snapshot ${snapshotId} has a corrupt manifest at ${file}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
    throw new Error(`Snapshot ${snapshotId} has a corrupt manifest at ${file}: expected a "files" array`);
  }
  return {
    id: typeof parsed.id === "string" ? parsed.id : snapshotId,
    schema: 1,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    tool: typeof parsed.tool === "string" ? parsed.tool : null,
    reason: typeof parsed.reason === "string" ? parsed.reason : null,
    projectName: typeof parsed.projectName === "string" ? parsed.projectName : "",
    previous: typeof parsed.previous === "string" ? parsed.previous : null,
    dedupe: parsed.dedupe === "link" ? "link" : "copy",
    files: parsed.files,
    touched: Array.isArray(parsed.touched) ? parsed.touched : [],
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    fileCount: typeof parsed.fileCount === "number" ? parsed.fileCount : parsed.files.length,
    totalBytes: typeof parsed.totalBytes === "number" ? parsed.totalBytes : 0,
    failed: parsed.failed === true,
    undoneAt: typeof parsed.undoneAt === "string" ? parsed.undoneAt : null,
  };
}

async function writeManifest(projectDir: string, manifest: SnapshotManifest): Promise<void> {
  const dir = snapshotDir(projectDir, manifest.id);
  const file = path.join(dir, MANIFEST_NAME);
  await atomicWriteFile(file, JSON.stringify(manifest, null, 2));
}

// Newest first. A corrupt manifest must not be silently invisible -- it is
// listed with `corrupt: true`, and sorted last so `latestSnapshot` still finds
// a usable snapshot.
async function readAllManifests(
  projectDir: string
): Promise<Array<{ id: string; manifest?: SnapshotManifest; error?: string }>> {
  const ids = await listSnapshotIds(projectDir);
  const out: Array<{ id: string; manifest?: SnapshotManifest; error?: string }> = [];
  for (const id of ids) {
    try {
      out.push({ id, manifest: await readManifest(projectDir, id) });
    } catch (e: any) {
      out.push({ id, error: e?.message ?? String(e) });
    }
  }
  return out;
}

function sortNewestFirst<T extends { id: string; manifest?: SnapshotManifest }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aAt = a.manifest?.createdAt ?? "";
    const bAt = b.manifest?.createdAt ?? "";
    if (aAt !== bAt) return aAt < bAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export async function latestSnapshot(projectDir: string): Promise<SnapshotManifest | null> {
  const all = sortNewestFirst(await readAllManifests(projectDir));
  return all.find((entry) => entry.manifest !== undefined)?.manifest ?? null;
}

export async function listSnapshots(projectDir: string): Promise<ListSnapshotsResult> {
  const all = sortNewestFirst(await readAllManifests(projectDir));
  const snapshots: Array<SnapshotSummary | CorruptSnapshotSummary> = [];
  let totalBytes = 0;
  for (const entry of all) {
    if (!entry.manifest) {
      snapshots.push({ snapshotId: entry.id, corrupt: true, error: entry.error ?? "unreadable manifest" });
      continue;
    }
    const m = entry.manifest;
    totalBytes += m.totalBytes;
    snapshots.push({
      snapshotId: m.id,
      createdAt: m.createdAt || null,
      tool: m.tool,
      reason: m.reason,
      fileCount: m.fileCount,
      totalBytes: m.totalBytes,
      failed: m.failed,
      undoneAt: m.undoneAt,
    });
  }
  return { snapshots, totalBytes, keep: SNAPSHOT_KEEP };
}

async function projectName(projectDir: string): Promise<string> {
  try {
    const entries = await fs.readdir(projectDir);
    const yyp = entries.find((f) => f.endsWith(".yyp"));
    if (yyp) return yyp.slice(0, -".yyp".length);
  } catch {
    /* fall through to the directory name */
  }
  return path.basename(path.resolve(projectDir));
}

// The snapshot undo_last would pick: newest with a non-empty `touched` that has
// not been undone yet. Both delete_snapshot and pruning must leave it alone.
function findUndoTarget(all: Array<{ id: string; manifest?: SnapshotManifest }>): string | null {
  for (const entry of sortNewestFirst(all)) {
    if (entry.manifest && entry.manifest.undoneAt === null && entry.manifest.touched.length > 0) {
      return entry.id;
    }
  }
  return null;
}

async function pruneSnapshots(
  projectDir: string,
  keepId: string,
  undoProtectId: string | null
): Promise<string[]> {
  const all = sortNewestFirst(await readAllManifests(projectDir));
  if (all.length <= SNAPSHOT_KEEP) return [];

  const protectedIds = new Set<string>([keepId]);
  if (undoProtectId) protectedIds.add(undoProtectId);
  // `previous` is deliberately not protected: it only records where a snapshot
  // looked for dedupe, and deleting an old snapshot directory just decrements
  // hard-link counts -- a surviving snapshot keeps its own inode and never loses
  // a byte. Protecting the whole chain instead would stall retention at
  // KEEP + 1 forever, because every surviving snapshot references its
  // predecessor and the predecessor of the oldest survivor is always prunable.

  const pruned: string[] = [];
  for (const entry of all.slice(SNAPSHOT_KEEP)) {
    if (protectedIds.has(entry.id)) continue;
    try {
      await fs.rm(snapshotDir(projectDir, entry.id), { recursive: true, force: false });
      pruned.push(entry.id);
    } catch {
      // Retention is housekeeping: failing to delete an old snapshot must not
      // fail the snapshot that was just taken.
    }
  }
  return pruned;
}

export async function createSnapshot(
  projectDir: string,
  options: CreateSnapshotOptions = {}
): Promise<CreateSnapshotResult> {
  const root = path.resolve(projectDir);
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (e: any) {
    throw new Error(`Cannot snapshot ${root}: ${e?.code === "ENOENT" ? "no such directory" : e.message}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Cannot snapshot ${root}: not a directory`);
  }

  await assertNoLock(projectDir, "create a snapshot");

  const walk = await walkProject(projectDir);
  const warnings: string[] = [];
  const storeExisted = await pathExists(storeDir(projectDir));

  if (exceedsSnapshotLimits(walk.files.length, walk.totalBytes)) {
    const detail = snapshotLimitDetail(walk.files.length, walk.totalBytes);
    if (options.onOverThreshold === "skip") {
      return {
        snapshotId: null,
        path: null,
        fileCount: walk.files.length,
        totalBytes: walk.totalBytes,
        copied: 0,
        linked: 0,
        skipped: walk.skipped,
        pruned: [],
        warnings: [`snapshot skipped: ${detail}. The write proceeded without a backup.`],
      };
    }
    throw new SnapshotTooLargeError(walk.files.length, walk.totalBytes);
  }

  const previous = await latestSnapshot(projectDir);
  const previousByPath = new Map<string, SnapshotFileEntry>();
  for (const entry of previous?.files ?? []) previousByPath.set(entry.path, entry);

  // Exclusive mkdir: a snapshot directory is created once and never written
  // into afterwards by anyone else.
  await fs.mkdir(backupsDir(projectDir), { recursive: true });
  let id = newSnapshotId();
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(path.join(backupsDir(projectDir), id), { recursive: false });
      break;
    } catch (e: any) {
      if (e?.code === "EEXIST" && attempt < 5) {
        id = newSnapshotId();
        continue;
      }
      throw e;
    }
  }
  const dir = path.join(backupsDir(projectDir), id);
  const filesDir = path.join(dir, FILES_DIR_NAME);

  const entries: SnapshotFileEntry[] = [];
  let copied = 0;
  let linked = 0;
  let totalBytes = 0;

  // The digest is what link dedupe compares and what a restore verifies, so it
  // is only skipped when neither needs it: copy mode with no previous snapshot
  // records size+mtime only (the next snapshot of the same project has a
  // `previous` again and hashes everything). With DEDUPE_MODE === "link" the
  // digest is always computed.
  const needDigest = DEDUPE_MODE === "link" || previous !== null;

  try {
    await fs.mkdir(filesDir, { recursive: true });
    for (const file of walk.files) {
      const dest = path.join(filesDir, ...file.rel.split("/"));
      const prior = previousByPath.get(file.rel);

      if (DEDUPE_MODE === "link" && prior && prior.sha256) {
        // The digest has to come from this file's current bytes, so it is read
        // once and the same buffer either proves the link is valid or is what
        // gets copied.
        const buf = await fs.readFile(file.abs);
        const digest = sha256(buf);
        if (prior.sha256 === digest && prior.size === file.size) {
          const priorStored = path.join(backupsDir(projectDir), previous!.id, FILES_DIR_NAME, ...prior.path.split("/"));
          try {
            await fs.link(priorStored, dest);
            linked++;
            totalBytes += buf.length;
            entries.push({ path: file.rel, size: buf.length, sha256: digest, mtimeMs: file.mtimeMs, stored: "link" });
            continue;
          } catch (e: any) {
            // Different volume (EXDEV), FAT/exFAT (EPERM), too many links
            // (EMLINK), antivirus holding the inode (EACCES): a snapshot must
            // never fail because linking is unavailable -- the copy below is
            // the fallback and `stored` records it.
            if (!["EPERM", "EXDEV", "EMLINK", "EACCES", "ENOENT"].includes(e?.code)) throw e;
          }
        }
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        copied++;
        totalBytes += buf.length;
        entries.push({ path: file.rel, size: buf.length, sha256: digest, mtimeMs: file.mtimeMs, stored: "copy" });
        continue;
      }

      // One read per project file: the hash and the stored copy come from the
      // same buffer, so the manifest always describes what was written.
      const buf = await fs.readFile(file.abs);
      const digest = needDigest ? sha256(buf) : "";
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
      copied++;
      totalBytes += buf.length;
      entries.push({ path: file.rel, size: buf.length, sha256: digest, mtimeMs: file.mtimeMs, stored: "copy" });
    }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  const now = new Date();
  const manifest: SnapshotManifest = {
    id,
    schema: 1,
    createdAt: now.toISOString(),
    tool: options.tool ?? null,
    reason: options.reason ? options.reason.slice(0, 500) : null,
    projectName: await projectName(projectDir),
    previous: previous?.id ?? null,
    dedupe: DEDUPE_MODE,
    files: entries,
    touched: options.touched ?? [],
    skipped: walk.skipped,
    fileCount: entries.length,
    totalBytes,
    failed: false,
    undoneAt: null,
  };
  await writeManifest(projectDir, manifest);

  const undoTarget = findUndoTarget(await readAllManifests(projectDir));
  const pruned = await pruneSnapshots(projectDir, id, undoTarget);

  if (!storeExisted && (await pathExists(path.join(projectDir, ".git")))) {
    warnings.push(
      `created the snapshot store at ${storeDir(projectDir)} inside a git repository -- add ".gm-forge/" to .gitignore if you don't want backups committed`
    );
  }

  await appendJournal(projectDir, {
    op: "create",
    snapshotId: id,
    tool: manifest.tool,
    fileCount: entries.length,
    totalBytes,
    copied,
    linked,
    pruned,
  });

  return {
    snapshotId: id,
    path: dir,
    fileCount: entries.length,
    totalBytes,
    copied,
    linked,
    skipped: walk.skipped,
    pruned,
    warnings,
  };
}

/**
 * Merge a patch into an existing manifest. Only manifest.json is rewritten
 * (atomically); the files/ tree is never touched, which is what keeps
 * hard-link dedupe safe.
 */
export async function updateManifest(
  projectDir: string,
  snapshotId: string,
  patch: Partial<Pick<SnapshotManifest, "touched" | "failed" | "undoneAt" | "reason" | "tool">>
): Promise<SnapshotManifest> {
  const manifest = await readManifest(projectDir, snapshotId);
  const next: SnapshotManifest = {
    ...manifest,
    ...patch,
    id: manifest.id,
    files: manifest.files,
    skipped: manifest.skipped,
  };
  await writeManifest(projectDir, next);
  return next;
}

/**
 * Remove a snapshot directory without the undo-target protection that
 * delete_snapshot applies. Only for the auto-hook's "the operation changed
 * nothing, so the snapshot it just took is pointless" case.
 */
export async function discardSnapshot(projectDir: string, snapshotId: string): Promise<boolean> {
  const dir = snapshotDir(projectDir, snapshotId);
  if (!(await pathExists(dir))) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

async function readStoredFile(projectDir: string, manifest: SnapshotManifest, entry: SnapshotFileEntry): Promise<Buffer> {
  const stored = path.join(backupsDir(projectDir), manifest.id, FILES_DIR_NAME, ...entry.path.split("/"));
  try {
    return await fs.readFile(stored);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(
        `Snapshot ${manifest.id} is incomplete: ${entry.path} is missing from ${path.join(backupsDir(projectDir), manifest.id, FILES_DIR_NAME)} -- refusing to restore a partial snapshot`
      );
    }
    throw new Error(`Could not read ${entry.path} from snapshot ${manifest.id}: ${e.message}`);
  }
}

function assertRestorablePath(requested: string): void {
  const segments = requested.split("/");
  if (segments.some((s) => s === ".." || s === "" || s === ".")) {
    throw new Error(`Refusing to restore "${requested}": the manifest path is not a normal project-relative path`);
  }
  if (isExcludedFromSnapshot(requested) || isTempFileName(segments[segments.length - 1])) {
    throw new Error(
      `Refusing to restore "${requested}": it lives in an excluded directory (dotted, node_modules or dist) or is an interrupted-write temp -- snapshots never contain those`
    );
  }
}

// Verify every stored byte before replacing anything: a corrupted snapshot
// must fail loudly, never half-restore. An entry with no recorded digest (copy
// mode, first snapshot in a project -- see `needDigest` in createSnapshot) can
// only be checked for size.
async function verifyStoredFiles(
  projectDir: string,
  manifest: SnapshotManifest,
  paths: string[]
): Promise<void> {
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const bad: string[] = [];
  for (const rel of paths) {
    const entry = byPath.get(rel)!;
    const buf = await readStoredFile(projectDir, manifest, entry);
    if (!entry.sha256) {
      if (buf.length !== entry.size) {
        bad.push(`${rel} (stored ${buf.length} bytes, manifest ${entry.size}; no digest was recorded)`);
      }
      continue;
    }
    const digest = sha256(buf);
    if (digest !== entry.sha256) {
      bad.push(`${rel} (stored ${digest.slice(0, 12)}..., manifest ${entry.sha256.slice(0, 12)}...)`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `Snapshot ${manifest.id} is corrupted -- ${bad.length} file(s) do not match their recorded sha256: ${bad.join(", ")}. Nothing was restored.`
    );
  }
}

interface FileRestoreSummary {
  restored: string[];
  removed: string[];
  bytes: number;
}

async function restoreFiles(
  projectDir: string,
  manifest: SnapshotManifest,
  paths: string[],
  deleteWhenAbsent: Set<string>
): Promise<FileRestoreSummary> {
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const restored: string[] = [];
  const removed: string[] = [];
  const replaced: Array<{ rel: string; target: string; before: Buffer | null }> = [];
  let bytes = 0;

  for (const rel of paths) {
    const entry = byPath.get(rel);
    if (!entry || deleteWhenAbsent.has(rel)) {
      // The operation created this file, so undo removes it rather than
      // restoring it to emptiness.
      const target = await resolveInProject(projectDir, rel);
      assertRestorablePath(rel);
      let live = true;
      try {
        const stat = await fs.stat(target);
        if (stat.isDirectory()) {
          throw new Error(`Refusing to remove ${target}: it is a directory, not a file`);
        }
      } catch (e: any) {
        if (e?.code === "ENOENT") live = false;
        else throw e;
      }
      if (live) {
        try {
          await fs.rm(target, { force: true });
          removed.push(rel);
        } catch (e: any) {
          if (e?.code === "EPERM" || e?.code === "EACCES") {
            const mixed = await rollbackRestored(replaced);
            throw new Error(
              `Could not remove ${target}: ${e.code} -- the file is locked by another program. Close the game/project in GameMaker (or wait for the antivirus scan) and retry. (${e.message})` +
                mixed
            );
          }
          throw e;
        }
      }
      continue;
    }

    const target = await resolveInProject(projectDir, rel);
    assertRestorablePath(rel);
    const buf = await readStoredFile(projectDir, manifest, entry);
    if (entry.sha256 && sha256(buf) !== entry.sha256) {
      const mixed = await rollbackRestored(replaced);
      throw new Error(`Snapshot ${manifest.id} is corrupted: ${rel} does not match its recorded sha256.` + mixed);
    }
    // Keep the bytes this restore is about to replace: an EPERM halfway through
    // must not leave a tree that is half old and half new with no way back.
    const before = await fs.readFile(target).catch((e: any) => (e?.code === "ENOENT" ? null : Promise.reject(e)));
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await atomicReplace(target, buf);
    } catch (e: any) {
      const mixed = await rollbackRestored(replaced);
      throw new Error(
        `Restore failed after ${restored.length} of ${paths.length} files: ${rel}: ${e?.message ?? String(e)}.` +
          mixed
      );
    }
    replaced.push({ rel, target, before });
    restored.push(rel);
    bytes += buf.length;
  }

  return { restored, removed, bytes };
}

// Best-effort reversal of the files this restore already replaced. Every write
// here goes back through the atomic helper, so a rollback can itself fail (the
// same lock, the same disk); the message says which files are in which state
// rather than pretending the tree is consistent.
async function rollbackRestored(
  replaced: Array<{ rel: string; target: string; before: Buffer | null }>
): Promise<string> {
  if (replaced.length === 0) {
    return " No files had been replaced yet, so the project is unchanged.";
  }
  const failed: string[] = [];
  for (const entry of replaced) {
    try {
      if (entry.before === null) await fs.rm(entry.target, { force: true });
      else await atomicReplace(entry.target, entry.before);
    } catch (e: any) {
      failed.push(`${entry.rel} (${e?.message ?? String(e)})`);
    }
  }
  if (failed.length === 0) {
    return ` Rolled back the ${replaced.length} file(s) already replaced (${replaced.map((r) => r.rel).join(", ")}), so the project is back to its pre-restore state.`;
  }
  return (
    ` Rollback also failed for ${failed.length} file(s): ${failed.join("; ")}. ` +
    `The project tree is MIXED -- re-run the restore (or restore the same snapshot again) once the lock is gone, and check those files by hand.`
  );
}

// Resolve a requested subset against the manifest, all-or-nothing: unknown
// paths are refused together so the caller fixes them in one round trip.
function selectRestorePaths(manifest: SnapshotManifest, requested?: string[]): { paths: string[]; missing: string[] } {
  const known = new Set(manifest.files.map((f) => f.path));
  const skipped = new Set(manifest.skipped.map((s) => s.path));
  if (!requested || requested.length === 0) {
    return { paths: manifest.files.map((f) => f.path), missing: [] };
  }
  const unknown: string[] = [];
  const paths: string[] = [];
  const missing: string[] = [];
  for (const raw of requested) {
    const rel = String(raw).replace(/\\/g, "/");
    if (known.has(rel)) paths.push(rel);
    else if (skipped.has(rel)) missing.push(rel);
    else unknown.push(rel);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Snapshot ${manifest.id} does not contain ${unknown.length === 1 ? "this path" : "these paths"}: ${unknown.join(", ")}. Nothing was restored.`
    );
  }
  return { paths: [...new Set(paths)], missing };
}

export async function restoreSnapshot(
  projectDir: string,
  options: RestoreSnapshotOptions
): Promise<RestoreSnapshotResult> {
  const manifest = await readManifest(projectDir, options.snapshotId);
  await assertNoLock(projectDir, "restore a snapshot");
  const { paths, missing } = selectRestorePaths(manifest, options.files);

  // Pre-write containment check: every target must resolve inside the project.
  for (const rel of paths) {
    assertRestorablePath(rel);
    await resolveInProject(projectDir, rel);
  }
  await verifyStoredFiles(projectDir, manifest, paths);

  await acquireLock(projectDir, "restore a snapshot");
  let summary: FileRestoreSummary;
  try {
    summary = await restoreFiles(projectDir, manifest, paths, new Set());
  } finally {
    await releaseLock(projectDir);
  }

  await appendJournal(projectDir, {
    op: "restore",
    snapshotId: manifest.id,
    restored: summary.restored.length,
    removed: summary.removed.length,
    bytes: summary.bytes,
  });

  return {
    snapshotId: manifest.id,
    restored: summary.restored,
    missingFromSnapshot: missing,
    removed: summary.removed,
    bytes: summary.bytes,
    lockCleared: true,
  };
}

export async function deleteSnapshot(projectDir: string, snapshotId: string): Promise<DeleteSnapshotResult> {
  const dir = snapshotDir(projectDir, snapshotId);
  await assertNoLock(projectDir, "delete a snapshot");
  if (!(await pathExists(dir))) {
    throw new Error(`Snapshot ${snapshotId} not found in ${backupsDir(projectDir)}`);
  }
  const undoTarget = findUndoTarget(await readAllManifests(projectDir));
  if (undoTarget === snapshotId) {
    throw new Error(
      `Snapshot ${snapshotId} is the one undo_last would restore -- deleting it would throw away the undo point. Create a newer snapshot first, then delete this one.`
    );
  }

  let freedBytes = 0;
  try {
    freedBytes = (await readManifest(projectDir, snapshotId)).totalBytes;
  } catch {
    // A corrupt manifest still gets deleted; there is just no logical size to report.
    freedBytes = 0;
  }

  await fs.rm(dir, { recursive: true, force: false });
  await appendJournal(projectDir, { op: "delete", snapshotId, freedBytes });
  return { snapshotId, deleted: true, freedBytes };
}

export async function undoLast(projectDir: string): Promise<UndoResult> {
  await assertNoLock(projectDir, "undo the last operation");
  const all = sortNewestFirst(await readAllManifests(projectDir));
  const target = all.find((entry) => entry.manifest && entry.manifest.undoneAt === null && entry.manifest.touched.length > 0);

  if (!target?.manifest) {
    throw new Error(`nothing to undo in ${path.resolve(projectDir)} -- no snapshot records touched files`);
  }
  const manifest = target.manifest;

  const liveInSnapshot = new Set(manifest.files.map((f) => f.path));
  const toRestore = manifest.touched.filter((rel) => liveInSnapshot.has(rel));
  const toRemove = manifest.touched.filter((rel) => !liveInSnapshot.has(rel));

  for (const rel of manifest.touched) {
    assertRestorablePath(rel);
    await resolveInProject(projectDir, rel);
  }
  await verifyStoredFiles(projectDir, manifest, toRestore);

  await acquireLock(projectDir, "undo the last operation");
  let summary: FileRestoreSummary;
  try {
    summary = await restoreFiles(projectDir, manifest, manifest.touched, new Set(toRemove));
  } finally {
    await releaseLock(projectDir);
  }

  const undoneAt = new Date().toISOString();
  await updateManifest(projectDir, manifest.id, { undoneAt });

  // Files the snapshot could not store (over the 8 MiB per-file cap, or a
  // symlink) are gone for good if the operation deleted them. Reporting plain
  // success would read as "everything came back".
  const skippedNotRestored: string[] = [];
  for (const skipped of manifest.skipped) {
    const target = await resolveInProject(projectDir, skipped.path).catch(() => null);
    if (!target) continue;
    const present = await pathExists(target).catch(() => false);
    if (!present) skippedNotRestored.push(skipped.path);
  }

  await appendJournal(projectDir, {
    op: "undo",
    snapshotId: manifest.id,
    restored: summary.restored.length,
    removed: summary.removed.length,
    skippedNotRestored: skippedNotRestored.length,
  });

  return {
    snapshotId: manifest.id,
    restored: summary.restored,
    removed: summary.removed,
    undoneAt,
    skippedNotRestored,
  };
}

/**
 * What a `list_changes` call reports: the project tree against the newest
 * snapshot. A file whose size and mtime both match is never read -- anything
 * else is hashed, and the hash (not the mtime) decides, because antivirus
 * scans and IDE saves churn mtimes and a false "modified" is noise while a
 * false "unchanged" is a lie.
 *
 * `rehashSinceMs` exists for the auto-snapshot hook's "did this call change
 * anything?" decision, not for list_changes. A coarse-timestamp filesystem (FAT
 * rounds to 2 s) can hand back the same size AND the same mtime for a real
 * write, and a no-op that discards the backup of a real write is the one error
 * this feature must never make -- so any file modified at or after
 * `rehashSinceMs` is hashed even when the fast path says unchanged.
 */
export interface DiffOptions {
  rehashSinceMs?: number;
}

export async function diffAgainstSnapshot(
  projectDir: string,
  manifest: SnapshotManifest,
  opts: DiffOptions = {}
): Promise<SnapshotDiff> {
  const walk = await walkProject(projectDir);
  const recorded = new Map(manifest.files.map((f) => [f.path, f]));
  const livePaths = new Set<string>();
  const files: SnapshotChange[] = [];
  let unchangedCount = 0;

  for (const file of walk.files) {
    livePaths.add(file.rel);
    const entry = recorded.get(file.rel);
    if (!entry) {
      files.push({ path: file.rel, status: "added", sizeDelta: file.size });
      continue;
    }
    const fastPathSaysUnchanged = entry.size === file.size && entry.mtimeMs === file.mtimeMs;
    const suspicious =
      opts.rehashSinceMs !== undefined && file.mtimeMs >= opts.rehashSinceMs;
    if (fastPathSaysUnchanged && !suspicious) {
      unchangedCount++;
      continue;
    }
    if (!entry.sha256) {
      // No digest was recorded (copy mode, first snapshot): size is all there is.
      if (fastPathSaysUnchanged) unchangedCount++;
      else files.push({ path: file.rel, status: "modified", sizeDelta: file.size - entry.size });
      continue;
    }
    const digest = sha256(await fs.readFile(file.abs));
    if (digest === entry.sha256) {
      unchangedCount++;
      continue;
    }
    files.push({ path: file.rel, status: "modified", sizeDelta: file.size - entry.size });
  }

  for (const entry of manifest.files) {
    if (!livePaths.has(entry.path)) {
      files.push({ path: entry.path, status: "deleted", sizeDelta: -entry.size });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files,
    unchangedCount,
    untrackedCount: walk.skipped.filter((s) => s.reason === "size").length,
  };
}
