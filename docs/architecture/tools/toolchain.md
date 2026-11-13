# toolchain

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Finding and driving GameMaker's own two headless tools, and the structural
checks that need no GameMaker at all: `lint_project` (our checks + ProjectTool)
and `compile_project` (Igor). It owns process spawning and cleanup; it does not
write project files.

## Key Paths

- `src/gm/gamemaker-tools.ts` (178) — discovery only.
- `src/gm/lint.ts` (267) — `lintProject` (`:78`), `LintIssue` (`:47`).
- `src/gm/build.ts` (224) — `compileProject` (`:134`), `CompileResult` (`:8`).

## Discovery (`gamemaker-tools.ts`)

GameMaker installs differ by channel/storefront, and the two tools live in
different roots: ProjectTool inside the IDE install
(`packages/gm-tools/project-tool-win-x64/ProjectTool.exe`, `:22`), Igor inside the
**active runtime** named by `runtime.json`'s `active` field (`:154-178`).
Candidates are probed in order (default install, LTS `GameMakerStudio2-LTS2026`,
Steam library folders parsed from `libraryfolders.vdf`, with the Steam root read
from the registry), each overridable by an environment variable (`:5-21`).

- `findProjectTool()` (`:135`) — `null` on non-Windows and when not installed.
- `findIgor()` (`:154`) — `null` when no runtime has been downloaded yet; the
  returned `runtimePath` is what `--runtimePath` needs.

## lint (`lint.ts`)

- `runProjectToolCheck` (`:17`) — runs `ProjectTool PROJECT OPEN SOURCE=<yyp>`
  with a 30 s timeout; success is the literal `ProjectTool Successful` in stdout.
  A nonzero exit whose output says `ProjectTool Failed` / `parsing errors` /
  `Error:` is a real error; anything else is a `warning` ("could not run it").
  ProjectTool is read-only by its own default.
- `lintProject(projectDir)` (`:78`) — structural checks over the twelve
  categories: dangling references, orphaned resources, missing folder
  registrations, missing event code files with the **expected** filename, and
  sound/sprite metadata that disagrees with the real underlying file. A per-file
  I/O error becomes a warning for that resource instead of failing the whole
  check (`safeFileExists`, `:57`).

## compile (`build.ts`)

- `compileProject(projectDir)` (`:134`) — spawns
  `Igor --project=<yyp> --runtimePath=<runtime> --cache=<tmp> -r VM Windows Run`,
  because `Run` genuinely compiles on every licence tier while `Build`/`Package`
  can short-circuit. No Igor → `{available:false}` with an actionable message
  (`:138-145`); the temporary cache dir lives in `os.tmpdir()` and is removed
  afterwards.
- Success is detected by the launch marker `[Run] Run game` (`:16`) in
  stdout/stderr, and the process tree is killed immediately — the check must not
  leave a game window open. `extractCompileErrors` (`:24`) handles Igor's habit of
  appending `Error : …` directly to a stage line.
- `BUILD_TIMEOUT_MS = 180_000` (`:15`). Running Igor PIDs are tracked and killed
  on graceful server shutdown; a hard kill of the server cannot be covered
  (`:53-60`).
- Side effect the tool description states plainly: a successful compile briefly
  **launches** the game, so the project's own code runs.

## Dependencies

- In: `yyp.ts` (`parseGameMakerJson`, `fileExists`), `sprites.ts` (PNG
  dimensions), `sounds.ts` (audio metadata + allowed rates), `objects.ts` (event
  filenames), Node `child_process`.
- Out: `index.ts` (`lint_project`, `compile_project`), `test/verify.ts`.
