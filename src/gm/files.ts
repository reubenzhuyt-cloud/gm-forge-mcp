import { promises as fs } from "fs";
import path from "path";
import { diffAgainstSnapshot, latestSnapshot, resolveInProject, storeDir } from "./snapshot.js";
import type { SnapshotChange } from "./snapshot.js";
import { writeWithSnapshot } from "./write.js";

export const READ_MAX_BYTES = 2 * 1024 * 1024;
export const PATCH_MAX_BYTES = 2 * 1024 * 1024;
export const READ_DEFAULT_LIMIT = 2000;
export const READ_MAX_LIMIT = 5000;

const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_LISTED_MATCH_LINES = 20;

export interface ReadFileOptions {
  offset?: number;
  limit?: number;
}

export interface ReadFileResult {
  path: string;
  totalLines: number;
  from: number;
  to: number;
  truncated: boolean;
  bytes: number;
  text: string;
}

export interface PatchFileOptions {
  find: string;
  replace: string;
  count?: "exact" | "all";
  skipSnapshot?: boolean;
}

export interface PatchFileResult {
  path: string;
  replacements: number;
  linesChanged: number;
  snapshotId: string | null;
  snapshotSkippedReason?: string;
}

export type FileChange = SnapshotChange;

export interface ListChangesResult {
  snapshotId: string | null;
  createdAt: string | null;
  files: FileChange[];
  unchangedCount: number;
  untrackedCount: number;
}

function rethrowLocked(e: any, file: string): never {
  if (e?.code === "EPERM" || e?.code === "EACCES") {
    throw new Error(
      `Could not read ${file}: ${e.code} -- the file is locked by another program. Close the file in GameMaker (or wait for the antivirus scan) and retry. (${e.message})`
    );
  }
  throw e;
}

async function readOrLock(file: string): Promise<Buffer> {
  try {
    return await fs.readFile(file);
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error(`no such file in project: ${file}`);
    rethrowLocked(e, file);
  }
}

// UTF-16 .gml/.yy would otherwise decode to mojibake and patch_file would
// corrupt it, so a NUL in the first 8 KiB is a refusal, not a warning.
function assertNotBinary(buf: Buffer, file: string): void {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) {
      throw new Error(
        `${file} is a binary file (NUL byte at offset ${i}) -- read_file and patch_file handle UTF-8 text only; a UTF-16 encoded file is reported here instead of being shown or patched as garbage`
      );
    }
  }
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export async function readFile(
  projectDir: string,
  requested: string,
  opts: ReadFileOptions = {}
): Promise<ReadFileResult> {
  const abs = await resolveInProject(projectDir, requested);
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error(`no such file in project: ${abs}`);
    rethrowLocked(e, abs);
  }
  if (st.isDirectory()) {
    throw new Error(`${abs} is a directory, not a file -- read_file takes a file path`);
  }
  if (st.size > READ_MAX_BYTES) {
    throw new Error(
      `${abs} is ${st.size} bytes, over the ${READ_MAX_BYTES}-byte read_file limit (2 MiB). offset/limit page lines, not bytes, so they are not a workaround -- open the file in an editor instead.`
    );
  }
  const buf = await readOrLock(abs);
  assertNotBinary(buf, abs);

  let text = buf.toString("utf8");
  // A BOM would sit in front of the "1: " prefix and break the documented
  // strip rule, so it is dropped from the rendered view.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = splitLines(text);
  const totalLines = lines.length;
  const from = Math.min(positiveInt(opts.offset, 1), totalLines + 1);
  const limit = Math.min(positiveInt(opts.limit, READ_DEFAULT_LIMIT), READ_MAX_LIMIT);
  const to = Math.min(from + limit - 1, totalLines);
  const picked = to < from ? [] : lines.slice(from - 1, to);

  return {
    path: requested,
    totalLines,
    from,
    to,
    truncated: to < totalLines,
    bytes: st.size,
    text: picked.map((line, i) => `${from + i}: ${line}`).join("\n"),
  };
}

function assertNoNul(value: string, name: string): void {
  if (value.includes("\u0000")) {
    throw new Error(`${name} contains a NUL character -- patch_file matches UTF-8 text, not binary data`);
  }
}

function findOccurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    found.push(i);
    i = text.indexOf(needle, i + needle.length);
  }
  return found;
}

function newlineOffsets(text: string): number[] {
  const offsets: number[] = [];
  let i = text.indexOf("\n");
  while (i !== -1) {
    offsets.push(i);
    i = text.indexOf("\n", i + 1);
  }
  return offsets;
}

function lineOf(newlines: number[], index: number): number {
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlines[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

function detectEol(text: string): "\r\n" | "\n" {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

function normaliseEol(value: string, eol: "\r\n" | "\n"): string {
  const flat = value.split("\r\n").join("\n");
  return eol === "\r\n" ? flat.split("\n").join("\r\n") : flat;
}

// Writing into the store would corrupt the snapshots that are supposed to
// protect the write, so it is refused by resolved path, not by string.
async function assertNotInStore(projectDir: string, abs: string): Promise<void> {
  const root = await fs.realpath(path.resolve(projectDir));
  const store = path.basename(storeDir(projectDir));
  const first = path.relative(root, abs).split(path.sep)[0] ?? "";
  const name = process.platform === "win32" ? first.toLowerCase() : first;
  const storeName = process.platform === "win32" ? store.toLowerCase() : store;
  if (name === storeName) {
    throw new Error(
      `${abs} is inside the ${store} store -- patch_file never writes there (snapshots are immutable; restore_snapshot is the way back)`
    );
  }
}

export async function patchFile(
  projectDir: string,
  requested: string,
  opts: PatchFileOptions
): Promise<PatchFileResult> {
  if (typeof opts?.find !== "string" || opts.find.length === 0) {
    throw new Error("find must be a non-empty string -- patch_file matches literal text, never a pattern");
  }
  if (typeof opts.replace !== "string") {
    throw new Error("replace must be a string (pass an empty string to delete the matched text)");
  }
  assertNoNul(opts.find, "find");
  assertNoNul(opts.replace, "replace");
  const mode = opts.count ?? "exact";
  if (mode !== "exact" && mode !== "all") {
    throw new Error(`count must be "exact" or "all", got "${String(mode)}"`);
  }

  const abs = await resolveInProject(projectDir, requested);
  await assertNotInStore(projectDir, abs);

  let st;
  try {
    st = await fs.stat(abs);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(`no such file in project: ${abs} -- patch_file only edits an existing file, it never creates one`);
    }
    rethrowLocked(e, abs);
  }
  if (st.isDirectory()) {
    throw new Error(`${abs} is a directory, not a file -- patch_file takes a file path`);
  }
  if (st.size > PATCH_MAX_BYTES) {
    throw new Error(
      `${abs} is ${st.size} bytes, over the ${PATCH_MAX_BYTES}-byte patch_file limit (2 MiB) -- edit it in an editor instead`
    );
  }

  const buf = await readOrLock(abs);
  assertNotBinary(buf, abs);
  const text = buf.toString("utf8");

  const occurrences = findOccurrences(text, opts.find);
  const newlines = newlineOffsets(text);
  if (occurrences.length === 0) {
    throw new Error(
      `find text not found in ${requested} (${abs}) -- 0 matches, nothing was written. patch_file is a literal match; check the exact text including whitespace and line endings.`
    );
  }
  if (mode === "exact" && occurrences.length > 1) {
    const listed = occurrences.slice(0, MAX_LISTED_MATCH_LINES).map((i) => lineOf(newlines, i));
    const more = occurrences.length > MAX_LISTED_MATCH_LINES
      ? ` and ${occurrences.length - MAX_LISTED_MATCH_LINES} more`
      : "";
    throw new Error(
      `find text occurs ${occurrences.length} times in ${requested} -- the default mode needs exactly one match; lines ${listed.join(", ")}${more}. Include more surrounding text to make the match unique, or pass count: "all". Nothing was written.`
    );
  }

  const applied = mode === "all" ? occurrences : [occurrences[0]];
  const eol = detectEol(text);
  const replacement = normaliseEol(opts.replace, eol);

  const changedLines = new Set<number>();
  for (const start of applied) {
    const lastLine = lineOf(newlines, start + opts.find.length - 1);
    for (let line = lineOf(newlines, start); line <= lastLine; line++) changedLines.add(line);
  }

  let out = "";
  let cursor = 0;
  for (const start of applied) {
    out += text.slice(cursor, start) + replacement;
    cursor = start + opts.find.length;
  }
  out += text.slice(cursor);

  const outcome = await writeWithSnapshot(projectDir, abs, out, {
    tool: "patch_file",
    reason: `patch_file: ${requested}`,
    skipSnapshot: opts.skipSnapshot === true,
  });

  return {
    path: requested,
    replacements: applied.length,
    linesChanged: changedLines.size,
    snapshotId: outcome.snapshotId ?? null,
    ...(outcome.snapshotSkippedReason ? { snapshotSkippedReason: outcome.snapshotSkippedReason } : {}),
  };
}

export async function listChanges(projectDir: string): Promise<ListChangesResult> {
  const latest = await latestSnapshot(projectDir);
  if (!latest) {
    return { snapshotId: null, createdAt: null, files: [], unchangedCount: 0, untrackedCount: 0 };
  }
  const diff = await diffAgainstSnapshot(projectDir, latest);
  return {
    snapshotId: latest.id,
    createdAt: latest.createdAt || null,
    files: diff.files,
    unchangedCount: diff.unchangedCount,
    untrackedCount: diff.untrackedCount,
  };
}

export const readProjectFile = readFile;
export const patchProjectFile = patchFile;
