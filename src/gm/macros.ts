import { promises as fs } from "fs";
import path from "path";
import type { Yyp } from "@bscotch/yy";
import { atomicWriteJson, isExcludedFromSnapshot } from "./atomic.js";
import { fileExists, loadYyp, registerResource, RESOURCE_VERSIONS, writeYyp } from "./yyp.js";
import { writeWithSnapshot } from "./write.js";

export const DEFAULT_MACRO_FILE = "scripts/macros/macros.gml";
export const DEFAULT_MACRO_SCRIPT = "scripts/macros/macros.yy";

const MACRO_SCRIPT_NAME = "macros";
const MACRO_SCRIPT_FOLDER = ["Scripts", "Macros"];

export interface MacroDefinition {
  name: string;
  value: string;
  file: string;
  line: number;
}

export interface MacroDuplicate {
  name: string;
  definitions: Array<{ file: string; line: number }>;
}

export interface ListMacrosResult {
  macros: MacroDefinition[];
  count: number;
  duplicates: MacroDuplicate[];
  note: string;
}

export interface SetMacroOptions {
  name: string;
  value: string;
  file?: string;
  skipSnapshot?: boolean;
}

export interface SetMacroResult {
  name: string;
  value: string;
  file: string;
  line: number;
  created: { file: string; script: string } | null;
  previous: { value: string; file: string; line: number } | null;
  eol: "lf" | "crlf";
  /** false when the file already held exactly this definition: nothing was written. */
  changed: boolean;
  /** The backup this call took, or null when nothing was written / the backup was skipped. */
  snapshotId: string | null;
  /** Set when the write proceeded without a backup (skipSnapshot, excluded path, size limit). */
  snapshotSkippedReason?: string;
}

const MACRO_VALUE_MAX_LENGTH = 1024;

// Captured from a real IDE-authored macro (261103GJ/scripts/scr_l1_data/
// scr_l1_data.gml): `#macro NAME value`, any indentation, and a trailing
// `// comment` that is not part of the value.
export const MACRO_LINE_RE = /^[ \t]*#macro[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(.+?)[ \t]*$/;
// A macro-looking line that MACRO_LINE_RE rejects (no value, malformed name).
// It is still reported, with an empty value, instead of being dropped.
const MACRO_PREFIX_RE = /^[ \t]*#macro(?![A-Za-z0-9_])/;

// GameMaker silently compiles the last definition of a duplicated macro, so a
// second `#macro NAME` never warns at build time -- this is the only place it
// can be surfaced.
export const MACROS_NOTE =
  "GameMaker compiles the last definition of a duplicated macro; earlier definitions are silently shadowed";

const GML_KEYWORDS = new Set([
  "all", "and", "begin", "break", "case", "catch", "constructor", "continue", "default",
  "define", "delete", "div", "do", "else", "end", "enum", "exit", "false", "finally", "for",
  "function", "global", "globalvar", "if", "infinity", "mod", "nan", "new", "noone", "not",
  "or", "other", "repeat", "return", "self", "static", "switch", "then", "throw", "true",
  "try", "undefined", "until", "var", "while", "with", "xor",
]);

// Top-level directories that hold build output, shipped data, or IDE-owned
// option files -- never project source, and `output/` in particular contains
// generated copies of every .gml in the project.
const IGNORED_TOP_LEVEL_DIRS = new Set(["output", "datafiles", "options"]);

interface MacroLine {
  body: string;
  eol: string;
}

// Keeps each line's own terminator so a rewrite can reproduce every byte that
// was not deliberately changed (files.ts splits on "\n" only because it
// replaces whole spans).
function splitLines(text: string): MacroLine[] {
  const lines: MacroLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\r" && ch !== "\n") continue;
    const eol = ch === "\r" && text[i + 1] === "\n" ? "\r\n" : ch;
    lines.push({ body: text.slice(start, i), eol });
    i += eol.length - 1;
    start = i + 1;
  }
  if (start < text.length) lines.push({ body: text.slice(start), eol: "" });
  return lines;
}

function detectEol(text: string): "lf" | "crlf" {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "crlf" : "lf";
}

function splitTrailingComment(text: string): { code: string; comment: string } {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "/" && text[i + 1] === "/") {
      return { code: text.slice(0, i), comment: text.slice(i) };
    }
  }
  return { code: text, comment: "" };
}

function hasUnquotedDoubleSlash(text: string): boolean {
  return splitTrailingComment(text).comment.length > 0;
}

function parseMacroLine(body: string): { name: string; value: string } | null {
  const strict = MACRO_LINE_RE.exec(body);
  if (strict) {
    return { name: strict[1], value: splitTrailingComment(strict[2]).code.trimEnd() };
  }
  if (!MACRO_PREFIX_RE.test(body)) return null;
  const token = /^[ \t]*#macro[ \t]+(\S+)/.exec(body);
  return { name: token ? token[1] : "", value: "" };
}

// A `/* ... */` comment can span lines, so matching line by line would report a
// commented-out `#macro` as a real definition -- and set_macro would rewrite it,
// turning dead comment text into live code. Every line is reduced to its code
// (block-comment characters blanked out, quoted runs kept verbatim so a "/*" or
// "//" inside a string stays content), carrying the block state to the next
// line. The result keeps each line's length-independent shape; only content is
// blanked, never shifted.
function codeLines(lines: MacroLine[]): string[] {
  let inBlock = false;
  return lines.map(({ body }) => {
    let out = "";
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (inBlock) {
        if (ch === "*" && body[i + 1] === "/") {
          inBlock = false;
          out += "  ";
          i++;
        } else {
          out += " ";
        }
        continue;
      }
      if (ch === "/" && body[i + 1] === "*") {
        inBlock = true;
        out += "  ";
        i++;
        continue;
      }
      if (ch === '"') {
        out += ch;
        for (i++; i < body.length; i++) {
          out += body[i];
          if (body[i] === "\\" && i + 1 < body.length) {
            out += body[i + 1];
            i++;
            continue;
          }
          if (body[i] === '"') break;
        }
        continue;
      }
      out += ch;
    }
    return out;
  });
}

async function walkGmlFiles(dir: string, relDir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (isExcludedFromSnapshot(rel)) continue;
      if (relDir === "" && IGNORED_TOP_LEVEL_DIRS.has(entry.name.toLowerCase())) continue;
      await walkGmlFiles(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile() && entry.name.endsWith(".gml")) {
      out.push(rel);
    }
  }
}

export async function listMacros(projectDir: string): Promise<ListMacrosResult> {
  const files: string[] = [];
  await walkGmlFiles(projectDir, "", files);

  const macros: MacroDefinition[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(path.join(projectDir, file), "utf8");
    } catch {
      continue;
    }
    const lines = splitLines(text);
    const code = codeLines(lines);
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseMacroLine(code[i]);
      if (parsed) macros.push({ name: parsed.name, value: parsed.value, file, line: i + 1 });
    }
  }
  macros.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  const byName = new Map<string, MacroDefinition[]>();
  for (const macro of macros) {
    const group = byName.get(macro.name);
    if (group) group.push(macro);
    else byName.set(macro.name, [macro]);
  }
  const duplicates: MacroDuplicate[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    duplicates.push({ name, definitions: group.map((d) => ({ file: d.file, line: d.line })) });
  }

  return { macros, count: macros.length, duplicates, note: MACROS_NOTE };
}

function validateMacroName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Macro name cannot be empty");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid macro name "${name}": a GML identifier starts with a letter or underscore and contains only letters, digits, and underscores`
    );
  }
  if (GML_KEYWORDS.has(name.toLowerCase())) {
    throw new Error(`Macro name "${name}" is a GML keyword -- pick a name the compiler can use`);
  }
  return name;
}

function validateMacroValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Macro value must be a string");
  }
  if (/[\r\n]/.test(value)) {
    throw new Error("Macro value must be a single line -- a newline would end the definition");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Macro value cannot be empty");
  }
  if (trimmed.length > MACRO_VALUE_MAX_LENGTH) {
    throw new Error(`Macro value is ${trimmed.length} characters -- longer than the ${MACRO_VALUE_MAX_LENGTH}-character limit`);
  }
  if (trimmed.startsWith("#macro")) {
    throw new Error(`Macro value cannot begin with "#macro" -- it would read back as a second definition`);
  }
  if (hasUnquotedDoubleSlash(value)) {
    throw new Error(
      `Macro value must not contain "//" outside a string -- GameMaker reads the rest of the line as a comment, so the value would not round-trip`
    );
  }
  return trimmed;
}

// A project-relative, forward-slashed path, or a message naming the root. The
// resolved path is what actually gets written, so a junction or a ".." has to
// be refused here rather than trusted.
function toProjectRelative(projectDir: string, file: string): string {
  if (typeof file !== "string" || file.trim().length === 0) {
    throw new Error("file must be a project-relative .gml path");
  }
  const root = path.resolve(projectDir);
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`"${file}" is outside the project directory ${root}`);
  }
  const segments = rel.split(path.sep);
  if (segments.some((segment) => segment.startsWith("."))) {
    throw new Error(`"${file}" is inside a hidden or tool-owned directory -- set_macro never writes there`);
  }
  return segments.join("/");
}

async function readTargetFile(abs: string, rel: string): Promise<string | null> {
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      throw new Error(`${rel} is a directory, not a .gml file`);
    }
    return await fs.readFile(abs, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

function folderNodePath(folders: string[]): string {
  return `folders/${folders.join("/")}.yy`;
}

// The 8 keys addScript writes (test/verify.ts REF.script), with the macro
// script parented to a nested Macros folder instead of the top-level Scripts
// one. Kept in newScriptYy's field order so both writers emit the same shape.
function macrosScriptYy() {
  return {
    name: MACRO_SCRIPT_NAME,
    resourceType: "GMScript",
    resourceVersion: RESOURCE_VERSIONS.script,
    isDnD: false,
    isCompatibility: false,
    parent: { name: MACRO_SCRIPT_FOLDER[MACRO_SCRIPT_FOLDER.length - 1], path: folderNodePath(MACRO_SCRIPT_FOLDER) },
    "$GMScript": "v1",
    "%Name": MACRO_SCRIPT_NAME,
  };
}

// ensureFolder's 6-key node, extended to a nested path: a nested folder carries
// no `parent` field, its parent is encoded in folderPath alone (captured from
// 261103GJ.yyp's folders/Sounds/Scripts.yy entry). Every ancestor is ensured
// too, so the nested node is never orphaned.
function ensureFolderPath(yyp: Yyp, folders: string[]): boolean {
  const list = ((yyp as any).Folders ?? []) as any[];
  let changed = false;
  for (let i = 1; i <= folders.length; i++) {
    const name = folders[i - 1];
    const folderPath = folderNodePath(folders.slice(0, i));
    if (list.some((f: any) => f.folderPath === folderPath)) continue;
    list.push({
      "$GMFolder": "",
      "%Name": name,
      folderPath,
      name,
      resourceType: "GMFolder",
      resourceVersion: RESOURCE_VERSIONS.folder,
    });
    changed = true;
  }
  (yyp as any).Folders = list;
  return changed;
}

export async function setMacro(projectDir: string, opts: SetMacroOptions): Promise<SetMacroResult> {
  const name = validateMacroName(opts?.name);
  const value = validateMacroValue(opts?.value);
  const requested = opts?.file === undefined ? null : toProjectRelative(projectDir, opts.file);
  const target = requested ?? DEFAULT_MACRO_FILE;

  if (!target.endsWith(".gml")) {
    throw new Error(`"${target}" is not a .gml file -- macros are defined in GML source`);
  }
  // Build output and shipped data are not project source: a name that happens to
  // be defined in output/ (the IDE's generated copy) must never be rewritten in
  // place, and datafiles/options/ hold no GML at all.
  const topLevelDirectory = target.split("/")[0].toLowerCase();
  if (IGNORED_TOP_LEVEL_DIRS.has(topLevelDirectory)) {
    throw new Error(
      `"${target}" is inside ${topLevelDirectory}/ -- that directory holds build output or shipped data, not project source, so set_macro never writes there`
    );
  }

  const { macros } = await listMacros(projectDir);
  const definitions = macros.filter((m) => m.name === name);
  const inTarget = definitions.filter((m) => m.file === target);
  const elsewhere = definitions.filter((m) => m.file !== target);

  if (inTarget.length > 1) {
    const sites = inTarget.map((d) => `${d.file}:${d.line}`).join(", ");
    throw new Error(
      `"${name}" is defined ${inTarget.length} times in ${target} (${sites}) -- refusing to guess which one to rewrite; remove the duplicates first`
    );
  }
  if (inTarget.length === 0 && elsewhere.length > 0) {
    const sites = elsewhere.map((d) => `${d.file}:${d.line}`).join(", ");
    if (requested === null) {
      throw new Error(
        `"${name}" is already defined at ${sites} -- pass file: "${elsewhere[0].file}" to update it there (a second definition would silently shadow it)`
      );
    }
    throw new Error(
      `"${name}" is already defined at ${sites} -- refusing to create a second definition, which GameMaker would silently prefer or shadow`
    );
  }

  if (requested !== null && inTarget.length === 0 && !target.startsWith("scripts/")) {
    throw new Error(
      `set_macro only creates ${DEFAULT_MACRO_FILE}; "${target}" is outside scripts/ and does not already define "${name}"`
    );
  }

  const abs = path.join(projectDir, target);
  const current = await readTargetFile(abs, target);
  if (current === null && requested !== null) {
    throw new Error(`${target} does not exist -- set_macro only creates ${DEFAULT_MACRO_FILE}, it never creates an arbitrary .gml`);
  }

  const creating = current === null;
  const text = current ?? "";
  const eol = creating ? "\n" : detectEol(text) === "crlf" ? "\r\n" : "\n";

  // Everything that could make the write half-done is validated before the
  // first byte lands: the .yyp is loaded, the resource name is free, and the
  // folder nodes are known to be addable.
  let scriptYyp: { yyp: Yyp; needsYyFile: boolean } | null = null;
  if (target === DEFAULT_MACRO_FILE) {
    const yyp = await loadYyp(projectDir);
    const collision = yyp.resources.find(
      (r: any) => r.id?.name?.toLowerCase() === MACRO_SCRIPT_NAME && r.id?.path !== DEFAULT_MACRO_SCRIPT
    );
    if (collision) {
      throw new Error(
        `A resource named "${MACRO_SCRIPT_NAME}" already exists at ${(collision as any).id?.path} -- cannot create ${DEFAULT_MACRO_SCRIPT} next to it (resource names are unique across the project)`
      );
    }
    scriptYyp = { yyp, needsYyFile: !(await fileExists(path.join(projectDir, DEFAULT_MACRO_SCRIPT))) };
  }

  const lines = splitLines(text);
  const oldLine = inTarget.length === 1 ? lines[inTarget[0].line - 1] : null;
  let nextText: string;
  let resultLine: number;
  let previous: SetMacroResult["previous"] = null;

  if (inTarget.length === 1 && oldLine) {
    const indent = /^[ \t]*/.exec(oldLine.body)?.[0] ?? "";
    const { comment } = splitTrailingComment(oldLine.body);
    const rewritten = `${indent}#macro ${name} ${value}${comment ? ` ${comment}` : ""}`;
    // Only the one body changes: every other line keeps its own terminator, so
    // a CRLF file stays CRLF and a missing trailing newline stays missing.
    nextText = lines.map((line, i) => (i === inTarget[0].line - 1 ? rewritten : line.body) + line.eol).join("");
    resultLine = inTarget[0].line;
    previous = { value: inTarget[0].value, file: target, line: inTarget[0].line };
  } else {
    const definition = `#macro ${name} ${value}`;
    const endsWithNewline = text.endsWith("\n") || text.endsWith("\r");
    if (creating) {
      nextText = `${definition}${eol}`;
    } else if (text.length === 0) {
      nextText = definition;
    } else {
      nextText = `${text}${endsWithNewline ? "" : eol}${definition}${endsWithNewline ? eol : ""}`;
    }
    resultLine = lines.length + 1;
  }

  if (creating) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
  }

  // Re-setting the value that is already there must not cost a backup or rewrite
  // identical bytes -- same rule set_project_option follows. Nothing is touched,
  // not even the .yy/.yyp below (a file that already holds the definition has
  // its resource or it does not; this call cannot fix that without a write).
  if (!creating && nextText === text) {
    return {
      name,
      value,
      file: target,
      line: resultLine,
      created: null,
      previous,
      eol: eol === "\r\n" ? "crlf" : "lf",
      changed: false,
      snapshotId: null,
    };
  }

  // Snapshot first, then write -- writeWithSnapshot's order, so a failed backup
  // aborts before the .gml is touched. The .yy and .yyp below are written after
  // it, which means the snapshot taken here already holds their pre-change
  // state: one backup covers the whole operation. The outcome is reported, never
  // dropped: a skipped backup (skipSnapshot, the size cap) has to reach the
  // caller or a big project would write with no way back and no warning.
  const outcome = await writeWithSnapshot(projectDir, abs, nextText, {
    tool: "set_macro",
    reason: `set_macro ${name}`,
    skipSnapshot: opts?.skipSnapshot === true,
  });

  if (scriptYyp) {
    if (scriptYyp.needsYyFile) {
      await atomicWriteJson(path.join(projectDir, DEFAULT_MACRO_SCRIPT), macrosScriptYy());
    }
    const folderChanged = ensureFolderPath(scriptYyp.yyp, MACRO_SCRIPT_FOLDER);
    const registered = scriptYyp.yyp.resources.some((r: any) => r.id?.path === DEFAULT_MACRO_SCRIPT);
    registerResource(scriptYyp.yyp, MACRO_SCRIPT_NAME, DEFAULT_MACRO_SCRIPT);
    if (folderChanged || !registered) {
      await writeYyp(projectDir, scriptYyp.yyp);
    }
  }

  return {
    name,
    value,
    file: target,
    line: resultLine,
    created: creating && target === DEFAULT_MACRO_FILE
      ? { file: DEFAULT_MACRO_FILE, script: DEFAULT_MACRO_SCRIPT }
      : null,
    previous,
    eol: eol === "\r\n" ? "crlf" : "lf",
    changed: true,
    snapshotId: outcome.snapshotId ?? null,
    ...(outcome.snapshotSkippedReason ? { snapshotSkippedReason: outcome.snapshotSkippedReason } : {}),
  };
}
