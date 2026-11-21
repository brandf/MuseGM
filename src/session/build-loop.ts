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
 *   room create, widen, door add/move (incl. secret doors), door
 *   verbs (open/close/lock/unlock/listen — BRA-234, the state lives
 *   on the door object in the spec), dressing add, prop move/remove
 *   (BRA-241), fog add, regional overlay, corridor. Anything else is
 *   "unsupported", never a hallucinated build. `parseBuildRequests`
 *   is the compound form: "add a door here and widen the room" is
 *   two ops, applied in order, one confirmation line each.
 * - `applyOp` / `BuildSession` — the edit history. Layout ops are
 *   pure and non-mutating, so the history is just a list of specs and
 *   undo is the previous one. Every entry records the GM's exact
 *   words + the op, so the history reads in chat. The session
 *   snapshots to a state file (`.build-state.json` by default, see
 *   `saveBuildState` / `loadBuildState`) so a monitor restart keeps
 *   the dungeon and the rooms already built on the server.
 * - `planSync` — given the dungeon before and after an edit and the
 *   rooms already built on the server, which rooms to build, rebuild,
 *   or delete. The executor runs the plan; this module only plans it.
 *
 * "Here" (FR-1: "add a door here") resolves from the named wall, or
 * from the GM's last ping/cursor when the monitor passes it in
 * `BuildParseContext.here` (the ping's scene identifies the room, the
 * point identifies the wall/cell) — or the monitor asks which wall.
 * The parser never guesses a position. Rooms are targetable by name
 * ("widen the Entry Hall") via `BuildParseContext.rooms`; a named
 * room becomes the active room, so the next edit lands there too.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  addCorridor,
  applyOverlay,
  doorEntryCell,
  layoutRoom,
  moveProp,
  removeProp,
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
  | { type: "widen"; side: WallSide; by: number; target?: string }
  | { type: "add-door"; wall: WallSide; at: number; secret?: boolean; target?: string }
  | { type: "move-door"; wall: WallSide; fromAt: number; toAt: number; target?: string }
  | { type: "add-dressing"; tile: string; where: DressingWhere; target?: string }
  | { type: "move-prop"; tile: string; from: { gx: number; gy: number }; to: DressingWhere; target?: string }
  | { type: "remove-prop"; tile: string; from: { gx: number; gy: number }; target?: string }
  | { type: "add-torches"; target?: string }
  | { type: "add-fog"; target?: string }
  | { type: "overlay"; region: OverlayRegion; variants: Record<string, string>; target?: string }
  | { type: "add-corridor"; direction: WallSide; length: number; unit: LengthUnit; target?: string }
  | { type: "open-door"; wall: WallSide; at: number; target?: string }
  | { type: "close-door"; wall: WallSide; at: number; target?: string }
  | { type: "lock-door"; wall: WallSide; at: number; key?: string; target?: string }
  | { type: "unlock-door"; wall: WallSide; at: number; key?: string; target?: string }
  | { type: "listen-door"; wall: WallSide; at: number; target?: string }
  | { type: "undo" }
  | { type: "redo" };

/**
 * `target` (a room id) is set when the GM named the room ("widen the
 * Entry Hall") or pinged its scene ("add a door here"). Without it the
 * op applies to the active room. A targeted op also makes that room
 * the active one, so the next edit lands there too.
 */

/** Where a dressing tile goes, in the creator's words — resolved to
 *  cells at apply time, against the room's actual size. */
export type DressingWhere =
  | { kind: "corner"; corner?: "nw" | "ne" | "sw" | "se" }
  | { kind: "center" }
  | { kind: "entry" }
  | { kind: "cell"; gx: number; gy: number };

export type OverlayRegion = "north-half" | "south-half" | "east-half" | "west-half" | "whole";

/** What the parser decided about one chat line. */
export type BuildParseResult =
  | { kind: "build"; op: BuildOp }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported"; reason: string };

/** What the parser may need from the session to resolve "that door",
 *  "this room", a room named in the line, and "here": the room
 *  currently being built, all the rooms in the dungeon, and the GM's
 *  last ping/cursor point (scene already resolved to a room id by the
 *  caller — the monitor owns the scene -> room map). */
export interface BuildParseContext {
  room?: RoomSpec;
  rooms?: DungeonRoomSpec[];
  here?: { roomId: string; x: number; y: number };
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

// ---------------------------------------------------------------- door verbs (BRA-234)

/**
 * A door's verb state — open, closed, or locked. Stored ON the door
 * object in the build session's spec (extra fields on the DoorSpec),
 * so it survives snapshots, `planSync` sees it (canonical() includes
 * it), and a rebuild re-emits the room. The composer (layoutRoom)
 * ignores the extra fields — it still emits a door:1/door:2 wall —
 * so the live Wall doc's `ds` (door state) update is a follow-up for
 * the executor/composer, not this layer. Absent `state` means closed:
 * a door the composer built is a closed door until a verb says
 * otherwise, and only open/locked are stored, so specs written
 * before door verbs stay byte-identical.
 *
 * `key` is the key or method that opens a locked door, as the GM
 * named it ("the brass key", "the rusted key") — recorded when the
 * GM locks with one, kept on the door when it is unlocked (the door's
 * key doesn't change unless the GM names a new one). A lock with no
 * named key keeps any previously recorded key, else is keyless.
 */
export type DoorState = "open" | "closed" | "locked";

/** A door carrying its verb state. */
export interface DoorWithState extends DoorSpec {
  state?: DoorState;
  key?: string;
}

/** The door's state, defaulting to closed when nothing is recorded. */
export function doorStateOf(d: DoorSpec): DoorState {
  return (d as DoorWithState).state ?? "closed";
}

/** The key that opens this door, when the GM named one. */
export function doorKeyOf(d: DoorSpec): string | undefined {
  return (d as DoorWithState).key;
}

/** A copy of the door with the given state (and key, when the caller
 *  passes one — otherwise the recorded key is kept). */
export function withDoorState(d: DoorSpec, state: DoorState, key?: string): DoorWithState {
  const next: DoorWithState = { ...d, state: state === "closed" ? undefined : state };
  const kept = key !== undefined ? key : doorKeyOf(d);
  if (kept !== undefined) next.key = kept;
  return next;
}

/** "the south door" / "the secret north door" — the door's name in
 *  chat lines and error messages. */
export function doorLabel(d: DoorSpec): string {
  return `the ${d.secret ? "secret " : ""}${d.wall} door`;
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

/** What a lock/unlock line names: a key ("with the brass key") or a
 *  method ("pick the lock", "force it"). A bare "the" is stripped;
 *  the phrase is kept whole ("brass key", not "brass") so an unlock
 *  naming a different key is a plain mismatch, never a guess. */
export function parseKeyOrMethod(
  text: string,
): { key?: string; method?: string } {
  if (/\bpick(?:ing)?\s+the\s+lock\b/i.test(text)) return { method: "pick the lock" };
  if (/\bforce\s+(?:it|the\s+door)\b/i.test(text)) return { method: "force it" };
  const m = /\b(?:with|using)\s+(?:the\s+)?([A-Za-z][A-Za-z'’ -]*?)(?:\s*,|\s+and\b|\s*$|\s*\.)/i.exec(text);
  if (!m) return {};
  const key = m[1].replace(/\s+/g, " ").trim().replace(/^(?:a|an)\s+/i, "");
  return key ? { key } : {};
}

/** Which door a verb line addresses, or a question. Never guesses:
 *  a wall with no door says so (an open archway on that wall says
 *  "look through", not "no door"); two doors on one wall, or a bare
 *  "the door" in a multi-door room, list the doors that exist. */
export type DoorTarget =
  | { door: DoorSpec }
  | { clarify: string };

export function resolveDoor(
  s: string,
  room: RoomSpec,
  ctx?: BuildParseContext,
): DoorTarget {
  const doors = room.doors ?? [];
  const openings = room.openings ?? [];
  const listDoors = (ds: DoorSpec[]): string =>
    ds.map((d) => `${d.secret ? "secret " : ""}${d.wall} door at cell ${d.at}`).join(", ");
  const secret = /\b(secret|hidden)\b/i.test(s);
  const wall = parseWall(s);
  const cell = parseCell(s);
  // "here" is the ping: the wall nearest it (a named wall or cell
  // wins over the ping).
  let hereWall: WallSide | null = null;
  if (!wall && !secret && /\bhere\b/i.test(s) && ctx?.here) {
    hereWall = resolveHere(ctx.here.x, ctx.here.y, room).wall;
  }
  const effWall = wall ?? hereWall;
  let pool = doors;
  if (secret) pool = pool.filter((d) => d.secret);
  if (effWall) pool = pool.filter((d) => d.wall === effWall);
  if (cell !== null) pool = pool.filter((d) => d.at === cell);
  if (pool.length === 1) return { door: pool[0] };
  if (pool.length > 1) {
    return {
      clarify: `Which door — ${listDoors(pool)}?`,
    };
  }
  if (secret) {
    return {
      clarify: doors.some((d) => d.secret)
        ? `Which secret door — ${listDoors(doors.filter((d) => d.secret))}?`
        : "There's no secret door in this room yet — add one first, or name a plain door.",
    };
  }
  if (effWall) {
    const opening = openings.find((o) => o.wall === effWall);
    if (opening) {
      return {
        clarify: `There's no door on the ${effWall} wall — it's an open archway, you can just look through.`,
      };
    }
    return {
      clarify: `There's no door on the ${effWall} wall yet — which door did you mean?`,
    };
  }
  if (cell !== null) {
    return { clarify: `There's no door at cell ${cell} in this room — which door did you mean?` };
  }
  if (doors.length === 0) {
    return {
      clarify: "There's no door in this room yet — build a room with a door first, or add one.",
    };
  }
  return {
    clarify: `Which door — ${listDoors(doors)}?`,
  };
}

// ---------------------------------------------------------------- props (BRA-241)

/** The words that name a prop kind in chat, to the dressing tile
 *  they mean — the same set the dressing branch adds. A word the
 *  room actually holds as a dressing tile (a bookshelf, a treasure
 *  pile) resolves too, even when it isn't in this map. */
const PROP_TILE_WORDS: Record<string, string> = {
  bones: "bones",
  bone: "bones",
  rubble: "rubble",
  pillar: "pillar",
  "ritual circle": "ritual-circle",
  altar: "altar",
  skeleton: "skeleton",
  chest: "chest",
};

/** Corner words to the corner they mean — shared by the dressing
 *  placement and the prop destination / disambiguator. */
const CORNER_WORDS: Record<string, "nw" | "ne" | "sw" | "se"> = {
  northwest: "nw", nw: "nw", northeast: "ne", ne: "ne",
  southwest: "sw", sw: "sw", southeast: "se", se: "se",
};

/** A torch is light + sconce tile together — moving or removing one
 *  sconce would leave its light behind, so a torch is never a prop
 *  move/remove. */
function isTorchWord(w: string): boolean {
  return w === "torch" || w === "torches" || w === "sconce";
}

/** The room's props in chat words — "some bones at (0, 4), a chest
 *  at (6, 4)" — or "nothing placed yet". */
export function describeRoomProps(room: RoomSpec): string {
  const props = room.dressing ?? [];
  if (props.length === 0) return "nothing placed yet";
  return props
    .map((p) => `${p.tile === "bones" ? "some bones" : `a ${p.tile}`} at (${p.gx}, ${p.gy})`)
    .join(", ");
}

/** Where a prop sits, in the creator's words — a corner, the middle,
 *  or its cell. The size comes from the pack when given, else the
 *  2x2 prop default. */
export function describePropPlace(
  tile: string,
  gx: number,
  gy: number,
  room: RoomSpec,
  pack?: Pack,
): string {
  const size = tileCells(tile, pack);
  if (gx === 0 && gy === 0) return "the northwest corner";
  if (gx === room.gridW - size && gy === 0) return "the northeast corner";
  if (gx === 0 && gy === room.gridH - size) return "the southwest corner";
  if (gx === room.gridW - size && gy === room.gridH - size) return "the southeast corner";
  if (
    gx === Math.floor((room.gridW - size) / 2) &&
    gy === Math.floor((room.gridH - size) / 2)
  ) {
    return "the middle";
  }
  return `(${gx}, ${gy})`;
}

/** The cell a named corner means for a prop of the tile's size. */
function cornerCell(
  corner: string,
  tile: string,
  room: RoomSpec,
): { gx: number; gy: number } {
  const size = tileCells(tile);
  const key = CORNER_WORDS[corner.toLowerCase()] ?? "se";
  return {
    gx: key === "nw" || key === "sw" ? 0 : room.gridW - size,
    gy: key === "nw" || key === "ne" ? 0 : room.gridH - size,
  };
}

/**
 * The prop a line starts naming, after the verb ("move the chest…",
 * "remove the bones…", "take the bones away"): the dressing tile +
 * the rest of the line. A torch is a { torch: true } answer, never a
 * tile — torches are light + sconce together. A word the room holds
 * as a dressing tile resolves even when it isn't a known kind word
 * ("move the bookshelf"). Returns null when the line names no prop.
 */
export function propTileAtStart(
  text: string,
  room?: RoomSpec,
): { tile: string; after: string } | { torch: true; after: string } | null {
  const s = text.trim().replace(/^(?:the\s+)?/i, "");
  const lower = s.toLowerCase();
  if (lower.startsWith("ritual circle")) {
    return { tile: "ritual-circle", after: s.slice("ritual circle".length).trim() };
  }
  const m = /^([A-Za-z]+)\b(.*)$/s.exec(s);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const after = m[2].trim();
  if (PROP_TILE_WORDS[word]) return { tile: PROP_TILE_WORDS[word], after };
  if (isTorchWord(word)) return { torch: true, after };
  if (room && (room.dressing ?? []).some((p) => p.tile === word)) {
    return { tile: word, after };
  }
  return null;
}

function pluralProp(tile: string): string {
  if (tile === "bones") return "piles of bones";
  if (tile === "rubble") return "piles of rubble";
  return `${tile}s`;
}

/** Which prop a move/remove line addresses, or a question. Never
 *  guesses: no such prop says what the room holds; several of a kind
 *  with no disambiguator list the cells. A disambiguator is an
 *  explicit cell ("the bones at 2, 3"), a place in the line ("in the
 *  northwest corner", "near the door", "in the middle"), or a
 *  proximity anchor — the destination cell when the line has one,
 *  the GM's ping otherwise — in which case the nearest one wins and
 *  the confirmation line says which cell it came from. */
export type PropTarget =
  | { prop: Placement }
  | { clarify: string };

export function resolveProp(
  tile: string,
  qualifierText: string,
  room: RoomSpec,
  anchor?: { gx: number; gy: number },
): PropTarget {
  const candidates = (room.dressing ?? []).filter((p) => p.tile === tile);
  const propName = tile === "bones" ? "the bones" : `the ${tile}`;
  const listCandidates = () =>
    candidates.map((p) => `${propName} at (${p.gx}, ${p.gy})`).join(", ");
  if (candidates.length === 0) {
    return {
      clarify: `There's no ${tile === "bones" ? "bones" : tile} in this room — the room has: ${describeRoomProps(room)}.`,
    };
  }
  if (candidates.length === 1) return { prop: candidates[0] };
  // Explicit cell: "the bones at 2, 3" / "at cell 2, 3".
  const cellM = /\bat\s+(?:cell\s+)?\(?(\d+)\s*,\s*(\d+)\)?/i.exec(qualifierText);
  if (cellM) {
    const gx = Number(cellM[1]);
    const gy = Number(cellM[2]);
    const hit = candidates.find((p) => p.gx === gx && p.gy === gy);
    if (hit) return { prop: hit };
    return {
      clarify: `There's no ${propName} at (${gx}, ${gy}) — the room has ${listCandidates()}.`,
    };
  }
  // A place in the line becomes the anchor: a corner, the middle, or
  // the door's entry cell.
  let effAnchor = anchor;
  const cornerM =
    /\bin\s+the\s+(northwest|northeast|southwest|southeast|nw|ne|sw|se)\s+corner\b/i.exec(
      qualifierText,
    );
  if (cornerM) {
    effAnchor = cornerCell(cornerM[1], tile, room);
  } else if (/\bin\s+the\s+(middle|center|centre)\b/i.test(qualifierText)) {
    const size = tileCells(tile);
    effAnchor = {
      gx: Math.floor((room.gridW - size) / 2),
      gy: Math.floor((room.gridH - size) / 2),
    };
  } else if (/\b(?:near|by|next to)\s+(?:the\s+)?door\b/i.test(qualifierText)) {
    const first = room.doors?.[0];
    if (!first) {
      return {
        clarify: `There's no door in this room to be near — the room has ${listCandidates()}.`,
      };
    }
    effAnchor = doorEntryCell(first.wall, first.at, room.gridW, room.gridH);
  }
  if (effAnchor) {
    let bestDist = Infinity;
    let best: Placement[] = [];
    for (const c of candidates) {
      const d = Math.abs(c.gx - effAnchor.gx) + Math.abs(c.gy - effAnchor.gy);
      if (d < bestDist) {
        bestDist = d;
        best = [c];
      } else if (d === bestDist) {
        best.push(c);
      }
    }
    if (best.length === 1) return { prop: best[0] };
    // A tie is still ambiguous — the anchor didn't disambiguate.
    return {
      clarify: `Those ${pluralProp(tile)} are equally close — ${best.map((p) => `${propName} at (${p.gx}, ${p.gy})`).join(", ")}. Which one?`,
    };
  }
  return {
    clarify: `There are ${candidates.length} ${pluralProp(tile)} in this room — ${listCandidates()}. Which one?`,
  };
}

/** A move-prop destination, from the text after the prop phrase:
 *  "to the middle", "to the northwest corner", "near the door" /
 *  "to the door", "here" (the ping), "to cell 3, 4", or a direction
 *  ("left", "two squares north"). The LAST location phrase in the
 *  line wins — "move the bones near the door to the middle" moves
 *  the bones by the door, it doesn't move them near the door. A
 *  direction word inside another phrase ("to the south door") is
 *  not a direction. Returns null when the line names no destination
 *  at all. */
export type PropDestination =
  | { to: DressingWhere; raw: string; index: number }
  | { direction: "left" | "right" | "up" | "down"; steps: number; raw: string; index: number };

export function parsePropDestination(
  text: string,
  room: RoomSpec,
  ctx?: BuildParseContext,
): PropDestination | null {
  const found: { start: number; end: number; dest: PropDestination }[] = [];
  const push = (m: RegExpExecArray | null, dest: PropDestination) => {
    if (m) found.push({ start: m.index, end: m.index + m[0].length, dest });
  };
  let m: RegExpExecArray | null;
  // Corner: "to the northwest corner" / "into the corner" (a bare
  // corner is SE, the dressing default).
  m = /\b(?:to|into)\s+(?:the\s+)?((?:northwest|northeast|southwest|southeast|nw|ne|sw|se)\s+)?corner\b/i.exec(text);
  if (m) {
    const corner = m[1] ? CORNER_WORDS[m[1].trim().toLowerCase()] : "se";
    push(m, { to: { kind: "corner", corner }, raw: m[0], index: m.index });
  }
  // Middle / centre.
  m = /\b(?:to|into)\s+(?:the\s+)?(middle|center|centre)\b/i.exec(text);
  if (m) push(m, { to: { kind: "center" }, raw: m[0], index: m.index });
  // Near / to the door.
  m = /\b(?:near|by|next to|to)\s+(?:the\s+)?(?:(?:north|south|east|west)\s+)?door\b/i.exec(text);
  if (m) push(m, { to: { kind: "entry" }, raw: m[0], index: m.index });
  // Explicit cell: "to cell 3, 4" / "to 3, 4" / "to (3, 4)".
  m = /\bto\s+(?:cell\s+)?\(?(\d+)\s*,\s*(\d+)\)?/i.exec(text);
  if (m) {
    push(m, {
      to: { kind: "cell", gx: Number(m[1]), gy: Number(m[2]) },
      raw: m[0],
      index: m.index,
    });
  }
  // Here: the pinged cell.
  m = /\bhere\b/i.exec(text);
  if (m && ctx?.here) {
    const here = resolveHere(ctx.here.x, ctx.here.y, room);
    push(m, { to: { kind: "cell", gx: here.gx, gy: here.gy }, raw: m[0], index: m.index });
  }
  // Direction: "left" / "right" / "up" / "down" / a cardinal — not
  // next to "wall" ("to the south wall" is not a direction).
  m = /\b(left|right|up|down|north|south|east|west)\b(?!\s+wall)/i.exec(text);
  if (m) {
    const dirWord = m[1].toLowerCase();
    const direction =
      dirWord === "left"
        ? "left"
        : dirWord === "right"
          ? "right"
          : dirWord === "up" || dirWord === "north"
            ? "up"
            : "down";
    const byM = /\bby\s+(\d+)\b/i.exec(text.slice(m.index));
    push(m, {
      direction,
      steps: byM ? Math.max(1, Number(byM[1])) : 1,
      raw: m[0],
      index: m.index,
    });
  }
  if (found.length === 0) return null;
  // A match inside another match's span is part of that phrase, not
  // its own destination ("south" inside "to the south door").
  const kept = found.filter(
    (f) => !found.some((o) => o !== f && o.start <= f.start && f.end <= o.end),
  );
  kept.sort((a, b) => b.start - a.start);
  return kept[0].dest;
}

// ---------------------------------------------------------------- resolving rooms + "here"

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NAME_MENTION_STOP = new Set([
  "wall", "side", "half", "door", "corner", "middle", "center", "centre",
  "north", "south", "east", "west", "up", "down", "left", "right",
]);

/**
 * A capitalized phrase after "the"/"in"/"to"/"of"/"from"/"into" that
 * looks like a room name ("the Entry Hall", "the Sunken Chapel", "the
 * Crypt") — a name the GM typed, not a word the parser invented.
 * Wall phrases ("the North Wall"), halves ("the North Half"), and
 * lone non-kind words ("the GM") never count. Returns the phrase in
 * its original case, or null.
 */
function parseNameMention(s: string): string | null {
  const re = /\b(?:the|in|to|of|from|into)\s+([A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const phrase = m[1].replace(/\s+/g, " ").trim();
    const words = phrase.toLowerCase().split(" ");
    if (NAME_MENTION_STOP.has(words[words.length - 1])) continue;
    const hasKind = words.some((w) => (ROOM_KINDS as readonly string[]).includes(w));
    if (!hasKind && words.length < 2) continue;
    return phrase;
  }
  return null;
}

/** The room(s) a line names, by whole-phrase match against the known
 *  room names ("the Entry Hall" matches "Entry Hall" but not "Hall").
 *  A longer name that contains a shorter one wins ("Entry Hall" over
 *  "Hall"); two names neither of which contains the other is a real
 *  ambiguity. */
function matchNamedRooms(
  s: string,
  rooms: DungeonRoomSpec[],
): DungeonRoomSpec[] {
  const norm = ` ${normalizeName(s)} `;
  const matches = rooms.filter((r) => {
    const name = normalizeName(r.name);
    return name !== "" && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(norm);
  });
  if (matches.length <= 1) return matches;
  const sorted = [...matches].sort((a, b) => b.name.length - a.name.length);
  const longest = sorted[0];
  if (sorted.slice(1).every((m) => normalizeName(longest.name).includes(normalizeName(m.name)))) {
    return [longest];
  }
  return matches;
}

export type RoomTarget =
  | { id: string }
  | { clarify: string };

/**
 * Resolve which room a room-scoped line targets: a named room, the
 * pinged room ("here"), or neither (the active room). A name that
 * matches nothing is a question, never a guess — the GM typed a name
 * on purpose. A line that names a room AND pings a different one is a
 * question too (the ping and the name disagree).
 */
export function resolveRoomTarget(
  s: string,
  ctx?: BuildParseContext,
): RoomTarget | null {
  const rooms = ctx?.rooms ?? [];
  let named: DungeonRoomSpec | null = null;
  if (rooms.length > 0) {
    const matches = matchNamedRooms(s, rooms);
    if (matches.length > 1) {
      return {
        clarify: `You named ${matches.map((r) => `"${r.name}"`).join(" and ")} in one line — which room did you mean?`,
      };
    }
    if (matches.length === 1) named = matches[0];
    if (!named) {
      const mention = parseNameMention(s);
      if (mention) {
        return {
          clarify: `I don't have a room called "${mention}" yet — the rooms I have are ${rooms.map((r) => r.name).join(", ")}. Build it first, or name one of those.`,
        };
      }
    }
  }
  const here = /\bhere\b/i.test(s) ? ctx?.here : undefined;
  if (here) {
    if (named && named.id !== here.roomId) {
      const pinged = rooms.find((r) => r.id === here.roomId);
      return {
        clarify: `You pinged the ${pinged ? pinged.name : "other room"} but named the ${named.name} — which room did you mean?`,
      };
    }
    return { id: here.roomId };
  }
  if (named) return { id: named.id };
  return null;
}

/** The room a room-scoped op acts on: the target room when the line
 *  named or pinged one, else the active room. */
function roomForTarget(ctx: BuildParseContext | undefined, targetId: string | undefined): RoomSpec | undefined {
  if (targetId && ctx?.rooms) {
    return ctx.rooms.find((r) => r.id === targetId);
  }
  return ctx?.room;
}

/**
 * Resolve a ping/cursor point (scene px) against a room: the cell it
 * lands in, the nearest wall, and the cell along that wall (clamped
 * to the door range 1..n-2 — doors may not sit in a corner). Ties
 * break north, then south, then west, then east, so the answer is
 * deterministic.
 */
export function resolveHere(
  x: number,
  y: number,
  room: RoomSpec,
): { wall: WallSide; at: number; gx: number; gy: number } {
  const gx = Math.max(0, Math.min(room.gridW - 1, Math.floor(x / TILE_PX)));
  const gy = Math.max(0, Math.min(room.gridH - 1, Math.floor(y / TILE_PX)));
  const d: [WallSide, number][] = [
    ["north", y],
    ["south", room.gridH * TILE_PX - y],
    ["west", x],
    ["east", room.gridW * TILE_PX - x],
  ];
  let wall: WallSide = "north";
  let best = Infinity;
  for (const [w, dist] of d) {
    if (dist < best) {
      best = dist;
      wall = w;
    }
  }
  const n = wall === "north" || wall === "south" ? room.gridW : room.gridH;
  const along = wall === "north" || wall === "south" ? gx : gy;
  const at = Math.max(1, Math.min(Math.max(1, n - 2), along));
  return { wall, at, gx, gy };
}

/**
 * Resolve a ping/cursor point to the overlay half it sits in: the
 * axis the point is furthest from the centre line on, wins. A point
 * dead on a centre line takes the north/south half on a tie.
 */
export function resolveHereRegion(x: number, y: number, room: RoomSpec): OverlayRegion {
  const gx = Math.max(0, Math.min(room.gridW - 1, Math.floor(x / TILE_PX)));
  const gy = Math.max(0, Math.min(room.gridH - 1, Math.floor(y / TILE_PX)));
  const fx = Math.abs(gx + 0.5 - room.gridW / 2) / room.gridW;
  const fy = Math.abs(gy + 0.5 - room.gridH / 2) / room.gridH;
  if (fy >= fx) return gy + 0.5 < room.gridH / 2 ? "north-half" : "south-half";
  return gx + 0.5 < room.gridW / 2 ? "west-half" : "east-half";
}

const BUILD_VERBS =
  /\b(build|make|create|add|put|place|move|widen|carve|dig|undo|redo)\b/i;

/** Leading fluff a door-verb command may carry ("please lock the
 *  door", "Meroki, open the south door") — the light-commands rule:
 *  strip it, then the verb must lead. */
const DOOR_FLUFF_LEAD =
  /^(?:please[,\s]+|(?:can|could)\s+you[,\s]+|hey\s+meroki[,\s]+|meroki[,\s]+)+/i;
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
 *   "widen the Entry Hall 10 units east" (a named room, when ctx.rooms lists it)
 *   "add a door [on the north wall]" / "put a secret door in the north wall"
 *   "add a door here" (the ping: nearest wall + cell, when ctx.here is set)
 *   "move that door left" / "move the south door to cell 5"
 *   "open/close/lock/unlock the south door" / "lock the door with the brass key" /
 *   "unlock the door by picking the lock" / "listen at the door" (BRA-234 — door
 *   verbs; "the door" with one door in the room is that door, otherwise a
 *   question listing the doors; a secret door is "the secret door")
 *   "add some bones / rubble / a pillar / a chest [in the corner / in the middle / near the door]"
 *   "add some bones here" (the pinged cell, when ctx.here is set)
 *   "move the chest to the middle" / "move the bones here" / "move the chest left" (BRA-241 —
 *   prop move; several of a kind with no disambiguator asks which one — the nearest to the
 *   destination or the ping wins, and the confirmation line says which cell it came from)
 *   "remove the bones" / "remove the bones at 2, 3" / "take the bones away" (BRA-241 — prop
 *   remove; torches are light + sconce together, never a prop move/remove)
 *   "add torches" / "add fog" / "more fog"
 *   "make the north half underwater" / "make this part underwater" (→ asks which part)
 *   "add a corridor going north for 100 meters"
 *   "undo that" / "redo that"
 *
 * Compound requests ("add a door here and widen the room") are
 * `parseBuildRequests`, below — this function parses one segment.
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
  // "Add a corridor here" runs through the wall nearest the ping.
  if (/\bcorridor\b/i.test(s)) {
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    let direction = parseDirection(s);
    if (!direction && /\bhere\b/i.test(s) && ctx?.here) {
      const room = roomForTarget(ctx, target?.id);
      if (room) direction = resolveHere(ctx.here.x, ctx.here.y, room).wall;
    }
    if (!direction) {
      return {
        kind: "clarify",
        question: "Which way should the corridor run — north, south, east, or west?",
      };
    }
    const len = parseLength(s) ?? { value: 10, unit: "squares" as LengthUnit };
    return { kind: "build", op: { type: "add-corridor", direction, length: len.value, unit: len.unit, ...(target ? { target: target.id } : {}) } };
  }

  // Widen — "make this room 10 units wider", "a bit wider". Runs
  // before create-room: "make this room wider" contains "make" + "room"
  // and would otherwise parse as a create. "Widen here" widens the
  // wall nearest the ping; without a ping the named direction (or
  // east) stands, as before.
  if (isWidenRequest(s)) {
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    let side = parseDirection(s);
    if (!side && /\bhere\b/i.test(s) && ctx?.here) {
      const room = roomForTarget(ctx, target?.id);
      if (room) side = resolveHere(ctx.here.x, ctx.here.y, room).wall;
    }
    side ??= "east";
    const len = parseLength(s);
    const by = len ? toSquares(len.value, len.unit) : 2;
    return { kind: "build", op: { type: "widen", side, by: Math.max(1, by), ...(target ? { target: target.id } : {}) } };
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

  // Door verbs (BRA-234) — open/close/lock/unlock/listen at a door.
  // The line must name a door ("the south door", "the secret door",
  // "that door"); a bare "lock it" has no door to resolve, so it falls
  // through to chat — in a compound, name the door in the verb
  // segment ("add a south door and lock the south door"). The verb
  // must LEAD the line (after "please" / "can you" / "meroki", the
  // light-commands rule): "three puzzles to unlock a door" is a floor
  // brief, not a command, and an anywhere-match would steal it from
  // the co-design brief detector. Runs before add-door: "put your ear
  // to the door" contains "put" + "door" and would otherwise parse
  // as adding a door — the same parser-ordering class as the Nov 20
  // widen/create fix.
  {
    const stripped = s.replace(DOOR_FLUFF_LEAD, "").trim();
    const leadsWithVerb = /^(open|close|shut|lock|bar|unlock|unbar|listen)\b/i.test(stripped);
    const leadsWithEar = /^(?:put|press|place)\b[^.]{0,25}\bear\s+(?:to|against)\b/i.test(stripped);
    if ((leadsWithVerb || leadsWithEar) && /\bdoor\b/i.test(s)) {
      // The key/method tail ("with the Brass Key") is not a room name —
      // resolve the room target on the line without it.
      const targetLine = stripped.replace(/\s+\b(?:with|using)\b\s+.*$/i, "");
      const target = resolveRoomTarget(targetLine, ctx);
      if (target && "clarify" in target) {
        return { kind: "clarify", question: target.clarify };
      }
      const room = roomForTarget(ctx, target?.id);
      if (!room) {
        return {
          kind: "clarify",
          question: "There's no door in this room yet — build a room first, or add one.",
        };
      }
      const resolved = resolveDoor(stripped, room, ctx);
      if ("clarify" in resolved) {
        return { kind: "clarify", question: resolved.clarify };
      }
      const door = resolved.door;
      const base = { wall: door.wall, at: door.at, ...(target ? { target: target.id } : {}) };
      if (/\blisten\b/i.test(stripped) || /\bear\s+(?:to|against)\b/i.test(stripped)) {
        return { kind: "build", op: { type: "listen-door", ...base } };
      }
      if (/\b(open)\b/i.test(stripped)) {
        return { kind: "build", op: { type: "open-door", ...base } };
      }
      if (/\b(close|shut)\b/i.test(stripped)) {
        return { kind: "build", op: { type: "close-door", ...base } };
      }
      if (/\b(unlock|unbar)\b/i.test(stripped)) {
        const { key, method } = parseKeyOrMethod(stripped);
        return {
          kind: "build",
          op: { type: "unlock-door", ...base, ...(key ? { key } : {}), ...(method ? { key: method } : {}) },
        };
      }
      // lock / bar — the last verb standing.
      const { key, method } = parseKeyOrMethod(stripped);
      return {
        kind: "build",
        op: { type: "lock-door", ...base, ...(key ? { key } : {}), ...(method ? { key: method } : {}) },
      };
    }
  }

  // Add a door. "Here" is the ping: the nearest wall and the cell
  // along it (a named wall or cell wins over the ping).
  if (/\b(add|put|place)\b/i.test(s) && /\bdoor\b/i.test(s)) {
    const secret = /\b(secret|hidden)\b/i.test(s);
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    let wall = parseWall(s);
    let at = parseCell(s);
    if ((!wall || at === null) && /\bhere\b/i.test(s) && ctx?.here) {
      const room = roomForTarget(ctx, target?.id);
      if (room) {
        const here = resolveHere(ctx.here.x, ctx.here.y, room);
        wall ??= here.wall;
        at ??= here.at;
      }
    }
    if (!wall) {
      return {
        kind: "clarify",
        question: `Which wall should the ${secret ? "secret " : ""}door go on — north, south, east, or west?`,
      };
    }
    return {
      kind: "build",
      op: {
        type: "add-door",
        wall,
        at: at ?? -1, // -1 = middle cell, resolved at apply time
        ...(secret ? { secret: true } : {}),
        ...(target ? { target: target.id } : {}),
      },
    };
  }

  // Move a prop (BRA-241) — "move the chest to the middle", "move
  // the bones here". Runs before move-door: "move the chest near the
  // door" names a prop, not a door, and the door branch would steal
  // it. A line that names no prop ("move the door") falls through to
  // the door branch below.
  if (/\bmove\b/i.test(s)) {
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    const room = roomForTarget(ctx, target?.id);
    if (!room) {
      return {
        kind: "clarify",
        question: "No room to move a prop in yet — build a room first.",
      };
    }
    const afterVerb = s.replace(/^\s*move\s+/i, "");
    const named = propTileAtStart(afterVerb, room);
    if (named) {
      if ("torch" in named) {
        return {
          kind: "clarify",
          question:
            "A torch is a light and a sconce tile together — moving one would leave its light behind. I can add torches, but I can't move a single torch yet.",
        };
      }
      const tileWord = named.tile === "bones" ? "bones" : named.tile;
      // Existence first: a missing prop is "no such prop", not "where
      // should it go" — the destination only matters once the prop
      // is known to be there.
      if (!(room.dressing ?? []).some((p) => p.tile === named.tile)) {
        return {
          kind: "clarify",
          question: `There's no ${tileWord} in this room — the room has: ${describeRoomProps(room)}.`,
        };
      }
      const dest = parsePropDestination(named.after, room, ctx);
      if (!dest) {
        return {
          kind: "clarify",
          question:
            `Where should the ${tileWord} go — in a corner, in the middle, near the door, or to a cell?` +
            (/\bhere\b/i.test(named.after) && !ctx?.here
              ? " I don't have a ping to aim at, so ping the spot or name a place."
              : ""),
        };
      }
      // The destination cell is the proximity anchor when several of
      // a kind match; a direction move has no destination cell, so
      // only the ping can disambiguate it.
      let anchor: { gx: number; gy: number } | undefined;
      let to: DressingWhere;
      if ("direction" in dest) {
        to = { kind: "cell", gx: -1, gy: -1 }; // placeholder — the from cell is not picked yet
        if (ctx?.here) {
          const here = resolveHere(ctx.here.x, ctx.here.y, room);
          anchor = { gx: here.gx, gy: here.gy };
        }
      } else {
        to = dest.to;
        if (to.kind === "cell") anchor = { gx: to.gx, gy: to.gy };
        else if (to.kind === "corner") anchor = cornerCell(to.corner ?? "se", named.tile, room);
        else if (to.kind === "center") {
          const size = tileCells(named.tile);
          anchor = {
            gx: Math.floor((room.gridW - size) / 2),
            gy: Math.floor((room.gridH - size) / 2),
          };
        } else if (to.kind === "entry") {
          const first = room.doors?.[0];
          if (!first) {
            return {
              kind: "clarify",
              question: "There's no door in this room to put it near.",
            };
          }
          anchor = doorEntryCell(first.wall, first.at, room.gridW, room.gridH);
        }
      }
      const qualifierText =
        named.after.slice(0, dest.index) + " " + named.after.slice(dest.index + dest.raw.length);
      const resolved = resolveProp(named.tile, qualifierText, room, anchor);
      if ("clarify" in resolved) {
        return { kind: "clarify", question: resolved.clarify };
      }
      const prop = resolved.prop;
      if ("direction" in dest) {
        const dx =
          dest.direction === "left" ? -dest.steps : dest.direction === "right" ? dest.steps : 0;
        const dy =
          dest.direction === "up" ? -dest.steps : dest.direction === "down" ? dest.steps : 0;
        to = { kind: "cell", gx: prop.gx + dx, gy: prop.gy + dy };
      }
      return {
        kind: "build",
        op: {
          type: "move-prop",
          tile: named.tile,
          from: { gx: prop.gx, gy: prop.gy },
          to,
          ...(target ? { target: target.id } : {}),
        },
      };
    }
    // No prop named — fall through to the door branch below.
  }

  // Remove a prop (BRA-241) — "remove the bones", "take the bones
  // away", "clear the rubble". No destination: the op names the prop
  // and the cell it sat in, so the confirmation line says what was
  // removed.
  if (
    /\b(remove|clear)\b/i.test(s) ||
    /\btake\b.*\baway\b/i.test(s) ||
    /\bget rid of\b/i.test(s)
  ) {
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    const room = roomForTarget(ctx, target?.id);
    if (!room) {
      return {
        kind: "clarify",
        question: "No room to remove a prop from yet — build a room first.",
      };
    }
    const afterVerb = s
      .replace(/^\s*(?:remove|clear)\s+/i, "")
      .replace(/^\s*take\s+/i, "")
      .replace(/^\s*get rid of\s+/i, "");
    const named = propTileAtStart(afterVerb, room);
    if (named) {
      if ("torch" in named) {
        return {
          kind: "clarify",
          question:
            "A torch is a light and a sconce tile together — removing one would leave its light behind. I can't remove a single torch yet.",
        };
      }
      const anchor = ctx?.here
        ? {
            gx: resolveHere(ctx.here.x, ctx.here.y, room).gx,
            gy: resolveHere(ctx.here.x, ctx.here.y, room).gy,
          }
        : undefined;
      const resolved = resolveProp(named.tile, named.after, room, anchor);
      if ("clarify" in resolved) {
        return { kind: "clarify", question: resolved.clarify };
      }
      const prop = resolved.prop;
      return {
        kind: "build",
        op: {
          type: "remove-prop",
          tile: named.tile,
          from: { gx: prop.gx, gy: prop.gy },
          ...(target ? { target: target.id } : {}),
        },
      };
    }
    // No prop named — "remove the door" and friends fall through to
    // chat (there is no door-removal op).
  }

  // Move a door. "Here" is the ping: the wall nearest it.
  if (/\bmove\b/i.test(s) && /\bdoor\b/i.test(s)) {
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    const room = roomForTarget(ctx, target?.id);
    const doors = room?.doors ?? [];
    let wall = parseWall(s);
    if (!wall && /\bhere\b/i.test(s) && ctx?.here && room) {
      wall = resolveHere(ctx.here.x, ctx.here.y, room).wall;
    }
    const toAt = parseCell(s);
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
      return { kind: "build", op: { type: "move-door", wall: effectiveWall, fromAt: from.at, toAt, ...(target ? { target: target.id } : {}) } };
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
    return { kind: "build", op: { type: "move-door", wall: effectiveWall, fromAt: from.at, toAt: to, ...(target ? { target: target.id } : {}) } };
  }

  // Dressing — bones, rubble, pillar, ritual circle, altar, skeleton,
  // chest. "Here" is the ping: the dressing lands on the pinged cell
  // (an explicit corner/middle/near-the-door wins over the ping);
  // without a ping, "here" asks where, as before.
  const DRESSING_TILES = PROP_TILE_WORDS;
  const dressingMatch = new RegExp(
    `\\b(add|put|place)\\b.*\\b(${Object.keys(DRESSING_TILES).join("|")})\\b`,
    "i",
  ).exec(s);
  if (dressingMatch) {
    const tile = DRESSING_TILES[dressingMatch[2].toLowerCase()];
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    const hasPosition = /\b(corner|middle|center|near|by)\b/i.test(s);
    if (/\bhere\b/i.test(s) && !hasPosition) {
      const room = roomForTarget(ctx, target?.id);
      if (room && ctx?.here) {
        const here = resolveHere(ctx.here.x, ctx.here.y, room);
        return {
          kind: "build",
          op: { type: "add-dressing", tile, where: { kind: "cell", gx: here.gx, gy: here.gy }, ...(target ? { target: target.id } : {}) },
        };
      }
      return {
        kind: "clarify",
        question: `Where should the ${tile} go — in a corner, in the middle, or near the door?`,
      };
    }
    const cornerM = /\b(northwest|northeast|southwest|southeast|nw|ne|sw|se)\s+corner\b/i.exec(s);
    const where: DressingWhere = /\bcorner\b/i.test(s)
      ? { kind: "corner", corner: cornerM ? CORNER_WORDS[cornerM[1].toLowerCase()] : "se" }
      : /\b(middle|center|centre)\b/i.test(s)
        ? { kind: "center" }
        : /\b(near|by|next to)\b.{0,12}\bdoor\b/i.test(s)
          ? { kind: "entry" }
          : { kind: "corner", corner: "se" };
    return { kind: "build", op: { type: "add-dressing", tile, where, ...(target ? { target: target.id } : {}) } };
  }

  // Torches — the dressing pass, torch items only (candles and
  // braziers have no tiles yet, so they are never smuggled in).
  if (/\b(add|put|more)\b/i.test(s) && /\btorches?\b/i.test(s)) {
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    return { kind: "build", op: { type: "add-torches", ...(target ? { target: target.id } : {}) } };
  }

  // Fog.
  if (/\b(add|more|foggy|fog)\b/i.test(s) && /\bfog\b/i.test(s)) {
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    return { kind: "build", op: { type: "add-fog", ...(target ? { target: target.id } : {}) } };
  }

  // Regional overlay — "make the north half underwater". "This part"
  // with no region asks which part; "here" takes the half the ping
  // sits in.
  if (/\b(underwater|wet|flooded)\b/i.test(s)) {
    const target = resolveRoomTarget(s, ctx);
    if (target && "clarify" in target) {
      return { kind: "clarify", question: target.clarify };
    }
    const half = /\b(north|south|east|west)\s+half\b/i.exec(s)?.[1].toLowerCase();
    let region: OverlayRegion | undefined = half ? `${half}-half` as OverlayRegion : undefined;
    if (!region && /\bhere\b/i.test(s) && ctx?.here) {
      const room = roomForTarget(ctx, target?.id);
      if (room) region = resolveHereRegion(ctx.here.x, ctx.here.y, room);
    }
    if (!region && /\bwhole\b/i.test(s)) {
      return {
        kind: "build",
        op: {
          type: "overlay",
          region: "whole",
          variants: { "floor-plain": "floor-dark", "floor-cracked": "floor-dark", "floor-rubble": "floor-dark" },
          ...(target ? { target: target.id } : {}),
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
        region,
        variants: { "floor-plain": "floor-dark", "floor-cracked": "floor-dark", "floor-rubble": "floor-dark" },
        ...(target ? { target: target.id } : {}),
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
        "that isn't in the kit yet — I can build rooms, widen them, add or move doors, add dressing and fog, move or remove props, carve corridors, and undo",
    };
  }
  return null;
}

// ---------------------------------------------------------------- compound requests

/** What the compound parser decided about one chat line. */
export type CompoundParseResult =
  | { kind: "build"; ops: BuildOp[] }
  | { kind: "clarify"; question: string }
  | { kind: "unsupported"; reason: string };

/** Split a line on "and" / "then" (", and" too) — the joints between
 *  two build requests. Returns null for a single request. */
function splitCompound(text: string): string[] | null {
  const parts = text
    .split(/\s+(?:and|then)\s+|\s*,\s+and\s+/i)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return parts.length > 1 ? parts : null;
}

/**
 * Parse one chat line into a list of build decisions, in order.
 * "add a door on the north wall and widen the room 10 east" is two
 * ops; each segment must parse standalone — a segment that is not a
 * complete request ("add bones and torches", where "torches" has no
 * verb) falls back to parsing the whole line as one request, so a
 * line that parsed before still parses exactly the same way. A
 * segment that asks a question or is out of scope falls back the
 * same way: the whole line gets the single-request answer.
 */
export function parseBuildRequests(
  text: string,
  ctx?: BuildParseContext,
): CompoundParseResult | null {
  const single = parseBuildRequest(text, ctx);
  const parts = splitCompound(text);
  if (!parts) {
    if (!single) return null;
    if (single.kind === "build") return { kind: "build", ops: [single.op] };
    return single;
  }
  const ops: BuildOp[] = [];
  for (const part of parts) {
    const parsed = parseBuildRequest(part, ctx);
    if (!parsed || parsed.kind !== "build") {
      // Not a clean compound — answer the whole line as one request.
      if (!single) return null;
      if (single.kind === "build") return { kind: "build", ops: [single.op] };
      return single;
    }
    ops.push(parsed.op);
  }
  return { kind: "build", ops };
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

/** The room an op acts on: the named/pinged target, else the active
 *  room. Throws a plain-English error when there is no room at all,
 *  or the target isn't in this build. */
function targetRoom(state: BuildState, op: { target?: string }, noRoom: string): DungeonRoomSpec {
  const id = op.target ?? state.activeRoom;
  if (!id) throw new Error(noRoom);
  return roomById(state, id);
}

/** A targeted op makes its room the active one, so the next edit
 *  lands there too; an untargeted op keeps the focus where it was. */
function withFocus(state: BuildState, op: { target?: string }): BuildState {
  return op.target ? { ...state, activeRoom: op.target } : state;
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

/** Replace one door in a room, keeping the rest of the spec. */
function replaceDoor(
  state: BuildState,
  room: DungeonRoomSpec,
  door: DoorSpec,
  next: DoorSpec,
): BuildState {
  return replaceRoom(state, {
    ...room,
    doors: (room.doors ?? []).map((d) => (d === door ? next : d)),
  });
}

/**
 * The GM's report from listening at a door: atmosphere from the far
 * side, never the far room's name or contents. The far room is the
 * other end of the dungeon link; an unlinked door has no far side to
 * hear. Fragments come from atmosphere only — light leaking under the
 * door, damp air, the room's theme — never dressing: a prop's sound
 * would give the contents away.
 */
export function listenSummary(
  dungeon: DungeonSpec,
  room: DungeonRoomSpec,
  door: DoorSpec,
): string {
  const label = doorLabel(door);
  const press = `You press your ear to ${label}`;
  const link = dungeon.links.find(
    (l) =>
      (l.from.room === room.id && l.from.wall === door.wall && l.from.at === door.at) ||
      (l.to.room === room.id && l.to.wall === door.wall && l.to.at === door.at),
  );
  if (!link) {
    return `${press} and hear nothing — the door doesn't lead anywhere yet.`;
  }
  const farEnd =
    link.from.room === room.id && link.from.wall === door.wall && link.from.at === door.at
      ? link.to
      : link.from;
  const far = dungeon.rooms.find((r) => r.id === farEnd.room);
  if (!far) {
    return `${press} and hear nothing — the room beyond isn't in this build.`;
  }
  const fragments: string[] = [];
  if ((far.torches ?? []).length > 0 || (far.lights ?? []).length > 0) {
    fragments.push("a faint warm glow leaks under the door");
  }
  if ((far.fog ?? []).length > 0) {
    fragments.push("damp air curls under the door");
  }
  if (far.theme === "western") {
    fragments.push("dry dust on the air");
  } else if (far.floorStyle === "dark") {
    fragments.push("cold, still dark air");
  } else {
    fragments.push("cold stone air");
  }
  const muffled = doorStateOf(door) === "locked" ? "Through the locked door, muffled: " : "";
  return `${press} — ${muffled}${fragments.join("; ")}.`;
}

/**
 * Does this door block passage right now? A locked door blocks
 * movement until unlocked; an open or closed door doesn't — a closed
 * door opens when the party walks through (the GM's call at the
 * table, the move itself isn't gated). An unlinked door has nowhere
 * to go, so it blocks too. An opening (no door at all) never blocks.
 * The enforcement point for walkThroughDoor and the monitor's
 * door-walk wiring — the gate is pure, the walk is the live half.
 */
export function canWalkThroughDoor(
  dungeon: DungeonSpec,
  roomId: string,
  wall: WallSide,
  at: number,
): { ok: boolean; reason?: string } {
  const room = dungeon.rooms.find((r) => r.id === roomId);
  if (!room) return { ok: false, reason: `No room "${roomId}" in this build.` };
  if ((room.openings ?? []).some((o) => o.wall === wall && o.at === at)) {
    return { ok: true };
  }
  const door = (room.doors ?? []).find((d) => d.wall === wall && d.at === at);
  if (!door) {
    return { ok: false, reason: `There's no door on the ${wall} wall at cell ${at} in the ${room.name}.` };
  }
  if (doorStateOf(door) === "locked") {
    const key = doorKeyOf(door);
    return {
      ok: false,
      reason: `${doorLabel(door).charAt(0).toUpperCase() + doorLabel(door).slice(1)} is locked${key ? ` (with the ${key})` : ""} — unlock it first.`,
    };
  }
  const linked = dungeon.links.some(
    (l) =>
      (l.from.room === roomId && l.from.wall === wall && l.from.at === at) ||
      (l.to.room === roomId && l.to.wall === wall && l.to.at === at),
  );
  if (!linked) {
    return { ok: false, reason: `${doorLabel(door).charAt(0).toUpperCase() + doorLabel(door).slice(1)} isn't linked to another room yet.` };
  }
  return { ok: true };
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
    case "cell":
      return {
        gx: Math.max(0, Math.min(room.gridW - size, where.gx)),
        gy: Math.max(0, Math.min(room.gridH - size, where.gy)),
      };
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
  const doors = (room.doors ?? []).map((d) => {
    const st = doorStateOf(d);
    return `${d.secret ? "secret " : ""}${d.wall}@${d.at}${st === "closed" ? "" : ` (${st})`}`;
  }).join(", ");
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
      const room = targetRoom(state, op, "No room to widen yet — build a room first.");
      // widenRoom returns a RoomSpec; the dungeon id lives on our side.
      const next: DungeonRoomSpec = { ...widenRoom(room, op.side, op.by), id: room.id };
      return {
        state: withFocus(replaceRoom(state, next), op),
        summary: `Widened the ${room.name} ${op.by} ${op.by === 1 ? "square" : "squares"} ${op.side} (now ${next.gridW}×${next.gridH}).`,
        changed: true,
      };
    }
    case "add-door": {
      const room = targetRoom(state, op, "No room to add a door to yet — build a room first.");
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
        state: withFocus(replaceRoom(state, next), op),
        summary: `Added a ${op.secret ? "secret " : ""}door to the ${op.wall} wall of the ${room.name}.`,
        changed: true,
      };
    }
    case "move-door": {
      const room = targetRoom(state, op, "No room with a door to move yet — build a room first.");
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
        state: withFocus(replaceRoom(state, next), op),
        summary: `Moved the ${op.wall} door from cell ${op.fromAt} to cell ${op.toAt}.`,
        changed: true,
      };
    }
    case "open-door":
    case "close-door":
    case "lock-door":
    case "unlock-door":
    case "listen-door": {
      const room = targetRoom(state, op, "No room with a door to work yet — build a room first.");
      const door = (room.doors ?? []).find((d) => d.wall === op.wall && d.at === op.at);
      if (!door) {
        throw new Error(`There's no door on the ${op.wall} wall at cell ${op.at} in the ${room.name}.`);
      }
      const label = doorLabel(door);
      const doorState = doorStateOf(door);
      const key = doorKeyOf(door);
      if (op.type === "listen-door") {
        return {
          state,
          summary: listenSummary(state.dungeon, room, door),
          changed: false,
        };
      }
      if (op.type === "open-door") {
        if (doorState === "locked") {
          throw new Error(
            `${label.charAt(0).toUpperCase() + label.slice(1)} is locked — unlock it first${key ? ` (with the ${key})` : ""}.`,
          );
        }
        if (doorState === "open") {
          return { state, summary: `${label.charAt(0).toUpperCase() + label.slice(1)} is already open.`, changed: false };
        }
        const next = replaceDoor(state, room, door, withDoorState(door, "open"));
        return {
          state: withFocus(next, op),
          summary: `Opened ${label}.`,
          changed: true,
        };
      }
      if (op.type === "close-door") {
        if (doorState === "locked") {
          return { state, summary: `${label.charAt(0).toUpperCase() + label.slice(1)} is already closed (and locked).`, changed: false };
        }
        if (doorState === "closed") {
          return { state, summary: `${label.charAt(0).toUpperCase() + label.slice(1)} is already closed.`, changed: false };
        }
        const next = replaceDoor(state, room, door, withDoorState(door, "closed"));
        return {
          state: withFocus(next, op),
          summary: `Closed ${label}.`,
          changed: true,
        };
      }
      if (op.type === "lock-door") {
        if (doorState === "open") {
          throw new Error(
            `Close ${label} first — you can't lock an open door.`,
          );
        }
        if (doorState === "locked") {
          return {
            state,
            summary: `${label.charAt(0).toUpperCase() + label.slice(1)} is already locked${key ? ` (with the ${key})` : ""}.`,
            changed: false,
          };
        }
        const next = replaceDoor(state, room, door, withDoorState(door, "locked", op.key));
        const newKey = doorKeyOf(withDoorState(door, "locked", op.key));
        return {
          state: withFocus(next, op),
          summary: `Locked ${label}${newKey ? ` with the ${newKey}` : ""}.`,
          changed: true,
        };
      }
      // unlock-door
      if (doorState !== "locked") {
        return {
          state,
          summary: `${label.charAt(0).toUpperCase() + label.slice(1)} isn't locked${doorState === "open" ? " — it's open" : ""}.`,
          changed: false,
        };
      }
      if (op.key && key && op.key !== key && op.key !== "pick the lock" && op.key !== "force it") {
        throw new Error(
          `${label.charAt(0).toUpperCase() + label.slice(1)} is locked with the ${key}, not the ${op.key}.`,
        );
      }
      const next = replaceDoor(state, room, door, withDoorState(door, "closed"));
      let summary: string;
      if (op.key === "pick the lock") summary = `Picked the lock on ${label}.`;
      else if (op.key === "force it") summary = `Forced ${label}.`;
      else if (op.key) summary = `Unlocked ${label} with the ${op.key}.`;
      else summary = `Unlocked ${label}${key ? ` (the ${key})` : ""}.`;
      return {
        state: withFocus(next, op),
        summary,
        changed: true,
      };
    }
    case "add-dressing": {
      const room = targetRoom(state, op, "No room to dress yet — build a room first.");
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
            : op.where.kind === "cell"
              ? " where you pinged"
              : " by the door";
      return {
        state: withFocus(replaceRoom(state, next), op),
        summary: `Added ${op.tile === "bones" ? "some bones" : `a ${op.tile}`} to the ${room.name}${whereNote}.`,
        changed: true,
      };
    }
    case "move-prop": {
      const room = targetRoom(state, op, "No room to move a prop in yet — build a room first.");
      if (!pack) {
        throw new Error("Moving a prop needs the tile pack — the executor passes it.");
      }
      // A named cell is the destination as named (validateSpec is the
      // authority on bounds); a corner/middle/entry resolves against
      // the room's actual size, like add-dressing.
      const dest =
        op.to.kind === "cell"
          ? { gx: op.to.gx, gy: op.to.gy }
          : resolvePlacement(op.to, op.tile, room, pack);
      if (dest.gx === op.from.gx && dest.gy === op.from.gy) {
        const subject = op.tile === "bones" ? "The bones are" : `The ${op.tile} is`;
        return {
          state,
          summary: `${subject} already at ${describePropPlace(op.tile, op.from.gx, op.from.gy, room, pack)}.`,
          changed: false,
        };
      }
      // moveProp re-resolves the prop by tile + cell and validates the
      // whole spec, so a prop that vanished between parse and apply
      // is a plain-English error, never a silent wrong move.
      const next: DungeonRoomSpec = {
        ...moveProp(room, { tile: op.tile, gx: op.from.gx, gy: op.from.gy }, dest, pack),
        id: room.id,
      };
      const name = op.tile === "bones" ? "the bones" : `the ${op.tile}`;
      return {
        state: withFocus(replaceRoom(state, next), op),
        summary: `Moved ${name} from ${describePropPlace(op.tile, op.from.gx, op.from.gy, room, pack)} to ${describePropPlace(op.tile, dest.gx, dest.gy, room, pack)} in the ${room.name}.`,
        changed: true,
      };
    }
    case "remove-prop": {
      const room = targetRoom(state, op, "No room to remove a prop from yet — build a room first.");
      const next: DungeonRoomSpec = {
        ...removeProp(room, { tile: op.tile, gx: op.from.gx, gy: op.from.gy }),
        id: room.id,
      };
      const name = op.tile === "bones" ? "the bones" : `the ${op.tile}`;
      return {
        state: withFocus(replaceRoom(state, next), op),
        summary: `Removed ${name} from ${describePropPlace(op.tile, op.from.gx, op.from.gy, room, pack)} in the ${room.name}.`,
        changed: true,
      };
    }
    case "add-torches": {
      const room = targetRoom(state, op, "No room to light yet — build a room first.");
      const merged = mergeTorches(room);
      if (merged.added === 0) {
        return { state, summary: `The ${room.name} already has torches on every wall.`, changed: false };
      }
      return {
        state: withFocus(replaceRoom(state, merged.room), op),
        summary: `Added ${merged.added} torches to the ${room.name}.`,
        changed: true,
      };
    }
    case "add-fog": {
      const room = targetRoom(state, op, "No room to fog yet — build a room first.");
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
        state: withFocus(replaceRoom(state, next), op),
        summary:
          n === 0
            ? `Added fog to the ${room.name}.`
            : `Added more fog to the ${room.name} (${n + 1} wisps now).`,
        changed: true,
      };
    }
    case "overlay": {
      const room = targetRoom(state, op, "No room to flood yet — build a room first.");
      const rect = overlayRect(op.region, room.gridW, room.gridH);
      // applyOverlay returns a RoomSpec; the dungeon id lives on our side.
      const next: DungeonRoomSpec = { ...applyOverlay(room, { ...rect, variants: op.variants }), id: room.id };
      const regionName =
        op.region === "whole" ? "the whole room" : `the ${op.region.replace("-half", "")} half`;
      return {
        state: withFocus(replaceRoom(state, next), op),
        summary: `Made ${regionName} of the ${room.name} underwater.`,
        changed: true,
      };
    }
    case "add-corridor": {
      const fromRoom = targetRoom(state, op, "No room to run a corridor from yet — build a room first.");
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

  /** The whole session as plain JSON: every state, every entry, the
   *  index into them. `built` is the executor's map (room id -> what
   *  the server already holds) — it travels with the session so a
   *  restart doesn't rebuild rooms that already exist as scenes. */
  snapshot(built?: Map<string, BuiltRoomRef>): BuildSessionSnapshot {
    return {
      version: 1,
      states: clone(this.states),
      entries: clone(this.entries),
      index: this.index,
      built: Object.fromEntries(built ?? new Map()),
    };
  }

  /** Replace this session's history with a snapshot's. Returns false
   *  when the snapshot is the wrong shape (a corrupt state file) —
   *  the caller starts fresh instead. */
  restore(snap: unknown): boolean {
    if (!isBuildSessionSnapshot(snap)) return false;
    this.states = clone(snap.states);
    this.entries = clone(snap.entries);
    this.index = snap.index;
    return true;
  }
}

/** A BuildSession as plain JSON (version 1). */
export interface BuildSessionSnapshot {
  version: 1;
  states: BuildState[];
  entries: BuildHistoryEntry[];
  index: number;
  built: Record<string, BuiltRoomRef>;
}

/** Shape check for a snapshot read back from disk — every field the
 *  session needs, nothing assumed about the rest. */
export function isBuildSessionSnapshot(v: unknown): v is BuildSessionSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (s.version !== 1) return false;
  if (!Array.isArray(s.states) || s.states.length === 0) return false;
  if (!Array.isArray(s.entries)) return false;
  if (typeof s.index !== "number" || s.index < 0 || s.index >= s.states.length) return false;
  if (!s.built || typeof s.built !== "object" || Array.isArray(s.built)) return false;
  for (const st of s.states as Record<string, unknown>[]) {
    if (!st || typeof st !== "object") return false;
    const d = (st as Record<string, unknown>).dungeon as Record<string, unknown> | undefined;
    if (!d || !Array.isArray(d.rooms) || !Array.isArray(d.links)) return false;
  }
  return true;
}

/**
 * Where the build session lives so a monitor restart keeps the
 * dungeon, the history, and the rooms already built on the server.
 * Same pattern as the autopilot / pins state files: an env override,
 * else a dotfile at the repo root. The file is a CACHE of the
 * session, not the source of truth — the scenes themselves live on
 * the server, so a lost file only loses the edit history (and the
 * next build would treat existing scenes as new — re-issue the
 * builds, don't hand-edit the file).
 */
export function defaultBuildStatePath(): string {
  return (
    process.env.FOUNDRY_BUILD_STATE ??
    path.join(import.meta.dir, "..", "..", ".build-state.json")
  );
}

/** Write the session + built map to the state file. Best effort, like
 *  the autopilot/pins state: a failed write never breaks a build. */
export function saveBuildState(
  session: BuildSession,
  built: Map<string, BuiltRoomRef>,
  filePath: string = defaultBuildStatePath(),
): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(session.snapshot(built)), "utf-8");
  } catch {
    // State is a convenience; a failed write must not break the build.
  }
}

/** Read the session + built map back. Returns null when there is no
 *  state yet, or the file is unreadable or the wrong shape — the
 *  caller starts a fresh session either way. */
export function loadBuildState(
  filePath: string = defaultBuildStatePath(),
): { session: BuildSession; built: Map<string, BuiltRoomRef> } | null {
  try {
    const snap = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    const session = new BuildSession();
    if (!session.restore(snap)) return null;
    const built = new Map<string, BuiltRoomRef>(
      Object.entries((snap as BuildSessionSnapshot).built),
    );
    return { session, built };
  } catch {
    return null;
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
    const doorKey = (d: DoorSpec) => {
      const st = doorStateOf(d);
      const key = doorKeyOf(d);
      return `${d.wall}:${d.at}${d.secret ? ":secret" : ""}${st !== "closed" ? `:${st}` : ""}${key ? `:${key}` : ""}`;
    };
    const doorDesc = (d: DoorSpec) => {
      const st = doorStateOf(d);
      const key = doorKeyOf(d);
      return `${d.secret ? "secret " : ""}door ${d.wall}@${d.at}${st !== "closed" ? ` (${st}${key ? `, ${key}` : ""})` : ""}`;
    };
    const oldDoors = new Set((old.doors ?? []).map(doorKey));
    const newDoors = new Set((room.doors ?? []).map(doorKey));
    for (const d of room.doors ?? []) {
      if (!oldDoors.has(doorKey(d))) lines.push(`+ ${doorDesc(d)} in ${room.name}`);
    }
    for (const d of old.doors ?? []) {
      if (!newDoors.has(doorKey(d))) lines.push(`- ${doorDesc(d)} in ${room.name}`);
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
    : op.type === "add-door" || op.type === "move-door" ||
      op.type === "open-door" || op.type === "close-door" ||
      op.type === "lock-door" || op.type === "unlock-door" ? "🚪"
    : op.type === "listen-door" ? "👂"
    : op.type === "add-dressing" ? "✨"
    : op.type === "move-prop" || op.type === "remove-prop" ? "📦"
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
