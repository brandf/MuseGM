/**
 * Unit tests for the dice-on-demand pure functions (src/session/dice.ts).
 * No Foundry connection needed — run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  firstDieResult,
  formatGroupCheckResult,
  formatRollResult,
  parseRollRequest,
} from "../src/session/dice.js";

describe("parseRollRequest", () => {
  it("parses a plain roll", () => {
    const r = parseRollRequest("roll 1d20+5");
    expect(r).not.toBeNull();
    expect(r!.formula).toBe("1d20+5");
    expect(r!.secret).toBe(false);
    expect(r!.group).toBe(false);
  });

  it("parses /roll and a bare formula", () => {
    expect(parseRollRequest("/roll 2d6 fireball")?.formula).toBe("2d6");
    expect(parseRollRequest("/roll 2d6 fireball")?.flavor).toBe("fireball");
    expect(parseRollRequest("1d20+5")?.formula).toBe("1d20+5");
    expect(parseRollRequest("d20")?.formula).toBe("d20");
  });

  it("parses spaced formulas and strips trailing punctuation", () => {
    expect(parseRollRequest("roll 1d20 + 5")?.formula).toBe("1d20+5");
    expect(parseRollRequest("roll 1d20+5!")?.formula).toBe("1d20+5");
  });

  it("pulls 'for <Name>' out as the actor", () => {
    const r = parseRollRequest("roll 1d20+5 for Ezren to hit");
    expect(r?.actorName).toBe("Ezren");
    expect(r?.flavor).toBe("to hit");
  });

  it("detects secret rolls", () => {
    expect(parseRollRequest("secret roll 1d20+3")?.secret).toBe(true);
    expect(parseRollRequest("roll secretly 1d20")?.secret).toBe(true);
    expect(parseRollRequest("gm roll 1d20")?.secret).toBe(true);
    expect(parseRollRequest("roll 1d20")?.secret).toBe(false);
  });

  it("detects group checks", () => {
    const r = parseRollRequest("group check 1d20+2 perception");
    expect(r?.group).toBe(true);
    expect(r?.formula).toBe("1d20+2");
    expect(r?.flavor).toBe("perception");
    expect(parseRollRequest("everyone roll 1d20")?.group).toBe(true);
    expect(parseRollRequest("party roll 1d20+3")?.group).toBe(true);
  });

  it("rejects non-requests", () => {
    expect(parseRollRequest("roll the barrel down the hill")).toBeNull();
    expect(parseRollRequest("I rolled out of bed")).toBeNull();
    expect(parseRollRequest("roll")).toBeNull();
    expect(parseRollRequest("hello there")).toBeNull();
    expect(parseRollRequest("")).toBeNull();
  });

  it("hands unsupported formulas to the roller (which rejects them)", () => {
    // The parser only extracts; the roller's grammar is the validator.
    // "4d6kh3" parses here so rollForChat can report the roller's error.
    expect(parseRollRequest("roll 4d6kh3")?.formula).toBe("4d6kh3");
  });
});

describe("firstDieResult", () => {
  it("reads the local roller's bracket form", () => {
    expect(firstDieResult("1d20: [17] + 5 = 22")).toBe(17);
    expect(firstDieResult("2d6: [3, 5] + 1d4: [2] = 12")).toBe(3);
  });

  it("reads the server roller's plain form", () => {
    expect(firstDieResult("17 + 5")).toBe(17);
  });

  it("returns null with no dice", () => {
    expect(firstDieResult("5")).toBeNull();
    expect(firstDieResult("")).toBeNull();
  });
});

describe("formatRollResult", () => {
  it("formats a plain roll without duplicating the total", () => {
    expect(
      formatRollResult({ formula: "1d20+5", total: 22, breakdown: "1d20: [17] + 5 = 22" }),
    ).toBe("🎲 1d20+5 = **22** (1d20: [17] + 5)");
  });

  it("adds actor and flavor", () => {
    expect(
      formatRollResult(
        { formula: "1d20+5", total: 22, breakdown: "1d20: [17] + 5 = 22" },
        { actorName: "Ezren", flavor: "to hit" },
      ),
    ).toBe("🎲 **Ezren** rolls to hit: 1d20+5 = **22** (1d20: [17] + 5)");
  });

  it("calls out natural 20 and natural 1 on a single d20", () => {
    expect(
      formatRollResult({ formula: "1d20", total: 20, breakdown: "1d20: [20] = 20" }),
    ).toContain("🌟 **Natural 20!**");
    expect(
      formatRollResult({ formula: "1d20", total: 1, breakdown: "1d20: [1] = 1" }),
    ).toContain("💥 **Natural 1!**");
    expect(
      formatRollResult({ formula: "2d20", total: 25, breakdown: "2d20: [20, 5] = 25" }),
    ).not.toContain("Natural");
  });
});

describe("formatGroupCheckResult", () => {
  it("sorts best first and marks crits", () => {
    const text = formatGroupCheckResult(
      [
        { name: "Kyra", total: 12, breakdown: "1d20: [10] + 2 = 12" },
        { name: "Ezren", total: 22, breakdown: "1d20: [20] + 2 = 22" },
        { name: "Valeros", total: 5, breakdown: "1d20: [1] + 4 = 5" },
      ],
      "Perception",
    );
    expect(text).toContain("**Group check — Perception** — 3 rolls, best: **Ezren** (22)");
    const lines = text.split("\n");
    expect(lines[1]).toContain("**Ezren**: 22 🌟");
    expect(lines[2]).toContain("**Kyra**: 12");
    expect(lines[3]).toContain("**Valeros**: 5 💥");
  });

  it("handles an empty party", () => {
    expect(formatGroupCheckResult([], "Perception")).toContain("no player characters found");
  });
});
