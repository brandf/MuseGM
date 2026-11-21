/**
 * Moving vehicles (BRA-235) — a vehicle map that advances each round.
 *
 * The doc, Act Three (Great Train Robbery beat 1): "a moving-feel map
 * — locomotive, tender, three cars — with the party's riders placed
 * at a gallop on both sides, dust and smoke doing the motion. The
 * train runs on a clock: every round it covers ground, and the
 * trestle bridge ahead is the deadline."
 *
 * A vehicle is cars + a track/route, in grid cells (1 cell = 100px
 * on the table — the live layer converts cells to px). The vehicle's
 * front sits at a distance along the route's polyline; each round it
 * advances by its speed (cells per round). Cars trail behind the
 * front, front-to-back, with a fixed gap between adjacent cars.
 * Riders aboard a car move with it (their offset inside the car is
 * fixed); escorts alongside keep pace with the front at a fixed
 * lateral offset — the party galloping next to the train. The route's
 * deadline (the bridge) is a clock that fires exactly once when the
 * front reaches it; its consequence is data, not code (same rule as
 * the clocks module, BRA-228).
 *
 * HONESTY RULE (same as the quest log, chronicle, and clocks): every
 * state change carries a `source` — a combat round, a GM statement,
 * a CLI invocation. A change without a source is rejected, so the
 * store never silently gains movement nobody called for. History is
 * append-only: creates, advances, boards, leaves, stops, resumes,
 * and speed changes are all recorded with their source.
 *
 * Two layers, kept separate on purpose (same pattern as
 * src/session/clocks.ts and src/session/scoreboard.ts):
 * - Pure functions (createVehicle / advanceVehicle / boardVehicle /
 *   leaveVehicle / addAlongside / removeAlongside / stopVehicle /
 *   resumeVehicle / setSpeed / vehicleTokenPositions /
 *   renderVehicle / serializeVehicleStore / parseVehicleStore /
 *   ...): no Foundry, no I/O, unit tested in tests/vehicles.test.ts.
 * - Live functions (*Live): thin wrappers over FoundryLive —
 *   advanceVehicleLive moves every token the advance shifted (one
 *   batched Token update) and announces deadline/arrival lines in
 *   chat; boardVehicleLive moves the boarding token onto its car.
 *   The store itself lives in a state file (same convention as the
 *   clock/scoreboard state files) while the watcher runs; persisting
 *   it as a JournalEntry the table can open is a follow-up.
 *
 * What this module deliberately does NOT do:
 * - It does not route chat messages — the monitor owns that. Wiring
 *   a "the train pulls ahead" sentence into the monitor is a
 *   follow-up; the CLI --advance/--watch is the live path today.
 * - It does not glide. A live advance sets each shifted token's new
 *   position in one batched update per round — the train "covers
 *   ground" between rounds. A smooth stepped glide (like
 *   moveTokenTo) is a follow-up.
 * - It does not move scenery. The route is a path the vehicle
 *   travels; dust, smoke, and passing scenery are dressing the GM
 *   stages alongside it, not state this module owns.
 * - The cutscene `move-vehicle` step (src/session/cutscene.ts)
 *   expands from a vehicle snapshot into concrete `move` steps, but
 *   expansion does NOT persist the advanced vehicle — the caller
 *   (monitor/autopilot) must save the new state. Playing a
 *   move-vehicle step through playCutscene with vehicle state
 *   loaded and saved is a follow-up.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FoundryLive } from "../live.js";

/** Validation / lookup failure. */
export class VehicleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VehicleError";
  }
}

/** Pixels per grid cell — the live layer converts cells to px. */
export const CELL_PX = 100;

/** A route waypoint, in integer grid cells. */
export interface RoutePoint {
  x: number;
  y: number;
}

/** One car of a vehicle, listed front-to-back. */
export interface VehicleCar {
  id: string;
  name: string;
  /** Length along the route, in cells. */
  lengthCells: number;
}

/** The route's deadline — the trestle bridge. Fires exactly once. */
export interface VehicleDeadline {
  name: string;
  /** Distance along the route (cells) where the front triggers it. */
  atDistance: number;
  /** What happens — data, not code; the caller delivers it. */
  consequence: string;
}

/** A token riding aboard a car. */
export interface VehicleRider {
  tokenId: string;
  name?: string;
  carId: string;
  /** Cells behind the car's front edge (0 = at the front). */
  offsetCells: number;
  /** Cells sideways from the car's centerline (0 = centered). */
  lateralCells: number;
}

/** A token keeping pace alongside the vehicle (galloping riders). */
export interface VehicleAlongside {
  tokenId: string;
  name?: string;
  /** Cells behind the vehicle's front. */
  behindCells: number;
  /** Cells sideways from the route centerline. Non-zero — an escort
   *  at lateral 0 would be standing on the rails. Positive is left
   *  of the direction of travel. */
  lateralCells: number;
}

export type VehicleStatus = "running" | "arrived" | "stopped";

/** One append-only history entry. Every change carries a source. */
export interface VehicleHistoryEntry {
  kind:
    | "create"
    | "advance"
    | "board"
    | "leave"
    | "alongside-add"
    | "alongside-remove"
    | "stop"
    | "resume"
    | "speed";
  detail: string;
  source: string;
}

export interface Vehicle {
  id: string;
  name: string;
  /** Free-form kind: train, ship, wagon, airship, ... */
  kind: string;
  route: RoutePoint[];
  /** Total route length in cells (derived from the route). */
  routeLength: number;
  /** Cells the front covers per round. */
  speedCellsPerRound: number;
  /** Gap between adjacent cars, in cells. */
  gapCells: number;
  cars: VehicleCar[];
  /** Front's distance along the route, in cells. */
  distance: number;
  status: VehicleStatus;
  deadline?: VehicleDeadline;
  deadlineFired: boolean;
  /** Foundry token id of the lead token (e.g. the locomotive). */
  tokenId?: string;
  /** Scene the vehicle runs on (required for live moves). */
  sceneId?: string;
  riders: VehicleRider[];
  alongside: VehicleAlongside[];
  history: VehicleHistoryEntry[];
}

export type VehicleAdvanceEvent =
  | { type: "deadline"; name: string; consequence: string }
  | { type: "arrived" }
  | { type: "not-advanced"; reason: string };

export interface AdvanceResult {
  vehicle: Vehicle;
  movedCells: number;
  events: VehicleAdvanceEvent[];
}

/** A token's computed position after an advance, in cells. */
export interface VehicleTokenPosition {
  tokenId: string;
  name?: string;
  role: "vehicle" | "rider" | "alongside";
  x: number;
  y: number;
}

export interface VehicleStore {
  vehicles: Vehicle[];
}

// ---------------------------------------------------------------- helpers

/** Slugify a name ("The Iron Horse" -> "the-iron-horse"). */
export function vehicleIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "vehicle";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Length of a route polyline, in cells. */
export function routeLength(route: RoutePoint[]): number {
  let total = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    total += Math.hypot(route[i + 1].x - route[i].x, route[i + 1].y - route[i].y);
  }
  return total;
}

/**
 * Point on the route at a distance along it (cells), with the
 * heading of the segment it lies on (degrees, east = 0, clockwise
 * in screen coords where y grows south). Distances outside
 * [0, length] clamp to the route's ends.
 */
export function pointAtDistance(
  route: RoutePoint[],
  distance: number,
): { x: number; y: number; headingDeg: number } {
  const total = routeLength(route);
  let d = Math.max(0, Math.min(total, distance));
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i];
    const b = route[i + 1];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= seg) {
      const t = seg === 0 ? 0 : d / seg;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        headingDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      };
    }
    d -= seg;
  }
  // Past the last segment (d was clamped to the total): the last
  // waypoint, with the last segment's heading.
  const last = route[route.length - 1];
  const prev = route[route.length - 2] ?? last;
  return {
    x: last.x,
    y: last.y,
    headingDeg: (Math.atan2(last.y - prev.y, last.x - prev.x) * 180) / Math.PI,
  };
}

/** Left-hand unit normal of a heading (positive lateral = left of travel). */
function leftNormal(headingDeg: number): { x: number; y: number } {
  const rad = (headingDeg * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/** Total extent of the vehicle (cars + gaps), in cells. */
export function vehicleExtent(cars: VehicleCar[], gapCells: number): number {
  return (
    cars.reduce((sum, c) => sum + c.lengthCells, 0) +
    Math.max(0, cars.length - 1) * gapCells
  );
}

/** Front's distance for car j (cars listed front-to-back). */
export function carFrontDistance(vehicle: Vehicle, carIndex: number): number {
  let d = vehicle.distance;
  for (let j = 0; j < carIndex; j++) {
    d -= vehicle.cars[j].lengthCells + vehicle.gapCells;
  }
  return d;
}

/** Center position of a car, in cells. */
export function carPosition(
  vehicle: Vehicle,
  carIndex: number,
): { x: number; y: number; headingDeg: number } {
  const car = vehicle.cars[carIndex];
  const front = carFrontDistance(vehicle, carIndex);
  return pointAtDistance(vehicle.route, front - car.lengthCells / 2);
}

/** Absolute position of a rider, in cells. */
export function riderPosition(
  vehicle: Vehicle,
  rider: VehicleRider,
): { x: number; y: number } {
  const carIndex = vehicle.cars.findIndex((c) => c.id === rider.carId);
  if (carIndex < 0) throw new VehicleError(`Unknown car "${rider.carId}".`);
  const front = carFrontDistance(vehicle, carIndex);
  const at = pointAtDistance(vehicle.route, front - rider.offsetCells);
  const n = leftNormal(at.headingDeg);
  return { x: at.x + n.x * rider.lateralCells, y: at.y + n.y * rider.lateralCells };
}

/** Absolute position of an alongside escort, in cells. */
export function alongsidePosition(
  vehicle: Vehicle,
  escort: VehicleAlongside,
): { x: number; y: number } {
  const at = pointAtDistance(vehicle.route, vehicle.distance - escort.behindCells);
  const n = leftNormal(at.headingDeg);
  return { x: at.x + n.x * escort.lateralCells, y: at.y + n.y * escort.lateralCells };
}

// ---------------------------------------------------------------- validation

export interface CreateVehicleInput {
  name: string;
  kind: string;
  route: RoutePoint[];
  speedCellsPerRound: number;
  gapCells?: number;
  cars: VehicleCar[];
  /** Front's starting distance. Default: the whole vehicle on the
   *  route (back of the last car at the route start). */
  startDistance?: number;
  deadline?: VehicleDeadline;
  tokenId?: string;
  sceneId?: string;
  riders?: VehicleRider[];
  alongside?: VehicleAlongside[];
  source: string;
}

function validateRoute(route: unknown, errors: string[]): RoutePoint[] | null {
  if (!Array.isArray(route) || route.length < 2) {
    errors.push(`"route" must be an array of at least 2 waypoints, got ${JSON.stringify(route)}.`);
    return null;
  }
  let ok = true;
  for (let i = 0; i < route.length; i++) {
    const p = route[i] as Record<string, unknown>;
    if (
      !isRecord(p) ||
      !Number.isInteger(p.x) ||
      !Number.isInteger(p.y)
    ) {
      errors.push(`"route[${i}]" must be {x, y} integer cells, got ${JSON.stringify(p)}.`);
      ok = false;
    }
  }
  if (!ok) return null;
  const pts = route as RoutePoint[];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pts[i].x === pts[i + 1].x && pts[i].y === pts[i + 1].y) {
      errors.push(
        `"route[${i}]" and "route[${i + 1}]" are the same cell — consecutive waypoints must differ.`,
      );
    }
  }
  return pts;
}

function validateCars(cars: unknown, errors: string[]): VehicleCar[] | null {
  if (!Array.isArray(cars) || cars.length === 0) {
    errors.push(`"cars" must be a non-empty array, got ${JSON.stringify(cars)}.`);
    return null;
  }
  const seen = new Set<string>();
  let ok = true;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i] as Record<string, unknown>;
    if (!isRecord(c)) {
      errors.push(`"cars[${i}]" must be {id, name, lengthCells}.`);
      ok = false;
      continue;
    }
    if (typeof c.id !== "string" || c.id.length === 0) {
      errors.push(`"cars[${i}].id" must be a non-empty string.`);
      ok = false;
    } else if (seen.has(c.id)) {
      errors.push(`"cars[${i}].id" ${JSON.stringify(c.id)} is used twice.`);
      ok = false;
    } else {
      seen.add(c.id);
    }
    if (typeof c.name !== "string" || c.name.length === 0) {
      errors.push(`"cars[${i}].name" must be a non-empty string.`);
      ok = false;
    }
    if (!isFiniteNumber(c.lengthCells) || (c.lengthCells as number) <= 0) {
      errors.push(`"cars[${i}].lengthCells" must be > 0, got ${JSON.stringify(c.lengthCells)}.`);
      ok = false;
    }
  }
  return ok ? (cars as VehicleCar[]) : null;
}

export interface ValidatedVehicleInput extends CreateVehicleInput {
  gapCells: number;
  startDistance: number;
  riders: VehicleRider[];
  alongside: VehicleAlongside[];
}

/**
 * Validate a create-vehicle input. Returns every error found, or the
 * normalized input when valid. Shared by createVehicle and
 * parseVehicle so a stored vehicle can never pass a check its
 * creation would have failed.
 */
function validateCreateInput(
  input: CreateVehicleInput,
  opts: { forParse?: boolean } = {},
): { ok: true; value: ValidatedVehicleInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    errors.push(`"name" must be a non-empty string.`);
  }
  if (typeof input.kind !== "string" || input.kind.trim().length === 0) {
    errors.push(`"kind" must be a non-empty string (train, ship, wagon, airship, ...).`);
  }
  const route = validateRoute(input.route, errors);
  if (!isFiniteNumber(input.speedCellsPerRound) || input.speedCellsPerRound <= 0) {
    errors.push(`"speedCellsPerRound" must be > 0, got ${JSON.stringify(input.speedCellsPerRound)}.`);
  }
  const gapCells = input.gapCells ?? 0;
  if (!isFiniteNumber(gapCells) || gapCells < 0) {
    errors.push(`"gapCells" must be >= 0, got ${JSON.stringify(input.gapCells)}.`);
  }
  const cars = validateCars(input.cars, errors);
  if (input.tokenId !== undefined && (typeof input.tokenId !== "string" || input.tokenId.length === 0)) {
    errors.push(`"tokenId" must be a non-empty string when present.`);
  }
  if (input.sceneId !== undefined && (typeof input.sceneId !== "string" || input.sceneId.length === 0)) {
    errors.push(`"sceneId" must be a non-empty string when present.`);
  }
  if (typeof input.source !== "string" || input.source.trim().length === 0) {
    errors.push(`"source" is required — every vehicle change carries its source.`);
  }

  let startDistance: number | undefined;
  let total = 0;
  if (route && cars) {
    total = routeLength(route);
    const extent = vehicleExtent(cars, gapCells);
    if (extent > total) {
      errors.push(
        `The route is ${total} cells long but the vehicle is ${extent} cells long — the route must be at least as long as the vehicle.`,
      );
    }
    startDistance = input.startDistance ?? extent;
    if (!isFiniteNumber(startDistance) || startDistance < 0 || startDistance > total) {
      errors.push(`"startDistance" must be between 0 and ${total}, got ${JSON.stringify(input.startDistance)}.`);
    }
  }

  if (input.deadline !== undefined) {
    const dl = input.deadline;
    if (!isRecord(dl)) {
      errors.push(`"deadline" must be {name, atDistance, consequence}.`);
    } else {
      if (typeof dl.name !== "string" || dl.name.length === 0) {
        errors.push(`"deadline.name" must be a non-empty string.`);
      }
      if (typeof dl.consequence !== "string" || dl.consequence.length === 0) {
        errors.push(`"deadline.consequence" must be a non-empty string.`);
      }
      if (!isFiniteNumber(dl.atDistance)) {
        errors.push(`"deadline.atDistance" must be a number, got ${JSON.stringify(dl.atDistance)}.`);
      } else if (route) {
        if ((dl.atDistance as number) > total) {
          errors.push(
            `"deadline.atDistance" ${dl.atDistance} is past the end of the route (${total}) — a deadline past the route can never fire.`,
          );
        } else if (startDistance !== undefined && (dl.atDistance as number) <= startDistance) {
          // A stored vehicle re-validated after advancing may sit
          // past its (already fired) deadline — the stored-state
          // check in parseVehicle covers that; creation does not
          // get the exemption.
          if (!opts.forParse) {
            errors.push(
              `"deadline.atDistance" ${dl.atDistance} is at or behind the starting distance ${startDistance} — the deadline would already be passed.`,
            );
          }
        }
      }
    }
  }

  // Riders and escorts share the token-id namespace: a token cannot
  // be both aboard and alongside.
  const tokenIds = new Set<string>();
  const riders = input.riders ?? [];
  const alongside = input.alongside ?? [];
  if (!Array.isArray(riders)) {
    errors.push(`"riders" must be an array when present.`);
  } else if (cars) {
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i] as unknown as Record<string, unknown>;
      if (!isRecord(r)) {
        errors.push(`"riders[${i}]" must be {tokenId, carId, offsetCells, lateralCells}.`);
        continue;
      }
      if (typeof r.tokenId !== "string" || r.tokenId.length === 0) {
        errors.push(`"riders[${i}].tokenId" must be a non-empty string.`);
      } else if (tokenIds.has(r.tokenId)) {
        errors.push(`"riders[${i}].tokenId" ${JSON.stringify(r.tokenId)} is already aboard or alongside.`);
      } else {
        tokenIds.add(r.tokenId);
      }
      const car = (cars as VehicleCar[]).find((c) => c.id === r.carId);
      if (typeof r.carId !== "string" || !car) {
        errors.push(
          `"riders[${i}].carId" must be one of the cars (${(cars as VehicleCar[]).map((c) => c.id).join(", ")}), got ${JSON.stringify(r.carId)}.`,
        );
      } else {
        if (!isFiniteNumber(r.offsetCells) || (r.offsetCells as number) < 0 || (r.offsetCells as number) > car.lengthCells) {
          errors.push(
            `"riders[${i}].offsetCells" must be between 0 and ${car.lengthCells} (the length of car "${car.id}"), got ${JSON.stringify(r.offsetCells)}.`,
          );
        }
      }
      if (!isFiniteNumber(r.lateralCells)) {
        errors.push(`"riders[${i}].lateralCells" must be a number, got ${JSON.stringify(r.lateralCells)}.`);
      }
    }
  }
  if (!Array.isArray(alongside)) {
    errors.push(`"alongside" must be an array when present.`);
  } else {
    for (let i = 0; i < alongside.length; i++) {
      const e = alongside[i] as unknown as Record<string, unknown>;
      if (!isRecord(e)) {
        errors.push(`"alongside[${i}]" must be {tokenId, behindCells, lateralCells}.`);
        continue;
      }
      if (typeof e.tokenId !== "string" || e.tokenId.length === 0) {
        errors.push(`"alongside[${i}].tokenId" must be a non-empty string.`);
      } else if (tokenIds.has(e.tokenId)) {
        errors.push(`"alongside[${i}].tokenId" ${JSON.stringify(e.tokenId)} is already aboard or alongside.`);
      } else {
        tokenIds.add(e.tokenId);
      }
      if (!isFiniteNumber(e.behindCells) || (e.behindCells as number) < 0) {
        errors.push(`"alongside[${i}].behindCells" must be >= 0, got ${JSON.stringify(e.behindCells)}.`);
      }
      if (!isFiniteNumber(e.lateralCells) || e.lateralCells === 0) {
        errors.push(
          `"alongside[${i}].lateralCells" must be a non-zero number — an escort at lateral 0 would be standing on the rails, got ${JSON.stringify(e.lateralCells)}.`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...input,
      gapCells,
      route: route as RoutePoint[],
      cars: cars as VehicleCar[],
      riders: riders as VehicleRider[],
      alongside: alongside as VehicleAlongside[],
      startDistance: startDistance as number,
    },
  };
}

// ---------------------------------------------------------------- creation

/** Create a vehicle. Throws VehicleError listing every problem. */
export function createVehicle(input: CreateVehicleInput): Vehicle {
  const checked = validateCreateInput(input);
  if (!checked.ok) {
    throw new VehicleError(`Invalid vehicle:\n- ${checked.errors.join("\n- ")}`);
  }
  const v = checked.value;
  const vehicle: Vehicle = {
    id: vehicleIdFromName(v.name),
    name: v.name,
    kind: v.kind,
    route: v.route.map((p) => ({ x: p.x, y: p.y })),
    routeLength: routeLength(v.route),
    speedCellsPerRound: v.speedCellsPerRound,
    gapCells: v.gapCells,
    cars: v.cars.map((c) => ({ id: c.id, name: c.name, lengthCells: c.lengthCells })),
    distance: v.startDistance,
    status: "running",
    deadlineFired: false,
    riders: v.riders.map((r) => ({
      tokenId: r.tokenId,
      ...(r.name !== undefined ? { name: r.name } : {}),
      carId: r.carId,
      offsetCells: r.offsetCells,
      lateralCells: r.lateralCells,
    })),
    alongside: v.alongside.map((e) => ({
      tokenId: e.tokenId,
      ...(e.name !== undefined ? { name: e.name } : {}),
      behindCells: e.behindCells,
      lateralCells: e.lateralCells,
    })),
    history: [
      {
        kind: "create",
        detail: `created ${v.name} (${v.kind}) on a ${routeLength(v.route)}-cell route at ${v.speedCellsPerRound} cells/round`,
        source: v.source,
      },
    ],
  };
  if (v.deadline !== undefined) vehicle.deadline = { ...v.deadline };
  if (v.tokenId !== undefined) vehicle.tokenId = v.tokenId;
  if (v.sceneId !== undefined) vehicle.sceneId = v.sceneId;
  return vehicle;
}

function requireSource(source: unknown): void {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new VehicleError(`"source" is required — every vehicle change carries its source.`);
  }
}

function withHistory(
  vehicle: Vehicle,
  kind: VehicleHistoryEntry["kind"],
  detail: string,
  source: string,
): Vehicle {
  return { ...vehicle, history: [...vehicle.history, { kind, detail, source }] };
}

// ---------------------------------------------------------------- advance

/**
 * Advance the vehicle by `rounds` rounds (default 1). The front
 * moves speed*rounds cells along the route, stopping at the end.
 * Riders and escorts move with it — their positions are derived
 * from the front, so nothing else needs updating. A deadline the
 * front crosses fires exactly once; reaching the end arrives the
 * vehicle. A stopped or arrived vehicle does not move (an event
 * says so) instead of throwing — the state is a fact, not bad input.
 */
export function advanceVehicle(
  vehicle: Vehicle,
  opts: { rounds?: number; source: string },
): AdvanceResult {
  requireSource(opts.source);
  const rounds = opts.rounds ?? 1;
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new VehicleError(`"rounds" must be an integer >= 1, got ${JSON.stringify(opts.rounds)}.`);
  }
  if (vehicle.status === "stopped") {
    return {
      vehicle,
      movedCells: 0,
      events: [{ type: "not-advanced", reason: `${vehicle.name} is stopped.` }],
    };
  }
  if (vehicle.status === "arrived") {
    return {
      vehicle,
      movedCells: 0,
      events: [{ type: "not-advanced", reason: `${vehicle.name} has already arrived.` }],
    };
  }
  const oldDistance = vehicle.distance;
  const newDistance = Math.min(
    oldDistance + vehicle.speedCellsPerRound * rounds,
    vehicle.routeLength,
  );
  const movedCells = newDistance - oldDistance;
  const events: VehicleAdvanceEvent[] = [];
  let next: Vehicle = {
    ...vehicle,
    distance: newDistance,
    deadlineFired: vehicle.deadlineFired,
  };
  if (
    vehicle.deadline !== undefined &&
    !vehicle.deadlineFired &&
    oldDistance < vehicle.deadline.atDistance &&
    newDistance >= vehicle.deadline.atDistance
  ) {
    next = { ...next, deadlineFired: true };
    events.push({
      type: "deadline",
      name: vehicle.deadline.name,
      consequence: vehicle.deadline.consequence,
    });
  }
  if (newDistance >= vehicle.routeLength) {
    next = { ...next, status: "arrived" };
    events.push({ type: "arrived" });
  }
  const detail =
    events.some((e) => e.type === "deadline")
      ? `advanced ${movedCells} cells to ${newDistance} — deadline "${vehicle.deadline?.name}" fired`
      : newDistance >= vehicle.routeLength
        ? `advanced ${movedCells} cells to ${newDistance} — arrived`
        : `advanced ${movedCells} cells to ${newDistance}`;
  next = withHistory(next, "advance", detail, opts.source);
  return { vehicle: next, movedCells, events };
}

// ---------------------------------------------------------------- riders

export function boardVehicle(
  vehicle: Vehicle,
  input: {
    tokenId: string;
    name?: string;
    carId: string;
    offsetCells?: number;
    lateralCells?: number;
    source: string;
  },
): Vehicle {
  requireSource(input.source);
  if (typeof input.tokenId !== "string" || input.tokenId.length === 0) {
    throw new VehicleError(`"tokenId" must be a non-empty string.`);
  }
  if (
    vehicle.riders.some((r) => r.tokenId === input.tokenId) ||
    vehicle.alongside.some((e) => e.tokenId === input.tokenId)
  ) {
    throw new VehicleError(`Token "${input.tokenId}" is already aboard or alongside ${vehicle.name}.`);
  }
  const car = vehicle.cars.find((c) => c.id === input.carId);
  if (!car) {
    throw new VehicleError(
      `Unknown car "${input.carId}" — the cars are ${vehicle.cars.map((c) => c.id).join(", ")}.`,
    );
  }
  const offsetCells = input.offsetCells ?? 0;
  if (!isFiniteNumber(offsetCells) || offsetCells < 0 || offsetCells > car.lengthCells) {
    throw new VehicleError(
      `"offsetCells" must be between 0 and ${car.lengthCells} (the length of car "${car.id}"), got ${JSON.stringify(input.offsetCells)}.`,
    );
  }
  const lateralCells = input.lateralCells ?? 0;
  if (!isFiniteNumber(lateralCells)) {
    throw new VehicleError(`"lateralCells" must be a number, got ${JSON.stringify(input.lateralCells)}.`);
  }
  const rider: VehicleRider = {
    tokenId: input.tokenId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    carId: input.carId,
    offsetCells,
    lateralCells,
  };
  return withHistory(
    { ...vehicle, riders: [...vehicle.riders, rider] },
    "board",
    `${input.name ?? input.tokenId} boarded car "${car.name}" (offset ${offsetCells}, lateral ${lateralCells})`,
    input.source,
  );
}

export function leaveVehicle(
  vehicle: Vehicle,
  input: { tokenId: string; source: string },
): Vehicle {
  requireSource(input.source);
  const rider = vehicle.riders.find((r) => r.tokenId === input.tokenId);
  if (!rider) {
    throw new VehicleError(
      `Token "${input.tokenId}" is not aboard ${vehicle.name} as a rider.`,
    );
  }
  return withHistory(
    { ...vehicle, riders: vehicle.riders.filter((r) => r.tokenId !== input.tokenId) },
    "leave",
    `${rider.name ?? rider.tokenId} left car "${rider.carId}"`,
    input.source,
  );
}

export function addAlongside(
  vehicle: Vehicle,
  input: {
    tokenId: string;
    name?: string;
    behindCells?: number;
    lateralCells: number;
    source: string;
  },
): Vehicle {
  requireSource(input.source);
  if (typeof input.tokenId !== "string" || input.tokenId.length === 0) {
    throw new VehicleError(`"tokenId" must be a non-empty string.`);
  }
  if (
    vehicle.riders.some((r) => r.tokenId === input.tokenId) ||
    vehicle.alongside.some((e) => e.tokenId === input.tokenId)
  ) {
    throw new VehicleError(`Token "${input.tokenId}" is already aboard or alongside ${vehicle.name}.`);
  }
  const behindCells = input.behindCells ?? 0;
  if (!isFiniteNumber(behindCells) || behindCells < 0) {
    throw new VehicleError(`"behindCells" must be >= 0, got ${JSON.stringify(input.behindCells)}.`);
  }
  if (!isFiniteNumber(input.lateralCells) || input.lateralCells === 0) {
    throw new VehicleError(
      `"lateralCells" must be a non-zero number — an escort at lateral 0 would be standing on the rails, got ${JSON.stringify(input.lateralCells)}.`,
    );
  }
  const escort: VehicleAlongside = {
    tokenId: input.tokenId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    behindCells,
    lateralCells: input.lateralCells,
  };
  return withHistory(
    { ...vehicle, alongside: [...vehicle.alongside, escort] },
    "alongside-add",
    `${input.name ?? input.tokenId} joined alongside (behind ${behindCells}, lateral ${input.lateralCells})`,
    input.source,
  );
}

export function removeAlongside(
  vehicle: Vehicle,
  input: { tokenId: string; source: string },
): Vehicle {
  requireSource(input.source);
  const escort = vehicle.alongside.find((e) => e.tokenId === input.tokenId);
  if (!escort) {
    throw new VehicleError(
      `Token "${input.tokenId}" is not alongside ${vehicle.name}.`,
    );
  }
  return withHistory(
    { ...vehicle, alongside: vehicle.alongside.filter((e) => e.tokenId !== input.tokenId) },
    "alongside-remove",
    `${escort.name ?? escort.tokenId} left the escort`,
    input.source,
  );
}

// ---------------------------------------------------------------- control

export function stopVehicle(vehicle: Vehicle, input: { source: string }): Vehicle {
  requireSource(input.source);
  if (vehicle.status === "stopped") throw new VehicleError(`${vehicle.name} is already stopped.`);
  if (vehicle.status === "arrived") throw new VehicleError(`${vehicle.name} has already arrived.`);
  return withHistory({ ...vehicle, status: "stopped" }, "stop", `stopped at ${vehicle.distance} cells`, input.source);
}

export function resumeVehicle(vehicle: Vehicle, input: { source: string }): Vehicle {
  requireSource(input.source);
  if (vehicle.status !== "stopped") {
    throw new VehicleError(`Only a stopped vehicle can resume — ${vehicle.name} is ${vehicle.status}.`);
  }
  return withHistory({ ...vehicle, status: "running" }, "resume", `resumed at ${vehicle.distance} cells`, input.source);
}

export function setSpeed(
  vehicle: Vehicle,
  input: { speed: number; source: string },
): Vehicle {
  requireSource(input.source);
  if (!isFiniteNumber(input.speed) || input.speed <= 0) {
    throw new VehicleError(`"speed" must be > 0, got ${JSON.stringify(input.speed)}.`);
  }
  return withHistory(
    { ...vehicle, speedCellsPerRound: input.speed },
    "speed",
    `speed set to ${input.speed} cells/round`,
    input.source,
  );
}

// ---------------------------------------------------------------- positions

/**
 * Every token the vehicle owns, at its current cell position: the
 * lead token at the front, riders in their cars, escorts alongside.
 * Positions are in cells; the live layer multiplies by CELL_PX.
 */
export function vehicleTokenPositions(vehicle: Vehicle): VehicleTokenPosition[] {
  const out: VehicleTokenPosition[] = [];
  if (vehicle.tokenId !== undefined) {
    const front = pointAtDistance(vehicle.route, vehicle.distance);
    out.push({ tokenId: vehicle.tokenId, role: "vehicle", x: front.x, y: front.y });
  }
  for (const rider of vehicle.riders) {
    const p = riderPosition(vehicle, rider);
    out.push({ tokenId: rider.tokenId, name: rider.name, role: "rider", x: p.x, y: p.y });
  }
  for (const escort of vehicle.alongside) {
    const p = alongsidePosition(vehicle, escort);
    out.push({ tokenId: escort.tokenId, name: escort.name, role: "alongside", x: p.x, y: p.y });
  }
  return out;
}

// ---------------------------------------------------------------- rendering

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** One-line status for chat / the CLI. */
export function renderVehicle(vehicle: Vehicle): string {
  const at = `${round1(vehicle.distance)}/${round1(vehicle.routeLength)} cells`;
  const crew = `${vehicle.riders.length} rider${vehicle.riders.length === 1 ? "" : "s"} aboard, ${vehicle.alongside.length} alongside`;
  const deadline =
    vehicle.deadline === undefined
      ? ""
      : vehicle.deadlineFired
        ? ` — deadline "${vehicle.deadline.name}" fired`
        : ` — deadline "${vehicle.deadline.name}" in ${round1(vehicle.deadline.atDistance - vehicle.distance)} cells`;
  if (vehicle.status === "arrived") {
    return `🚂 ${vehicle.name} (${vehicle.kind}) — ${at} — arrived — ${crew}${deadline}`;
  }
  if (vehicle.status === "stopped") {
    return `🚂 ${vehicle.name} (${vehicle.kind}) — ${at} — stopped — ${crew}${deadline}`;
  }
  return `🚂 ${vehicle.name} (${vehicle.kind}) — ${at} — running at ${vehicle.speedCellsPerRound}/round — ${crew}${deadline}`;
}

export function renderVehicleStore(store: VehicleStore): string {
  if (store.vehicles.length === 0) return "No vehicles.";
  return store.vehicles.map((v) => renderVehicle(v)).join("\n");
}

// ---------------------------------------------------------------- store

export function emptyVehicleStore(): VehicleStore {
  return { vehicles: [] };
}

export function addVehicle(store: VehicleStore, vehicle: Vehicle): VehicleStore {
  if (store.vehicles.some((v) => v.id === vehicle.id)) {
    throw new VehicleError(
      `A vehicle with id "${vehicle.id}" already exists (${store.vehicles.find((v) => v.id === vehicle.id)?.name}).`,
    );
  }
  return { vehicles: [...store.vehicles, vehicle] };
}

export function updateVehicle(store: VehicleStore, vehicle: Vehicle): VehicleStore {
  if (!store.vehicles.some((v) => v.id === vehicle.id)) {
    throw new VehicleError(`No vehicle with id "${vehicle.id}" in the store.`);
  }
  return { vehicles: store.vehicles.map((v) => (v.id === vehicle.id ? vehicle : v)) };
}

export function removeVehicle(store: VehicleStore, id: string): VehicleStore {
  if (!store.vehicles.some((v) => v.id === id)) {
    throw new VehicleError(`No vehicle with id "${id}" in the store.`);
  }
  return { vehicles: store.vehicles.filter((v) => v.id !== id) };
}

export function getVehicle(store: VehicleStore, id: string): Vehicle {
  const found = store.vehicles.find((v) => v.id === id);
  if (!found) throw new VehicleError(`No vehicle with id "${id}" in the store.`);
  return found;
}

/**
 * Resolve a vehicle by id, exact name (case-insensitive), or unique
 * case-insensitive substring. Zero matches list the vehicles that
 * exist; several list the matches — never guesses.
 */
export function resolveVehicleTarget(store: VehicleStore, ref: string): Vehicle {
  const byId = store.vehicles.find((v) => v.id === ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const exact = store.vehicles.filter((v) => v.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = store.vehicles.filter((v) => v.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0 && exact.length === 0) {
    const names =
      store.vehicles.length === 0
        ? "no vehicles exist yet"
        : `the vehicles are: ${store.vehicles.map((v) => v.name).join(", ")}`;
    throw new VehicleError(`No vehicle matches "${ref}" — ${names}.`);
  }
  const matches = (partial.length > 0 ? partial : exact).map((v) => v.name).join(", ");
  throw new VehicleError(`"${ref}" matches several vehicles: ${matches} — be more specific.`);
}

// ---------------------------------------------------------------- serialize

export function isVehicle(v: unknown): v is Vehicle {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.kind === "string" &&
    Array.isArray(v.route) &&
    isFiniteNumber(v.routeLength) &&
    isFiniteNumber(v.speedCellsPerRound) &&
    isFiniteNumber(v.gapCells) &&
    Array.isArray(v.cars) &&
    isFiniteNumber(v.distance) &&
    (v.status === "running" || v.status === "arrived" || v.status === "stopped") &&
    typeof v.deadlineFired === "boolean" &&
    Array.isArray(v.riders) &&
    Array.isArray(v.alongside) &&
    Array.isArray(v.history)
  );
}

/** Strictly parse one stored vehicle. */
export function parseVehicle(
  input: unknown,
): { ok: true; vehicle: Vehicle } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Vehicle must be a JSON object."] };
  if (!isVehicle(input)) {
    return { ok: false, errors: ["Vehicle is missing fields or has the wrong shape."] };
  }
  // Re-run the creation validation on the stored shape — a stored
  // vehicle can never pass a check its creation would have failed.
  // forParse exempts the deadline-vs-start check: a stored vehicle
  // may legitimately sit past its (already fired) deadline.
  const checked = validateCreateInput({
    name: input.name,
    kind: input.kind,
    route: input.route,
    speedCellsPerRound: input.speedCellsPerRound,
    gapCells: input.gapCells,
    cars: input.cars,
    startDistance: input.distance,
    deadline: input.deadline,
    tokenId: input.tokenId,
    sceneId: input.sceneId,
    riders: input.riders,
    alongside: input.alongside,
    source: "parse",
  }, { forParse: true });
  if (!checked.ok) return { ok: false, errors: checked.errors };
  // The stored route length must match the route it claims.
  if (Math.abs(routeLength(input.route) - input.routeLength) > 1e-9) {
    errors.push(
      `"routeLength" ${input.routeLength} does not match the route (${routeLength(input.route)}).`,
    );
  }
  // History entries must be well-formed.
  for (let i = 0; i < input.history.length; i++) {
    const h = input.history[i] as unknown as Record<string, unknown>;
    if (
      !isRecord(h) ||
      typeof h.kind !== "string" ||
      typeof h.detail !== "string" ||
      typeof h.source !== "string"
    ) {
      errors.push(`"history[${i}]" must be {kind, detail, source}.`);
    }
  }
  // The stored distance must be reachable: within [0, routeLength].
  // (A stored distance past the end would mean a corrupted file.)
  if (input.distance < 0 || input.distance > input.routeLength) {
    errors.push(`"distance" ${input.distance} is outside [0, ${input.routeLength}].`);
  }
  // A deadline the front has passed must already be marked fired.
  if (
    input.deadline !== undefined &&
    !input.deadlineFired &&
    input.distance >= input.deadline.atDistance
  ) {
    errors.push(
      `The deadline "${input.deadline.name}" is at ${input.deadline.atDistance} but the front is already at ${input.distance} and deadlineFired is false — inconsistent state.`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, vehicle: input as Vehicle };
}

export function serializeVehicle(vehicle: Vehicle): string {
  return JSON.stringify(vehicle, null, 2);
}

export function serializeVehicleStore(store: VehicleStore): string {
  return JSON.stringify({ version: 1, vehicles: store.vehicles }, null, 2);
}

/** Strictly parse a stored vehicle store. */
export function parseVehicleStore(
  input: unknown,
): { ok: true; store: VehicleStore } | { ok: false; errors: string[] } {
  if (!isRecord(input)) return { ok: false, errors: ["Vehicle store must be a JSON object."] };
  if (input.version !== 1) {
    return { ok: false, errors: [`"version" must be 1, got ${JSON.stringify(input.version)}.`] };
  }
  if (!Array.isArray(input.vehicles)) {
    return { ok: false, errors: [`"vehicles" must be an array.`] };
  }
  const errors: string[] = [];
  const vehicles: Vehicle[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.vehicles.length; i++) {
    const parsed = parseVehicle(input.vehicles[i]);
    if (!parsed.ok) {
      for (const e of parsed.errors) errors.push(`vehicles[${i}]: ${e}`);
      continue;
    }
    if (seen.has(parsed.vehicle.id)) {
      errors.push(`vehicles[${i}]: duplicate id "${parsed.vehicle.id}".`);
      continue;
    }
    seen.add(parsed.vehicle.id);
    vehicles.push(parsed.vehicle);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, store: { vehicles } };
}

export function defaultVehicleStatePath(): string {
  return (
    process.env.FOUNDRY_VEHICLE_STATE ??
    path.join(import.meta.dir, "..", "..", ".vehicle-state.json")
  );
}

/** Write the store to the state file. Best effort — a failed write
 *  never breaks the loop (same convention as the clock/scoreboard
 *  state files). */
export function saveVehicleState(
  store: VehicleStore,
  filePath: string = defaultVehicleStatePath(),
): void {
  try {
    fs.writeFileSync(filePath, serializeVehicleStore(store), "utf-8");
  } catch {
    // State is a convenience; a failed write must not break the loop.
  }
}

/**
 * Read the store back. Returns null when there is no state yet, or
 * the file is unreadable or the wrong shape — the caller starts
 * from an empty store.
 */
export function loadVehicleState(
  filePath: string = defaultVehicleStatePath(),
): VehicleStore | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const result = parseVehicleStore(parsed);
    return result.ok ? result.store : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- live layer

/** Chat line for an advance event. */
export function advanceEventLine(vehicle: Vehicle, event: VehicleAdvanceEvent): string | null {
  if (event.type === "deadline") {
    return `🚂 ${vehicle.name} reaches ${event.name} — ${event.consequence}`;
  }
  if (event.type === "arrived") {
    return `🚂 ${vehicle.name} has reached the end of the line.`;
  }
  return null;
}

export interface AdvanceLiveResult {
  vehicle: Vehicle;
  movedCells: number;
  events: VehicleAdvanceEvent[];
  /** Tokens moved, in px (what the table sees). */
  movedTokens: { tokenId: string; name?: string; x: number; y: number }[];
  lines: string[];
}

/**
 * Advance a vehicle live: pure advance, then one batched Token
 * update for every token the advance shifted, then the deadline /
 * arrival lines in chat. The vehicle needs a sceneId — without one
 * there is nowhere to move the tokens.
 *
 * The advance sets positions in one update per round (no glide):
 * the train "covers ground" between rounds. Tokens that did not
 * move are not touched.
 */
export async function advanceVehicleLive(
  live: FoundryLive,
  vehicle: Vehicle,
  opts: { rounds?: number; source: string },
): Promise<AdvanceLiveResult> {
  if (vehicle.sceneId === undefined) {
    throw new VehicleError(
      `${vehicle.name} has no sceneId — a vehicle needs a scene before it can move live.`,
    );
  }
  const before = vehicleTokenPositions(vehicle);
  const advanced = advanceVehicle(vehicle, opts);
  const after = vehicleTokenPositions(advanced.vehicle);
  const movedTokens: { tokenId: string; name?: string; x: number; y: number }[] = [];
  const updates: { _id: string; x: number; y: number }[] = [];
  for (const pos of after) {
    const prev = before.find((b) => b.tokenId === pos.tokenId);
    if (prev && Math.abs(prev.x - pos.x) < 0.01 && Math.abs(prev.y - pos.y) < 0.01) continue;
    const px = { x: Math.round(pos.x * CELL_PX), y: Math.round(pos.y * CELL_PX) };
    movedTokens.push({ tokenId: pos.tokenId, name: pos.name, x: px.x, y: px.y });
    updates.push({ _id: pos.tokenId, x: px.x, y: px.y });
  }
  if (updates.length > 0) {
    await live.modifyDocument("Token", "update", {
      updates,
      parentUuid: `Scene.${vehicle.sceneId}`,
    });
  }
  const lines: string[] = [];
  for (const event of advanced.events) {
    const line = advanceEventLine(advanced.vehicle, event);
    if (line) {
      lines.push(line);
      await live.sendChat(line);
    }
  }
  return { vehicle: advanced.vehicle, movedCells: advanced.movedCells, events: advanced.events, movedTokens, lines };
}

export interface BoardLiveResult {
  vehicle: Vehicle;
  rider: VehicleRider;
  /** Where the token was moved to, in px. */
  movedTo: { x: number; y: number };
  line: string;
}

/**
 * Board a token live: pure board, then move the token onto its car
 * position and announce it. The token must already exist on the
 * scene — boarding snaps it to its seat.
 */
export async function boardVehicleLive(
  live: FoundryLive,
  vehicle: Vehicle,
  input: {
    tokenId: string;
    name?: string;
    carId: string;
    offsetCells?: number;
    lateralCells?: number;
    source: string;
  },
): Promise<BoardLiveResult> {
  if (vehicle.sceneId === undefined) {
    throw new VehicleError(
      `${vehicle.name} has no sceneId — a vehicle needs a scene before it can move live.`,
    );
  }
  const boarded = boardVehicle(vehicle, input);
  const rider = boarded.riders.find((r) => r.tokenId === input.tokenId) as VehicleRider;
  const pos = riderPosition(boarded, rider);
  const movedTo = { x: Math.round(pos.x * CELL_PX), y: Math.round(pos.y * CELL_PX) };
  await live.modifyDocument("Token", "update", {
    updates: [{ _id: rider.tokenId, x: movedTo.x, y: movedTo.y }],
    parentUuid: `Scene.${vehicle.sceneId}`,
  });
  const car = boarded.cars.find((c) => c.id === rider.carId) as VehicleCar;
  const line = `🚂 ${rider.name ?? rider.tokenId} boards ${boarded.name} — ${car.name}.`;
  await live.sendChat(line);
  return { vehicle: boarded, rider, movedTo, line };
}

export interface LeaveLiveResult {
  vehicle: Vehicle;
  rider: VehicleRider;
  line: string;
}

/**
 * Leave a vehicle live: pure leave, then announce it. The token
 * stays where it is — it steps off at the vehicle's current spot.
 */
export async function leaveVehicleLive(
  live: FoundryLive,
  vehicle: Vehicle,
  input: { tokenId: string; source: string },
): Promise<LeaveLiveResult> {
  const rider = vehicle.riders.find((r) => r.tokenId === input.tokenId);
  if (!rider) {
    throw new VehicleError(`Token "${input.tokenId}" is not aboard ${vehicle.name} as a rider.`);
  }
  const left = leaveVehicle(vehicle, input);
  const line = `🚂 ${rider.name ?? rider.tokenId} steps off ${left.name}.`;
  await live.sendChat(line);
  return { vehicle: left, rider, line };
}
