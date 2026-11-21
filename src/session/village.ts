/**
 * Living village core (BRA-227) — the map that lives when nobody is
 * watching. Design: docs/living-village.md. The vision doc, Act Five.
 *
 * Pure functions only: no Foundry, no I/O, no wall clock. The core
 * answers three questions — where is everyone, what is happening, and
 * how does this villager feel about that PC — as deterministic
 * functions of in-game time plus recorded history.
 *
 * THE ONE DECISION: position and event stage are pure functions of
 * in-game time, not simulated state. A villager's round is a schedule;
 * where they are at hour H is computed from the schedule, not from
 * replaying every step. A background event's stage is computed from
 * its stage hours. The store keeps an hour cursor and an append-only
 * history, but the village never needs to be "simulated forward" to
 * know where things stand — a week unobserved is one function call.
 *
 * HONESTY RULES (same family as the quest log, chronicle, and
 * clocks): every memory carries a `source`; every relationship change
 * carries a `reason` and a `source`; every state change is recorded
 * in the append-only history. A backstory is required, stored
 * verbatim, and never generated or paraphrased by this module —
 * responses quote it. A memory is what the villager remembers and can
 * be wrong; memory and backstory are never merged into one "truth".
 * The core never generates villager dialogue: `respondTo` returns
 * grounded context (backstory + memories + disposition) and Muse
 * writes the words at the table from that context only.
 *
 * Two layers, kept separate on purpose (same pattern as
 * src/session/clocks.ts and src/session/chronicle.ts):
 * - Pure functions in this file: no Foundry, no I/O, unit tested in
 *   tests/village.test.ts.
 * - Live functions: NOT built here. The monitor owns the watch (it
 *   reads the in-game hour and calls advanceVillageToHour), moves
 *   tokens to the positions the core reports, drafts replies from
 *   respondTo, and persists the store as a JournalEntry named
 *   "Village" (quest-log/chronicle pattern). See the design doc's
 *   "Live layer seam" section for the exact call order.
 *
 * What this module deliberately does NOT do:
 * - It does not generate dialogue, move tokens, or read actor
 *   sheets. Charisma and PC identity arrive as inputs.
 * - It does not decay memory or relationships with time. Forgetting
 *   is a deliberate act, not entropy.
 * - It does not run background events as code. A stage's text is
 *   data; the consequence is the GM's or a staged cutscene's job.
 * - It does not advance itself. The in-game hour arrives as input;
 *   the module never reads the wall clock and never guesses the time.
 */
import type { RoutePoint } from "./vehicles.js";

/** Validation / lookup failure. */
export class VillageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VillageError";
  }
}

/** Relationship bounds: -5 (hates) .. +5 (loves). */
export const MIN_RELATIONSHIP = -5;
export const MAX_RELATIONSHIP = 5;
/** Memory sentiment bounds per entry, and the cap on how much all
 *  memories together can move one response. */
export const MIN_SENTIMENT = -2;
export const MAX_SENTIMENT = 2;
export const MAX_MEMORY_SHIFT = 3;
/** Default engagement length in in-game hours — a conversation
 *  can't hold a villager forever. */
export const DEFAULT_MAX_ENGAGEMENT_HOURS = 1;
/** Hours in an in-game day. Schedule legs use hour of day. */
export const HOURS_PER_DAY = 24;

export type ResponseBand = "hostile" | "wary" | "neutral" | "warm" | "friendly";

/** One leg of a villager's daily round. */
export interface ScheduleLeg {
  /** e.g. "morning market". */
  name: string;
  /** e.g. "selling bread at the market stall". */
  activity: string;
  /** Hour of day the leg starts, 0..23. */
  startHour: number;
  /** Hour of day the leg ends, 1..24, strictly after startHour. A
   *  leg never crosses midnight — a night leg is two legs, or one
   *  leg ending at 24. */
  endHour: number;
  /** Waypoints in integer grid cells, at least 2, consecutive
   *  waypoints must differ. */
  waypoints: RoutePoint[];
}

/** What one villager remembers. */
export interface MemoryEntry {
  /** Stable id, e.g. "mara-1". */
  id: string;
  /** Who or what this is about: a PC id, another villager id, an
   *  event id. */
  subject: string;
  /** What happened, as stated. */
  text: string;
  /** How the villager feels about it, stated at record time, -2..+2. */
  sentiment: number;
  /** Short tag, e.g. "mill-fire". */
  topic?: string;
  /** Where this came from — required. */
  source: string;
  /** Absolute in-game hour it was recorded. */
  hour: number;
}

/** An open conversation with a villager. */
export interface Engagement {
  /** The PC who started the conversation. */
  by: string;
  /** Every PC in the conversation — a second PC joins the same
   *  conversation rather than starting a second one. */
  participants: string[];
  /** Absolute in-game hour it started. */
  sinceHour: number;
  /** The cell where the villager stopped walking. */
  engagedAt: RoutePoint;
  /** In-game hours before the tick returns the villager to the
   *  round on its own. */
  maxHours: number;
}

/** One villager. */
export interface Villager {
  /** Stable id, e.g. "mara-baker". */
  id: string;
  /** What the table calls them, e.g. "Mara". */
  name: string;
  /** What they do, e.g. "baker". */
  role: string;
  /** Stored backstory text, written by the GM or Muse. Required,
   *  non-empty. Quoted verbatim in responses, never generated or
   *  paraphrased. */
  backstory: string;
  /** At least one leg; legs never overlap. */
  schedule: ScheduleLeg[];
  /** Relationship score per subject (a PC id or another villager
   *  id), -5..+5. Absent means 0 — a stranger is neutral. */
  relationships: Record<string, number>;
  /** What this villager remembers. Append-only. */
  memories: MemoryEntry[];
  /** Null when walking the round. */
  engagement: Engagement | null;
}

/** One stage of a background event. */
export interface EventStage {
  /** Absolute in-game hour this stage starts. */
  atHour: number;
  /** What happens. */
  text: string;
  /** Chat line the live layer posts IF the GM wants the table to
   *  hear about it. Absent: the stage happens silently — the
   *  village changes whether or not the players notice. */
  announce?: string;
}

/** A background event: it progresses whether or not the players
 *  notice. Its current stage is a pure function of the hour. */
export interface BackgroundEvent {
  /** Stable id, e.g. "mill-fire". */
  id: string;
  name: string;
  description: string;
  /** In strictly increasing absolute-hour order. */
  stages: EventStage[];
}

/** One recorded change. Append-only, never edited or deleted. */
export interface VillageHistoryEntry {
  kind:
    | "create-village"
    | "add-villager"
    | "add-event"
    | "tick"
    | "engage"
    | "disengage"
    | "return"
    | "remember"
    | "relationship"
    | "event-stage";
  /** Absolute in-game hour it happened. */
  hour: number;
  /** Where this came from — required. A chat message id, a GM
   *  statement, a tick. */
  source: string;
  /** One line of detail. */
  detail: string;
}

/** The whole village. */
export interface VillageStore {
  villageName: string;
  /** Last in-game hour processed, absolute (day * 24 + hourOfDay). */
  hourCursor: number;
  villagers: Villager[];
  events: BackgroundEvent[];
  history: VillageHistoryEntry[];
}

/** Where a villager is at an hour, and what they are doing. */
export interface VillagerPosition {
  villagerId: string;
  x: number;
  y: number;
  /** The leg they are on, or null when engaged. */
  legName: string | null;
  /** What they are doing — the leg's activity, or "talking". */
  activity: string;
  /** True when they stepped off the path for a conversation. */
  engaged: boolean;
}

/** One thing that changed during a tick. */
export interface VillageTickEvent {
  kind: "event-stage" | "return" | "moved";
  /** Absolute in-game hour it happened on. */
  hour: number;
  villagerId?: string;
  eventId?: string;
  detail: string;
}

/** Grounded context for a reply — not words. Muse drafts the reply
 *  from this, quoting the backstory and memories, never extending
 *  them. */
export interface VillagerResponse {
  villagerId: string;
  villagerName: string;
  /** Relationship score with this PC, -5..+5 (0 for a stranger). */
  relationship: number;
  /** Memories about this PC (and about the topic, if one was given),
   *  newest first. Quoted verbatim. */
  memories: MemoryEntry[];
  /** The stored backstory, quoted verbatim. */
  backstory: string;
  /** The PC's charisma modifier as supplied by the caller. */
  charismaMod: number;
  /** relationship + capped memory sentiment + charisma, clamped
   *  -5..+5. */
  disposition: number;
  band: ResponseBand;
}

// ---------------------------------------------------------------- validation

function requireSource(source: string | undefined, what: string): string {
  if (typeof source !== "string" || source.trim() === "") {
    throw new VillageError(`${what} needs a source — who stated it (a chat message id, a GM statement, a tick).`);
  }
  return source;
}

function requireHour(hour: number, what: string): number {
  if (!Number.isInteger(hour) || hour < 0) {
    throw new VillageError(`${what} needs an in-game hour (a non-negative integer, absolute: day * 24 + hour of day), got ${JSON.stringify(hour)}.`);
  }
  return hour;
}

function requireCell(cell: RoutePoint, what: string): RoutePoint {
  if (
    !cell ||
    typeof cell.x !== "number" ||
    typeof cell.y !== "number" ||
    !Number.isInteger(cell.x) ||
    !Number.isInteger(cell.y)
  ) {
    throw new VillageError(`${what} needs an integer grid cell {x, y}, got ${JSON.stringify(cell)}.`);
  }
  return { x: cell.x, y: cell.y };
}

function validateLeg(leg: ScheduleLeg, villagerId: string): void {
  if (typeof leg.name !== "string" || leg.name.trim() === "") {
    throw new VillageError(`Villager "${villagerId}": a schedule leg needs a name.`);
  }
  if (typeof leg.activity !== "string" || leg.activity.trim() === "") {
    throw new VillageError(`Villager "${villagerId}": leg "${leg.name}" needs an activity.`);
  }
  if (!Number.isInteger(leg.startHour) || leg.startHour < 0 || leg.startHour > 23) {
    throw new VillageError(`Villager "${villagerId}": leg "${leg.name}" startHour must be an hour of day (0..23), got ${JSON.stringify(leg.startHour)}.`);
  }
  if (!Number.isInteger(leg.endHour) || leg.endHour < 1 || leg.endHour > 24) {
    throw new VillageError(`Villager "${villagerId}": leg "${leg.name}" endHour must be 1..24, got ${JSON.stringify(leg.endHour)}.`);
  }
  if (leg.endHour <= leg.startHour) {
    throw new VillageError(
      `Villager "${villagerId}": leg "${leg.name}" runs ${leg.startHour}..${leg.endHour} — a leg never crosses midnight, endHour must be after startHour (use two legs for a night leg).`,
    );
  }
  if (!Array.isArray(leg.waypoints) || leg.waypoints.length < 2) {
    throw new VillageError(`Villager "${villagerId}": leg "${leg.name}" needs at least 2 waypoints.`);
  }
  leg.waypoints.forEach((w, i) => requireCell(w, `Villager "${villagerId}": leg "${leg.name}" waypoint ${i}`));
  for (let i = 1; i < leg.waypoints.length; i++) {
    if (leg.waypoints[i].x === leg.waypoints[i - 1].x && leg.waypoints[i].y === leg.waypoints[i - 1].y) {
      throw new VillageError(
        `Villager "${villagerId}": leg "${leg.name}" waypoints[${i - 1}] and waypoints[${i}] are the same cell — consecutive waypoints must differ.`,
      );
    }
  }
}

function validateSchedule(schedule: ScheduleLeg[], villagerId: string): void {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new VillageError(`Villager "${villagerId}" needs at least one schedule leg — a villager with no round is a missing schedule, not a villager standing still.`);
  }
  schedule.forEach((leg) => validateLeg(leg, villagerId));
  const sorted = [...schedule].sort((a, b) => a.startHour - b.startHour);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startHour < sorted[i - 1].endHour) {
      throw new VillageError(
        `Villager "${villagerId}": legs "${sorted[i - 1].name}" (${sorted[i - 1].startHour}..${sorted[i - 1].endHour}) and "${sorted[i].name}" (${sorted[i].startHour}..${sorted[i].endHour}) overlap — one hour, one leg.`,
      );
    }
  }
}

function validateEvent(event: BackgroundEvent): void {
  if (typeof event.id !== "string" || event.id.trim() === "") {
    throw new VillageError("A background event needs an id.");
  }
  if (typeof event.name !== "string" || event.name.trim() === "") {
    throw new VillageError(`Event "${event.id}": needs a name.`);
  }
  if (!Array.isArray(event.stages) || event.stages.length === 0) {
    throw new VillageError(`Event "${event.id}" needs at least one stage.`);
  }
  event.stages.forEach((s, i) => {
    requireHour(s.atHour, `Event "${event.id}" stage ${i}`);
    if (typeof s.text !== "string" || s.text.trim() === "") {
      throw new VillageError(`Event "${event.id}" stage ${i} needs text — what happens.`);
    }
  });
  for (let i = 1; i < event.stages.length; i++) {
    if (event.stages[i].atHour <= event.stages[i - 1].atHour) {
      throw new VillageError(
        `Event "${event.id}": stages must be in strictly increasing hour order — stage ${i} at hour ${event.stages[i].atHour} is not after stage ${i - 1} at hour ${event.stages[i - 1].atHour}.`,
      );
    }
  }
}

// ---------------------------------------------------------------- store

/** An empty village at in-game hour 0 (day 0, midnight). */
export function createVillage(
  villageName: string,
  opts: { hourCursor?: number; source?: string } = {},
): VillageStore {
  if (typeof villageName !== "string" || villageName.trim() === "") {
    throw new VillageError("A village needs a name.");
  }
  const hourCursor = opts.hourCursor === undefined ? 0 : requireHour(opts.hourCursor, "hourCursor");
  return {
    villageName,
    hourCursor,
    villagers: [],
    events: [],
    history: [
      {
        kind: "create-village",
        hour: hourCursor,
        source: requireSource(opts.source, "Creating a village"),
        detail: `Village "${villageName}" created at in-game hour ${hourCursor}.`,
      },
    ],
  };
}

function getVillager(store: VillageStore, villagerId: string): Villager {
  const v = store.villagers.find((x) => x.id === villagerId);
  if (!v) {
    throw new VillageError(
      `No villager "${villagerId}" in ${store.villageName} — the village has: ${store.villagers.map((x) => x.id).join(", ") || "(nobody)"}.`,
    );
  }
  return v;
}

/** Add a villager. The backstory is required and stored verbatim —
 *  the core never generates one. Pure: returns a new store. */
export function addVillager(
  store: VillageStore,
  input: Omit<Villager, "relationships" | "memories" | "engagement"> & {
    relationships?: Record<string, number>;
    memories?: MemoryEntry[];
  },
  source: string,
): VillageStore {
  const src = requireSource(source, "Adding a villager");
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new VillageError("A villager needs an id.");
  }
  if (store.villagers.some((v) => v.id === input.id)) {
    throw new VillageError(`Villager "${input.id}" already exists in ${store.villageName}.`);
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new VillageError(`Villager "${input.id}": needs a name.`);
  }
  if (typeof input.backstory !== "string" || input.backstory.trim() === "") {
    throw new VillageError(
      `Villager "${input.id}": needs a backstory — written by the GM or Muse, stored verbatim. The core never generates one; a villager with no backstory yet is a missing backstory, not a villager.`,
    );
  }
  validateSchedule(input.schedule, input.id);
  const relationships: Record<string, number> = {};
  for (const [subject, score] of Object.entries(input.relationships ?? {})) {
    if (typeof score !== "number" || !Number.isInteger(score) || score < MIN_RELATIONSHIP || score > MAX_RELATIONSHIP) {
      throw new VillageError(`Villager "${input.id}": relationship with "${subject}" must be an integer ${MIN_RELATIONSHIP}..${MAX_RELATIONSHIP}, got ${JSON.stringify(score)}.`);
    }
    relationships[subject] = score;
  }
  const villager: Villager = {
    id: input.id,
    name: input.name,
    role: input.role ?? "",
    backstory: input.backstory,
    schedule: input.schedule.map((leg) => ({
      ...leg,
      waypoints: leg.waypoints.map((w) => ({ x: w.x, y: w.y })),
    })),
    relationships,
    memories: [...(input.memories ?? [])],
    engagement: null,
  };
  return {
    ...store,
    villagers: [...store.villagers, villager],
    history: [
      ...store.history,
      { kind: "add-villager", hour: store.hourCursor, source: src, detail: `Added villager "${villager.name}" (${villager.id}, ${villager.role}).` },
    ],
  };
}

/** Add a background event. Its stage is a pure function of the hour
 *  from here on. Pure: returns a new store. */
export function addBackgroundEvent(
  store: VillageStore,
  event: BackgroundEvent,
  source: string,
): VillageStore {
  const src = requireSource(source, "Adding a background event");
  validateEvent(event);
  if (store.events.some((e) => e.id === event.id)) {
    throw new VillageError(`Background event "${event.id}" already exists in ${store.villageName}.`);
  }
  return {
    ...store,
    events: [
      ...store.events,
      {
        ...event,
        stages: event.stages.map((s) => ({ ...s })),
      },
    ],
    history: [
      ...store.history,
      { kind: "add-event", hour: store.hourCursor, source: src, detail: `Added background event "${event.name}" (${event.id}, ${event.stages.length} stages).` },
    ],
  };
}

// ---------------------------------------------------------------- position

/** Hour of day for an absolute in-game hour. */
export function hourOfDay(absoluteHour: number): number {
  return ((absoluteHour % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
}

/** The stage an event is in at an absolute hour — the last stage
 *  whose hour has been reached, or null before the first stage. */
export function eventStageAt(event: BackgroundEvent, absoluteHour: number): EventStage | null {
  let current: EventStage | null = null;
  for (const stage of event.stages) {
    if (stage.atHour <= absoluteHour) current = stage;
    else break;
  }
  return current;
}

/** Where a villager is at an absolute in-game hour. Pure schedule
 *  resolution — except when engaged, when they stand where the
 *  conversation caught them. */
export function positionAtHour(villager: Villager, absoluteHour: number): VillagerPosition {
  const hour = requireHour(absoluteHour, "positionAtHour");
  if (villager.engagement) {
    return {
      villagerId: villager.id,
      x: villager.engagement.engagedAt.x,
      y: villager.engagement.engagedAt.y,
      legName: null,
      activity: "talking",
      engaged: true,
    };
  }
  const hod = hourOfDay(hour);
  const legs = [...villager.schedule].sort((a, b) => a.startHour - b.startHour);
  // The leg containing this hour, if any.
  let leg = legs.find((l) => hod >= l.startHour && hod < l.endHour);
  if (!leg) {
    // Between legs: stay at the previous leg's last waypoint (or the
    // first leg's first waypoint before the day's first leg).
    const prev = [...legs].reverse().find((l) => l.endHour <= hod);
    if (prev) {
      const last = prev.waypoints[prev.waypoints.length - 1];
      return { villagerId: villager.id, x: last.x, y: last.y, legName: prev.name, activity: prev.activity, engaged: false };
    }
    const first = legs[0].waypoints[0];
    return { villagerId: villager.id, x: first.x, y: first.y, legName: legs[0].name, activity: legs[0].activity, engaged: false };
  }
  const progress = (hod - leg.startHour) / (leg.endHour - leg.startHour);
  const idx = Math.min(leg.waypoints.length - 1, Math.floor(progress * leg.waypoints.length));
  const cell = leg.waypoints[idx];
  return { villagerId: villager.id, x: cell.x, y: cell.y, legName: leg.name, activity: leg.activity, engaged: false };
}

/** Every villager's position at an absolute in-game hour. */
export function positionsAtHour(store: VillageStore, absoluteHour: number): VillagerPosition[] {
  return store.villagers.map((v) => positionAtHour(v, absoluteHour));
}

// ---------------------------------------------------------------- tick

/** Advance the village to an absolute in-game hour. Time does not
 *  go backwards. Returns the new store plus what changed during the
 *  jump: each background-event stage transition (with its hour), each
 *  engagement that expired (the villager returned to the round), and
 *  each villager whose position changed between the start and end
 *  hours (one entry per villager, however many hours passed).
 *
 *  Positions are re-derived, not stepped — a week unobserved is one
 *  call, and the answer is the same whether the village was watched
 *  or not. */
export function advanceVillageToHour(
  store: VillageStore,
  absoluteHour: number,
  source: string,
): { store: VillageStore; events: VillageTickEvent[] } {
  const src = requireSource(source, "Advancing the village");
  const target = requireHour(absoluteHour, "advanceVillageToHour");
  if (target < store.hourCursor) {
    throw new VillageError(
      `Cannot advance ${store.villageName} to hour ${target} — the cursor is at hour ${store.hourCursor}, and in-game time does not go backwards. (If the GM rewinds the game clock, that is a new store, not a silent edit.)`,
    );
  }
  if (target === store.hourCursor) return { store, events: [] };
  const events: VillageTickEvent[] = [];
  const history: VillageHistoryEntry[] = [...store.history];
  // Stage transitions and engagement expiries, in hour order.
  for (let h = store.hourCursor + 1; h <= target; h++) {
    for (const event of store.events) {
      const before = eventStageAt(event, h - 1);
      const after = eventStageAt(event, h);
      if (after !== before && after !== null) {
        events.push({
          kind: "event-stage",
          hour: h,
          eventId: event.id,
          detail: `Event "${event.name}" reached a new stage at hour ${h}: ${after.text}`,
        });
        history.push({
          kind: "event-stage",
          hour: h,
          source: src,
          detail: `Event "${event.name}" (${event.id}) reached a new stage: ${after.text}`,
        });
      }
    }
  }
  // Expire engagements whose hour limit was reached, and report
  // moves as start-vs-end positions only.
  const beforePositions = new Map(store.villagers.map((v) => [v.id, positionAtHour(v, store.hourCursor)]));
  let villagers = store.villagers;
  const expired: { villager: Villager; atHour: number }[] = [];
  for (const v of villagers) {
    if (v.engagement && target >= v.engagement.sinceHour + v.engagement.maxHours) {
      expired.push({ villager: v, atHour: v.engagement.sinceHour + v.engagement.maxHours });
    }
  }
  if (expired.length > 0) {
    villagers = villagers.map((v) => {
      const hit = expired.find((e) => e.villager.id === v.id);
      if (!hit) return v;
      events.push({
        kind: "return",
        hour: hit.atHour,
        villagerId: v.id,
        detail: `${v.name} returned to the round at hour ${hit.atHour} — the conversation ran past its hour limit.`,
      });
      history.push({
        kind: "return",
        hour: hit.atHour,
        source: src,
        detail: `${v.name} (${v.id}) returned to the round — engagement expired at hour ${hit.atHour}.`,
      });
      return { ...v, engagement: null };
    });
    // Expired engagements are reported in hour order.
    events.sort((a, b) => a.hour - b.hour || (a.kind < b.kind ? -1 : 1));
  }
  const next: VillageStore = {
    ...store,
    hourCursor: target,
    villagers,
    history: [
      ...history,
      { kind: "tick", hour: target, source: src, detail: `Advanced ${store.villageName} from hour ${store.hourCursor} to hour ${target}.` },
    ],
  };
  for (const v of villagers) {
    const before = beforePositions.get(v.id)!;
    const after = positionAtHour(v, target);
    if (before.x !== after.x || before.y !== after.y) {
      events.push({
        kind: "moved",
        hour: target,
        villagerId: v.id,
        detail: `${v.name} moved from (${before.x}, ${before.y}) to (${after.x}, ${after.y}).`,
      });
    }
  }
  return { store: next, events };
}

// ---------------------------------------------------------------- engagement

/** Engage a villager in conversation. A free villager stops walking
 *  where the conversation catches them; a second PC joins the same
 *  conversation as a participant. Pure: returns a new store. */
export function engageVillager(
  store: VillageStore,
  villagerId: string,
  pcId: string,
  source: string,
  opts: { maxHours?: number } = {},
): VillageStore {
  const src = requireSource(source, "Engaging a villager");
  if (typeof pcId !== "string" || pcId.trim() === "") {
    throw new VillageError("Engaging a villager needs a PC id.");
  }
  const maxHours = opts.maxHours ?? DEFAULT_MAX_ENGAGEMENT_HOURS;
  if (!Number.isInteger(maxHours) || maxHours < 1) {
    throw new VillageError(`maxHours must be an integer >= 1, got ${JSON.stringify(maxHours)}.`);
  }
  const villager = getVillager(store, villagerId);
  if (villager.engagement) {
    if (villager.engagement.participants.includes(pcId)) return store;
    const next: Villager = {
      ...villager,
      engagement: { ...villager.engagement, participants: [...villager.engagement.participants, pcId] },
    };
    return {
      ...store,
      villagers: store.villagers.map((v) => (v.id === villagerId ? next : v)),
      history: [
        ...store.history,
        { kind: "engage", hour: store.hourCursor, source: src, detail: `${pcId} joined the conversation with ${villager.name} (started by ${villager.engagement.by}).` },
      ],
    };
  }
  const at = positionAtHour(villager, store.hourCursor);
  const next: Villager = {
    ...villager,
    engagement: {
      by: pcId,
      participants: [pcId],
      sinceHour: store.hourCursor,
      engagedAt: { x: at.x, y: at.y },
      maxHours,
    },
  };
  return {
    ...store,
    villagers: store.villagers.map((v) => (v.id === villagerId ? next : v)),
    history: [
      ...store.history,
      { kind: "engage", hour: store.hourCursor, source: src, detail: `${pcId} engaged ${villager.name} at (${at.x}, ${at.y}).` },
    ],
  };
}

/** One PC leaves the conversation. When the last participant
 *  leaves, the engagement ends and the villager resumes the round
 *  at the schedule position for the current hour. Pure: returns a
 *  new store. */
export function disengageVillager(
  store: VillageStore,
  villagerId: string,
  pcId: string,
  source: string,
): VillageStore {
  const src = requireSource(source, "Disengaging a villager");
  const villager = getVillager(store, villagerId);
  if (!villager.engagement) return store;
  if (!villager.engagement.participants.includes(pcId)) return store;
  const remaining = villager.engagement.participants.filter((p) => p !== pcId);
  const next: Villager =
    remaining.length === 0
      ? { ...villager, engagement: null }
      : { ...villager, engagement: { ...villager.engagement, participants: remaining } };
  return {
    ...store,
    villagers: store.villagers.map((v) => (v.id === villagerId ? next : v)),
    history: [
      ...store.history,
      {
        kind: "disengage",
        hour: store.hourCursor,
        source: src,
        detail:
          remaining.length === 0
            ? `${pcId} left the conversation with ${villager.name} — the last participant, so ${villager.name} returns to the round.`
            : `${pcId} left the conversation with ${villager.name} (${remaining.join(", ")} still talking).`,
      },
    ],
  };
}

// ---------------------------------------------------------------- memory + relationship

/** Record what a villager remembers. The sentiment is stated at
 *  record time; the core never infers how a villager feels. Pure:
 *  returns a new store. */
export function remember(
  store: VillageStore,
  villagerId: string,
  entry: { subject: string; text: string; sentiment?: number; topic?: string },
  source: string,
): VillageStore {
  const src = requireSource(source, "Recording a memory");
  const villager = getVillager(store, villagerId);
  if (typeof entry.subject !== "string" || entry.subject.trim() === "") {
    throw new VillageError(`A memory needs a subject — who or what it is about.`);
  }
  if (typeof entry.text !== "string" || entry.text.trim() === "") {
    throw new VillageError(`A memory needs text — what happened, as stated.`);
  }
  const sentiment = entry.sentiment ?? 0;
  if (typeof sentiment !== "number" || !Number.isInteger(sentiment) || sentiment < MIN_SENTIMENT || sentiment > MAX_SENTIMENT) {
    throw new VillageError(`Memory sentiment must be an integer ${MIN_SENTIMENT}..${MAX_SENTIMENT}, got ${JSON.stringify(sentiment)}.`);
  }
  const id = `${villagerId}-${villager.memories.length + 1}`;
  const memory: MemoryEntry = {
    id,
    subject: entry.subject,
    text: entry.text,
    sentiment,
    ...(entry.topic !== undefined ? { topic: entry.topic } : {}),
    source: src,
    hour: store.hourCursor,
  };
  const next: Villager = { ...villager, memories: [...villager.memories, memory] };
  return {
    ...store,
    villagers: store.villagers.map((v) => (v.id === villagerId ? next : v)),
    history: [
      ...store.history,
      { kind: "remember", hour: store.hourCursor, source: src, detail: `${villager.name} remembers (${entry.subject}): ${entry.text}` },
    ],
  };
}

/** Change how a villager feels about a subject (a PC id or another
 *  villager id). The reason and source are required and recorded —
 *  a relationship never moves silently. Clamps to -5..+5. Pure:
 *  returns a new store. */
export function adjustRelationship(
  store: VillageStore,
  villagerId: string,
  subjectId: string,
  delta: number,
  reason: string,
  source: string,
): VillageStore {
  const src = requireSource(source, "Changing a relationship");
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new VillageError(`Changing a relationship needs a reason — why it moved.`);
  }
  if (typeof subjectId !== "string" || subjectId.trim() === "") {
    throw new VillageError("Changing a relationship needs a subject id.");
  }
  if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0) {
    throw new VillageError(`A relationship change needs a non-zero integer delta, got ${JSON.stringify(delta)}.`);
  }
  const villager = getVillager(store, villagerId);
  const before = villager.relationships[subjectId] ?? 0;
  const after = Math.max(MIN_RELATIONSHIP, Math.min(MAX_RELATIONSHIP, before + delta));
  const next: Villager = {
    ...villager,
    relationships: { ...villager.relationships, [subjectId]: after },
  };
  return {
    ...store,
    villagers: store.villagers.map((v) => (v.id === villagerId ? next : v)),
    history: [
      ...store.history,
      {
        kind: "relationship",
        hour: store.hourCursor,
        source: src,
        detail: `${villager.name}'s feeling about ${subjectId} moved ${before} → ${after} (${delta > 0 ? "+" : ""}${delta}): ${reason}`,
      },
    ],
  };
}

/** A villager's relationship score with a subject. Absent means 0 —
 *  a stranger is neutral. */
export function relationshipWith(villager: Villager, subjectId: string): number {
  return villager.relationships[subjectId] ?? 0;
}

// ---------------------------------------------------------------- responses

export function bandFor(disposition: number): ResponseBand {
  if (disposition <= -4) return "hostile";
  if (disposition <= -1) return "wary";
  if (disposition <= 1) return "neutral";
  if (disposition <= 3) return "warm";
  return "friendly";
}

/** Grounded context for a reply — not words. The backstory and
 *  memories are quoted verbatim from the store; the disposition is
 *  relationship + capped memory sentiment + charisma. Muse drafts
 *  the reply from this context only. */
export function respondTo(
  store: VillageStore,
  villagerId: string,
  pcId: string,
  opts: { pcCharismaMod?: number; topic?: string } = {},
): VillagerResponse {
  const villager = getVillager(store, villagerId);
  if (typeof pcId !== "string" || pcId.trim() === "") {
    throw new VillageError("Responding needs a PC id — who the villager is talking to.");
  }
  const charismaMod = opts.pcCharismaMod ?? 0;
  if (typeof charismaMod !== "number" || !Number.isInteger(charismaMod)) {
    throw new VillageError(`pcCharismaMod must be an integer, got ${JSON.stringify(charismaMod)}.`);
  }
  const relationship = relationshipWith(villager, pcId);
  const relevant = villager.memories
    .filter((m) => m.subject === pcId || (opts.topic !== undefined && m.topic === opts.topic))
    .sort((a, b) => b.hour - a.hour || b.id.localeCompare(a.id));
  const memoryShift = Math.max(
    -MAX_MEMORY_SHIFT,
    Math.min(MAX_MEMORY_SHIFT, relevant.reduce((sum, m) => sum + m.sentiment, 0)),
  );
  const disposition = Math.max(
    MIN_RELATIONSHIP,
    Math.min(MAX_RELATIONSHIP, relationship + memoryShift + charismaMod),
  );
  return {
    villagerId: villager.id,
    villagerName: villager.name,
    relationship,
    memories: relevant,
    backstory: villager.backstory,
    charismaMod,
    disposition,
    band: bandFor(disposition),
  };
}

// ---------------------------------------------------------------- render + serialize

/** One-screen summary of the village at an absolute hour — for the
 *  GM, or for a chat line. Positions, engagements, event stages. */
export function renderVillage(store: VillageStore, absoluteHour: number): string {
  const hour = requireHour(absoluteHour, "renderVillage");
  const lines: string[] = [
    `${store.villageName} — in-game hour ${hour} (day ${Math.floor(hour / HOURS_PER_DAY)}, ${hourOfDay(hour)}:00).`,
  ];
  for (const v of store.villagers) {
    const pos = positionAtHour(v, hour);
    const at = pos.engaged
      ? `engaged in conversation at (${pos.x}, ${pos.y})`
      : `${pos.activity} at (${pos.x}, ${pos.y})`;
    lines.push(`- ${v.name} (${v.role}): ${at}.`);
  }
  for (const event of store.events) {
    const stage = eventStageAt(event, hour);
    lines.push(
      stage
        ? `- ${event.name}: ${stage.text}`
        : `- ${event.name}: not yet begun (first stage at hour ${event.stages[0].atHour}).`,
    );
  }
  return lines.join("\n");
}

/** Serialize the whole store (for the state file / JournalEntry
 *  flags). The history travels with it — the store is its own
 *  audit trail. */
export function serializeVillage(store: VillageStore): string {
  return JSON.stringify(store);
}

/** Parse a serialized store, validating it the same way the
 *  constructors do. Throws VillageError on anything malformed. */
export function parseVillage(json: string): VillageStore {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new VillageError("Village state is not valid JSON.");
  }
  if (!raw || typeof raw !== "object") throw new VillageError("Village state must be an object.");
  const r = raw as Record<string, unknown>;
  if (typeof r.villageName !== "string" || r.villageName.trim() === "") {
    throw new VillageError("Village state needs a villageName.");
  }
  const hourCursor = requireHour(r.hourCursor as number, "Village state hourCursor");
  if (!Array.isArray(r.villagers) || !Array.isArray(r.events) || !Array.isArray(r.history)) {
    throw new VillageError("Village state needs villagers, events, and history arrays.");
  }
  const store: VillageStore = {
    villageName: r.villageName,
    hourCursor,
    villagers: [],
    events: [],
    history: [],
  };
  // Rebuild through the validated constructors so a hand-edited or
  // stale file gets the same checks as a fresh build.
  let next: VillageStore = {
    ...store,
    history: (r.history as VillageHistoryEntry[]).map((h) => ({ ...h })),
  };
  for (const v of r.villagers as Villager[]) {
    if (typeof v.id !== "string" || v.id.trim() === "") {
      throw new VillageError("Village state has a villager without an id.");
    }
    validateSchedule(v.schedule, v.id);
    if (typeof v.backstory !== "string" || v.backstory.trim() === "") {
      throw new VillageError(`Villager "${v.id}" in the saved state has no backstory.`);
    }
    for (const m of v.memories ?? []) {
      if (typeof m.source !== "string" || m.source.trim() === "") {
        throw new VillageError(`Villager "${v.id}" in the saved state has a memory without a source.`);
      }
    }
    next = {
      ...next,
      villagers: [
        ...next.villagers,
        {
          ...v,
          schedule: v.schedule.map((leg) => ({ ...leg, waypoints: leg.waypoints.map((w) => ({ ...w })) })),
          relationships: { ...(v.relationships ?? {}) },
          memories: (v.memories ?? []).map((m) => ({ ...m })),
          engagement: v.engagement ? { ...v.engagement, participants: [...v.engagement.participants], engagedAt: { ...v.engagement.engagedAt } } : null,
        },
      ],
    };
  }
  for (const e of r.events as BackgroundEvent[]) {
    validateEvent(e);
    next = { ...next, events: [...next.events, { ...e, stages: e.stages.map((s) => ({ ...s })) }] };
  }
  return next;
}
