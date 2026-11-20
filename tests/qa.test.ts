/**
 * Unit tests for the player Q&A pure functions (src/session/qa.ts).
 * No Foundry connection needed — run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  answerQuestion,
  findItem,
  parseQuestion,
  readAc,
  readHp,
  readInventory,
  readSpellsLeft,
} from "../src/session/qa.js";
import type { ActorSheet } from "../src/session/qa.js";

/** Fixture actor: Ezren, level 3 wizard (test data only). */
const EZREN: ActorSheet = {
  _id: "fixture-ezren",
  name: "Ezren",
  type: "character",
  system: {
    details: { level: { value: 3 } },
    attributes: {
      ac: { value: 16 },
      hp: { value: 21, max: 28 },
      perception: { value: 7 },
    },
    abilities: {
      str: { mod: 0 },
      dex: { mod: 2 },
      con: { mod: 1 },
      int: { mod: 4 },
      wis: { mod: 1 },
      cha: { mod: 0 },
    },
    saves: {
      fortitude: { value: 5 },
      reflex: { value: 7 },
      will: { value: 8 },
    },
    skills: { stealth: { mod: 5 }, arcana: { mod: 9 } },
    spellcasting: {
      entries: {
        arcane: {
          name: "Arcane",
          slots: {
            slot1: { max: 3, prepared: ["s1", "s2"] },
            slot2: { max: 2, prepared: [] },
          },
        },
      },
    },
  },
  items: [
    { _id: "i1", name: "Healing Potion (lesser)", type: "consumable", system: { quantity: 2 } },
    { _id: "i2", name: "Staff", type: "weapon", system: { quantity: 1 } },
    { _id: "i3", name: "Fireball", type: "spell", system: {} },
    { _id: "i4", name: "Magic Missile", type: "spell", system: {} },
  ],
};

const BARE: ActorSheet = { name: "Nameless", type: "character", system: {} };

describe("parseQuestion", () => {
  it("parses AC, HP, perception, level, saves", () => {
    expect(parseQuestion("what's my ac")?.intent).toBe("ac");
    expect(parseQuestion("armor class?")?.intent).toBe("ac");
    expect(parseQuestion("how much hp do I have")?.intent).toBe("hp");
    expect(parseQuestion("what's my perception")?.intent).toBe("perception");
    expect(parseQuestion("what level am I")?.intent).toBe("level");
    expect(parseQuestion("what are my saves")?.intent).toBe("saves");
  });

  it("parses inventory, has-item, and spells", () => {
    expect(parseQuestion("what do I have")?.intent).toBe("inventory");
    expect(parseQuestion("do I have a healing potion")?.intent).toBe("hasItem");
    expect(parseQuestion("do I have a healing potion")?.target).toBe("healing potion");
    expect(parseQuestion("how many spells left")?.intent).toBe("spells");
    expect(parseQuestion("can I cast fireball")?.intent).toBe("canCast");
    expect(parseQuestion("can I cast fireball")?.target).toBe("fireball");
  });

  it("parses abilities and skills", () => {
    expect(parseQuestion("what's my strength mod")?.intent).toBe("ability");
    expect(parseQuestion("what's my strength mod")?.stat).toBe("strength");
    expect(parseQuestion("what's my stealth bonus")?.intent).toBe("skill");
    expect(parseQuestion("what's my stealth bonus")?.stat).toBe("stealth");
  });

  it("returns null for non-questions", () => {
    expect(parseQuestion("hello there")).toBeNull();
    expect(parseQuestion("I attack the kobold")).toBeNull();
    expect(parseQuestion("")).toBeNull();
  });
});

describe("readers", () => {
  it("reads AC, HP, perception, level, saves", () => {
    expect(readAc(EZREN)).toBe(16);
    expect(readHp(EZREN)).toEqual({ value: 21, max: 28 });
    expect(readHp({ ...EZREN, system: { ...EZREN.system, attributes: { ...(EZREN.system as Record<string, unknown>).attributes as Record<string, unknown>, hp: { value: 5, max: 10, temp: 3 } } } })).toEqual({ value: 5, max: 10, temp: 3 });
    expect(readAc(BARE)).toBeUndefined();
    expect(readHp(BARE)).toBeUndefined();
  });

  it("reads inventory without spells, and finds items by partial name", () => {
    const inv = readInventory(EZREN);
    expect(inv.map((i) => i.name)).toEqual(["Healing Potion (lesser)", "Staff"]);
    expect(findItem(EZREN, "healing potion")?.quantity).toBe(2);
    expect(findItem(EZREN, "longsword")).toBeUndefined();
  });

  it("reads spell slots left in both slot shapes", () => {
    const slots = readSpellsLeft(EZREN);
    expect(slots).toEqual([
      { entry: "Arcane", rank: 1, remaining: 1, max: 3 },
      { entry: "Arcane", rank: 2, remaining: 2, max: 2 },
    ]);
  });

  it("reads value/max slot shape too", () => {
    const actor: ActorSheet = {
      name: "Kyra",
      type: "character",
      system: {
        spellcasting: {
          entries: {
            divine: { name: "Divine", slots: { slot1: { max: 2, value: 0 } } },
          },
        },
      },
    };
    expect(readSpellsLeft(actor)).toEqual([
      { entry: "Divine", rank: 1, remaining: 0, max: 2 },
    ]);
  });
});

describe("answerQuestion", () => {
  it("answers AC, HP, perception, level, saves", () => {
    expect(answerQuestion(EZREN, "what's my ac")).toContain("AC 16");
    expect(answerQuestion(EZREN, "how much hp")).toContain("21/28 HP");
    expect(answerQuestion(EZREN, "what's my perception")).toContain("Perception +7");
    expect(answerQuestion(EZREN, "what level am I")).toContain("level 3");
    expect(answerQuestion(EZREN, "saves")).toContain("Fortitude +5");
    expect(answerQuestion(EZREN, "saves")).toContain("Reflex +7");
    expect(answerQuestion(EZREN, "saves")).toContain("Will +8");
  });

  it("answers abilities and skills with signs", () => {
    expect(answerQuestion(EZREN, "what's my int mod")).toContain("intelligence +4");
    expect(answerQuestion(EZREN, "what's my stealth")).toContain("stealth +5");
  });

  it("answers inventory and has-item", () => {
    const inv = answerQuestion(EZREN, "what do I have");
    expect(inv).toContain("Healing Potion (lesser) ×2");
    expect(inv).toContain("Staff");
    expect(inv).not.toContain("Fireball");
    expect(answerQuestion(EZREN, "do I have a healing potion")).toContain("Yes");
    expect(answerQuestion(EZREN, "do I have a longsword")).toContain("doesn't seem to have");
  });

  it("answers spells left and can-cast", () => {
    const spells = answerQuestion(EZREN, "how many spells left");
    expect(spells).toContain("Rank 1: 1/3 left");
    expect(spells).toContain("Rank 2: 2/2 left");
    expect(answerQuestion(EZREN, "can I cast fireball")).toContain("knows Fireball");
    expect(answerQuestion(EZREN, "can I cast lightning bolt")).toContain("doesn't seem to know");
  });

  it("says so instead of inventing when the sheet lacks the field", () => {
    expect(answerQuestion(BARE, "what's my ac")).toContain("can't find an AC");
    expect(answerQuestion(BARE, "how much hp")).toContain("can't find HP");
    expect(answerQuestion(BARE, "what do I have")).toContain("carrying nothing");
    expect(answerQuestion(BARE, "how many spells left")).toContain("no spell slots");
  });

  it("declines questions it can't parse", () => {
    expect(answerQuestion(EZREN, "tell me a joke")).toContain("don't know how to answer");
  });
});
