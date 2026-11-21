/**
 * Multi-floor dungeons + gated reveals (FR-3 / BRA-195) — the pure
 * half plus a thin live layer.
 *
 * The model (data lives in src/worldbuilding/tiles-layout.ts):
 * - A room has a `floor` (0 = ground floor, the default). A `StairLink`
 *   connects two rooms on different floors; its direction ("up"/"down")
 *   is derived from the floor numbers, never stored. `layoutDungeon`
 *   validates stairs like door links and counts them as graph edges.
 * - A stair may carry a `gate` — a GateCondition over plain facts
 *   (pressure plates solved, doors unlocked, levers pulled). The gate
 *   is evaluated against a GateState; `always` (or no gate) is open.
 * - A floor is either revealed or hidden. Floor 0 is always revealed.
 *   A hidden floor's rooms exist (built) but their scenes are built
 *   with navigation off (`RoomSpec.hidden`) — the players cannot see
 *   or navigate to them until a reveal flips them live.
 *
 * The flow, per the spec: a token enters the staircase zone (built by
 * `staircaseZone`, covering the stair door's cell and the cell just
 * inside) and the reveal fires — when the gate is satisfied, the floor
 * is shown: its scenes get navigation, the destination scene
 * activates, and the tokens move up. No creator action in the moment.
 * When the gate is NOT satisfied, nothing is revealed and the table is
 * told what is missing; the zone stays armed so the party can retry
 * after solving the gate (that is why `staircaseZone` does NOT set
 * fireOnce — a spent "once" zone would leave them stuck).
 *
 * Walking a stair directly (resolveStairWalk) is blocked while its
 * floor is hidden, with a reason naming the gate. The reveal itself is
 * idempotent: planning an already-revealed floor is a no-op.
 *
 * Live layer: `revealFloorLive` (flip navigation + activate + move
 * tokens) and `FloorSession` (holds the dungeon + gate state +
 * visibility, and hands a FloorRevealPlayer to a TrapWatcher). The
 * trap CLI wires a session from a `--dungeon` JSON file (see
 * parseBuiltDungeon). The monitor does not yet route stair walks —
 * that is a follow-up, not this item.
 *
 * Import safety: this module statically imports only tiles-layout.ts
 * (pure) and movement.ts (import-safe: type-only live import). It
 * never imports worldbuilding/index.ts or tiles.ts at runtime (those
 * pull the vendored MCP client, which validates FOUNDRY_URL at
 * import) — Scene updates go through `live.modifyDocument` directly,
 * and BuiltDungeon arrives as the plain FloorDungeonFile shape.
 */
import {
  TILE_PX,
  doorEntryCell,
  stairDirection,
  type DoorEnd,
  type DungeonLayout,
  type DungeonRoomSpec,
  type DungeonSpec,
  type GateCondition,
  type ResolvedDoorEnd,
  type ResolvedStairLink,
  type WallSide,
} from "./tiles-layout.js";
import type { FoundryLive } from "../live.js";
import type { Zone, ZoneSet } from "../session/traps.js";
import { deleteToken, placeToken, resolveToken } from "../session/movement.js";

// ---------------------------------------------------------------- gates

/** The facts a gate reads: which plates are solved, which doors are
 *  unlocked, which levers are pulled. Plain arrays — JSON-friendly. */
export interface GateState {
  platesSolved: string[];
  doorsUnlocked: string[];
  leversPulled: string[];
}

export const EMPTY_GATE_STATE: GateState = {
  platesSolved: [],
  doorsUnlocked: [],
  leversPulled: [],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a gate condition (strict: every error listed, never a
 * silent skip). Unknown kinds, empty names, empty all/any lists, and
 * unknown fields are all errors naming the problem.
 */
export function validateGate(
  gate: unknown,
): { ok: true; gate: GateCondition } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const check = (g: unknown, where: string): GateCondition | null => {
    if (!isRecord(g)) {
      errors.push(`${where}: a gate must be an object, got ${JSON.stringify(g)}.`);
      return null;
    }
    const kind = g.kind;
    const allowed: Record<string, string[]> = {
      always: ["kind"],
      "plate-solved": ["kind", "plate"],
      "door-unlocked": ["kind", "door"],
      "lever-pulled": ["kind", "lever"],
      all: ["kind", "gates"],
      any: ["kind", "gates"],
    };
    if (typeof kind !== "string" || !(kind in allowed)) {
      errors.push(
        `${where}: "kind" must be always|plate-solved|door-unlocked|lever-pulled|all|any, got ${JSON.stringify(kind)}.`,
      );
      return null;
    }
    for (const key of Object.keys(g)) {
      if (!allowed[kind]!.includes(key)) {
        errors.push(`${where}: unknown field "${key}" for a ${kind} gate.`);
      }
    }
    if (kind === "always") return { kind: "always" };
    if (kind === "plate-solved" || kind === "door-unlocked" || kind === "lever-pulled") {
      const field = kind === "plate-solved" ? "plate" : kind === "door-unlocked" ? "door" : "lever";
      const name = g[field];
      if (typeof name !== "string" || name.length === 0) {
        errors.push(`${where}: "${field}" must be a non-empty string.`);
        return null;
      }
      return { kind, [field]: name } as GateCondition;
    }
    // all / any.
    if (!Array.isArray(g.gates) || g.gates.length === 0) {
      errors.push(`${where}: "gates" must be a non-empty array.`);
      return null;
    }
    const gates: GateCondition[] = [];
    let bad = false;
    for (let i = 0; i < g.gates.length; i++) {
      const sub = check(g.gates[i], `${where} gates[${i}]`);
      if (!sub) bad = true;
      else gates.push(sub);
    }
    if (bad) return null;
    return { kind, gates } as GateCondition;
  };
  const out = check(gate, "gate");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, gate: out! };
}

/** Evaluate a validated gate against the current facts. */
export function evaluateGate(gate: GateCondition, state: GateState): boolean {
  switch (gate.kind) {
    case "always":
      return true;
    case "plate-solved":
      return state.platesSolved.includes(gate.plate);
    case "door-unlocked":
      return state.doorsUnlocked.includes(gate.door);
    case "lever-pulled":
      return state.leversPulled.includes(gate.lever);
    case "all":
      return gate.gates.every((g) => evaluateGate(g, state));
    case "any":
      return gate.gates.some((g) => evaluateGate(g, state));
  }
}

/** Human-readable gate, for the "sealed until …" line. */
export function describeGate(gate: GateCondition): string {
  switch (gate.kind) {
    case "always":
      return "nothing — the way is open";
    case "plate-solved":
      return `the "${gate.plate}" pressure plate is solved`;
    case "door-unlocked":
      return `the door "${gate.door}" is unlocked`;
    case "lever-pulled":
      return `the "${gate.lever}" lever is pulled`;
    case "all":
      return gate.gates.map(describeGate).join(" and ");
    case "any":
      return gate.gates.map(describeGate).join(" or ");
  }
}

/** The fact names a gate reads, e.g. ["plate:sun-plate"] — what a
 *  session must track to know when the gate flips. */
export function gateFacts(gate: GateCondition): string[] {
  switch (gate.kind) {
    case "always":
      return [];
    case "plate-solved":
      return [`plate:${gate.plate}`];
    case "door-unlocked":
      return [`door:${gate.door}`];
    case "lever-pulled":
      return [`lever:${gate.lever}`];
    case "all":
    case "any":
      return gate.gates.flatMap(gateFacts);
  }
}

// ---------------------------------------------------------------- visibility

/** Which floors the table can see. Floor 0 is always revealed. */
export interface FloorVisibility {
  revealed: number[];
}

export function emptyFloorVisibility(): FloorVisibility {
  return { revealed: [0] };
}

export function isFloorRevealed(v: FloorVisibility, floor: number): boolean {
  return floor === 0 || v.revealed.includes(floor);
}

/** Immutable: returns a new visibility with the floor revealed. */
export function revealFloor(v: FloorVisibility, floor: number): FloorVisibility {
  if (isFloorRevealed(v, floor)) return { revealed: [...v.revealed] };
  return { revealed: [...v.revealed, floor].sort((a, b) => a - b) };
}

/** The floor numbers a dungeon has, ascending. */
export function floorsOf(spec: DungeonSpec): number[] {
  const floors = new Set<number>();
  for (const room of spec.rooms) floors.add(room.floor ?? 0);
  return [...floors].sort((a, b) => a - b);
}

/** Floors that exist but are still hidden. */
export function hiddenFloors(spec: DungeonSpec, v: FloorVisibility): number[] {
  return floorsOf(spec).filter((f) => !isFloorRevealed(v, f));
}

/** Rooms the table can see right now. */
export function visibleRooms(spec: DungeonSpec, v: FloorVisibility): DungeonRoomSpec[] {
  return spec.rooms.filter((r) => isFloorRevealed(v, r.floor ?? 0));
}

// ---------------------------------------------------------------- reveal planning

export type StairRevealPlan =
  | { action: "reveal"; floor: number; stair: ResolvedStairLink }
  | { action: "already-revealed"; floor: number; stair: ResolvedStairLink }
  | { action: "blocked"; floor: number; reason: string; stair: ResolvedStairLink };

/**
 * What entering a staircase zone does: reveal the floor (when the
 * gate is satisfied), nothing (already revealed), or nothing with a
 * reason (gate unsatisfied — the table is told what is missing).
 */
export function planStairReveal(
  stair: ResolvedStairLink,
  gateState: GateState,
  visibility: FloorVisibility,
): StairRevealPlan {
  const floor = stair.to.floor;
  if (isFloorRevealed(visibility, floor)) {
    return { action: "already-revealed", floor, stair };
  }
  const gate = stair.gate;
  if (gate && !evaluateGate(gate, gateState)) {
    return {
      action: "blocked",
      floor,
      reason: `The way ${stair.direction} is sealed until ${describeGate(gate)}.`,
      stair,
    };
  }
  return { action: "reveal", floor, stair };
}

/**
 * Where does walking through this staircase lead? The other end of
 * the stair — or a block: no staircase here, or its floor is still
 * hidden (the reason names the gate when there is one).
 */
export function resolveStairWalk(
  layout: DungeonLayout,
  roomId: string,
  wall: WallSide,
  at: number,
  visibility: FloorVisibility,
): { ok: true; destination: ResolvedDoorEnd; stair: ResolvedStairLink } | { ok: false; reason: string } {
  const key = `${roomId}:${wall}:${at}`;
  const endKey = (e: ResolvedDoorEnd): string => `${e.room}:${e.wall}:${e.at}`;
  for (const stair of layout.stairs) {
    let dest: ResolvedDoorEnd | null = null;
    if (endKey(stair.from) === key) dest = stair.to;
    else if (endKey(stair.to) === key) dest = stair.from;
    if (!dest) continue;
    if (!isFloorRevealed(visibility, dest.floor)) {
      const gate = stair.gate;
      return {
        ok: false,
        reason: gate
          ? `The way ${stair.direction} is sealed until ${describeGate(gate)}.`
          : `Floor ${dest.floor} is not revealed yet.`,
      };
    }
    return { ok: true, destination: dest, stair };
  }
  return { ok: false, reason: `No staircase at ${key} — that door does not lead up or down.` };
}

// ---------------------------------------------------------------- staircase zone

function doorCellFor(
  wall: WallSide,
  at: number,
  gridW: number,
  gridH: number,
): { gx: number; gy: number } {
  switch (wall) {
    case "north":
      return { gx: at, gy: 0 };
    case "south":
      return { gx: at, gy: gridH - 1 };
    case "west":
      return { gx: 0, gy: at };
    case "east":
      return { gx: gridW - 1, gy: at };
  }
}

/**
 * The trigger zone for a staircase: a rect covering the stair door's
 * cell and the cell just inside it, on the source room's scene, with
 * a `reveal-floor` action naming the stair. A token stepping up to
 * the door (or standing just inside it) fires the reveal.
 *
 * fireOnce is deliberately false: a gate-blocked reveal must be
 * retryable after the party solves the gate, and the reveal itself is
 * idempotent (the player no-ops once the floor is revealed).
 */
export function staircaseZone(
  room: DungeonRoomSpec,
  end: DoorEnd,
  opts: { name?: string; gate?: GateCondition; gridSize?: number } = {},
): Zone {
  const grid = opts.gridSize ?? TILE_PX;
  const inside = doorEntryCell(end.wall, end.at, room.gridW, room.gridH);
  const doorCell = doorCellFor(end.wall, end.at, room.gridW, room.gridH);
  const x = Math.min(doorCell.gx, inside.gx) * grid;
  const y = Math.min(doorCell.gy, inside.gy) * grid;
  const w = (Math.abs(doorCell.gx - inside.gx) + 1) * grid;
  const h = (Math.abs(doorCell.gy - inside.gy) + 1) * grid;
  return {
    name: opts.name ?? `Staircase — ${room.name}`,
    shape: { kind: "rect", x, y, w, h },
    actions: [
      {
        type: "reveal-floor",
        stair: { room: room.id, wall: end.wall, at: end.at },
        ...(opts.gate ? { gate: opts.gate } : {}),
      },
    ],
    triggerFor: "any",
    fireOnce: false,
  };
}

/** The trigger plan for a zone set's reveal-floor actions (CLI --plan). */
export interface FloorRevealPlan {
  zone: string;
  stair: { room: string; wall: WallSide; at: number };
  gateDescription?: string;
  mode: "once" | "per-token";
}

export function planFloorReveals(zoneSet: ZoneSet): { sceneId: string; reveals: FloorRevealPlan[] } {
  const reveals: FloorRevealPlan[] = [];
  for (const zone of zoneSet.zones) {
    for (const action of zone.actions) {
      if (action.type !== "reveal-floor") continue;
      reveals.push({
        zone: zone.name,
        stair: action.stair,
        ...(action.gate ? { gateDescription: describeGate(action.gate) } : {}),
        mode: zone.fireOnce ? "once" : "per-token",
      });
    }
  }
  return { sceneId: zoneSet.sceneId, reveals };
}

// ---------------------------------------------------------------- live layer

/**
 * The dungeon as the live floor layer needs it: room id → scene id +
 * floor, and the resolved stairs. `floorDungeonOf` builds it from a
 * BuiltDungeon (see tiles.ts); the trap CLI parses it from JSON (see
 * parseBuiltDungeon).
 */
export interface FloorDungeonFile {
  rooms: { id: string; sceneId: string; floor: number }[];
  stairs: ResolvedStairLink[];
}

/** Build the live floor view from a BuiltDungeon (rooms carry floor
 *  after the BRA-195 tiles.ts change; stairs resolve in buildDungeon). */
export function floorDungeonOf(dungeon: {
  rooms: { id: string; sceneId: string; floor?: number }[];
  stairs: ResolvedStairLink[];
}): FloorDungeonFile {
  return {
    rooms: dungeon.rooms.map((r) => ({ id: r.id, sceneId: r.sceneId, floor: r.floor ?? 0 })),
    stairs: dungeon.stairs,
  };
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Validate a `--dungeon` JSON file for the trap CLI. Shape:
 *   { "rooms": [{ "id", "sceneId", "floor"? }], "stairs": [{ "from": {room, wall, at, enterGx, enterGy}, "to": {...}, "gate"? }] }
 * Direction is derived from the rooms' floors. Every error is listed.
 */
export function parseBuiltDungeon(
  input: unknown,
): { ok: true; dungeon: FloorDungeonFile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["Dungeon file must be a JSON object."] };
  }
  if (!Array.isArray(input.rooms) || input.rooms.length === 0) {
    errors.push(`"rooms" must be a non-empty array.`);
    return { ok: false, errors };
  }
  const rooms: FloorDungeonFile["rooms"] = [];
  const floorById = new Map<string, number>();
  for (let i = 0; i < input.rooms.length; i++) {
    const where = `Room ${i}`;
    const r = input.rooms[i];
    if (!isRecord(r)) {
      errors.push(`${where}: must be an object.`);
      continue;
    }
    if (typeof r.id !== "string" || r.id.length === 0) {
      errors.push(`${where}: "id" must be a non-empty string.`);
      continue;
    }
    if (typeof r.sceneId !== "string" || r.sceneId.length === 0) {
      errors.push(`${where}: "sceneId" must be a non-empty string.`);
      continue;
    }
    if (floorById.has(r.id)) {
      errors.push(`${where}: duplicate room id "${r.id}".`);
      continue;
    }
    const floor = r.floor === undefined ? 0 : r.floor;
    if (!isInt(floor) || floor < 0) {
      errors.push(`${where}: "floor" must be a non-negative integer, got ${JSON.stringify(r.floor)}.`);
      continue;
    }
    floorById.set(r.id, floor);
    rooms.push({ id: r.id, sceneId: r.sceneId, floor });
  }
  const stairs: ResolvedStairLink[] = [];
  if (input.stairs !== undefined) {
    if (!Array.isArray(input.stairs)) {
      errors.push(`"stairs" must be an array.`);
    } else {
      const readEnd = (
        raw: unknown,
        where: string,
      ): ResolvedDoorEnd | null => {
        if (!isRecord(raw)) {
          errors.push(`${where}: must be an object {room, wall, at, enterGx, enterGy}.`);
          return null;
        }
        let bad = false;
        if (typeof raw.room !== "string" || raw.room.length === 0) {
          errors.push(`${where}: "room" must be a non-empty string.`);
          bad = true;
        } else if (!floorById.has(raw.room)) {
          errors.push(`${where}: unknown room "${raw.room}".`);
          bad = true;
        }
        if (
          typeof raw.wall !== "string" ||
          !["north", "south", "east", "west"].includes(raw.wall)
        ) {
          errors.push(`${where}: "wall" must be north|south|east|west.`);
          bad = true;
        }
        for (const f of ["at", "enterGx", "enterGy"] as const) {
          if (!isInt(raw[f]) || (raw[f] as number) < 0) {
            errors.push(`${where}: "${f}" must be a non-negative integer.`);
            bad = true;
          }
        }
        if (bad) return null;
        return {
          room: raw.room as string,
          wall: raw.wall as WallSide,
          at: raw.at as number,
          enterGx: raw.enterGx as number,
          enterGy: raw.enterGy as number,
          floor: floorById.get(raw.room as string)!,
        };
      };
      for (let i = 0; i < input.stairs.length; i++) {
        const where = `Stair ${i}`;
        const s = input.stairs[i];
        if (!isRecord(s)) {
          errors.push(`${where}: must be an object.`);
          continue;
        }
        const from = readEnd(s.from, `${where} from`);
        const to = readEnd(s.to, `${where} to`);
        if (!from || !to) continue;
        if (from.room === to.room) {
          errors.push(`${where}: a staircase must lead to another room.`);
          continue;
        }
        if (from.floor === to.floor) {
          errors.push(
            `${where}: stays on floor ${from.floor} — a staircase must connect different floors (rooms "${from.room}" and "${to.room}").`,
          );
          continue;
        }
        let gate: GateCondition | undefined;
        if (s.gate !== undefined) {
          const g = validateGate(s.gate);
          if (!g.ok) {
            for (const e of g.errors) errors.push(`${where} gate: ${e}`);
            continue;
          }
          gate = g.gate;
        }
        stairs.push({
          from,
          to,
          direction: stairDirection(from.floor, to.floor),
          ...(gate ? { gate } : {}),
        });
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, dungeon: { rooms, stairs } };
}

/** Validate a `--gate-state` JSON file: optional arrays of fact names. */
export function parseGateState(
  input: unknown,
): { ok: true; state: GateState } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["Gate state must be a JSON object."] };
  }
  const state: GateState = { platesSolved: [], doorsUnlocked: [], leversPulled: [] };
  for (const [field, key] of [
    ["platesSolved", "platesSolved"],
    ["doorsUnlocked", "doorsUnlocked"],
    ["leversPulled", "leversPulled"],
  ] as const) {
    const v = input[field];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) {
      errors.push(`"${field}" must be an array of non-empty strings.`);
      continue;
    }
    state[key] = [...v];
  }
  for (const k of Object.keys(input)) {
    if (!["platesSolved", "doorsUnlocked", "leversPulled"].includes(k)) {
      errors.push(`Unknown field "${k}" (known: platesSolved, doorsUnlocked, leversPulled).`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, state };
}

/**
 * Move tokens through a staircase: delete on the source scene,
 * re-place on the destination scene at the arrival cell (Foundry has
 * no cross-scene token move — same pattern as walkThroughDoor in
 * tiles.ts). `from` is the end the tokens are standing at; the other
 * end is the destination.
 */
export async function climbStair(
  live: FoundryLive,
  dungeon: FloorDungeonFile,
  stair: ResolvedStairLink,
  from: DoorEnd,
  tokenIds: string[],
): Promise<{
  toSceneId: string;
  tokens: { oldId: string; newId: string; name: string }[];
}> {
  const fromKey = `${from.room}:${from.wall}:${from.at}`;
  const endKey = (e: ResolvedDoorEnd): string => `${e.room}:${e.wall}:${e.at}`;
  let dest: ResolvedDoorEnd | null = null;
  if (endKey(stair.from) === fromKey) dest = stair.to;
  else if (endKey(stair.to) === fromKey) dest = stair.from;
  if (!dest) {
    throw new Error(`No staircase at ${fromKey} — that door does not lead up or down.`);
  }
  const fromScene = dungeon.rooms.find((r) => r.id === from.room);
  const toScene = dungeon.rooms.find((r) => r.id === dest.room);
  if (!fromScene || !toScene) {
    throw new Error(`Dungeon is missing a scene for ${!fromScene ? from.room : dest.room}.`);
  }
  const x = dest.enterGx * TILE_PX + TILE_PX / 2;
  const y = dest.enterGy * TILE_PX + TILE_PX / 2;
  const moved: { oldId: string; newId: string; name: string }[] = [];
  for (const tokenId of tokenIds) {
    const token = resolveToken(live, fromScene.sceneId, tokenId);
    if (!token.actorId) {
      throw new Error(`Token ${token.name} has no actor — cannot re-place it on floor ${dest.floor}.`);
    }
    await deleteToken(live, fromScene.sceneId, token._id);
    const newId = await placeToken(live, toScene.sceneId, token.actorId, x, y, { name: token.name });
    moved.push({ oldId: token._id, newId, name: token.name });
  }
  return { toSceneId: toScene.sceneId, tokens: moved };
}

/**
 * Execute a reveal: every scene on the target floor gets navigation,
 * the stair's destination scene activates (the creator authored this
 * reveal — the party's climb triggers it, no creator action in the
 * moment), and the tokens move up. Planning (gate + visibility) is
 * the caller's job — see planStairReveal / FloorSession.
 */
export async function revealFloorLive(
  live: FoundryLive,
  dungeon: FloorDungeonFile,
  stair: ResolvedStairLink,
  tokenIds: string[],
): Promise<{
  toSceneId: string;
  tokens: { oldId: string; newId: string; name: string }[];
}> {
  const targetFloor = stair.to.floor;
  const targetScenes = dungeon.rooms.filter((r) => r.floor === targetFloor);
  if (targetScenes.length === 0) {
    throw new Error(`No rooms on floor ${targetFloor} — nothing to reveal.`);
  }
  const destSceneId = dungeon.rooms.find((r) => r.id === stair.to.room)?.sceneId;
  if (!destSceneId) throw new Error(`Dungeon is missing a scene for ${stair.to.room}.`);
  await live.modifyDocument("Scene", "update", {
    updates: targetScenes.map((r) => ({
      _id: r.sceneId,
      navigation: true,
      ...(r.sceneId === destSceneId ? { active: true } : {}),
    })),
  });
  return climbStair(live, dungeon, stair, stair.from, tokenIds);
}

/**
 * A session's floor state: the dungeon, the gate facts as they flip,
 * and which floors are revealed. Hands a FloorRevealPlayer to a
 * TrapWatcher so staircase zones fire reveals live.
 */
export class FloorSession {
  readonly dungeon: FloorDungeonFile;
  private gateState: GateState;
  private visibility: FloorVisibility;

  constructor(
    dungeon: FloorDungeonFile,
    opts: { gateState?: GateState; revealed?: number[] } = {},
  ) {
    this.dungeon = dungeon;
    // Deep-copy the arrays: a shallow copy would share them with the
    // caller's state (or the EMPTY_GATE_STATE constant), so marking a
    // plate in one session would leak into every later session.
    const gs = opts.gateState;
    this.gateState = gs
      ? {
          platesSolved: [...gs.platesSolved],
          doorsUnlocked: [...gs.doorsUnlocked],
          leversPulled: [...gs.leversPulled],
        }
      : { platesSolved: [], doorsUnlocked: [], leversPulled: [] };
    const revealed = [...(opts.revealed ?? [0])];
    if (!revealed.includes(0)) revealed.push(0);
    this.visibility = { revealed: revealed.sort((a, b) => a - b) };
  }

  /** Current state (copies — the session owns the originals). */
  get state(): { gateState: GateState; visibility: FloorVisibility } {
    return {
      gateState: { ...this.gateState, platesSolved: [...this.gateState.platesSolved], doorsUnlocked: [...this.gateState.doorsUnlocked], leversPulled: [...this.gateState.leversPulled] },
      visibility: { revealed: [...this.visibility.revealed] },
    };
  }

  markPlateSolved(plate: string): void {
    if (!this.gateState.platesSolved.includes(plate)) this.gateState.platesSolved.push(plate);
  }

  markDoorUnlocked(door: string): void {
    if (!this.gateState.doorsUnlocked.includes(door)) this.gateState.doorsUnlocked.push(door);
  }

  markLeverPulled(lever: string): void {
    if (!this.gateState.leversPulled.includes(lever)) this.gateState.leversPulled.push(lever);
  }

  /**
   * The FloorRevealPlayer to inject into a TrapWatcher. Plans the
   * reveal from current state, executes it when the gate is satisfied
   * (and records the floor as revealed), and tells the table what is
   * missing when it is not. An already-revealed floor is silent —
   * the zone re-firing must not spam chat.
   */
  revealPlayer(): (
    live: FoundryLive,
    action: { type: "reveal-floor"; stair: { room: string; wall: WallSide; at: number }; gate?: GateCondition },
    token: { _id: string; name: string },
  ) => Promise<{ revealed: boolean; reason?: string }> {
    return async (live, action, token) => {
      const stair = this.dungeon.stairs.find(
        (s) =>
          s.from.room === action.stair.room &&
          s.from.wall === action.stair.wall &&
          s.from.at === action.stair.at,
      );
      if (!stair) {
        const reason = `No staircase at ${action.stair.room}:${action.stair.wall}:${action.stair.at} in this dungeon — the reveal is not wired.`;
        await live.sendChat(`🚪 **${token.name}** reaches the stairs, but ${reason}`);
        return { revealed: false, reason };
      }
      // The zone's own gate wins over the dungeon's when both are set:
      // the zone is the author's latest word for this staircase.
      const effective: ResolvedStairLink =
        action.gate !== undefined ? { ...stair, gate: action.gate } : stair;
      const plan = planStairReveal(effective, this.gateState, this.visibility);
      if (plan.action === "already-revealed") return { revealed: true };
      if (plan.action === "blocked") {
        await live.sendChat(`🚪 **${token.name}** reaches the stairs, but ${plan.reason}`);
        return { revealed: false, reason: plan.reason };
      }
      await revealFloorLive(live, this.dungeon, effective, [token._id]);
      this.visibility = revealFloor(this.visibility, plan.floor);
      await live.sendChat(`🌀 The way ${effective.direction} opens — floor ${plan.floor} is revealed!`);
      return { revealed: true };
    };
  }
}
