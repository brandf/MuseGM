/**
 * Unit tests for the compendium import module (pure functions only —
 * no Foundry connection). Fixtures stand in for pack index entries and
 * full PF2e NPC documents.
 */
import { describe, test, expect } from "bun:test";
import {
  DRACOLICH_DRAFT,
  applyDracolichPatch,
  findPackEntry,
  listPacks,
  mapCompendiumActorToWorld,
  searchPackIndex,
  type PackInfo,
} from "../src/session/compendium.js";

const PACKS: PackInfo[] = [
  {
    id: "pf2e.bestiaries",
    label: "Bestiary",
    type: "Actor",
    system: "pf2e",
    packageType: "system",
    packageName: "pf2e",
    index: [
      { _id: "lich00000000001", name: "Lich", type: "npc", img: "lich.webp" },
      { _id: "drag00000000001", name: "Adult Red Dragon", type: "npc", img: "dragon.webp" },
      { _id: "kobold000000001", name: "Kobold Warrior", type: "npc", img: "kobold.webp" },
    ],
  },
  {
    id: "pf2e.spells-srd",
    label: "Spells",
    type: "Item",
    system: "pf2e",
    packageType: "system",
    packageName: "pf2e",
    index: [
      { _id: "spell0000000001", name: "Fireball", type: "spell", img: "fireball.webp" },
      { _id: "spell0000000002", name: "Lich's Touch", type: "spell", img: "touch.webp" },
    ],
  },
];

const LICH_DOC: Record<string, unknown> = {
  _id: "lich00000000001",
  name: "Lich",
  type: "npc",
  img: "lich.webp",
  folder: "packfolder123456",
  system: {
    details: { level: { value: 12 }, alignment: { value: "LE" }, creatureType: "Undead" },
    attributes: {
      hp: { value: 195, max: 195 },
      ac: { value: 33 },
      speed: { value: 25, otherSpeeds: [] },
    },
    perception: { mod: 24 },
    traits: { size: { value: "medium" }, rarity: "unique" },
  },
  prototypeToken: { name: "Lich", texture: { src: "lich.webp" } },
  items: [
    { _id: "strike0000000001", name: "Hand of the Lich", type: "melee", system: { bonus: { value: 26 } } },
    { _id: "spell0000000001", name: "Paralyzing Touch", type: "spell", system: {} },
  ],
};

describe("listPacks", () => {
  test("sorts by label and counts entries", () => {
    const out = listPacks(PACKS);
    expect(out.map((p) => p.id)).toEqual(["pf2e.bestiaries", "pf2e.spells-srd"]);
    expect(out[0].entries).toBe(3);
    expect(out[1].entries).toBe(2);
  });
});

describe("searchPackIndex", () => {
  test("exact match sorts first", () => {
    const out = searchPackIndex(PACKS, "lich");
    expect(out[0].entry.name).toBe("Lich");
    expect(out.map((h) => h.entry.name)).toContain("Lich's Touch");
  });
  test("case-insensitive substring", () => {
    expect(searchPackIndex(PACKS, "DRAGON").map((h) => h.entry.name)).toEqual([
      "Adult Red Dragon",
    ]);
  });
  test("type filter applies to entries and packs", () => {
    const out = searchPackIndex(PACKS, "lich", { type: "spell" });
    expect(out.map((h) => h.entry.name)).toEqual(["Lich's Touch"]);
  });
  test("pack filter scopes the search", () => {
    const out = searchPackIndex(PACKS, "lich", { packId: "pf2e.spells-srd" });
    expect(out).toHaveLength(1);
    expect(out[0].packId).toBe("pf2e.spells-srd");
  });
  test("limit is honored", () => {
    expect(searchPackIndex(PACKS, "a", { limit: 2 })).toHaveLength(2);
  });
  test("no match and empty query return empty", () => {
    expect(searchPackIndex(PACKS, "dracolich")).toEqual([]);
    expect(searchPackIndex(PACKS, "  ")).toEqual([]);
  });
  test("hit carries pack context", () => {
    const [hit] = searchPackIndex(PACKS, "Kobold Warrior");
    expect(hit.packId).toBe("pf2e.bestiaries");
    expect(hit.packLabel).toBe("Bestiary");
    expect(hit.entry._id).toBe("kobold000000001");
  });
});

describe("findPackEntry", () => {
  test("finds by pack + doc id", () => {
    const found = findPackEntry(PACKS, "pf2e.bestiaries", "lich00000000001");
    expect(found?.entry.name).toBe("Lich");
  });
  test("null for unknown pack or doc", () => {
    expect(findPackEntry(PACKS, "nope", "lich00000000001")).toBeNull();
    expect(findPackEntry(PACKS, "pf2e.bestiaries", "nope")).toBeNull();
  });
});

describe("mapCompendiumActorToWorld", () => {
  test("drops pack _id and folder, splits items", () => {
    const { actorData, items } = mapCompendiumActorToWorld(LICH_DOC);
    expect(actorData._id).toBeUndefined();
    expect(actorData.folder).toBeUndefined();
    expect(actorData.name).toBe("Lich");
    expect(actorData.type).toBe("npc");
    expect((actorData.system as { details: { level: { value: number } } }).details.level.value).toBe(12);
    expect(items).toHaveLength(2);
    expect(items[0]._id).toBeUndefined();
    expect(items[0].name).toBe("Hand of the Lich");
  });
  test("keepId preserves ids", () => {
    const { actorData, items } = mapCompendiumActorToWorld(LICH_DOC, { keepId: true });
    expect(actorData._id).toBe("lich00000000001");
    expect(items[0]._id).toBe("strike0000000001");
  });
  test("rename and folder options", () => {
    const { actorData } = mapCompendiumActorToWorld(LICH_DOC, {
      name: "Lich (Copy)",
      folder: "worldfolder9999",
    });
    expect(actorData.name).toBe("Lich (Copy)");
    expect(actorData.folder).toBe("worldfolder9999");
  });
  test("no items array yields empty items", () => {
    const { items } = mapCompendiumActorToWorld({ name: "Empty", type: "npc" });
    expect(items).toEqual([]);
  });
  test("rejects documents without name or type", () => {
    expect(() => mapCompendiumActorToWorld({ type: "npc" })).toThrow("no name");
    expect(() => mapCompendiumActorToWorld({ name: "X" })).toThrow("no type");
    expect(() => mapCompendiumActorToWorld(null as unknown as Record<string, unknown>)).toThrow();
  });
});

describe("applyDracolichPatch", () => {
  test("renames, retypes, adds flight and breath — base stats preserved", () => {
    const out = applyDracolichPatch(LICH_DOC);
    expect(out.name).toBe("Dracolich");
    const system = out.system as Record<string, any>;
    expect(system.details.creatureType).toBe("Dragon");
    expect(system.traits.size.value).toBe("large");
    expect(system.attributes.hp.value).toBe(195);
    expect(system.attributes.ac.value).toBe(33);
    expect(system.attributes.speed.otherSpeeds).toContainEqual({ type: "fly", value: 60 });
    const items = out.items as Record<string, any>[];
    expect(items).toHaveLength(3);
    expect(items[2].name).toBe("Necrotic Breath");
    expect(items[2].system.damageRolls[0].damageType).toBe("void");
  });
  test("does not mutate the input and does not duplicate flight", () => {
    const once = applyDracolichPatch(LICH_DOC);
    const twice = applyDracolichPatch(once);
    const speeds = (twice.system as Record<string, any>).attributes.speed.otherSpeeds;
    expect(speeds.filter((s: any) => s.type === "fly")).toHaveLength(1);
    expect((LICH_DOC.system as Record<string, any>).details.creatureType).toBe("Undead");
    expect(LICH_DOC.name).toBe("Lich");
  });
});

describe("DRACOLICH_DRAFT", () => {
  test("has the shape a world Actor create needs", () => {
    expect(DRACOLICH_DRAFT.name).toBe("Dracolich");
    expect(DRACOLICH_DRAFT.type).toBe("npc");
    const system = DRACOLICH_DRAFT.system as Record<string, any>;
    expect(system.details.level.value).toBe(12);
    expect(system.attributes.hp.max).toBe(210);
    expect(system.attributes.ac.value).toBe(32);
    const items = DRACOLICH_DRAFT.items as Record<string, any>[];
    expect(items.length).toBe(3);
    for (const item of items) {
      expect(item.system.damageRolls[0].damage).toBeTruthy();
      expect(item.system.damageRolls[0].damageType).toBeTruthy();
    }
  });
});
