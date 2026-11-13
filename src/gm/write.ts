import { promises as fs } from "fs";
import path from "path";
import { atomicWriteFile, isExcludedFromSnapshot, snapshotLimitDetail, SnapshotTooLargeError } from "./atomic.js";
import {
  createSnapshot,
  diffAgainstSnapshot,
  discardSnapshot,
  readManifest,
  updateManifest,
} from "./snapshot.js";

// The tools that get an automatic backup from the dispatch hook, chosen by one
// rule: the call can overwrite or remove content that already exists in a
// resource file (a `.yy`, a `.gml`, a `.vsh`/`.fsh`, the `.yyp`), as opposed to
// only appending a brand-new resource to the catalog.
//
// Included: every `edit_*` (whole-file rewriters), the delete/rename pair, the
// room layer/tile writers, `add_room_layer`/`add_room_instance` (they rewrite an
// existing room .yy), `add_object_event` (it rewrites an existing object .yy
// and drops a new event .gml), `reorder_room`/`move_room_relative` (they rewrite
// the existing .yyp's RoomOrderNodes, which is content the user already had),
// plus `patch_file`, which snapshots itself through `writeWithSnapshot`.
//
// Deliberately excluded, and why:
//  - `create_project`, `add_script`, `add_object`, `add_sprite_from_images`,
//    `add_shader`, `add_sound`, `add_font`, `add_note`, `add_tileset`,
//    `add_extension`, `add_particle_system`, `add_anim_curve`, `add_room`,
//    `add_texture_group`, `add_audio_group`: they only append a new resource (or
//    a new group) to the .yyp; nothing the user already had is removed.
//  - `create_snapshot`, `list_snapshots`, `restore_snapshot`, `delete_snapshot`,
//    `list_changes`, `undo_last`, `read_file`, every `get_*`/`list_*`/`find_*`,
//    `lint_project`, `compile_project`: read-only, or they manage the store.
//  - `patch_file`, `undo_last`: not here so double-snapshotting is impossible
//    by construction -- patch_file snapshots itself.
//  - `set_project_option`, `set_macro`: same rule, they snapshot themselves
//    through `writeWithSnapshot`. Listing them here would take a second copy of
//    the project for the same call and burn two of the 20 retention slots.
//  - `get_project_options`, `list_included_files`, `list_macros`: read-only.
// (The spec's table also listed `remove_resource`; no such tool is registered --
// deleting a resource is `delete_resource`, already below.)
export const AUTO_SNAPSHOT_TOOLS: ReadonlySet<string> = new Set([
  "rename_resource",
  "delete_resource",
  "remove_room_layer",
  "set_room_tiles",
  "fill_room_tiles",
  "edit_object",
  "edit_room",
  "edit_script",
  "edit_sprite",
  "edit_shader",
  "edit_sound",
  "edit_font",
  "edit_tileset",
  "set_room_layer",
  "add_room_layer",
  "add_room_instance",
  "add_object_event",
  // The five sprite-frame writers rewrite an existing sprite .yy AND delete or
  // overwrite frame pngs that already hold the user's art, so each needs a
  // backup before it runs. `list_sprite_frames` is read-only and stays out.
  "add_sprite_frame",
  "remove_sprite_frame",
  "replace_sprite_frame",
  "reorder_sprite_frames",
  "trim_sprite_frames",
  // The included-file pair rewrites the .yyp through writeYyp, which takes no
  // snapshot of its own, so the dispatch hook is the only backup they get.
  "add_included_file",
  "remove_included_file",
  // Room order lives in the .yyp's RoomOrderNodes: a reorder is an edit to a
  // file the user already had, not an append. The hook discards the snapshot
  // when the order comes back byte-identical (nothing moved), so a no-op
  // reorder still costs no retained backup.
  "reorder_room",
  "move_room_relative",
]);

const STORE_DIR = ".gm-forge";
const SKIP_ON_REQUEST = "snapshot skipped on request";
const SKIP_OVER_LIMIT = "snapshot skipped: project is over the snapshot size limit";

export interface WriteWithSnapshotContext {
  tool?: string;
  reason?: string;
  skipSnapshot?: boolean;
}

export interface WriteWithSnapshotResult {
  written: boolean;
  snapshotId?: string;
  snapshotSkippedReason?: string;
  warnings: string[];
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// A project write may never land outside the project. Lexical containment alone
// is not enough on Windows: a junction or symlink inside the project passes it
// and still points elsewhere, so the parent directory's realpath is checked too.
// Both an already-resolved absolute path (patch_file resolves first) and a
// project-relative one are accepted.
async function assertInsideProject(projectDir: string, dest: string): Promise<void> {
  const root = path.resolve(projectDir);
  const target = path.resolve(dest);
  if (!isInside(root, target)) {
    throw new Error(`Refusing to write ${target}: it is outside the project directory ${root}`);
  }
  const parent = path.dirname(target);
  let realRoot: string;
  let realParent: string;
  try {
    [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(parent)]);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(`Cannot write ${target}: its directory ${parent} does not exist`);
    }
    throw e;
  }
  if (!isInside(realRoot, path.join(realParent, path.basename(target)))) {
    throw new Error(`Refusing to write ${target}: it resolves outside the project directory ${realRoot}`);
  }
}

// Snapshot first, then write: if the backup fails the file is not touched, and a
// failed write still leaves the snapshot behind -- which is exactly the moment
// the user wants it. The snapshot is skipped, never silently, for an excluded
// path, an explicit skipSnapshot, and a project past the size limits (the walk
// is createSnapshot's, so its caps stay the only copy of those numbers); every
// other snapshot failure is fatal and aborts the write.
export async function writeWithSnapshot(
  projectDir: string,
  file: string,
  data: string,
  ctx: WriteWithSnapshotContext = {}
): Promise<WriteWithSnapshotResult> {
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw new Error("writeWithSnapshot needs a project directory");
  }
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("writeWithSnapshot needs a file path");
  }
  const dest = path.isAbsolute(file) ? file : path.join(projectDir, file);
  const relPath = path.relative(path.resolve(projectDir), path.resolve(dest)).split(path.sep).join("/");

  if (relPath === STORE_DIR || relPath.startsWith(`${STORE_DIR}/`)) {
    throw new Error(`Refusing to write ${relPath}: ${STORE_DIR}/ holds the snapshots and no tool may write into it`);
  }
  await assertInsideProject(projectDir, dest);

  if (ctx.skipSnapshot === true) {
    await atomicWriteFile(dest, data);
    return { written: true, snapshotSkippedReason: SKIP_ON_REQUEST, warnings: [] };
  }

  if (isExcludedFromSnapshot(relPath)) {
    await atomicWriteFile(dest, data);
    return {
      written: true,
      snapshotSkippedReason: `snapshot skipped: ${relPath} is excluded from snapshots`,
      warnings: [],
    };
  }

  let snapshot: Awaited<ReturnType<typeof createSnapshot>>;
  try {
    snapshot = await createSnapshot(projectDir, {
      tool: ctx.tool,
      reason: ctx.reason,
      onOverThreshold: "skip",
    });
  } catch (e) {
    if (!(e instanceof SnapshotTooLargeError)) throw e;
    await atomicWriteFile(dest, data);
    const warning = `snapshot skipped: ${snapshotLimitDetail(e.fileCount, e.totalBytes)}. The write proceeded without a backup.`;
    return { written: true, snapshotSkippedReason: warning, warnings: [warning] };
  }
  await atomicWriteFile(dest, data);
  if (snapshot.snapshotId === null) {
    return {
      written: true,
      snapshotSkippedReason: snapshot.warnings[0] ?? SKIP_OVER_LIMIT,
      warnings: snapshot.warnings,
    };
  }
  return { written: true, snapshotId: snapshot.snapshotId, warnings: snapshot.warnings };
}

// The shape every tool handler returns: one or more text parts, never a thrown
// warning (the central catch renders only an error, so a warning riding on a
// failure would be lost).
export interface ToolTextResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// A warning is a SECOND content part, never merged into the tool's own text and
// never a new field: four wrapped tools (`add_room_layer`, `remove_room_layer`,
// `set_room_tiles`, `fill_room_tiles`) return pure JSON in content[0], and a
// `⚠ ...` suffix there would make every one of them unparseable. Appending a
// `snapshot: <id>` line to content[0] would likewise change nine tools' output,
// which their contracts forbid.
function appendWarnings<T extends ToolTextResponse>(result: T, warnings: string[]): T {
  if (warnings.length === 0) return result;
  if (!result || !Array.isArray(result.content) || result.content.length === 0) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: warnings.map((w) => `⚠ ${w}`).join("\n") }],
  };
}

// The hook needs the registered schema of the tool it is wrapping. It is passed
// in rather than imported: write.ts -> index.ts would be an import cycle, and
// the plan's import graph (atomic -> snapshot -> files -> write -> index) is
// what keeps "nobody has to reason about ESM hoisting" true.
export interface ToolSchemaLike {
  safeParse(value: unknown): { success: boolean };
  /**
   * Optional disk-free argument check: a message means "this call cannot be
   * valid", so the hook dispatches immediately (the handler throws its own
   * error) instead of spending a project copy on it.
   */
  prevalidate?(value: unknown): string | null;
}

// Same rule loadYyp uses: a project directory holds exactly one .yyp. Anything
// else (a home directory, a folder of unrelated files) is not a project, and
// snapshotting it would copy a tree no tool is allowed to write to.
async function isProjectRoot(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((f) => f.endsWith(".yyp")).length === 1;
  } catch {
    return false;
  }
}

// Two seconds of slack, because the coarse-timestamp case this guards against
// (FAT rounds mtimes to 2 s) can put a written file's recorded mtime *before*
// manifest creation.
const COARSE_MTIME_SLACK_MS = 2000;

/**
 * The single cross-cutting wrapper, installed once at the MCP request handler so
 * that no handler body contains snapshot code. Runs inside the project lock and
 * after the schema is known to exist (the caller passes the already-validated
 * projectDir), so two writes can never snapshot over each other.
 *
 * A snapshot that cannot be taken (over the size threshold) is a warning, not a
 * failure: blocking every destructive tool on a 30,000-file project would break
 * every existing contract, as long as the response says plainly that the write
 * had no backup. Any other snapshot failure is fatal and aborts the write.
 *
 * Two pre-checks exist for cost and error-text reasons, not for safety:
 *  - a call that does not parse against the tool's own schema is dispatched
 *    immediately. It cannot write anything, and a full project copy retained as
 *    `failed: true` per typo would let 20 typos prune the user's undo points.
 *    Dispatch then throws the exact error the caller always got.
 *  - when projectDir holds no `.yyp` there is nothing to back up and nothing
 *    that could be written, so the handler produces its own "No .yyp found in
 *    ..." instead of the call failing on a snapshot error instead.
 */
export async function withAutoSnapshot<T extends ToolTextResponse>(
  name: string,
  projectDir: string,
  args: unknown,
  fn: () => Promise<T>,
  schema?: ToolSchemaLike
): Promise<T> {
  if (!AUTO_SNAPSHOT_TOOLS.has(name)) return fn();
  if (schema && !schema.safeParse(args).success) return fn();
  // A cheap argument refusal that needs no disk (a negative frame index, a
  // repeated order entry, an inverted trim range) is the same case as a schema
  // reject: it cannot write anything, so it must not spend a project copy that
  // would then be retained as `failed: true`. Dispatch still runs and throws its
  // own message -- the handler owns the wording, this only decides whether to
  // pay for a backup.
  if (schema?.prevalidate?.(args) != null) return fn();
  if ((args as { skipSnapshot?: unknown } | undefined)?.skipSnapshot === true) {
    return appendWarnings(await fn(), [SKIP_ON_REQUEST]);
  }

  const projectStat = await fs.stat(projectDir).catch((e: any) => {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  });
  if (!projectStat || !projectStat.isDirectory()) return fn();
  if (!(await isProjectRoot(projectDir))) return fn();

  const snapshot = await createSnapshot(projectDir, {
    tool: name,
    reason: `auto: ${name}`,
    onOverThreshold: "skip",
  });
  const warnings = [...snapshot.warnings];
  if (snapshot.snapshotId === null) {
    return appendWarnings(await fn(), warnings);
  }
  const snapshotId = snapshot.snapshotId;

  let result: T;
  try {
    result = await fn();
  } catch (e) {
    // A failed operation is exactly when the backup matters most: keep it,
    // record that it belongs to a failure, and rethrow the original error
    // untouched so the caller sees the tool's own message.
    await updateManifest(projectDir, snapshotId, { failed: true }).catch(() => {});
    throw e;
  }

  try {
    const manifest = await readManifest(projectDir, snapshotId);
    // The "did anything change?" decision must not trust size+mtime alone: a
    // coarse-timestamp filesystem can report both unchanged for a real write,
    // and discarding the only backup of a real write is the one failure this
    // feature must never make. Anything modified from just before the snapshot
    // onward is hashed (a handful of files), and the hash decides.
    const diff = await diffAgainstSnapshot(projectDir, manifest, {
      rehashSinceMs: Date.parse(manifest.createdAt) - COARSE_MTIME_SLACK_MS,
    });
    if (diff.files.length === 0) {
      // Nothing changed, verified by digest, so the snapshot protects nothing:
      // drop it rather than spend a retention slot on a no-op and report a
      // `snapshotId` that does not exist.
      await discardSnapshot(projectDir, snapshotId);
      return appendWarnings(result, warnings);
    }
    const touched = diff.files.map((f) => f.path);
    await updateManifest(projectDir, snapshotId, { touched });
  } catch (e: any) {
    // The write already happened. Failing the call now would invite the caller
    // to retry a write that succeeded, so say what is degraded instead:
    // restore_snapshot still restores everything, undo_last cannot target it.
    warnings.push(
      `could not record which files ${name} touched (${e?.message ?? String(e)}) -- restore_snapshot still restores the whole snapshot, undo_last will skip this one`
    );
  }

  return appendWarnings(result, warnings);
}

