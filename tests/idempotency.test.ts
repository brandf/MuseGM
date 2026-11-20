/**
 * Tests for the idempotency helpers (src/idempotency.ts) — the pure core
 * of the retry-safety work. No Foundry connection, no network.
 */
import { describe, expect, test } from "bun:test";
import {
  FLAG_FIELDS,
  FLAG_SCOPE,
  dedupeKeyFor,
  docHasFlag,
  findDocByFlag,
  findMessageByDedupeKey,
  flagValue,
  hashStringToSeed,
  messageHasDedupeKey,
  rngFromSeed,
} from "../src/idempotency.js";

describe("hashStringToSeed", () => {
  test("is deterministic for the same input", () => {
    expect(hashStringToSeed("encounter-7")).toBe(hashStringToSeed("encounter-7"));
  });
  test("differs for different inputs", () => {
    expect(hashStringToSeed("encounter-7")).not.toBe(hashStringToSeed("encounter-8"));
  });
  test("returns a non-negative integer in range", () => {
    const seed = hashStringToSeed("anything");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 32);
  });
  test("handles the empty string", () => {
    expect(hashStringToSeed("")).toBe(0x811c9dc5);
  });
});

describe("rngFromSeed", () => {
  test("same seed reproduces the same stream", () => {
    const a = rngFromSeed(42);
    const b = rngFromSeed(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  test("different seeds diverge", () => {
    const a = rngFromSeed(1);
    const b = rngFromSeed(2);
    expect(a()).not.toBe(b());
  });
  test("stays in [0, 1)", () => {
    const rng = rngFromSeed(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  test("a seeded roll is reproducible end-to-end (d20 via mulberry32)", () => {
    // 1d20 from a seed: floor(rng() * 20) + 1. Two runs must agree.
    const roll = (seed: number) => Math.floor(rngFromSeed(seed)() * 20) + 1;
    expect(roll(hashStringToSeed("demo-1:init:tok-9"))).toBe(
      roll(hashStringToSeed("demo-1:init:tok-9")),
    );
  });
});

describe("dedupeKeyFor", () => {
  test("joins parts with ':'", () => {
    expect(dedupeKeyFor("demo-1", "chat", 3)).toBe("demo-1:chat:3");
  });
  test("a single part is itself", () => {
    expect(dedupeKeyFor("demo-1")).toBe("demo-1");
  });
});

describe("flagValue / docHasFlag / findDocByFlag", () => {
  test("flagValue builds the scoped nested object", () => {
    expect(flagValue(FLAG_FIELDS.sceneBuild, "room-1")).toEqual({
      [FLAG_SCOPE]: { [FLAG_FIELDS.sceneBuild]: "room-1" },
    });
  });
  test("docHasFlag matches a doc carrying the flag", () => {
    const doc = { _id: "s1", flags: { [FLAG_SCOPE]: { [FLAG_FIELDS.sceneBuild]: "room-1" } } };
    expect(docHasFlag(doc, FLAG_FIELDS.sceneBuild, "room-1")).toBe(true);
  });
  test("docHasFlag rejects a different key value", () => {
    const doc = { _id: "s1", flags: { [FLAG_SCOPE]: { [FLAG_FIELDS.sceneBuild]: "room-1" } } };
    expect(docHasFlag(doc, FLAG_FIELDS.sceneBuild, "room-2")).toBe(false);
  });
  test("docHasFlag is false when flags are absent or the scope is missing", () => {
    expect(docHasFlag({ _id: "s1" }, FLAG_FIELDS.sceneBuild, "room-1")).toBe(false);
    expect(docHasFlag({ _id: "s1", flags: {} }, FLAG_FIELDS.sceneBuild, "room-1")).toBe(false);
    expect(docHasFlag({ _id: "s1", flags: null }, FLAG_FIELDS.sceneBuild, "room-1")).toBe(false);
  });
  test("docHasFlag does not match another scope's same-named key", () => {
    const doc = { _id: "s1", flags: { other: { [FLAG_FIELDS.sceneBuild]: "room-1" } } };
    expect(docHasFlag(doc, FLAG_FIELDS.sceneBuild, "room-1")).toBe(false);
  });
  test("findDocByFlag returns the first matching doc, or undefined", () => {
    const docs = [
      { _id: "s1", flags: { [FLAG_SCOPE]: { [FLAG_FIELDS.sceneBuild]: "room-1" } } },
      { _id: "s2", flags: { [FLAG_SCOPE]: { [FLAG_FIELDS.sceneBuild]: "room-2" } } },
    ];
    expect(findDocByFlag(docs, FLAG_FIELDS.sceneBuild, "room-2")?._id).toBe("s2");
    expect(findDocByFlag(docs, FLAG_FIELDS.sceneBuild, "room-9")).toBeUndefined();
  });
  test("findDocByFlag works on docs without flags (no throw)", () => {
    const docs = [{ _id: "s1" }, { _id: "s2", flags: null }];
    expect(findDocByFlag(docs, FLAG_FIELDS.sceneBuild, "room-1")).toBeUndefined();
  });
  test("FLAG_FIELDS covers the keyed operations", () => {
    for (const field of ["chatDedupe", "tokenPlace", "combatEncounter", "sceneBuild", "chest"] as const) {
      expect(typeof FLAG_FIELDS[field]).toBe("string");
    }
    // No two fields collide — a token key must never match a chest key.
    const values = Object.values(FLAG_FIELDS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("messageHasDedupeKey / findMessageByDedupeKey", () => {
  const key = "demo-1:announce";
  const mine = {
    id: "m1",
    content: "hello",
    author: "74bQ3Z3siKIJsXF2",
    flags: { [FLAG_SCOPE]: { [FLAG_FIELDS.chatDedupe]: key } },
  };
  const otherAuthor = {
    id: "m2",
    content: "hello",
    author: "G4LfGOoX5ex27D5B",
    flags: { [FLAG_SCOPE]: { [FLAG_FIELDS.chatDedupe]: key } },
  };
  const unkeyed = { id: "m3", content: "hello", author: "74bQ3Z3siKIJsXF2" };

  test("messageHasDedupeKey matches only the same key AND the same author", () => {
    expect(messageHasDedupeKey(mine, key, mine.author)).toBe(true);
    expect(messageHasDedupeKey(otherAuthor, key, mine.author)).toBe(false);
    expect(messageHasDedupeKey(unkeyed, key, mine.author)).toBe(false);
  });
  test("messageHasDedupeKey without an author argument matches on key alone", () => {
    expect(messageHasDedupeKey(otherAuthor, key)).toBe(true);
    expect(messageHasDedupeKey(unkeyed, key)).toBe(false);
  });
  test("findMessageByDedupeKey finds the message, scoped by author", () => {
    const docs = [unkeyed, otherAuthor, mine];
    expect(findMessageByDedupeKey(docs, key, mine.author)?.id).toBe("m1");
    expect(findMessageByDedupeKey(docs, key, "G4LfGOoX5ex27D5B")?.id).toBe("m2");
    expect(findMessageByDedupeKey(docs, "nope", mine.author)).toBeUndefined();
  });
});
