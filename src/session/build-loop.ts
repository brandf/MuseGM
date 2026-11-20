/**
 * Chat-driven building loop (FR-1) + undo (FR-8).
 *
 * The creator talks in intent ("add a door here", "make this room 10
 * units wider", "undo that") and the loop turns each line into a small
 * spec edit, rebuilds the room from the edited spec, and posts ONE
 * confirmation line in chat. Muse's tokens go to the decisions (the
 * op); code does the enumeration (placements, wall splits, fog
 * positions) and the playback (the rebuild).
 *
 * PURE functions only — no Foundry, no network, no vendored MCP
 * client (importing it validates FOUNDRY_URL at import time and breaks
 * plain `bun test`). The live execution (buildTileRoom /
 * rebuildTileRoom / Scene delete + the chat post) lives in
 * `build-exec.ts`, imported lazily by the monitor only when a build
 * request actually arrives.
 *
 * Three layers:
 * - `parseBuildRequest` — chat line -> BuildOp (or a clarification
 *   question, or "can't do that yet", or null when it isn't a build
 *   request at all). Only the intents the composer already supports:
 *   room create, widen, door add/move (incl. secret doors), dressing
 *   add, fog add, regional overlay, corridor. Anything else is
 *   "unsupported", never a hallucinated build.
 * - `applyOp` / `BuildSession` — the edit history. Layout ops are
 *   pure and non-mutating, so the history is just a list of specs and
 *   undo is the previous one. Every entry records the GM's exact
 *   words + the op, so the history reads in chat.
 * - `planSync` — given the dungeon before and after an edit and the
 *   rooms already built on the server, which rooms to build, rebuild,
 *   or delete. The executor runs the plan; this module only plans it.
 *
 * "Here" (FR-1: "add a door here") resolves from the named wall, or
 * the monitor asks which wall — the parser never guesses a position.
 * Resolving "here" from the GM's last ping/cursor is a live follow-up
 * (the monitor doesn't track cursor positions yet); see BACKLOG.md.
 */
import {
  addCorridor,
  applyOverlay,
  doorEntryCell,
  layoutRoom,
  widenRoom,
  TILE_PX,
  type DoorSpec,
  type DungeonRoomSpec,
  type DungeonSpec,
  type Pack,
  type Placement,
  type RoomSpec,
  type WallSide,
} from "../worldbuilding/tiles-layout.js";
import { oppositeSide, toSquares, type LengthUnit } from "../worldbuilding/maze.js";
import { planDressing } from "./dressing.js";

// ---------------------------------------------------------------- types

/** One build decision — compact, JSON-shaped, the only thing Muse (or
 *  the parser) authors. Code expands it into placements and tiles. */
export type BuildOp =
  | {
      type: "create-room";
      name: string;
      gridW: number;
      gridH: number;
      doors: { wall: WallSide; secret?: boolean }[];
      chest: boolean;
      torches: boolean;
      fog: boolean;
    }
  | { type: "widen"; side: WallSide; by: number }
  | { type: "add-door"; wall: WallSide; at: number; secret?: boolean }
  | { type: "move-door"; wall: WallSide; fromAt: number; toAt: number }
  | { type: "add-dressing"; tile: string; where: DressingWhere }
  | { type: "add-torches" }
  | { type: "add-fog" }
  | { type: "overlay"; region: OverlayRegion; variants: Record<string, string> }
  | { type: "add-corridor"; direction: WallSide; length: number; unit: LengthUnit }
  | { type: "undo" }
  | { type: "redo" };

/** Where a dressing tile goes, in the creator's words — resolved to
 *  cells at apply time, against the room's actual size. */
export type DressingWhere =
  | { kind: "corner"; corner?: "nw" | "ne" | "sw" | "se" }
  | { kind: "center" }
  | { kind: "entry" };

export type OverlayRegion = "north-half" | "south-half" | "east-half" | "west-half" | "whole";

/** What the parser decided about one chat line. */
export type BuildParseResult =
  | { kind: "build"; op: BuildOp }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported"; reason: string };

/** What the parser may need from the session to resolve "that door"
 *  and "this room": the room currently being built. */
export interface BuildParseContext {
  room?: RoomSpec;
}

/** The loop's state: a dungeon (rooms + links) and which room the
 *  creator is currently editing. A one-room build is a dungeon with
 *  one room and no links. */
export interface BuildState {
  dungeon: DungeonSpec;
  activeRoom: string | null;
}

/** One history entry: the GM's exact words, the op, and the line
 *  that was posted — so "undid: ..." reads in chat. */
export interface BuildHistoryEntry {
  said: string;
  op: BuildOp;
  summary: string;
}

// ---------------------------------------------------------------- parser

const WALL_WORDS =
  "(north|northern|south|southern|east|eastern|west|western|top|bottom|left|right)";

function wallFromWord(w: string): WallSide | null {
  const l = w.toLowerCase();
  if (l.startsWith("north") || l === "top") return "north";
  if (l.startsWith("south") || l === "bottom") return "south";
  if (l.startsWith("east") || l === "right") return "east";
  if (l.startsWith("west") || l === "left") return "west";
  return null;
}

/** A wall named in the line ("the north wall", "on the south side",
 *  or a bare cardinal). "left"/"right" only count next to "wall"/"side"
 *  — in "move that door left", left is a direction, not a wall. */
export function parseWall(text: string): WallSide | null {
  const m =
    new RegExp(`\\b${WALL_WORDS}\\s+(?:wall|side)\\b`, "i").exec(text) ??
    new RegExp("\\b(north|northern|south|southern|east|eastern|west|western|top|bottom)\\b", "i").exec(text);
  return m ? wallFromWord(m[1]) : null;
}

/** A direction ("going north", "to the west", "up", "left"). */
function parseDirection(text: string): WallSide | null {
  const m =
    /\b(northward|southward|eastward|westward|north|northern|south|southern|east|eastern|west|western|up|down|left|right)\b/i.exec(text);
  if (!m) return null;
  const l = m[1].toLowerCase();
  if (l.startsWith("north") || l === "up") return "north";
  if (l.startsWith("south") || l === "down") return "south";
  if (l.startsWith("east") || l === "right") return "east";
  if (l.startsWith("west") || l === "left") return "west";
  return null;
}

/** A length with units ("100 meters", "10 units", "5 ft", "66 squares")
 *  — or a bare number, which reads as squares. */
function parseLength(text: string): { value: number; unit: LengthUnit } | null {
  const m =
    /(\d+(?:\.\d+)?)\s*(meters?|metres?|feet|foot|ft|squares?|sq|units?|m)\b/i.exec(text);
  if (!m) {
    const bare = /\bby\s+(\d+(?:\.\d+)?)\b/i.exec(text) ?? /\b(\d+(?:\.\d+)?)\b/.exec(text);
    return bare ? { value: Number(bare[1]), unit: "squares" } : null;
  }
  const u = m[2].toLowerCase();
  const unit: LengthUnit =
    u === "m" || u.startsWith("meter") || u.startsWith("metre")
      ? "m"
      : u.startsWith("f")
        ? "ft"
        : "squares"; // squares, sq, units — a unit is a square
  return { value: Number(m[1]), unit };
}

/** The middle cell along a wall — where a door goes when the creator
 *  names the wall but not the cell. */
export function middleAt(wall: WallSide, gridW: number, gridH: number): number {
  const n = wall === "north" || wall === "south" ? gridW : gridH;
  return Math.floor(n / 2);
}

/** "Left" as if you are standing in the room facing that wall: north
 *  wall left = west (at-1); south wall left = east (at+1); west wall
 *  left = south (at+1); east wall left = north (at-1). "Right" is the
 *  opposite step. */
export function leftDelta(wall: WallSide): number {
  return wall === "north" || wall === "east" ? -1 : 1;
}

const SIZE_WORDS: Record<string, [number, number]> = {
  tiny: [5, 4],
  small: [6, 5],
  medium: [8, 6],
  large: [10, 8],
  huge: [12, 10],
};

const ROOM_KINDS = ["crypt", "tavern", "hall", "chamber", "lair", "vault", "temple", "chapel", "cellar"];

/** A room word that introduces a NEW room ("a room", "the crypt") —
 *  not a count ("3-room dungeon", where "room" is part of "3-room"). */
function hasRoomWord(s: string): boolean {
  return new RegExp(
    `(?<!\\d-)\\b(room|${ROOM_KINDS.join("|")})\\b`,
    "i",
  ).test(s);
}

/** A widen request: the verb "widen", or "wider/bigger" applied to an
 *  EXISTING room ("this room", "it", "the room", "a bit wider") — not
 *  "build a wider room", which is a create. */
function isWidenRequest(s: string): boolean {
  if (/\bwiden\b/i.test(s)) return true;
  if (!/\b(wider|bigger)\b/i.test(s)) return false;
  // "a wider room" / "a bigger hall" introduces a new room — a create.
  return !/\b(a|an)\s+(?:\w+\s+)?(?:room|hall|chamber|crypt|tavern|lair|vault|temple|chapel|cellar)\b/i.test(s);
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseRoomName(text: string): string {
  const called =
    /\b(?:called|named)\s+(?:the\s+)?["']?([A-Za-z][A-Za-z'’ -]{0,30}?)(?:["']|$|\s+with\b|\s+that\b|\.)/i.exec(text);
  if (called) return titleCase(called[1].trim());
  if (/\bentry\s+(?:hall|room)\b/i.test(text)) return "Entry Hall";
  const kind = new RegExp(`\\b(${ROOM_KINDS.join("|")})\\b`, "i").exec(text);
  if (kind) return titleCase(kind[1]);
  return "Room";
}

/** A door's cell when the creator names one: "cell 5", "at 5". */
function parseCell(text: string): number | null {
  const m = /\b(?:cell|at)\s+(\d+)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

const BUILD_VERBS =
  /\b(build|make|create|add|put|place|move|widen|carve|dig|undo|redo)\b/i;
const BUILD_NOUNS =
  /\b(room|door|wall|corridor|hall|chamber|dungeon|fog|torch|torches|chest|maze|tile|floor|overlay|passage|hallway|secret|darker|darkness|theme|gothic|crypt|tavern|lair|vault|temple)\b/i;

/**
 * Parse one chat line into a build decision. Returns null when the
 * line isn't a build request at all (so the monitor falls through to
 * the question / needs-agent paths). Ambiguity is a question, never a
 * guess; out-of-scope is "unsupported", never a hallucinated build.
 *
 * Recognized (Nov 19 phrasings first):
 *   "build an 8x6 room / entry hall / crypt [with a south door] [and a chest] [with torches]"
 *   "start with a small entry room"
 *   "make this room 10 units wider" / "a bit wider" / "widen the room west by 5"
 *   "add a door [on the north wall]" / "put a secret door in the north wall"
 *   "move that door left" / "move the south door to cell 5"
 *   "add some bones / rubble / a pillar / a chest [in the corner / in the middle / near the door]"
 *   "add torches" / "add fog" / "more fog"
 *   "make the north half underwater" / "make this part underwater" (→ asks which part)
 *   "add a corridor going north for 100 meters"
 *   "undo that" / "redo that"
 */
export function parseBuildRequest(
  text: string,
  ctx?: BuildParseContext,
): BuildParseResult | null {
  const s = text.replace(/\s+/g, " ").replace(/[?!.]+$/, "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();

  // Undo / redo — the line must lead with it ("undo that room" is
  // FR-8's phrasing; "I can't undo this" in roleplay is not).
  if (/^(undo|revert|take (?:that|it) back)\b/i.test(s) || /\bundo (?:that|it|this|the last(?: one)?)\b/i.test(s)) {
    return { kind: "build", op: { type: "undo" } };
  }
  if (/^(redo|re-apply)\b/i.test(s) || /\bredo (?:that|it|this)\b/i.test(s)) {
    return { kind: "build", op: { type: "redo" } };
  }

  // Corridor — direction first, length in the creator's units.
  if (/\bcorridor\b/i.test(s)) {
    const direction = parseDirection(s);
    if (!direction) {
      return {
        kind: "clarify",
        question: "Which way should the corridor run — north, south, east, or west?",
      };
    }
    const len = parseLength(s) ?? { value: 10, unit: "squares" as LengthUnit };
    return { kind: "build", op: { type: "add-corridor", direction, length: len.value, unit: len.unit } };
  }

  // Widen — "make this room 10 units wider", "a bit wider". Runs
  // before create-room: "make this room wider" contains "make" + "room"
  // and would otherwise parse as a create.
  if (isWidenRequest(s)) {
    const side = parseDirection(s) ?? "east";
    const len = parseLength(s);
    const by = len ? toSquares(len.value, len.unit) : 2;
    return { kind: "build", op: { type: "widen", side, by: Math.max(1, by) } };
  }

  // Create a room. "Build a 3-room dungeon" has no standalone room
  // word, so it falls through to the unsupported detector below.
  if (
    /\b(build|make|create|start(?:ing)?(?: with)?)\b/i.test(s) &&
    hasRoomWord(s)
  ) {
    const dims =
      /(\d+)\s*[x×]\s*(\d+)/.exec(s) ?? /(\d+)\s+by\s+(\d+)/i.exec(s);
    const sizeWord = /\b(tiny|small|medium|large|huge)\b/i.exec(s);
    const [gridW, gridH] = dims
      ? [Number(dims[1]), Number(dims[2])]
      : sizeWord
        ? SIZE_WORDS[sizeWord[1].toLowerCase()]
        : [8, 6];
    const doors: { wall: WallSide; secret?: boolean }[] = [];
    const seen = new Set<string>();
    const doorRe = /(secret\s+)?(north|south|east|west)\s+door\b/gi;
    let dm: RegExpExecArray | null;
    while ((dm = doorRe.exec(s)) !== null) {
      const wall = dm[2].toLowerCase() as WallSide;
      if (!seen.has(wall)) {
        seen.add(wall);
        doors.push({ wall, ...(dm[1] ? { secret: true } : {}) });
      }
    }
    const doorOnRe = /door\s+(?:on|in)\s+(?:the\s+)?(north|south|east|west)\s+wall\b/gi;
    while ((dm = doorOnRe.exec(s)) !== null) {
      const wall = dm[1].toLowerCase() as WallSide;
      if (!seen.has(wall)) {
        seen.add(wall);
        doors.push({ wall });
      }
    }
    if (/\bsecret\s+door\b/i.test(s) && doors.length === 0) {
      const wall = parseWall(s);
      if (!wall) {
        return {
          kind: "clarify",
          question: "Which wall should the secret door go on — north, south, east, or west?",
        };
      }
      doors.push({ wall, secret: true });
    }
    return {
      kind: "build",
      op: {
        type: "create-room",
        name: parseRoomName(s),
        gridW,
        gridH,
        doors,
        chest: /\bchest\b/i.test(s),
        torches: /\btorches?\b/i.test(s),
        fog: /\bfog\b/i.test(s),
      },
    };
  }

  // Add a door.
  if (/\b(add|put|place)\b/i.test(s) && /\bdoor\b/i.test(s)) {
    const secret = /\b(secret|hidden)\b/i.test(s);
    const wall = parseWall(s);
    if (!wall) {
      return {
        kind: "clarify",
        question: `Which wall should the ${secret ? "secret " : ""}door go on — north, south, east, or west?`,
      };
    }
    const at = parseCell(s);
    return {
      kind: "build",
      op: {
        type: "add-door",
        wall,
        at: at ?? -1, // -1 = middle cell, resolved at apply time
        ...(secret ? { secret: true } : {}),
      },
    };
  }

  // Move a door.
  if (/\bmove\b/i.test(s) && /\bdoor\b/i.test(s)) {
    const wall = parseWall(s);
    const toAt = parseCell(s);
    const room = ctx?.room;
    const doors = room?.doors ?? [];
    let from: DoorSpec | undefined;
    if (wall) {
      const onWall = doors.filter((d) => d.wall === wall);
      if (onWall.length === 0) {
        return {
          kind: "clarify",
          question: `There's no door on the ${wall} wall yet — which door did you mean?`,
        };
      }
      if (onWall.length > 1) {
        return {
          kind: "clarify",
          question: `There are ${onWall.length} doors on the ${wall} wall (cells ${onWall.map((d) => d.at).join(", ")}) — which cell is it in?`,
        };
      }
      from = onWall[0];
    } else if (doors.length === 1) {
      from = doors[0];
    } else if (doors.length === 0) {
      return {
        kind: "clarify",
        question: "There's no door in this room yet — which wall should the door go on?",
      };
    } else {
      return {
        kind: "clarify",
        question: "Which door — the one on the north, south, east, or west wall?",
      };
    }
    if (!from) {
      return { kind: "clarify", question: "Which door did you mean?" };
    }
    const effectiveWall = from.wall;
    if (toAt !== null) {
      return { kind: "build", op: { type: "move-door", wall: effectiveWall, fromAt: from.at, toAt } };
    }
    const dir = /\bleft\b/i.test(s) ? -1 : /\bright\b/i.test(s) ? 1 : 0;
    if (dir === 0) {
      return {
        kind: "clarify",
        question: `Move the ${effectiveWall} door which way — left, right, or to a cell number?`,
      };
    }
    const byM = /\bby\s+(\d+)\b/i.exec(s);
    const steps = byM ? Number(byM[1]) : 1;
    const step = dir === -1 ? leftDelta(effectiveWall) : -leftDelta(effectiveWall);
    const to = from.at + step * steps;
    return { kind: "build", op: { type: "move-door", wall: effectiveWall, fromAt: from.at, toAt: to } };
  }

  // Dressing — bones, rubble, pillar, ritual circle, altar, skeleton,
  // chest. "Here" with no position asks; no position defaults to the
  // south-east corner (said in the summary, so it's visible).
  const DRESSING_TILES: Record<string, string> = {
    bones: "bones",
    bone: "bones",
    rubble: "rubble",
    pillar: "pillar",
    "ritual circle": "ritual-circle",
    altar: "altar",
    skeleton: "skeleton",
    chest: "chest",
  };
  const dressingMatch = new RegExp(
    `\\b(add|put|place)\\b.*\\b(${Object.keys(DRESSING_TILES).join("|")})\\b`,
    "i",
  ).exec(s);
  if (dressingMatch) {
    const tile = DRESSING_TILES[dressingMatch[2].toLowerCase()];
    if (/\bhere\b/i.test(s) && !/\b(corner|middle|center|near|by)\b/i.test(s)) {
      return {
        kind: "clarify",
        question: `Where should the ${tile} go — in a corner, in the middle, or near the door?`,
      };
    }
    const cornerM = /\b(northwest|northeast|southwest|southeast|nw|ne|sw|se)\s+corner\b/i.exec(s);
    const cornerMap: Record<string, "nw" | "ne" | "sw" | "se"> = {
      northwest: "nw", nw: "nw", northeast: "ne", ne: "ne",
      southwest: "sw", sw: "sw", southeast: "se", se: "se",
    };
    const where: DressingWhere = /\bcorner\b/i.test(s)
      ? { kind: "corner", corner: cornerM ? cornerMap[cornerM[1].toLowerCase()] : "se" }
      : /\b(middle|center|centre)\b/i.test(s)
        ? { kind: "center" }
        : /\b(near|by|next to)\b.{0,12}\bdoor\b/i.test(s)
          ? { kind: "entry" }
          : { kind: "corner", corner: "se" };
    return { kind: "build", op: { type: "add-dressing", tile, where } };
  }

  // Torches — the dressing pass, torch items only (candles and
  // braziers have no tiles yet, so they are never smuggled in).
  if (/\b(add|put|more)\b/i.test(s) && /\btorches?\b/i.test(s)) {
    return { kind: "build", op: { type: "add-torches" } };
  }

  // Fog.
  if (/\b(add|more|foggy|fog)\b/i.test(s) && /\bfog\b/i.test(s)) {
    return { kind: "build", op: { type: "add-fog" } };
  }

  // Regional overlay — "make the north half underwater". "This part"
  // with no region asks which part.
  if (/\b(underwater|wet|flooded)\b/i.test(s)) {
    const region = /\b(north|south|east|west)\s+half\b/i.exec(s)?.[1].toLowerCase() as
      | "north" | "south" | "east" | "west" | undefined;
    if (!region && /\bwhole\b/i.test(s)) {
      return {
        kind: "build",
        op: {
          type: "overlay",
          region: "whole",
          variants: { "floor-plain": "floor-dark", "floor-cracked": "floor-dark", "floor-rubble": "floor-dark" },
        },
      };
    }
    if (!region) {
      return {
        kind: "clarify",
        question: "Which part should go underwater — the north, south, east, or west half?",
      };
    }
    return {
      kind: "build",
      op: {
        type: "overlay",
        region: `${region}-half` as OverlayRegion,
        variants: { "floor-plain": "floor-dark", "floor-cracked": "floor-dark", "floor-rubble": "floor-dark" },
      },
    };
  }

  // Build-ish but out of scope — say so plainly, never build the
  // wrong thing. (A line with a build verb but no build noun is just
  // chat — null, so the monitor logs needs-agent.)
  if (BUILD_VERBS.test(s) && BUILD_NOUNS.test(s)) {
    if (/\bdungeon\b/i.test(s)) {
      return {
        kind: "unsupported",
        reason: "I build one room at a time — a whole dungeon comes from the floor planner",
      };
    }
    if (/\b(darker|darkness|theme|gothic)\b/i.test(s)) {
      return {
        kind: "unsupported",
        reason: "darkness and re-skins aren't room edits yet — themes are a later pack swap",
      };
    }
    return {
      kind: "unsupported",
      reason:
        "that isn't in the kit yet — I can build rooms, widen them, add or move doors, add dressing and fog, carve corridors, and undo",
    };
  }
  return null;
}

// ---------------------------------------------------------------- applying ops

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "room";
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function cellsAlong(wall: WallSide, gridW: number, gridH: number): number {
  return wall === "north" || wall === "south" ? gridW : gridH;
}

function checkDoorAt(wall: WallSide, at: number, gridW: number, gridH: number): void {
  const n = cellsAlong(wall, gridW, gridH);
  if (!Number.isInteger(at) || at < 1 || at > n - 2) {
    throw new Error(
      `A door on the ${wall} wall must sit at cell 1..${n - 2} (not in a corner) — got ${at}.`,
    );
  }
}

function roomById(state: BuildState, id: string): DungeonRoomSpec {
  const room = state.dungeon.rooms.find((r) => r.id === id);
  if (!room) throw new Error(`No room "${id}" in this build.`);
  return room;
}

function replaceRoom(state: BuildState, room: DungeonRoomSpec): BuildState {
  return {
    ...state,
    dungeon: {
      ...state.dungeon,
      rooms: state.dungeon.rooms.map((r) => (r.id === room.id ? room : r)),
    },
  };
}

/** Tile size in cells, from the pack when given, else the pack's known
 *  defaults (dressing is 2x2; fog wisps are 2x2, large fog and pools
 *  are 4x4). The pack is the authority — the defaults only cover the
 *  --demo path's fake pack. */
function tileCells(tile: string, pack?: Pack): number {
  const entry = pack?.get(tile);
  if (entry) return entry.sizePx / TILE_PX;
  if (tile === "fog-wisp-large" || tile === "fog-pool") return 4;
  return 2;
}

function resolvePlacement(
  where: DressingWhere,
  tile: string,
  room: RoomSpec,
  pack?: Pack,
): { gx: number; gy: number } {
  const size = tileCells(tile, pack);
  if (size > room.gridW || size > room.gridH) {
    throw new Error(
      `The "${tile}" tile (${size}x${size}) doesn't fit in a ${room.gridW}x${room.gridH} room.`,
    );
  }
  switch (where.kind) {
    case "center":
      return { gx: Math.floor((room.gridW - size) / 2), gy: Math.floor((room.gridH - size) / 2) };
    case "entry": {
      const first = room.doors?.[0];
      if (!first) throw new Error(`There's no door in this room to put the "${tile}" near.`);
      const { gx, gy } = doorEntryCell(first.wall, first.at, room.gridW, room.gridH);
      return { gx: Math.min(gx, room.gridW - size), gy: Math.min(gy, room.gridH - size) };
    }
    case "corner": {
      const c = where.corner ?? "se";
      return {
        gx: c === "nw" || c === "sw" ? 0 : room.gridW - size,
        gy: c === "nw" || c === "ne" ? 0 : room.gridH - size,
      };
    }
  }
}

/** Torches for a room, from the dressing generator (FR-16) — torch
 *  items only. Candles and braziers have no tiles yet, so they are
 *  never smuggled into a "torches" request. */
function torchesFor(room: RoomSpec): { torches: { gx: number; gy: number }[]; dressing: Placement[] } {
  const plan = planDressing(room);
  const torches = plan.items.filter((i) => i.kind === "torch");
  return {
    torches: torches.map((i) => ({ gx: i.gx, gy: i.gy })),
    dressing: torches
      .filter((i) => i.tile !== null)
      .map((i) => ({ tile: i.tile as string, gx: i.gx, gy: i.gy })),
  };
}

function mergeTorches<T extends RoomSpec>(room: T): { room: T; added: number } {
  const { torches, dressing } = torchesFor(room);
  const haveTorch = new Set((room.torches ?? []).map((t) => `${t.gx},${t.gy}`));
  const newTorches = torches.filter((t) => !haveTorch.has(`${t.gx},${t.gy}`));
  const haveDressing = new Set((room.dressing ?? []).map((p) => `${p.tile}:${p.gx},${p.gy}`));
  const newDressing = dressing.filter((p) => !haveDressing.has(`${p.tile}:${p.gx},${p.gy}`));
  if (newTorches.length === 0 && newDressing.length === 0) return { room, added: 0 };
  return {
    room: {
      ...room,
      torches: [...(room.torches ?? []), ...newTorches],
      dressing: [...(room.dressing ?? []), ...newDressing],
    },
    added: newTorches.length,
  };
}

function overlayRect(region: OverlayRegion, gridW: number, gridH: number): { gx: number; gy: number; w: number; h: number } {
  switch (region) {
    case "north-half": return { gx: 0, gy: 0, w: gridW, h: Math.floor(gridH / 2) };
    case "south-half": return { gx: 0, gy: Math.ceil(gridH / 2), w: gridW, h: Math.floor(gridH / 2) };
    case "west-half": return { gx: 0, gy: 0, w: Math.floor(gridW / 2), h: gridH };
    case "east-half": return { gx: Math.ceil(gridW / 2), gy: 0, w: Math.floor(gridW / 2), h: gridH };
    case "whole": return { gx: 0, gy: 0, w: gridW, h: gridH };
  }
}

function describeRoomShort(room: RoomSpec): string {
  const doors = (room.doors ?? []).map((d) => `${d.secret ? "secret " : ""}${d.wall}@${d.at}`).join(", ");
  const bits = [`${room.gridW}×${room.gridH}`];
  if (doors) bits.push(`door${(room.doors ?? []).length > 1 ? "s" : ""} ${doors}`);
  if ((room.dressing ?? []).length > 0) bits.push(`${room.dressing!.length} dressing`);
  if ((room.torches ?? []).length > 0) bits.push(`${room.torches!.length} torches`);
  if ((room.fog ?? []).length > 0) bits.push("fog");
  return `**${room.name}** (${bits.join(", ")})`;
}

/**
 * Apply one op to a build state. Pure and non-mutating — the input is
 * never touched, the returned state is new. Throws a plain-English
 * error when the op can't apply (no room yet, door out of range, tile
 * doesn't fit); the executor posts the message in chat.
 */
export function applyOp(
  state: BuildState,
  op: BuildOp,
  opts?: { pack?: Pack },
): { state: BuildState; summary: string; changed: boolean } {
  const pack = opts?.pack;
  switch (op.type) {
    case "create-room": {
      if (op.gridW < 1 || op.gridH < 1) {
        throw new Error(`A room must be at least 1x1 squares, got ${op.gridW}x${op.gridH}.`);
      }
      let id = slugify(op.name);
      if (state.dungeon.rooms.some((r) => r.id === id)) {
        let i = 2;
        while (state.dungeon.rooms.some((r) => r.id === `${id}-${i}`)) i += 1;
        id = `${id}-${i}`;
      }
      let room: DungeonRoomSpec = {
        id,
        name: op.name,
        gridW: op.gridW,
        gridH: op.gridH,
        seed: 1,
        doors: op.doors.map((d) => ({
          wall: d.wall,
          at: middleAt(d.wall, op.gridW, op.gridH),
          ...(d.secret ? { secret: true } : {}),
        })),
        dressing: op.chest
          ? [{ tile: "chest", gx: op.gridW - 2, gy: op.gridH - 2 }]
          : [],
        fog: op.fog
          ? [{ tile: "fog-pool", gx: Math.floor((op.gridW - 4) / 2), gy: Math.floor((op.gridH - 4) / 2) }]
          : [],
      };
      for (const d of room.doors ?? []) checkDoorAt(d.wall, d.at, op.gridW, op.gridH);
      if (room.fog && room.fog.length > 0 && (op.gridW < 4 || op.gridH < 4)) {
        throw new Error(`A ${op.gridW}x${op.gridH} room is too small for a fog pool (needs 4x4).`);
      }
      let torchNote = "";
      if (op.torches) {
        const merged = mergeTorches(room);
        room = merged.room;
        torchNote = merged.added > 0 ? `, ${merged.added} torches` : ", torches already placed";
      }
      const doorNote =
        (room.doors ?? []).length > 0
          ? `, ${(room.doors ?? []).map((d) => `${d.secret ? "secret " : ""}${d.wall} door`).join(", ")}`
          : "";
      const chestNote = op.chest ? ", chest" : "";
      const fogNote = op.fog ? ", fog" : "";
      return {
        state: {
          dungeon: { ...state.dungeon, rooms: [...state.dungeon.rooms, room] },
          activeRoom: id,
        },
        summary: `Built the ${op.gridW}×${op.gridH} ${room.name}${doorNote}${chestNote}${torchNote}${fogNote}.`,
        changed: true,
      };
    }
    case "widen": {
      if (!state.activeRoom) throw new Error("No room to widen yet — build a room first.");
      const room = roomById(state, state.activeRoom);
      // widenRoom returns a RoomSpec; the dungeon id lives on our side.
      const next: DungeonRoomSpec = { ...widenRoom(room, op.side, op.by), id: room.id };
      return {
        state: replaceRoom(state, next),
        summary: `Widened the ${room.name} ${op.by} ${op.by === 1 ? "square" : "squares"} ${op.side} (now ${next.gridW}×${next.gridH}).`,
        changed: true,
      };
    }
    case "add-door": {
      if (!state.activeRoom) throw new Error("No room to add a door to yet — build a room first.");
      const room = roomById(state, state.activeRoom);
      const at = op.at === -1 ? middleAt(op.wall, room.gridW, room.gridH) : op.at;
      checkDoorAt(op.wall, at, room.gridW, room.gridH);
      const clash = [...(room.doors ?? []), ...(room.openings ?? [])].some(
        (d) => d.wall === op.wall && d.at === at,
      );
      if (clash) {
        throw new Error(`There's already a door or opening on the ${op.wall} wall at cell ${at}.`);
      }
      const next: DungeonRoomSpec = {
        ...room,
        doors: [...(room.doors ?? []), { wall: op.wall, at, ...(op.secret ? { secret: true } : {}) }],
      };
      return {
        state: replaceRoom(state, next),
        summary: `Added a ${op.secret ? "secret " : ""}door to the ${op.wall} wall of the ${room.name}.`,
        changed: true,
      };
    }
    case "move-door": {
      if (!state.activeRoom) throw new Error("No room with a door to move yet — build a room first.");
      const room = roomById(state, state.activeRoom);
      const door = (room.doors ?? []).find((d) => d.wall === op.wall && d.at === op.fromAt);
      if (!door) {
        throw new Error(`There's no door on the ${op.wall} wall at cell ${op.fromAt} to move.`);
      }
      checkDoorAt(op.wall, op.toAt, room.gridW, room.gridH);
      if (op.toAt === op.fromAt) {
        return { state, summary: `The ${op.wall} door is already at cell ${op.toAt}.`, changed: false };
      }
      const clash = [...(room.doors ?? []), ...(room.openings ?? [])].some(
        (d) => d !== door && d.wall === op.wall && d.at === op.toAt,
      );
      if (clash) {
        throw new Error(`There's already a door or opening on the ${op.wall} wall at cell ${op.toAt}.`);
      }
      const next: DungeonRoomSpec = {
        ...room,
        doors: (room.doors ?? []).map((d) =>
          d === door ? { ...d, at: op.toAt } : d,
        ),
      };
      return {
        state: replaceRoom(state, next),
        summary: `Moved the ${op.wall} door from cell ${op.fromAt} to cell ${op.toAt}.`,
        changed: true,
      };
    }
    case "add-dressing": {
      if (!state.activeRoom) throw new Error("No room to dress yet — build a room first.");
      const room = roomById(state, state.activeRoom);
      const { gx, gy } = resolvePlacement(op.where, op.tile, room, pack);
      const next: DungeonRoomSpec = {
        ...room,
        dressing: [...(room.dressing ?? []), { tile: op.tile, gx, gy }],
      };
      const whereNote =
        op.where.kind === "corner"
          ? ` in the ${op.where.corner ?? "se"} corner`
          : op.where.kind === "center"
            ? " in the middle"
            : " by the door";
      return {
        state: replaceRoom(state, next),
        summary: `Added ${op.tile === "bones" ? "some bones" : `a ${op.tile}`} to the ${room.name}${whereNote}.`,
        changed: true,
      };
    }
    case "add-torches": {
      if (!state.activeRoom) throw new Error("No room to light yet — build a room first.");
      const room = roomById(state, state.activeRoom);
      const merged = mergeTorches(room);
      if (merged.added === 0) {
        return { state, summary: `The ${room.name} already has torches on every wall.`, changed: false };
      }
      return {
        state: replaceRoom(state, merged.room),
        summary: `Added ${merged.added} torches to the ${room.name}.`,
        changed: true,
      };
    }
    case "add-fog": {
      if (!state.activeRoom) throw new Error("No room to fog yet — build a room first.");
      const room = roomById(state, state.activeRoom);
      const tile = "fog-wisp-large";
      const size = tileCells(tile, pack);
      if (size > room.gridW || size > room.gridH) {
        throw new Error(`A ${room.gridW}x${room.gridH} room is too small for a fog wisp (needs ${size}x${size}).`);
      }
      // Fog drifts: each new wisp lands at the next offset in a small
      // cycle around the centre, so "more fog" spreads instead of
      // stacking on the same cell.
      const offsets: [number, number][] = [[0, 0], [-2, -2], [2, 2], [-2, 2], [2, -2]];
      const n = (room.fog ?? []).length;
      const [dx, dy] = offsets[n % offsets.length];
      const gx = Math.max(0, Math.min(room.gridW - size, Math.floor((room.gridW - size) / 2) + dx));
      const gy = Math.max(0, Math.min(room.gridH - size, Math.floor((room.gridH - size) / 2) + dy));
      const next: DungeonRoomSpec = {
        ...room,
        fog: [...(room.fog ?? []), { tile, gx, gy }],
      };
      return {
        state: replaceRoom(state, next),
        summary:
          n === 0
            ? `Added fog to the ${room.name}.`
            : `Added more fog to the ${room.name} (${n + 1} wisps now).`,
        changed: true,
      };
    }
    case "overlay": {
      if (!state.activeRoom) throw new Error("No room to flood yet — build a room first.");
      const room = roomById(state, state.activeRoom);
      const rect = overlayRect(op.region, room.gridW, room.gridH);
      // applyOverlay returns a RoomSpec; the dungeon id lives on our side.
      const next: DungeonRoomSpec = { ...applyOverlay(room, { ...rect, variants: op.variants }), id: room.id };
      const regionName =
        op.region === "whole" ? "the whole room" : `the ${op.region.replace("-half", "")} half`;
      return {
        state: replaceRoom(state, next),
        summary: `Made ${regionName} of the ${room.name} underwater.`,
        changed: true,
      };
    }
    case "add-corridor": {
      if (!state.activeRoom) throw new Error("No room to run a corridor from yet — build a room first.");
      const fromRoom = roomById(state, state.activeRoom);
      const wall = op.direction; // the corridor leaves through the wall it runs toward
      const n = cellsAlong(wall, fromRoom.gridW, fromRoom.gridH);
      const at = Math.floor(n / 2);
      const nextDungeon = addCorridor(state.dungeon, {
        room: fromRoom.id,
        wall,
        at,
        direction: op.direction,
        length: op.length,
        unit: op.unit,
        width: 1,
      });
      const squares = toSquares(op.length, op.unit);
      // The corridor is an appendage of the room it leaves — the
      // focus stays on the source room, so the next edit ("add some
      // bones") lands in the room, not in a 1-wide corridor.
      return {
        state: { dungeon: nextDungeon, activeRoom: fromRoom.id },
        summary: `Added a corridor running ${op.direction} from the ${fromRoom.name} (${squares} squares, ${op.length}${op.unit === "squares" ? "" : ` ${op.unit}`}).`,
        changed: true,
      };
    }
    case "undo":
    case "redo":
      throw new Error(`"${op.type}" is a history operation, not a build op — use BuildSession.undo()/redo().`);
  }
}

// ---------------------------------------------------------------- the session

/** The edit history: a list of states, an index into it, and the
 *  entries that produced each step. Undo is the previous state, redo
 *  is the next one; a new edit after an undo drops the redo tail. */
export class BuildSession {
  private states: BuildState[];
  private entries: BuildHistoryEntry[] = [];
  private index = 0;

  constructor(initial?: DungeonSpec) {
    this.states = [
      {
        dungeon: initial ? clone(initial) : { rooms: [], links: [] },
        activeRoom: initial?.rooms[0]?.id ?? null,
      },
    ];
  }

  /** The current state (a copy — callers can't mutate the history). */
  current(): BuildState {
    return clone(this.states[this.index]);
  }

  /** The room the creator is currently editing, or null. */
  activeRoomSpec(): RoomSpec | null {
    const cur = this.states[this.index];
    if (!cur.activeRoom) return null;
    return clone(cur.dungeon.rooms.find((r) => r.id === cur.activeRoom) ?? null) as RoomSpec | null;
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.states.length - 1;
  }

  /** Entries applied so far, oldest first. */
  history(): BuildHistoryEntry[] {
    return this.entries.slice(0, this.index);
  }

  /** Entries undone and available to redo, oldest first. */
  undone(): BuildHistoryEntry[] {
    return this.entries.slice(this.index);
  }

  /** Compute the next state for an op without committing it — the
   *  executor validates the result before it commits. */
  peek(op: BuildOp, opts?: { pack?: Pack }): { state: BuildState; summary: string; changed: boolean } {
    if (op.type === "undo" || op.type === "redo") {
      throw new Error(`"${op.type}" is a history operation — use undo()/redo().`);
    }
    return applyOp(this.current(), op, opts);
  }

  /** Commit a state computed by peek(). */
  commit(state: BuildState, said: string, op: BuildOp, summary: string): void {
    this.states = this.states.slice(0, this.index + 1);
    this.entries = this.entries.slice(0, this.index);
    this.states.push(clone(state));
    this.entries.push({ said, op, summary });
    this.index = this.states.length - 1;
  }

  /** Compute + commit in one step (pure use, tests, --demo). */
  apply(op: BuildOp, said: string, opts?: { pack?: Pack }): { summary: string; changed: boolean } {
    const peeked = this.peek(op, opts);
    if (peeked.changed) this.commit(peeked.state, said, op, peeked.summary);
    return { summary: peeked.summary, changed: peeked.changed };
  }

  /** Step back one edit. Returns the entry being undone, or null at
   *  the start of history. */
  undo(): BuildHistoryEntry | null {
    if (!this.canUndo()) return null;
    this.index -= 1;
    return this.entries[this.index];
  }

  /** Step forward one undone edit. Returns the entry being redone,
   *  or null when nothing is undone. */
  redo(): BuildHistoryEntry | null {
    if (!this.canRedo()) return null;
    const entry = this.entries[this.index];
    this.index += 1;
    return entry;
  }
}

// ---------------------------------------------------------------- sync planning

/** One room already built on the server (what buildTileRoom returns). */
export interface BuiltRoomRef {
  sceneId: string;
  tileIds: string[];
  wallIds: string[];
  lightIds: string[];
}

/** What the executor must do to make the table match `after`, given
 *  what the table looked like at `before` and which rooms are already
 *  built. Pure — the executor runs the plan. */
export interface SyncPlan {
  /** New rooms to build as scenes. */
  build: DungeonRoomSpec[];
  /** Changed rooms to rebuild in place (with the ids to delete first). */
  rebuild: { room: DungeonRoomSpec; previous: BuiltRoomRef }[];
  /** Removed rooms whose scenes to delete. */
  remove: { roomId: string; sceneId: string }[];
}

/** Canonical JSON: object keys sorted recursively, so two specs built
 *  by different code paths compare equal when they mean the same room. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function planSync(
  before: DungeonSpec,
  after: DungeonSpec,
  built: Map<string, BuiltRoomRef>,
): SyncPlan {
  const beforeById = new Map(before.rooms.map((r) => [r.id, r]));
  const plan: SyncPlan = { build: [], rebuild: [], remove: [] };
  for (const room of after.rooms) {
    const prev = built.get(room.id);
    if (!prev) {
      plan.build.push(room);
      continue;
    }
    const old = beforeById.get(room.id);
    if (!old || canonical(old) !== canonical(room)) {
      plan.rebuild.push({ room, previous: prev });
    }
  }
  const afterIds = new Set(after.rooms.map((r) => r.id));
  for (const [roomId, ref] of built) {
    if (!afterIds.has(roomId)) plan.remove.push({ roomId, sceneId: ref.sceneId });
  }
  return plan;
}

// ---------------------------------------------------------------- formatting

/** One-line description of a room, for the demo output and the diff. */
export function describeRoom(room: RoomSpec): string {
  return describeRoomShort(room).replace(/\*\*/g, "");
}

/** The whole dungeon in one line per room. */
export function describeDungeon(dungeon: DungeonSpec): string[] {
  if (dungeon.rooms.length === 0) return ["(no rooms yet)"];
  return dungeon.rooms.map((r) => describeRoom(r));
}

/** What changed between two dungeon specs, as short lines. */
export function diffSummary(before: DungeonSpec, after: DungeonSpec): string[] {
  const lines: string[] = [];
  const beforeById = new Map(before.rooms.map((r) => [r.id, r]));
  for (const room of after.rooms) {
    const old = beforeById.get(room.id);
    if (!old) {
      lines.push(`+ room ${room.name} (${room.gridW}×${room.gridH})`);
      continue;
    }
    if (old.gridW !== room.gridW || old.gridH !== room.gridH) {
      lines.push(`${room.name}: ${old.gridW}×${old.gridH} → ${room.gridW}×${room.gridH}`);
    }
    const doorKey = (d: DoorSpec) => `${d.wall}:${d.at}${d.secret ? ":secret" : ""}`;
    const oldDoors = new Set((old.doors ?? []).map(doorKey));
    const newDoors = new Set((room.doors ?? []).map(doorKey));
    for (const d of room.doors ?? []) {
      if (!oldDoors.has(doorKey(d))) lines.push(`+ ${d.secret ? "secret " : ""}door ${d.wall}@${d.at} in ${room.name}`);
    }
    for (const d of old.doors ?? []) {
      if (!newDoors.has(doorKey(d))) lines.push(`- door ${d.wall}@${d.at} in ${room.name}`);
    }
    const count = (label: string, a?: unknown[], b?: unknown[]) => {
      if ((a?.length ?? 0) !== (b?.length ?? 0)) {
        lines.push(`${room.name}: ${label} ${a?.length ?? 0} → ${b?.length ?? 0}`);
      }
    };
    count("dressing", old.dressing, room.dressing);
    count("fog", old.fog, room.fog);
    count("torches", old.torches, room.torches);
    count("overlays", old.overlays, room.overlays);
  }
  const afterIds = new Set(after.rooms.map((r) => r.id));
  for (const room of before.rooms) {
    if (!afterIds.has(room.id)) lines.push(`- room ${room.name} (removed)`);
  }
  const oldLinks = before.links.length;
  const newLinks = after.links.length;
  if (oldLinks !== newLinks) lines.push(`links ${oldLinks} → ${newLinks}`);
  return lines.length > 0 ? lines : ["(no change)"];
}

/** The chat line the monitor posts for a build result. The summary is
 *  already a past-tense sentence; this adds the icon for the op. */
export function formatBuildLine(summary: string, op: BuildOp): string {
  const icon =
    op.type === "create-room" ? "🏰"
    : op.type === "widen" ? "↔️"
    : op.type === "add-door" || op.type === "move-door" ? "🚪"
    : op.type === "add-dressing" ? "✨"
    : op.type === "add-torches" ? "🕯️"
    : op.type === "add-fog" ? "🌫️"
    : op.type === "overlay" ? "💧"
    : op.type === "add-corridor" ? "➡️"
    : op.type === "undo" ? "↩️"
    : "↪️";
  return `${icon} ${summary}`;
}

/** Validate a whole dungeon spec's rooms against the pack (what the
 *  executor runs before it commits — a bad spec never reaches the
 *  table). Throws the composer's own error, plain-English. */
export function validateDungeonRooms(dungeon: DungeonSpec, pack: Pack, serverBase: string): void {
  for (const room of dungeon.rooms) {
    layoutRoom(room, pack, serverBase);
  }
}
