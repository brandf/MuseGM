/**
 * Build-loop executor (FR-1 + FR-8) — the LIVE half.
 *
 * Takes a parsed BuildOp, validates the resulting spec against the
 * pack, commits it to the BuildSession, and syncs the table to match:
 * new rooms are built as scenes, changed rooms are rebuilt in place,
 * removed rooms (undo of a create) have their scene deleted. Returns
 * the one chat line the monitor posts — this module posts nothing
 * itself, so the monitor owns all chat output.
 *
 * This module imports `tiles.ts`, which pulls in the vendored MCP
 * client and validates FOUNDRY_URL at import time — it is NOT safe to
 * import from `bun test`. The monitor loads it with a dynamic import
 * only inside the build branch, so the pure tests never touch it. The
 * sync PLAN (which rooms to build/rebuild/delete) is pure and lives in
 * `build-loop.ts`, where it is unit-tested.
 *
 * Failure shape: a validation error (bad door, tile that doesn't fit)
 * throws BEFORE the session commits and BEFORE anything reaches the
 * table — the monitor posts "I couldn't build that: <reason>" and the
 * session is unchanged, so the GM can rephrase and try again. A
 * failure mid-sync (after the commit) is the known limitation: the
 * session is ahead of the table, and the GM recovers with "undo that"
 * and a re-issue. See BACKLOG.md.
 */
import type { FoundryLive } from "../live.js";
import {
  buildTileRoom,
  rebuildTileRoom,
  type BuiltTileRoom,
} from "../worldbuilding/tiles.js";
import type { Pack } from "../worldbuilding/tiles-layout.js";
import {
  applyOp,
  formatBuildLine,
  planSync,
  validateDungeonRooms,
  type BuildOp,
  type BuildSession,
} from "./build-loop.js";

export interface BuildExecOptions {
  pack: Pack;
  /** Server folder the pack was uploaded to, e.g. "worlds/testbed". */
  serverBase: string;
  /** Rooms already built on the server, by room id — the executor
   *  keeps this map current across builds. */
  built: Map<string, BuiltTileRoom>;
}

/** The server folder for this world, derived the same way
 *  uploadTilePack does it (world title, slugified). */
export function serverBaseForWorld(title: string | null | undefined): string {
  const slug = (title ?? "testbed").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `worlds/${slug}`;
}

/**
 * Execute one build op (or undo/redo) against the live world.
 * Returns the chat line to post. Throws a plain-English error when
 * the op can't apply or the resulting spec is invalid — nothing is
 * committed or built in that case.
 */
export async function executeBuild(
  live: FoundryLive,
  session: BuildSession,
  op: BuildOp,
  said: string,
  opts: BuildExecOptions,
): Promise<string> {
  const { pack, serverBase, built } = opts;

  if (op.type === "undo") {
    const before = session.current();
    const entry = session.undo();
    if (!entry) return "Nothing to undo yet.";
    await syncSession(live, session, built, pack, serverBase, before);
    return `↩️ Undid: ${entry.summary}`;
  }
  if (op.type === "redo") {
    const before = session.current();
    const entry = session.redo();
    if (!entry) return "Nothing to redo.";
    await syncSession(live, session, built, pack, serverBase, before);
    return `↪️ Redid: ${entry.summary}`;
  }

  // Peek, validate, then commit — a bad spec never reaches the table
  // or the history.
  const peeked = session.peek(op, { pack });
  validateDungeonRooms(peeked.state.dungeon, pack, serverBase);
  if (!peeked.changed) return peeked.summary;
  const before = session.current();
  session.commit(peeked.state, said, op, peeked.summary);
  await syncSession(live, session, built, pack, serverBase, before);
  return formatBuildLine(peeked.summary, op);
}

/**
 * Sync the table to the session's current dungeon: build new rooms,
 * rebuild changed ones, delete removed scenes. `before` is the dungeon
 * as it was before the last commit — the caller captures it before
 * stepping the history (undo/redo) or before committing (build ops).
 */
async function syncSession(
  live: FoundryLive,
  session: BuildSession,
  built: Map<string, BuiltTileRoom>,
  pack: Pack,
  serverBase: string,
  before: { dungeon: import("../worldbuilding/tiles-layout.js").DungeonSpec; activeRoom: string | null },
): Promise<void> {
  const after = session.current().dungeon;
  const plan = planSync(before.dungeon, after, built);
  for (const { roomId, sceneId } of plan.remove) {
    await live.modifyDocument("Scene", "delete", { ids: [sceneId] });
    built.delete(roomId);
  }
  for (const { room, previous } of plan.rebuild) {
    const rebuilt = await rebuildTileRoom(live, previous.sceneId, room, pack, serverBase, previous);
    built.set(room.id, rebuilt);
  }
  for (const room of plan.build) {
    const created = await buildTileRoom(live, room, pack, serverBase);
    built.set(room.id, created);
  }
}
