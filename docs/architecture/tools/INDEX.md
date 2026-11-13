# tools

> Router only. Open the one module doc you need.

| Module | Covers | Doc |
|--------|--------|-----|
| registry | `src/index.ts`: schemas, `TOOL_DEFS`, `dispatchTool`, `callTool`, response conventions | registry.md |
| toolchain | `gamemaker-tools.ts`, `lint.ts`, `build.ts`: ProjectTool / Igor discovery and use | toolchain.md |

## Why

The registry is the only place a tool name becomes reachable; the toolchain is
the only place the server shells out to GameMaker itself.
