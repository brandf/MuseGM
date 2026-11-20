/**
 * Unit tests for the turn-reminder pure functions (src/session/reminders.ts).
 * No Foundry connection needed — run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  buildTurnReminder,
  formatConditions,
  hpStatus,
} from "../src/session/reminders.js";

describe("hpStatus", () => {
  it("bands the ratio", () => {
    expect(hpStatus(25, 25)).toBe("unhurt");
    expect(hpStatus(20, 25)).toBe("lightly hurt");
    expect(hpStatus(13, 25)).toBe("hurt");
    expect(hpStatus(7, 25)).toBe("badly hurt");
    expect(hpStatus(3, 25)).toBe("barely standing");
    expect(hpStatus(0, 25)).toBe("down (0 HP)");
  });

  it("says unknown when there is no max", () => {
    expect(hpStatus(5, 0)).toBe("HP unknown");
  });
});

describe("formatConditions", () => {
  it("formats one condition with its expiry", () => {
    expect(formatConditions([{ statusId: "Frightened 1", expiresRound: 3 }])).toBe(
      "*Frightened 1* (until round 3)",
    );
  });

  it("joins several and returns empty for none", () => {
    expect(
      formatConditions([
        { statusId: "Frightened 1", expiresRound: 3 },
        { statusId: "Sickened 1", expiresRound: 2 },
      ]),
    ).toBe("*Frightened 1* (until round 3), *Sickened 1* (until round 2)");
    expect(formatConditions([])).toBe("");
  });
});

describe("buildTurnReminder", () => {
  const base = {
    name: "Merisiel",
    round: 2,
    turn: 3,
    total: 5,
    hp: 11,
    hpMax: 25,
    isEnemy: false,
    conditions: [{ statusId: "Frightened 1", expiresRound: 3 }],
  };

  it("reminds a player with HP, conditions, and the action hint", () => {
    const text = buildTurnReminder(base);
    expect(text).toContain("**Merisiel**, your turn!");
    expect(text).toContain("Round 2, turn 3/5");
    expect(text).toContain("HP 11/25");
    expect(text).toContain("badly hurt");
    expect(text).toContain("Frightened 1");
    expect(text).toContain("3 actions");
  });

  it("omits the conditions line when there are none", () => {
    const text = buildTurnReminder({ ...base, conditions: [] });
    expect(text).not.toContain("Conditions:");
    expect(text).toContain("your turn!");
  });

  it("gives enemies a short GM-facing line, no action hint", () => {
    const text = buildTurnReminder({ ...base, name: "Xulgath", isEnemy: true });
    expect(text).toContain("**Xulgath**");
    expect(text).not.toContain("your turn!");
    expect(text).not.toContain("3 actions");
  });

  it("gives a downed combatant a 'you are down' line, not actions", () => {
    const text = buildTurnReminder({ ...base, hp: 0 });
    expect(text).toContain("is down (0 HP)");
    expect(text).not.toContain("3 actions");
  });
});
