import { createReadStream, promises as fs } from "fs";
import crypto from "crypto";
import path from "path";

// Snapshot cost bounds. Exported here because the exclusion rule below needs the
// per-file cap, and snapshot.ts re-exports all three so there is one copy of the
// numbers in the tree.
export const SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_MAX_FILES = 20_000;
export const SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist"]);

// Everything a snapshot must not touch, as described in docs/specs/E. A
// dot-prefixed name is either VCS/tool state (`.git`, `.gm-forge`,
// `.gamemaker-mcp`, `.opencode`) or one of our own `.name.tmp-<uuid>`
// half-written files; GameMaker's own project files never start with a dot, so
// one rule covers all of them.
export function isExcludedFromSnapshot(relPath: string, size?: number): boolean {
  const segments = relPath.split(/[\\/]+/).filter(segment => segment.length > 0 && segment !== ".");
  for (const segment of segments) {
    if (segment.startsWith(".")) return true;
    if (EXCLUDED_DIR_NAMES.has(segment.toLowerCase())) return true;
  }
  return size !== undefined && size > SNAPSHOT_MAX_FILE_BYTES;
}

export function exceedsSnapshotLimits(fileCount: number, totalBytes: number): boolean {
  return fileCount > SNAPSHOT_MAX_FILES || totalBytes > SNAPSHOT_MAX_BYTES;
}

function formatSnapshotBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

export function snapshotLimitDetail(fileCount: number, totalBytes: number): string {
  return (
    `project has ${fileCount.toLocaleString("en-US")} files / ${formatSnapshotBytes(totalBytes)}, ` +
    `over the ${SNAPSHOT_MAX_FILES.toLocaleString("en-US")}-file / ${formatSnapshotBytes(SNAPSHOT_MAX_BYTES)} limit`
  );
}

// An explicit create_snapshot must throw over the cap -- the caller believes it
// has a backup. The automatic path catches this and skips the snapshot instead,
// because blocking the write would break every existing tool on a big project.
export class SnapshotTooLargeError extends Error {
  readonly code = "SNAPSHOT_TOO_LARGE";
  readonly fileCount: number;
  readonly totalBytes: number;
  constructor(fileCount: number, totalBytes: number) {
    super(`Refusing to snapshot: ${snapshotLimitDetail(fileCount, totalBytes)}`);
    this.name = "SnapshotTooLargeError";
    this.fileCount = fileCount;
    this.totalBytes = totalBytes;
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
}

// Windows reports a rename over an open file as EPERM/EACCES -- in practice that
// means the IDE (or an antivirus scan) is holding the file open. One message for
// every atomic replace in the tree (project files, snapshots, the .yyp, sprite
// frames and imported audio), so a caller never has to read two variants.
export function describeLockedFile(dest: string, e: any, action = "replace"): Error | null {
  if (e?.code !== "EPERM" && e?.code !== "EACCES") return null;
  return new Error(
    `Could not ${action} ${dest}: ${e.code} -- the file is locked by another program. Close the room in GameMaker (or wait for the antivirus scan) and retry. (${e.message})`
  );
}

/**
 * The one temp-then-rename implementation. The temp file lives in the target's
 * own directory (never another volume, so the rename cannot degrade into a
 * copy) and matches .gitignore's `.*.tmp-*`. It is removed on every failure path;
 * the target is only ever replaced by the rename. `writeTemp` produces the bytes
 * -- a string, a Buffer, a file copy, or @bscotch/yy's own writer (which
 * reconciles key order against the existing file and therefore cannot be
 * expressed as a string).
 */
export async function atomicReplaceWith(
  dest: string,
  writeTemp: (tempPath: string) => Promise<unknown>
): Promise<void> {
  const tempPath = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp-${crypto.randomUUID()}`);
  try {
    await writeTemp(tempPath);
    await fs.rename(tempPath, dest);
  } catch (e: any) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw describeLockedFile(dest, e) ?? e;
  }
}

export async function atomicWriteFile(
  dest: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {}
): Promise<void> {
  await atomicReplaceWith(dest, (tempPath) =>
    typeof data === "string"
      ? fs.writeFile(tempPath, data, { encoding: opts.encoding ?? "utf8" })
      : fs.writeFile(tempPath, data)
  );
}

export async function atomicWriteJson(dest: string, value: unknown): Promise<void> {
  await atomicWriteFile(dest, JSON.stringify(value, null, 2));
}

// Imported assets (sprite frames, .wav/.ogg) are project files too: a crash
// midway through fs.copyFile leaves a truncated image the .yy already points at.
export async function atomicCopyFile(source: string, dest: string): Promise<void> {
  await atomicReplaceWith(dest, (tempPath) => fs.copyFile(source, tempPath));
}

