/**
 * Compendium import — read pack documents over the plain Socket.IO
 * connection and import them as world actors. No REST module, no API key,
 * no browser client.
 *
 * Why this works (see docs/compendium-import.md for the full research):
 * - The `world` payload already carries every pack's index
 *   (`worldData.packs[].index`), so searching by name needs no round trip.
 * - `modifyDocument` accepts a fourth action, "get":
 *   `modifyDocument(type, "get", { query, pack })` returns the matching
 *   pack documents. Verified in an independent implementation
 *   (Pelmog/foundry-mcp, v13-tested); NOT yet run against TestBed 14.370.
 * - The MCP's own `searchCompendium` is REST-gated and returns empty
 *   without the removed REST module — it was never the right path.
 *
 * Layout follows the dice module: pure functions (search / map / patch)
 * are unit-tested with fixtures; the thin live wrappers do the socket
 * calls. Anything that needs a live Foundry is marked as such.
 */
import type { FoundryLive } from "../live.js";

// ---------------------------------------------------------------- types

/** One entry of a pack's index, as delivered in the `world` payload. */
export interface PackIndexEntry {
  _id: string;
  name: string;
  type: string;
  img?: string;
  uuid?: string;
  sort?: number;
  folder?: string | null;
  [key: string]: unknown;
}

/** One pack as delivered in the `world` payload (`worldData.packs`). */
export interface PackInfo {
  id: string;
  label: string;
  type: string;
  system?: string | null;
  packageType?: string;
  packageName?: string;
  path?: string;
  index: PackIndexEntry[];
}

export interface PackSearchHit {
  packId: string;
  packLabel: string;
  packType: string;
  entry: PackIndexEntry;
}

export interface PackSummary {
  id: string;
  label: string;
  type: string;
  system: string | null;
  entries: number;
}

/** A compendium actor split into the world Actor create + its items. */
export interface WorldActorData {
  actorData: Record<string, unknown>;
  items: Record<string, unknown>[];
}

export interface ImportResult {
  actorId: string;
  name: string;
  itemIds: string[];
  /** The pack document this was imported from. */
  source: { packId: string; docId: string };
}

// ---------------------------------------------------------------- pure: search

/** Packs sorted by label, with entry counts. */
export function listPacks(packs: PackInfo[]): PackSummary[] {
  return [...packs]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((p) => ({
      id: p.id,
      label: p.label,
      type: p.type,
      system: p.system ?? null,
      entries: p.index?.length ?? 0,
    }));
}

export interface PackSearchOptions {
  /** Only entries of this document type (e.g. "Actor"). Case-insensitive. */
  type?: string;
  /** Only this pack id. */
  packId?: string;
  /** Max hits. Default 20. */
  limit?: number;
}

/**
 * Search every pack's index by name substring (case-insensitive).
 * Exact-name matches sort first, then by pack label, then by name.
 * Pure — the index is already in memory from the `world` payload.
 */
export function searchPackIndex(
  packs: PackInfo[],
  query: string,
  opts: PackSearchOptions = {},
): PackSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 20;
  const type = opts.type?.toLowerCase();
  const hits: PackSearchHit[] = [];
  for (const pack of packs) {
    if (opts.packId && pack.id !== opts.packId) continue;
    // Note: `type` filters *entries* by their document sub-type
    // ("npc", "spell", ...), NOT packs — a pack's `type` is its collection
    // type ("Actor", "Item"), which is coarser than entry types.
    for (const entry of pack.index ?? []) {
      if (type && entry.type.toLowerCase() !== type) continue;
      if (!entry.name.toLowerCase().includes(q)) continue;
      hits.push({ packId: pack.id, packLabel: pack.label, packType: pack.type, entry });
    }
  }
  hits.sort((a, b) => {
    const aExact = a.entry.name.toLowerCase() === q ? 0 : 1;
    const bExact = b.entry.name.toLowerCase() === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const byPack = a.packLabel.localeCompare(b.packLabel);
    if (byPack !== 0) return byPack;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return hits.slice(0, limit);
}

/** Find one index entry by pack id + document id, or null. */
export function findPackEntry(
  packs: PackInfo[],
  packId: string,
  docId: string,
): { pack: PackInfo; entry: PackIndexEntry } | null {
  const pack = packs.find((p) => p.id === packId);
  if (!pack) return null;
  const entry = (pack.index ?? []).find((e) => e._id === docId);
  return entry ? { pack, entry } : null;
}

// ---------------------------------------------------------------- pure: map

export interface MapActorOptions {
  /** Keep the pack document's _id on the world copy. Default false (fresh id). */
  keepId?: boolean;
  /** Rename the world copy. Default: keep the pack name. */
  name?: string;
  /** World folder _id to put the actor in. Default: no folder. */
  folder?: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Map a full compendium actor document to a world Actor create + its
 * embedded items. The pack `_id` is dropped by default (the server
 * assigns a fresh world id); the pack `folder` is dropped (pack folder
 * ids don't exist in the world). Everything else — name, type, img,
 * system, prototypeToken, flags — carries over untouched.
 *
 * Embedded items are returned separately because the proven creation
 * path in this codebase is Actor first, then Item creates with
 * `parentUuid: Actor.<id>` (see addChest in src/worldbuilding/index.ts).
 * Item `_id`s are dropped too, unless keepId.
 */
export function mapCompendiumActorToWorld(
  doc: Record<string, unknown>,
  opts: MapActorOptions = {},
): WorldActorData {
  if (!isRecord(doc)) throw new Error("Compendium document must be an object.");
  if (typeof doc.name !== "string" || doc.name === "") {
    throw new Error("Compendium document has no name — not an importable actor.");
  }
  if (typeof doc.type !== "string" || doc.type === "") {
    throw new Error(`Compendium document "${doc.name}" has no type.`);
  }
  const { _id, folder, items, ...rest } = doc;
  const actorData: Record<string, unknown> = { ...rest };
  if (opts.keepId && typeof _id === "string") actorData._id = _id;
  if (opts.name !== undefined) actorData.name = opts.name;
  if (opts.folder !== undefined && opts.folder !== null) actorData.folder = opts.folder;
  const rawItems = Array.isArray(items) ? items : [];
  const mappedItems = rawItems
    .filter((it) => isRecord(it) && typeof it.name === "string" && typeof it.type === "string")
    .map((it) => {
      const item = it as Record<string, unknown>;
      if (opts.keepId) return { ...item };
      const { _id: _itemId, ...itemRest } = item;
      return itemRest;
    });
  return { actorData, items: mappedItems };
}

// ---------------------------------------------------------------- the Dracolich

/**
 * Turn an imported Lich into a Dracolich: rename, creature type Dragon,
 * size Large, flight 60, and a necrotic breath strike. The base stats
 * (HP, AC, saves, spells) come from the book Lich; only the dragon parts
 * are homebrew, and they are the explicit changes below. Returns a new
 * document — the input is untouched.
 *
 * Level warning: the party is level 1–2. A level 12 Dracolich is a story
 * device / future boss, not a fight. Scale it down (or don't fight it)
 * — that call is Dave's, not Muse's.
 */
export function applyDracolichPatch(
  lichDoc: Record<string, unknown>,
): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(lichDoc)) as Record<string, unknown>;
  doc.name = "Dracolich";
  const system = (doc.system = isRecord(doc.system) ? { ...doc.system } : {});
  const details = (system.details = isRecord(system.details) ? { ...system.details } : {});
  details.creatureType = "Dragon";
  const traits = (system.traits = isRecord(system.traits) ? { ...system.traits } : {});
  const size = (traits.size = isRecord(traits.size) ? { ...traits.size } : {});
  size.value = "large";
  const attrs = (system.attributes = isRecord(system.attributes) ? { ...system.attributes } : {});
  const speed = (attrs.speed = isRecord(attrs.speed) ? { ...attrs.speed } : {});
  const otherSpeeds = Array.isArray(speed.otherSpeeds) ? [...speed.otherSpeeds] : [];
  if (!otherSpeeds.some((s) => isRecord(s) && s.type === "fly")) {
    otherSpeeds.push({ type: "fly", value: 60 });
  }
  speed.otherSpeeds = otherSpeeds;
  const items = Array.isArray(doc.items) ? [...(doc.items as unknown[])] : [];
  items.push({
    name: "Necrotic Breath",
    type: "melee",
    img: "systems/pf2e/icons/spells/necromancy.webp",
    system: {
      bonus: { value: 0 },
      damageRolls: [{ damage: "6d6", damageType: "void" }],
      traits: { value: ["magical", "necromancy"] },
      description: { value: "<p>Homebrew breath weapon (draft): 60-foot cone, 6d6 void damage, DC 30 basic Reflex save. Tune with Dave.</p>" },
    },
  });
  doc.items = items;
  return doc;
}

/**
 * Minimal full Dracolich actor document, for use ONLY if the compendium
 * import path stays blocked. EVERY NUMBER IN THIS DRAFT IS HOMEBREW —
 * chosen as a starting point, not book data. The recommended path is
 * import-the-Lich + applyDracolichPatch, where the base stats are real.
 *
 * Level 12, Large, unique. See docs/compendium-import.md for the level
 * warning (party is level 1–2; this is not a fair fight).
 */
export const DRACOLICH_DRAFT: Record<string, unknown> = {
  name: "Dracolich",
  type: "npc",
  img: "systems/pf2e/icons/default-icons/npc.svg",
  system: {
    details: {
      level: { value: 12 },
      alignment: { value: "LE" },
      creatureType: "Dragon",
    },
    attributes: {
      hp: { value: 210, max: 210 },
      ac: { value: 32 },
      speed: { value: 25, otherSpeeds: [{ type: "fly", value: 60 }] },
    },
    perception: { mod: 24 },
    saves: {
      fortitude: { value: 23 },
      reflex: { value: 21 },
      will: { value: 26 },
    },
    abilities: {
      str: { mod: 7 },
      dex: { mod: 4 },
      con: { mod: 5 },
      int: { mod: 4 },
      wis: { mod: 5 },
      cha: { mod: 5 },
    },
    skills: {
      arcana: { base: 24 },
      intimidation: { base: 26 },
    },
    traits: {
      size: { value: "large" },
      rarity: "unique",
    },
  },
  prototypeToken: {
    name: "Dracolich",
    width: 2,
    height: 2,
    texture: { src: "systems/pf2e/icons/default-icons/npc.svg" },
    disposition: -1,
  },
  items: [
    {
      name: "Jaws",
      type: "melee",
      system: {
        bonus: { value: 28 },
        damageRolls: [{ damage: "2d12+13", damageType: "piercing" }],
        traits: { value: ["reach-15"] },
      },
    },
    {
      name: "Claw",
      type: "melee",
      system: {
        bonus: { value: 28 },
        damageRolls: [{ damage: "2d10+13", damageType: "slashing" }],
        traits: { value: ["agile", "reach-10"] },
      },
    },
    {
      name: "Necrotic Breath",
      type: "melee",
      system: {
        bonus: { value: 0 },
        damageRolls: [{ damage: "6d6", damageType: "void" }],
        traits: { value: ["magical", "necromancy"] },
        description: { value: "<p>Homebrew breath weapon (draft): 60-foot cone, 6d6 void damage, DC 30 basic Reflex save. Tune with Dave.</p>" },
      },
    },
  ],
};

// ---------------------------------------------------------------- live wrappers

interface RawClient {
  getWorldData(): unknown;
}

/** The packs from the `world` payload (indexes included, no round trip). */
export function getWorldPacks(live: FoundryLive): PackInfo[] {
  const raw = live.raw() as unknown as RawClient;
  const data = raw.getWorldData() as { packs?: PackInfo[] } | null;
  return data?.packs ?? [];
}

/** Search the live world's pack indexes by name. */
export function searchLivePacks(
  live: FoundryLive,
  query: string,
  opts: PackSearchOptions = {},
): PackSearchHit[] {
  return searchPackIndex(getWorldPacks(live), query, opts);
}

/**
 * Read one full document from a compendium pack over the socket:
 * `modifyDocument(type, "get", { query: { _id }, pack })`.
 *
 * NEEDS LIVE CONFIRMATION on 14.370 — the "get" action is verified in an
 * independent implementation (Pelmog/foundry-mcp, v13-tested) and in the
 * v13/v14 type definitions, but has not been run against this server.
 * If the server rejects it, the thrown error is the diagnosis.
 */
export async function getPackDocument(
  live: FoundryLive,
  type: string,
  packId: string,
  docId: string,
): Promise<Record<string, unknown>> {
  const docs = await live.modifyDocument(type, "get", {
    query: { _id: docId },
    pack: packId,
  });
  const doc = docs[0];
  if (!doc || typeof doc !== "object") {
    throw new Error(
      `No ${type} document ${docId} in pack ${packId} (server returned ${docs.length} result(s)).`,
    );
  }
  return doc as Record<string, unknown>;
}

/**
 * Read a pack's index straight from the server (rather than the copy in
 * the `world` payload). Use when the cached index looks incomplete.
 */
export async function getPackIndex(
  live: FoundryLive,
  type: string,
  packId: string,
): Promise<PackIndexEntry[]> {
  const docs = await live.modifyDocument(type, "get", {
    query: {},
    pack: packId,
    index: true,
  });
  return docs as PackIndexEntry[];
}

/**
 * Import one compendium document as a world Actor: read it from the pack,
 * map it, create the Actor, then create its embedded items (the proven
 * two-step pattern from addChest). Returns the new world actor id.
 */
export async function importPackActor(
  live: FoundryLive,
  packId: string,
  docId: string,
  opts: MapActorOptions = {},
): Promise<ImportResult> {
  const doc = await getPackDocument(live, "Actor", packId, docId);
  const { actorData, items } = mapCompendiumActorToWorld(doc, opts);
  const created = await live.modifyDocument("Actor", "create", { data: [actorData] });
  const actorId = String(created[0]?._id ?? "");
  if (!actorId) throw new Error("Actor create returned no _id.");
  const itemIds: string[] = [];
  if (items.length > 0) {
    const made = await live.modifyDocument("Item", "create", {
      data: items,
      parentUuid: `Actor.${actorId}`,
    });
    itemIds.push(...made.map((d) => String(d._id)));
  }
  return {
    actorId,
    name: String(actorData.name ?? doc.name ?? ""),
    itemIds,
    source: { packId, docId },
  };
}
