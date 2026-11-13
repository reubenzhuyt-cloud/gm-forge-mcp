import { promises as fs } from "fs";
import path from "path";
import type { Yyp } from "@bscotch/yy";
import { atomicWriteFile, atomicWriteJson } from "./atomic.js";
import { ensureFolder, validateResourceName, RESOURCE_VERSIONS, registerResource } from "./yyp.js";

// Notes are plain-text project documentation, never compiled into the game.
// Content lives in a separate .txt file, same as scripts use .gml.
export async function addNote(
  projectDir: string,
  yyp: Yyp,
  noteName: string,
  content: string = ""
): Promise<Yyp> {
  validateResourceName(yyp, noteName);

  const dir = path.join(projectDir, "notes", noteName);
  await fs.mkdir(dir, { recursive: true });

  await atomicWriteFile(path.join(dir, `${noteName}.txt`), content);

  const noteYy = {
    "$GMNotes": "",
    "%Name": noteName,
    name: noteName,
    parent: {
      name: "Notes",
      path: "folders/Notes.yy"
    },
    resourceType: "GMNotes",
    resourceVersion: RESOURCE_VERSIONS.note
  };

  await atomicWriteJson(path.join(dir, `${noteName}.yy`), noteYy);

  ensureFolder(yyp, "Notes");

  registerResource(yyp, noteName, `notes/${noteName}/${noteName}.yy`);

  return yyp;
}
