/**
 * Meroki Pins — monitor side.
 *
 * The Foundry module (modules/meroki-pins/) drops a Note pin backed by a
 * JournalEntry carrying `flags.meroki = { request, status, scene, x, y }`.
 * This module is the other half: it watches those flags, builds what was
 * asked, replies in chat, and marks the pin done.
 *
 * Contract (see modules/meroki-pins/README.md):
 * - JournalEntry.flags.meroki: { request, status: "open"|"done", scene, x, y }
 * - Note.flags.meroki: { request, status: "open"|"done", entryId }
 * - Flow: open pin → act → reply in chat + append to the journal page →
 *   set status "done" on BOTH docs. Never edit the request text.
 *
 * Two layers (same pattern as dice.ts / monitor.ts):
 * - Pure functions (extractPin / parsePinRequest / extractRoomName /
 *   nearestWall / splitWallForDoor / planPinAction): no Foundry, no I/O,
 *   unit tested in tests/pins.test.ts.
 * - Live functions (PinProcessor / findOpenPins / handlePin): thin
 *   wrappers over FoundryLive.modifyDocument + the worldbuilding
 *   builders. The worldbuilding modules are dynamically imported ONLY
 *   when a plan actually builds something — statically importing them
 *   would pull the vendored MCP client (via upload.ts) into every test
 *   run, which validates FOUNDRY_URL at import time.
 *
 * Dedupe: a pin is processed once per entryId, tracked in memory AND in
 * a state file (like the autopilot), so a restart doesn't re-answer pins
 * it already handled. A pin with status "done" is never re-processed.
 * An "unknown" request is still answered (chat + journal, asking for
 * clarification) and marked done — otherwise it would sit open forever
 * and be re-read every cycle.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FoundryLive } from "../live.js";
import { TORCH } from "../worldbuilding/tiles-layout.js";
import type { RoomSpec } from "../worldbuilding/tiles-layout.js";

/** Where processed pin entryIds live so restarts don't re-answer pins. */
const STATE_FILE =
  process.env.FOUNDRY_PINS_STATE ??
  path.join(import.meta.dir, "..", "..", ".pins-state.json");

/** A pin as the monitor sees it (JournalEntry is authoritative). */
export interface Pin {
  entryId: string;
  noteId?: string;
  request: string;
  status: "open" | "done";
  scene?: string;
  x?: number;
  y?: number;
  /** The raw document, for the live layer to re-read flags from. */
  raw: Record<string, unknown>;
}

interface MerokiFlags {
  request?: unknown;
  status?: unknown;
  scene?: unknown;
  x?: unknown;
  y?: unknown;
  entryId?: unknown;
}

function readFlags(doc: Record<string, unknown>): MerokiFlags {
  const flags = doc.flags as Record<string, unknown> | undefined;
  return (flags?.meroki as MerokiFlags | undefined) ?? {};
}

/**
 * Extract a pin from a raw JournalEntry or Note document, or null when
 * the document carries no `flags.meroki.request`.
 */
export function extractPin(doc: Record<string, unknown>): Pin | null {
  const f = readFlags(doc);
  if (typeof f.request !== "string" || !f.request.trim()) return null;
  // A Note carries flags.meroki.entryId (its _id is the note); a
  // JournalEntry IS the entry (its _id is the entryId).
  const isNote = typeof f.entryId === "string" && f.entryId.length > 0;
  const entryId = isNote
    ? (f.entryId as string)
    : (doc._id as string | undefined) ?? "";
  if (!entryId) return null;
  const pin: Pin = {
    entryId,
    request: f.request.trim(),
    status: f.status === "done" ? "done" : "open",
    raw: doc,
  };
  if (isNote) pin.noteId = typeof doc._id === "string" ? doc._id : undefined;
  if (typeof f.scene === "string") pin.scene = f.scene;
  if (typeof f.x === "number") pin.x = f.x;
  if (typeof f.y === "number") pin.y = f.y;
  return pin;
}

/** What kind of build a pin request asks for. */
export type PinRequestKind =
  | "secret-door"
  | "door"
  | "room"
  | "chest"
  | "light"
  | "unknown";

export interface PinRequest {
  kind: PinRequestKind;
  /** Room name, when the request names one ("the love nest room"). */
  roomName?: string;
  raw: string;
}

/**
 * Pull a room name out of a request. Tries, in order:
 *   "room that is / called / named X", "leads into (a|the) X",
 *   "build/make/create (a|the) room (called|named) X".
 * Returns undefined when no name is present.
 */
export function extractRoomName(text: string): string | undefined {
  const patterns = [
    /\broom (?:that is|called|named)\s+([^.,;]+)/i,
    /\blead(?:s|ing)?\s+(?:in)?to\s+((?:a |the )?[^.,;]+)/i,
    /\b(?:build|make|create) (?:a |the )?room (?:called |named )?([^.,;]+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    let name = m[1].trim().replace(/^(?:a |the )?room (?:that is|called|named)\s+/i, "");
    name = name.replace(/\s+room$/i, "").trim();
    if (name) return name;
  }
  return undefined;
}

/**
 * Classify a pin request. "secret door" (or "secret passage") wins over a
 * plain door; a request naming a room keeps the name for the build.
 */
export function parsePinRequest(text: string): PinRequest {
  const s = text.trim();
  const lower = s.toLowerCase();
  const roomName = extractRoomName(s);
  if (/\bsecret (?:door|passage)\b/.test(lower)) {
    return { kind: "secret-door", roomName, raw: s };
  }
  if (/\bchest\b/.test(lower)) return { kind: "chest", raw: s };
  if (/\b(?:torch|light|lantern|candle)\b/.test(lower)) return { kind: "light", raw: s };
  if (/\bdoor\b/.test(lower)) return { kind: "door", roomName, raw: s };
  if (/\broom\b/.test(lower)) return { kind: "room", roomName, raw: s };
  return { kind: "unknown", raw: s };
}

/** One wall segment, as read from the scene cache. */
export interface WallSeg {
  _id?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  door?: number;
}

function pointSegDist(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): { dist: number; t: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

/** The wall nearest a point, within maxDist px, or null. */
export function nearestWall(
  walls: WallSeg[],
  x: number,
  y: number,
  maxDist = 150,
): { wall: WallSeg; dist: number; t: number } | null {
  let best: { wall: WallSeg; dist: number; t: number } | null = null;
  for (const w of walls) {
    const { dist, t } = pointSegDist(x, y, w.x1, w.y1, w.x2, w.y2);
    if (dist <= maxDist && (!best || dist < best.dist)) {
      best = { wall: w, dist, t };
    }
  }
  return best;
}

/**
 * Split a wall segment around a door-sized gap centered on the pin's
 * projection onto the segment. Returns the keep-segments plus the door
 * segment (door type set by the caller). A segment shorter than the door
 * becomes the door itself.
 */
export function splitWallForDoor(
  wall: WallSeg,
  px: number,
  py: number,
  doorWidth = 100,
): { keep: WallSeg[]; door: WallSeg } {
  const { t } = pointSegDist(px, py, wall.x1, wall.y1, wall.x2, wall.y2);
  const len = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  if (len <= doorWidth) {
    return { keep: [], door: { ...wall } };
  }
  const half = doorWidth / 2 / len;
  const t0 = Math.max(0, t - half);
  const t1 = Math.min(1, t + half);
  const at = (tt: number): { x: number; y: number } => ({
    x: wall.x1 + (wall.x2 - wall.x1) * tt,
    y: wall.y1 + (wall.y2 - wall.y1) * tt,
  });
  const a = at(0);
  const b = at(t0);
  const c = at(t1);
  const d = at(1);
  const keep: WallSeg[] = [];
  if (t0 > 0.001) keep.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, door: 0 });
  if (t1 < 0.999) keep.push({ x1: c.x, y1: c.y, x2: d.x, y2: d.y, door: 0 });
  return { keep, door: { x1: b.x, y1: b.y, x2: c.x, y2: c.y, door: 0 } };
}

/** A build plan for a pin — everything the executor needs, no I/O. */
export type PinPlan =
  | {
      kind: "secret-door";
      sceneId: string;
      wallId: string;
      keep: WallSeg[];
      door: WallSeg;
      room: RoomSpec;
      reply: string;
    }
  | {
      kind: "door";
      sceneId: string;
      wallId: string;
      keep: WallSeg[];
      door: WallSeg;
      reply: string;
    }
  | { kind: "room"; sceneId: string; room: RoomSpec; reply: string }
  | { kind: "chest"; sceneId: string; x: number; y: number; reply: string }
  | { kind: "light"; sceneId: string; x: number; y: number; reply: string }
  | { kind: "no-wall"; reply: string }
  | { kind: "no-scene"; reply: string }
  | { kind: "unknown"; reply: string };

const DEFAULT_ROOM_W = 8;
const DEFAULT_ROOM_H = 6;

/**
 * Plan the build for a parsed pin request. Needs the scene's walls (for
 * door pins) and size (for the room-behind-the-door direction).
 * The room behind a secret door is a new scene (one scene per room); its
 * door sits on the side facing the old room, centered.
 */
export function planPinAction(
  req: PinRequest,
  pin: Pin,
  walls: WallSeg[],
  sceneSize: { width: number; height: number },
): PinPlan {
  const sceneId = pin.scene;
  if (!sceneId) {
    return { kind: "no-scene", reply: "That pin isn't on a scene I can read — drop it on the map and I'll build it." };
  }
  if (req.kind === "unknown") {
    return {
      kind: "unknown",
      reply:
        `📌 I didn't understand that pin ("${req.raw}"). Try "secret door here", "door here", "chest here", "light here", or "build a room called …".`,
    };
  }
  if (req.kind === "chest") {
    if (pin.x === undefined || pin.y === undefined) {
      return { kind: "no-scene", reply: "That pin has no position — drop it on the map and I'll put a chest there." };
    }
    return { kind: "chest", sceneId, x: pin.x, y: pin.y, reply: `📦 Chest placed where you pinned it.` };
  }
  if (req.kind === "light") {
    if (pin.x === undefined || pin.y === undefined) {
      return { kind: "no-scene", reply: "That pin has no position — drop it on the map and I'll light it." };
    }
    return { kind: "light", sceneId, x: pin.x, y: pin.y, reply: `🕯️ Torch lit where you pinned it.` };
  }
  if (req.kind === "room") {
    const name = req.roomName ?? "Hidden Room";
    const room: RoomSpec = {
      name,
      gridW: DEFAULT_ROOM_W,
      gridH: DEFAULT_ROOM_H,
      floorStyle: "dark",
      torches: [{ gx: 1, gy: 1 }, { gx: DEFAULT_ROOM_W - 2, gy: 1 }],
      description: `Built from a pin: ${req.raw}`,
    };
    return { kind: "room", sceneId, room, reply: `🏰 Built **${name}** as its own scene — the GM can activate it when you're ready.` };
  }
  // Door / secret-door: find the wall, split a door-sized piece out of it.
  if (pin.x === undefined || pin.y === undefined) {
    return { kind: "no-scene", reply: "That pin has no position — drop it right on the wall you mean." };
  }
  const near = nearestWall(walls, pin.x, pin.y);
  if (!near || !near.wall._id) {
    return {
      kind: "no-wall",
      reply: "I couldn't find a wall near that pin — drop the pin right on the wall you want the door in.",
    };
  }
  const { keep, door } = splitWallForDoor(near.wall, pin.x, pin.y);
  if (req.kind === "door") {
    return {
      kind: "door",
      sceneId,
      wallId: near.wall._id,
      keep,
      door: { ...door, door: 1 },
      reply: `🚪 Door cut into the wall where you pinned it.`,
    };
  }
  // Secret door + the room behind it.
  const name = req.roomName ?? "Hidden Room";
  const mx = (door.x1 + door.x2) / 2;
  const my = (door.y1 + door.y2) / 2;
  // Outward = away from the scene center. The new room's door sits on the
  // side facing the old room.
  const cx = sceneSize.width / 2;
  const cy = sceneSize.height / 2;
  const ox = mx - cx;
  const oy = my - cy;
  let side: "north" | "south" | "east" | "west";
  let at: number;
  if (Math.abs(oy) >= Math.abs(ox)) {
    // Door on a horizontal wall; outward is north/south.
    if (oy >= 0) {
      side = "north"; // new room is south of the wall; its north wall faces it
    } else {
      side = "south";
    }
    at = Math.floor(DEFAULT_ROOM_W / 2);
  } else {
    if (ox >= 0) {
      side = "west";
    } else {
      side = "east";
    }
    at = Math.floor(DEFAULT_ROOM_H / 2);
  }
  const room: RoomSpec = {
    name,
    gridW: DEFAULT_ROOM_W,
    gridH: DEFAULT_ROOM_H,
    floorStyle: "dark",
    doors: [{ wall: side, at }],
    torches: [{ gx: 1, gy: 1 }, { gx: DEFAULT_ROOM_W - 2, gy: 1 }],
    description: `Built from a pin: ${req.raw}`,
  };
  return {
    kind: "secret-door",
    sceneId,
    wallId: near.wall._id,
    keep,
    door: { ...door, door: 2 },
    room,
    reply:
      `🚪🤫 Secret door cut into the wall where you pinned it — and behind it, **${name}**, built as its own scene. The GM can activate it when you're ready.`,
  };
}

// ---------------------------------------------------------------- live layer

/** What executing a plan needs from the world. Injectable for tests. */
export interface PinExecutor {
  /** Delete one wall, create the replacement segments; returns new ids. */
  replaceWall(
    live: FoundryLive,
    sceneId: string,
    wallId: string,
    segments: (WallSeg & { door: number })[],
  ): Promise<string[]>;
  /** Build a tile room from a spec; returns the new scene. */
  buildRoom(live: FoundryLive, spec: RoomSpec): Promise<{ sceneId: string; name: string }>;
  /** Place an openable chest with default loot at (x, y). */
  addChest(live: FoundryLive, sceneId: string, x: number, y: number): Promise<void>;
  /** Place a warm torch light at (x, y). */
  addLight(live: FoundryLive, sceneId: string, x: number, y: number): Promise<void>;
}

let cachedServerBase: string | null = null;

/** The production executor — dynamically imports the builders only when used. */
export const defaultExecutor: PinExecutor = {
  async replaceWall(live, sceneId, wallId, segments) {
    const parentUuid = `Scene.${sceneId}`;
    await live.modifyDocument("Wall", "delete", { ids: [wallId], parentUuid });
    const created = await live.modifyDocument("Wall", "create", {
      data: segments.map((s) => ({
        c: [s.x1, s.y1, s.x2, s.y2],
        move: 1,
        sense: 1,
        light: 1,
        sound: 1,
        dir: 0,
        door: s.door ?? 0,
        ds: 0,
      })),
      parentUuid,
    });
    return created.map((d) => String(d._id));
  },
  async buildRoom(live, spec) {
    const tiles = await import("../worldbuilding/tiles.js");
    const pack = tiles.loadPack();
    if (!cachedServerBase) {
      cachedServerBase = await tiles.uploadTilePack(
        live,
        path.join(import.meta.dir, "..", "..", "tiles"),
      );
    }
    const built = await tiles.buildTileRoom(live, spec, pack, cachedServerBase);
    return { sceneId: built.sceneId, name: spec.name };
  },
  async addChest(live, sceneId, x, y) {
    const wb = await import("../worldbuilding/index.js");
    await wb.addChest(live, sceneId, {
      x,
      y,
      loot: [
        { name: "Gold", type: "treasure", quantity: 50, price: 1 },
        { name: "Healing Potion", type: "consumable", quantity: 2, price: 4 },
      ],
    });
  },
  async addLight(live, sceneId, x, y) {
    const wb = await import("../worldbuilding/index.js");
    await wb.addLights(live, sceneId, [{ x, y, dim: TORCH.dim, bright: TORCH.bright, color: TORCH.color }]);
  },
};

/**
 * Tracks which pins have been handled, in memory + a state file, so a
 * restart never re-answers a pin. Same pattern as the autopilot state.
 */
export class PinProcessor {
  private done = new Set<string>();

  constructor() {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
        entryIds?: string[];
      };
      this.done = new Set(saved.entryIds ?? []);
    } catch {
      // No state yet.
    }
  }

  has(entryId: string): boolean {
    return this.done.has(entryId);
  }

  mark(entryId: string): void {
    this.done.add(entryId);
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ entryIds: [...this.done] }), "utf-8");
    } catch {
      // State is a convenience; a failed write must not break the pin.
    }
  }
}

/** All currently-open pins in the cached world data. */
export function findOpenPins(live: FoundryLive): Pin[] {
  const data = live.raw() as unknown as {
    getWorldData(): { journal?: Record<string, unknown>[] } | null;
    getJournals(): Record<string, unknown>[];
  };
  const journals = data.getJournals?.() ?? data.getWorldData()?.journal ?? [];
  const pins: Pin[] = [];
  for (const doc of journals) {
    const pin = extractPin(doc);
    if (pin && pin.status === "open") pins.push(pin);
  }
  return pins;
}

interface RawScene {
  _id: string;
  name: string;
  width: number;
  height: number;
  walls?: { _id?: string; c?: [number, number, number, number]; door?: number }[];
  notes?: { _id?: string; flags?: Record<string, unknown> }[];
}

/** Read a scene's walls from the cache. */
function sceneWalls(live: FoundryLive, sceneId: string): { walls: WallSeg[]; size: { width: number; height: number } } {
  const raw = live.raw() as unknown as {
    getScenes(): RawScene[];
  };
  const scene = raw.getScenes().find((s) => s._id === sceneId);
  if (!scene) return { walls: [], size: { width: 0, height: 0 } };
  const walls: WallSeg[] = (scene.walls ?? []).map((w) => ({
    _id: w._id,
    x1: w.c?.[0] ?? 0,
    y1: w.c?.[1] ?? 0,
    x2: w.c?.[2] ?? 0,
    y2: w.c?.[3] ?? 0,
    door: w.door ?? 0,
  }));
  return { walls, size: { width: scene.width, height: scene.height } };
}

/** Set flags.meroki.status = "done" on a JournalEntry + its Note, keeping the rest of the flags. */
async function markPinDone(
  live: FoundryLive,
  pin: Pin,
): Promise<void> {
  const entryFlags = readFlags(pin.raw);
  await live.modifyDocument("JournalEntry", "update", {
    updates: [{
      _id: pin.entryId,
      flags: {
        meroki: {
          request: entryFlags.request,
          status: "done",
          scene: entryFlags.scene,
          x: entryFlags.x,
          y: entryFlags.y,
        },
      },
    }],
  });
  if (pin.noteId) {
    const note = (await findNote(live, pin)) as Record<string, unknown> | null;
    const noteFlags = note ? readFlags(note) : {};
    await live.modifyDocument("Note", "update", {
      updates: [{
        _id: pin.noteId,
        flags: {
          meroki: {
            request: noteFlags.request ?? entryFlags.request,
            status: "done",
            entryId: pin.entryId,
          },
        },
      }],
      parentUuid: pin.scene ? `Scene.${pin.scene}` : undefined,
    });
  }
}

/** Find the Note doc for a pin (needed to re-read its flags before marking done). */
async function findNote(
  live: FoundryLive,
  pin: Pin,
): Promise<Record<string, unknown> | null> {
  if (!pin.scene || !pin.noteId) return null;
  const raw = live.raw() as unknown as { getScenes(): RawScene[] };
  const scene = raw.getScenes().find((s) => s._id === pin.scene);
  const note = (scene?.notes ?? []).find((n) => n._id === pin.noteId);
  return (note as Record<string, unknown> | undefined) ?? null;
}

/**
 * A pin that arrived as a Note create carries no scene/coords — those
 * live on the JournalEntry. Fill them in from the cached entry so the
 * plan can use them. Pins that arrived as entries already carry them.
 */
function resolvePinCoords(live: FoundryLive, pin: Pin): Pin {
  if (pin.scene !== undefined && pin.x !== undefined && pin.y !== undefined) {
    return pin;
  }
  try {
    const raw = live.raw() as unknown as {
      getJournals(): Record<string, unknown>[];
    };
    const entry = raw.getJournals().find((j) => j._id === pin.entryId);
    if (!entry) return pin;
    const f = readFlags(entry);
    return {
      ...pin,
      scene: pin.scene ?? (typeof f.scene === "string" ? f.scene : undefined),
      x: pin.x ?? (typeof f.x === "number" ? f.x : undefined),
      y: pin.y ?? (typeof f.y === "number" ? f.y : undefined),
    };
  } catch {
    return pin;
  }
}

/** Append a reply to the pin's journal page (first text page). Best effort — never fails the pin. */
async function appendJournalReply(
  live: FoundryLive,
  pin: Pin,
  reply: string,
): Promise<void> {
  try {
    const raw = live.raw() as unknown as {
      getJournals(): {
        _id: string;
        pages?: { _id: string; text?: { content?: string } }[];
      }[];
    };
    const entry = raw.getJournals().find((j) => j._id === pin.entryId);
    const page = entry?.pages?.[0];
    if (!page) return;
    const content = `${page.text?.content ?? ""}<hr><p><b>Meroki:</b> ${reply}</p>`;
    await live.modifyDocument("JournalEntryPage", "update", {
      updates: [{ _id: page._id, text: { content } }],
      parentUuid: `JournalEntry.${pin.entryId}`,
    });
  } catch {
    // The chat reply already went out; a failed journal append is logged
    // by the caller, not fatal.
    throw new Error("journal append failed");
  }
}

/**
 * Handle one open pin end to end: plan, build, reply in chat, append to
 * the journal page, mark done on both docs. Returns true when the pin
 * was handled (false when it was already done/handled — the caller
 * skips it). The executor is injectable for tests; production uses the
 * dynamic-import default.
 */
export async function handlePin(
  live: FoundryLive,
  pin: Pin,
  opts: { pins?: PinProcessor; executor?: PinExecutor; alias?: string } = {},
): Promise<boolean> {
  if (pin.status !== "open") return false;
  const pins = opts.pins ?? new PinProcessor();
  if (pins.has(pin.entryId)) return false;
  const executor = opts.executor ?? defaultExecutor;
  const alias = opts.alias ?? "Meroki";

  // A Note-only pin carries no scene/coords — resolve them from its entry.
  pin = resolvePinCoords(live, pin);

  const req = parsePinRequest(pin.request);
  const { walls, size } = pin.scene
    ? sceneWalls(live, pin.scene)
    : { walls: [], size: { width: 0, height: 0 } };
  const plan = planPinAction(req, pin, walls, size);

  let reply = plan.reply;
  try {
    switch (plan.kind) {
      case "secret-door": {
        await executor.replaceWall(live, plan.sceneId, plan.wallId, [
          ...plan.keep.map((w) => ({ ...w, door: 0 })),
          { ...plan.door, door: 2 },
        ]);
        const built = await executor.buildRoom(live, plan.room);
        reply = `${plan.reply} (scene: ${built.name})`;
        break;
      }
      case "door": {
        await executor.replaceWall(live, plan.sceneId, plan.wallId, [
          ...plan.keep.map((w) => ({ ...w, door: 0 })),
          { ...plan.door, door: 1 },
        ]);
        break;
      }
      case "room": {
        const built = await executor.buildRoom(live, plan.room);
        reply = `${plan.reply} (scene: ${built.name})`;
        break;
      }
      case "chest":
        await executor.addChest(live, plan.sceneId, plan.x, plan.y);
        break;
      case "light":
        await executor.addLight(live, plan.sceneId, plan.x, plan.y);
        break;
      default:
        // no-wall / no-scene / unknown — the reply IS the handling.
        break;
    }
  } catch (err) {
    // A failed build must not leave the pin open forever re-firing, and
    // must not silently vanish: say so in chat, mark done with the error
    // noted, and let the table re-pin if they want it retried.
    reply = `📌 I tried to build that pin ("${pin.request}") but it failed: ${err instanceof Error ? err.message : String(err)}. Drop a new pin to retry.`;
  }

  await live.sendChat(reply, { alias });
  try {
    await appendJournalReply(live, pin, reply);
  } catch {
    // Chat already went out; note the journal failure in the log via the error return.
  }
  await markPinDone(live, pin);
  pins.mark(pin.entryId);
  return true;
}
