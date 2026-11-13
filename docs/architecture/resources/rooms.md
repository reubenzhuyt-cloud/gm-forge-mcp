# rooms

> last-verified: 4f6312c (dirty tree) @ 2026-11-13

## Responsibility

Creating, resizing and reordering rooms, and placing an object instance into an
existing room. It owns the room `.yy` scaffold and the `.yyp`'s `RoomOrderNodes`;
layer and tile editing live in `room-layers.md` / `room-tiles.md`.

## Key Paths

- `src/gm/rooms.ts` (265 lines) — `addRoom`, `editRoom`, `reorderRoom`,
  `moveRoomRelativeTo`.
- `src/gm/instances.ts` (87 lines) — `addRoomInstance`.
- Room files: `rooms/<name>/<name>.yy`, optional
  `rooms/<name>/RoomCreationCode.gml`.

## Public API / Key Types

- `RoomOptions` (`rooms.ts:8`) — `width, height, persistent, creationCode?`.
- `addRoom(projectDir, yyp, name, options)` (`:33`) — creates the directory, the
  creation-code file when the string is non-empty (`:44-47`), a `$GMRoom`
  record (`:57`) with the default instance + background layers, registers the
  resource and appends the `RoomOrderNodes` entry. Views follow the room size
  (`:49-55`).
- `editRoom(projectDir, yyp, name, { width?, height?, persistent? })` (`:185`) —
  rewrites only those fields; resizes the view ports/windows too.
- `reorderRoom(yyp, roomName, newIndex)` (`:226`) — absolute 0-based position in
  `RoomOrderNodes`, the order `room_goto_next/previous` follow; index is clamped
  (`:232`).
- `moveRoomRelativeTo(yyp, roomName, targetRoomName, "before" | "after")`
  (`:244`) — refuses a self-relative move (`:250`), re-finds the target index
  after removal (`:260`).
- `addRoomInstance(projectDir, roomName, { objectName, x, y, ... })`
  (`instances.ts:23`) — appends to the room's instance layer and its
  `instanceCreationOrder`; the object must already exist.

## Contracts

- Deleting a room also drops its `RoomOrderNodes` entry (`delete.ts:70-73`);
  nothing else prunes the order.
- `add_room` is an *append* tool and is therefore **not** auto-snapshotted;
  `edit_room`, `reorder_room` and `move_room_relative` are (`auto-snapshot.md`).
- No multi-file transaction: each room write is atomic on its own, but a crash
  between the room `.yy` and the `.yyp` write can leave the two out of step
  (`docs/specs/A-objects-rooms.md:210`).
- Layer/tile/instance writers rewrite the same `.yy` and all go through
  `writeRoomYy` (one atomic write) — see `room-layers.md`.

## Dependencies

- In: `yyp.ts` (registration, versions, folder), `room_layers.ts` (read/write,
  grid), `atomic.ts`.
- Out: `index.ts` dispatch; `delete.ts` (room order cleanup); `lint.ts`.
