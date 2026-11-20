/**
 * Unit tests for the session-recap pure functions (src/session/recap.ts).
 * No Foundry connection needed — run with `bun test`.
 *
 * The fixture log is modeled on the Nov 19 session (Merisiel vs Xulgath,
 * Valeros joining, a chest) — it IS the test data, so extraction from it
 * is honest by construction.
 */
import { describe, expect, it } from "bun:test";
import { buildRecap, plainText, recapToJournalHtml, recapToText } from "../src/session/recap.js";
import type { ChatMessage } from "../src/types.js";

function msg(
  id: string,
  alias: string | undefined,
  content: string,
  style = 1,
): ChatMessage {
  return {
    id,
    author: alias === "Meroki" ? "74bQ3Z3siKIJsXF2" : "KpemqVj5YCznuMRK",
    speaker: alias ? { alias } : undefined,
    content,
    style,
    timestamp: 1000,
  };
}

const FIXTURE_LOG: ChatMessage[] = [
  msg("m1", "Meroki", "🏰 **Lich's Lair — Entry Hall**\nA cold hall, fog on the floor."),
  msg("m2", "Dave", "ok everyone roll initiative"),
  msg("m3", "Meroki", "➡️ Round 1, turn 1/3: **Merisiel** (HP 25/25)"),
  msg("m4", "Meroki", "🎲 **Merisiel** rolls Rapier: 1d20+5 = **20** (1d20: [20] + 5 = 25) — 🌟 **Natural 20!**"),
  msg("m5", "Meroki", "💀 **Merisiel** is down! (0 HP)"),
  msg("m6", "Brandon", "ouch, that hurt"),
  msg("m7", "Meroki", "💰 **Valeros** takes: 50 gp; Healing Potion (lesser)."),
  msg("m8", "Meroki", "🏆 **Combat over!** All enemies are down."),
  msg("m9", "Dave", "great session, same time next week?"),
];

describe("plainText", () => {
  it("strips tags and collapses whitespace", () => {
    expect(plainText("<b>Hello</b>   <i>world</i>")).toBe("Hello world");
    expect(plainText("a &amp; b")).toBe("a & b");
  });
});

describe("buildRecap", () => {
  const recap = buildRecap(FIXTURE_LOG, { title: "Test session", date: "2026-11-19" });

  it("extracts the room entry", () => {
    expect(recap.rooms).toHaveLength(1);
    expect(recap.rooms[0].text).toContain("Lich's Lair");
  });

  it("extracts the down, not the player's 'ouch'", () => {
    expect(recap.kills).toHaveLength(1);
    expect(recap.kills[0].text).toContain("Merisiel");
    expect(recap.kills[0].messageId).toBe("m5");
  });

  it("counts combat milestones and the round count", () => {
    expect(recap.combat.some((e) => e.text === "Combat ended.")).toBe(true);
    expect(recap.combat.some((e) => e.text.includes("1 round"))).toBe(true);
  });

  it("extracts the natural 20", () => {
    expect(recap.notableRolls).toHaveLength(1);
    expect(recap.notableRolls[0].text).toContain("natural 20");
  });

  it("extracts the loot line", () => {
    expect(recap.loot).toHaveLength(1);
    expect(recap.loot[0].messageId).toBe("m7");
  });

  it("does not turn player chatter into events", () => {
    const texts = recap.events.map((e) => e.text).join(" ");
    expect(texts).not.toContain("same time next week");
    expect(texts).not.toContain("ouch");
  });

  it("reports the message count it was built from", () => {
    expect(recap.messageCount).toBe(FIXTURE_LOG.length);
  });

  it("says nothing notable for a quiet log", () => {
    const quiet = buildRecap([msg("q1", "Dave", "hello all")]);
    expect(quiet.events).toHaveLength(0);
    expect(recapToText(quiet)).toContain("Nothing notable");
    expect(recapToJournalHtml(quiet)).toContain("Nothing notable");
  });

  it("ignores a down line from a player (only Meroki announcements count)", () => {
    const log = buildRecap([msg("x1", "Dave", "the kobold is down!")]);
    expect(log.kills).toHaveLength(0);
  });
});

describe("recapToText", () => {
  it("renders sections in order with the title and date", () => {
    const text = recapToText(buildRecap(FIXTURE_LOG, { title: "Test", date: "2026-11-19" }));
    expect(text).toContain("**Test** — 2026-11-19");
    expect(text.indexOf("🏰 Rooms")).toBeLessThan(text.indexOf("💀 Downs"));
    expect(text.indexOf("💀 Downs")).toBeLessThan(text.indexOf("💰 Loot"));
  });
});

describe("recapToJournalHtml", () => {
  it("escapes content and renders headings", () => {
    const html = recapToJournalHtml(buildRecap(FIXTURE_LOG, { title: "Test <b>", date: "2026-11-19" }));
    expect(html).toContain("<h1>Test &lt;b&gt;</h1>");
    expect(html).toContain("<h2>Downs</h2>");
  });
});
