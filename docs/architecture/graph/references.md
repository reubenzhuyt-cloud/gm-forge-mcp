# references

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Find every mention of a resource name across the project, as `{file, line,
context}` hits. It is a text scanner, deliberately not JSON- or GML-aware;
over-reporting is preferred because its output gates `delete_resource` and drives
`rename_resource`.

## Key Paths

- `src/gm/references.ts` (85 lines).
- Scanned extensions: `.yy`, `.yyp`, `.gml` (`:10`) — but the `.yyp` is filtered
  out of the result (`:59`, `:46-47`).

## Public API / Key Types

- `ReferenceHit` (`:4`) — `file` (project-relative), 1-based `line`, `context`
  (trimmed, 200 chars).
- `findReferences(projectDir, resourceName, excludeOwnFiles = true)` (`:48`) —
  a `\b`-delimited regex with the name escaped (`:56`); an empty name is refused
  because it would match almost every line (`:53`).
- `excludeOwnFiles` skips files under `<sep><resourceName><sep>` so a resource's
  own directory does not count as a "reference" to itself.

## Scan scope

`walkFiles` (`:22`) recurses the project skipping **every dot-prefixed
directory** — `.git`, `.gm-forge`, `.gamemaker-mcp`, `.opencode` — and only keeps
the three extensions. This matters because `.gamemaker-mcp` holds full project
copies from a previous MCP: recursing into backups would rewrite the backups and
inflate the count until nothing could be deleted. A real I/O error aborts
nothing; an unreadable file is simply skipped (`:68-70`).

## Contracts

- The `.yyp` is excluded from the hits: it lists every resource by definition, so
  a match there is bookkeeping, not usage.
- No type awareness: a sequence/timeline field holding a sprite name will be
  found as text, but nothing in `delete.ts`/`rename.ts` knows that structure — see
  `timelines-sequences.md`.
- Read-only; no snapshot.

## Dependencies

- In: Node `fs`/`path` only.
- Out: `delete.ts`, `rename.ts`, `index.ts` (`find_references`).
