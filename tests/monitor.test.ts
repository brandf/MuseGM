/**
 * Unit tests for the monitor's pure functions (src/session/monitor.ts).
 * No Foundry connection needed — run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  classifyMessage,
  combatAnnouncements,
  parseQuestion,
  stripHtml,
} from "../src/session/monitor.js";
import type { ChatMessage } from "../src/types.js";
import type { CombatStatus } from "../src/session/autopilot.js";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    author: "author-1",
    content: "hello",
    style: 1,
    timestamp: 0,
    ...partial,
  };
}

function combatStatus(partial: Partial<CombatStatus>): CombatStatus {
  return {
    combatId: "c1",
    sceneId: "s1",
    round: 1,
    turn: 0,
    active: true,
    combatants: [
      {
        combatantId: "cb1",
        tokenId: "t1",
        actorId: "a1",
        name: "Merisiel",
        initiative: 15,
        hp: 20,
        hpMax: 20,
        defeated: false,
        disposition: 1,
        isEnemy: false,
      },
      {
        combatantId: "cb2",
        tokenId: "t2",
        actorId: "a2",
        name: "Kobold",
        initiative: 8,
        hp: 11,
        hpMax: 11,
        defeated: false,
        disposition: -1,
        isEnemy: true,
      },
    ],
    current: null,
    ...partial,
  };
}

describe("stripHtml", () => {
  it("strips tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
    expect(stripHtml("  a   b  ")).toBe("a b");
    expect(stripHtml("&lt;tag&gt; &amp; co")).toBe("<tag> & co");
  });

  it("is empty for markup-only content", () => {
    expect(stripHtml("<img src='x.png'>")).toBe("");
    expect(stripHtml("")).toBe("");
  });
});

describe("classifyMessage", () => {
  const ownId = "own-user";

  it("own messages by author never wake the monitor", () => {
    expect(classifyMessage(msg({ author: ownId }), ownId, "Meroki")).toBe("own");
  });

  it("own messages by speaker alias never wake the monitor", () => {
    expect(
      classifyMessage(
        msg({ author: "someone-else", speaker: { alias: "Meroki" } }),
        ownId,
        "Meroki",
      ),
    ).toBe("own");
  });

  it("empty messages are noise", () => {
    expect(classifyMessage(msg({ content: "   " }), ownId, "Meroki")).toBe("noise");
    expect(classifyMessage(msg({ content: "<p></p>" }), ownId, "Meroki")).toBe("noise");
  });

  it("roll requests route to roll", () => {
    expect(classifyMessage(msg({ content: "roll 1d20+5" }), ownId, "Meroki")).toBe("roll");
    expect(classifyMessage(msg({ content: "1d20" }), ownId, "Meroki")).toBe("roll");
  });

  it("data questions route to question", () => {
    expect(classifyMessage(msg({ content: "whose turn is it?" }), ownId, "Meroki")).toBe(
      "question",
    );
    expect(classifyMessage(msg({ content: "what is Ezren's hp?" }), ownId, "Meroki")).toBe(
      "question",
    );
  });

  it("everything else is chat (needs a Muse, logged and skipped)", () => {
    expect(classifyMessage(msg({ content: "nice hit!" }), ownId, "Meroki")).toBe("chat");
    expect(classifyMessage(msg({ content: "Meroki, open the chest" }), ownId, "Meroki")).toBe(
      "chat",
    );
    expect(classifyMessage(msg({ content: "roll the barrel down the hill" }), ownId, "Meroki")).toBe(
      "chat",
    );
  });

  it("a roll request from another alias is still a roll", () => {
    expect(
      classifyMessage(msg({ content: "roll 1d20", speaker: { alias: "Dave" } }), ownId, "Meroki"),
    ).toBe("roll");
  });
});

describe("parseQuestion", () => {
  it("turn and round", () => {
    expect(parseQuestion("whose turn is it?")).toEqual({ kind: "turn" });
    expect(parseQuestion("who's turn is it")).toEqual({ kind: "turn" });
    expect(parseQuestion("what round is it?")).toEqual({ kind: "round" });
    expect(parseQuestion("which round are we on")).toEqual({ kind: "round" });
  });

  it("hp in all shapes", () => {
    expect(parseQuestion("what is Ezren's hp?")).toEqual({ kind: "hp", name: "Ezren" });
    expect(parseQuestion("how much hp does Merisiel have")).toEqual({
      kind: "hp",
      name: "Merisiel",
    });
    expect(parseQuestion("Kyra's hp")).toEqual({ kind: "hp", name: "Kyra" });
    expect(parseQuestion("hp of Valeros")).toEqual({ kind: "hp", name: "Valeros" });
  });

  it("ac and initiative", () => {
    expect(parseQuestion("what is Ezren's ac?")).toEqual({ kind: "ac", name: "Ezren" });
    expect(parseQuestion("what's Kyra's armor class")).toEqual({ kind: "ac", name: "Kyra" });
    expect(parseQuestion("ac of Valeros")).toEqual({ kind: "ac", name: "Valeros" });
    expect(parseQuestion("what is Merisiel's initiative?")).toEqual({
      kind: "initiative",
      name: "Merisiel",
    });
  });

  it("scene", () => {
    expect(parseQuestion("where are we?")).toEqual({ kind: "scene" });
    expect(parseQuestion("what scene are we on")).toEqual({ kind: "scene" });
  });

  it("returns null for non-questions and near misses", () => {
    expect(parseQuestion("I love this game")).toBeNull();
    expect(parseQuestion("what is the plan?")).toBeNull();
    expect(parseQuestion("whose sword is this")).toBeNull();
    expect(parseQuestion("")).toBeNull();
  });
});

describe("combatAnnouncements", () => {
  it("announces a turn change", () => {
    const prev = combatStatus({ turn: 0, round: 1, current: null });
    const next = combatStatus({
      turn: 1,
      round: 1,
      current: {
        combatantId: "cb2",
        tokenId: "t2",
        actorId: "a2",
        name: "Kobold",
        initiative: 8,
        hp: 11,
        hpMax: 11,
        defeated: false,
        disposition: -1,
        isEnemy: true,
      },
    });
    const lines = combatAnnouncements(prev, next);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Round 1, turn 2/2");
    expect(lines[0]).toContain("Kobold");
    expect(lines[0]).toContain("HP 11/11");
  });

  it("announces a round wrap as a turn change", () => {
    const prev = combatStatus({ turn: 1, round: 1 });
    const next = combatStatus({
      turn: 0,
      round: 2,
      current: {
        combatantId: "cb1",
        tokenId: "t1",
        actorId: "a1",
        name: "Merisiel",
        initiative: 15,
        hp: 20,
        hpMax: 20,
        defeated: false,
        disposition: 1,
        isEnemy: false,
      },
    });
    expect(combatAnnouncements(prev, next)).toHaveLength(1);
  });

  it("says nothing when nothing changed", () => {
    const prev = combatStatus({});
    const next = combatStatus({});
    expect(combatAnnouncements(prev, next)).toEqual([]);
  });

  it("does NOT announce HP drops or downs — that is the autopilot's job", () => {
    const prev = combatStatus({});
    const next = combatStatus({
      combatants: [
        {
          combatantId: "cb1",
          tokenId: "t1",
          actorId: "a1",
          name: "Merisiel",
          initiative: 15,
          hp: 0,
          hpMax: 20,
          defeated: false,
          disposition: 1,
          isEnemy: false,
        },
        {
          combatantId: "cb2",
          tokenId: "t2",
          actorId: "a2",
          name: "Kobold",
          initiative: 8,
          hp: 11,
          hpMax: 11,
          defeated: false,
          disposition: -1,
          isEnemy: true,
        },
      ],
    });
    expect(combatAnnouncements(prev, next)).toEqual([]);
  });

  it("does NOT announce combat start or end", () => {
    expect(combatAnnouncements(null, combatStatus({}))).toEqual([]);
    expect(combatAnnouncements(combatStatus({}), null)).toEqual([]);
    // A different combat id is a new combat, not a turn change.
    expect(
      combatAnnouncements(combatStatus({}), combatStatus({ combatId: "c2" })),
    ).toEqual([]);
  });
});
