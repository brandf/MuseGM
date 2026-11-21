/**
 * Unit tests for the downtime ledger pure functions (src/session/downtime.ts).
 * No Foundry connection needed — run with `bun test`.
 *
 * The fixture activities are demo data (a potion purchase, a sword
 * being crafted, a rest proposal), clearly labeled as such — the
 * honesty rule is tested, not violated, by them: activities without
 * sources are rejected, healing is proposed from the rest rules and
 * never applied, and the summary only reports what the ledger
 * contains.
 */
import { describe, expect, it } from "bun:test";
import {
  activityToText,
  advanceActivity,
  cancelActivity,
  characterLedger,
  completeActivity,
  confirmActivity,
  demoLedger,
  DowntimeError,
  downtimeIndexHtml,
  emptyLedger,
  getActivity,
  getRestRule,
  listActivities,
  listCharacters,
  parseLedger,
  proposeHealing,
  REST_RULES,
  serializeLedger,
  spentGp,
  startActivity,
  summarizeDowntime,
  type DowntimeLedger,
} from "../src/session/downtime.js";

const SOURCE = "Valeros asked in chat between sessions";

function demoInProgress(): DowntimeLedger {
  let ledger = emptyLedger("Menace Under Otari");
  ledger = startActivity(ledger, {
    kind: "shopping",
    character: "Valeros",
    title: "Buy a healing potion",
    costGp: 4,
    source: SOURCE,
    createdAt: "2026-11-20",
  }).ledger;
  ledger = confirmActivity(ledger, "valeros-buy-a-healing-potion").ledger;
  return ledger;
}

function demoCrafting(): DowntimeLedger {
  let ledger = emptyLedger();
  ledger = startActivity(ledger, {
    kind: "crafting",
    character: "Ezren",
    title: "Craft a +1 longsword",
    costGp: 35,
    days: 4,
    source: "Ezren asked in chat between sessions",
    createdAt: "2026-11-20",
  }).ledger;
  ledger = confirmActivity(ledger, "ezren-craft-a-1-longsword").ledger;
  return ledger;
}

describe("startActivity validation", () => {
  it("starts an activity as proposed with zero progress", () => {
    const { ledger, activity } = startActivity(emptyLedger(), {
      kind: "shopping",
      character: "Valeros",
      title: "Buy rope",
      costGp: 1,
      source: SOURCE,
    });
    expect(activity.status).toBe("proposed");
    expect(activity.progressDays).toBe(0);
    expect(activity.days).toBe(0);
    expect(activity.id).toBe("valeros-buy-rope");
    expect(ledger.activities).toHaveLength(1);
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      startActivity(emptyLedger(), {
        kind: "fishing" as never,
        character: "Valeros",
        title: "Go fishing",
        source: SOURCE,
      }),
    ).toThrow(DowntimeError);
  });

  it("rejects an empty character or title", () => {
    expect(() =>
      startActivity(emptyLedger(), {
        kind: "shopping",
        character: "  ",
        title: "Buy rope",
        source: SOURCE,
      }),
    ).toThrow(DowntimeError);
    expect(() =>
      startActivity(emptyLedger(), {
        kind: "shopping",
        character: "Valeros",
        title: "  ",
        source: SOURCE,
      }),
    ).toThrow(DowntimeError);
  });

  it("rejects a missing source", () => {
    expect(() =>
      startActivity(emptyLedger(), {
        kind: "shopping",
        character: "Valeros",
        title: "Buy rope",
        source: "  ",
      }),
    ).toThrow(DowntimeError);
  });

  it("rejects a negative cost and a non-whole day count", () => {
    expect(() =>
      startActivity(emptyLedger(), {
        kind: "shopping",
        character: "Valeros",
        title: "Buy rope",
        costGp: -1,
        source: SOURCE,
      }),
    ).toThrow(DowntimeError);
    expect(() =>
      startActivity(emptyLedger(), {
        kind: "crafting",
        character: "Ezren",
        title: "Craft a sword",
        days: 2.5,
        source: SOURCE,
      }),
    ).toThrow(DowntimeError);
  });

  it("rejects a crafting activity with 0 days", () => {
    for (const kind of ["crafting", "training", "research"] as const) {
      expect(() =>
        startActivity(emptyLedger(), {
          kind,
          character: "Ezren",
          title: `Do ${kind}`,
          days: 0,
          source: SOURCE,
        }),
      ).toThrow(DowntimeError);
    }
  });

  it("rejects a duplicate character + title", () => {
    let ledger = emptyLedger();
    ledger = startActivity(ledger, {
      kind: "shopping",
      character: "Valeros",
      title: "Buy rope",
      source: SOURCE,
    }).ledger;
    expect(() =>
      startActivity(ledger, {
        kind: "shopping",
        character: "Valeros",
        title: "Buy rope",
        source: SOURCE,
      }),
    ).toThrow(/already exists/);
  });

  it("does not mutate the input ledger", () => {
    const before = emptyLedger();
    startActivity(before, {
      kind: "shopping",
      character: "Valeros",
      title: "Buy rope",
      source: SOURCE,
    });
    expect(before.activities).toHaveLength(0);
  });
});

describe("confirm / complete / cancel lifecycle", () => {
  it("confirm moves proposed -> in-progress, and only from proposed", () => {
    const ledger = demoInProgress();
    const activity = getActivity(ledger, "valeros-buy-a-healing-potion")!;
    expect(activity.status).toBe("in-progress");
    expect(() => confirmActivity(ledger, "valeros-buy-a-healing-potion")).toThrow(DowntimeError);
  });

  it("complete on a proposed activity is an error — the GM gate cannot be skipped", () => {
    let ledger = emptyLedger();
    ledger = startActivity(ledger, {
      kind: "shopping",
      character: "Valeros",
      title: "Buy rope",
      source: SOURCE,
    }).ledger;
    expect(() =>
      completeActivity(ledger, "valeros-buy-rope", "Bought rope.", SOURCE),
    ).toThrow(/confirm it first/);
  });

  it("complete records the outcome and date; completing twice is a no-op", () => {
    let ledger = demoInProgress();
    const first = completeActivity(
      ledger,
      "valeros-buy-a-healing-potion",
      "Bought a minor healing potion (4 gp).",
      "GM confirmed the purchase in chat",
      "2026-11-20",
    );
    expect(first.activity.status).toBe("complete");
    expect(first.activity.outcome).toBe("Bought a minor healing potion (4 gp).");
    expect(first.activity.completedAt).toBe("2026-11-20");
    expect(first.alreadyCompleted).toBe(false);
    const second = completeActivity(
      first.ledger,
      "valeros-buy-a-healing-potion",
      "Bought it again.",
      SOURCE,
    );
    expect(second.alreadyCompleted).toBe(true);
    expect(second.activity.outcome).toBe("Bought a minor healing potion (4 gp).");
  });

  it("complete needs an outcome and a source", () => {
    const ledger = demoInProgress();
    expect(() =>
      completeActivity(ledger, "valeros-buy-a-healing-potion", "  ", SOURCE),
    ).toThrow(DowntimeError);
    expect(() =>
      completeActivity(ledger, "valeros-buy-a-healing-potion", "Bought it.", "  "),
    ).toThrow(DowntimeError);
  });

  it("completing keeps the original source and records the completion source separately", () => {
    const ledger = demoInProgress();
    const done = completeActivity(
      ledger,
      "valeros-buy-a-healing-potion",
      "Bought it.",
      "GM confirmed in chat",
    );
    expect(done.activity.source).toBe(SOURCE);
    expect(done.activity.completedSource).toBe("GM confirmed in chat");
    const roundTripped = parseLedger(serializeLedger(done.ledger));
    expect(getActivity(roundTripped, "valeros-buy-a-healing-potion")?.source).toBe(SOURCE);
    expect(getActivity(roundTripped, "valeros-buy-a-healing-potion")?.completedSource).toBe(
      "GM confirmed in chat",
    );
  });

  it("cancel works from proposed and in-progress; cancelling twice is a no-op; cancelling a completed activity is an error", () => {
    let ledger = emptyLedger();
    ledger = startActivity(ledger, {
      kind: "research",
      character: "Ezren",
      title: "Research the Lich",
      days: 2,
      source: SOURCE,
    }).ledger;
    const cancelled = cancelActivity(ledger, "ezren-research-the-lich", SOURCE);
    expect(cancelled.activity.status).toBe("cancelled");
    expect(cancelActivity(cancelled.ledger, "ezren-research-the-lich", SOURCE).alreadyCancelled).toBe(
      true,
    );

    let done = demoInProgress();
    done = completeActivity(done, "valeros-buy-a-healing-potion", "Bought it.", SOURCE).ledger;
    expect(() => cancelActivity(done, "valeros-buy-a-healing-potion", SOURCE)).toThrow(
      DowntimeError,
    );
    expect(() =>
      completeActivity(cancelled.ledger, "ezren-research-the-lich", "Finished.", SOURCE),
    ).toThrow(DowntimeError);
  });

  it("unknown ids are errors", () => {
    const ledger = emptyLedger();
    expect(() => confirmActivity(ledger, "nope")).toThrow(DowntimeError);
    expect(() => completeActivity(ledger, "nope", "Done.", SOURCE)).toThrow(DowntimeError);
    expect(() => cancelActivity(ledger, "nope", SOURCE)).toThrow(DowntimeError);
    expect(() => advanceActivity(ledger, "nope", 1, SOURCE)).toThrow(DowntimeError);
  });
});

describe("crafting progress persists across sessions", () => {
  it("advance adds up across calls and never resets", () => {
    let ledger = demoCrafting();
    const first = advanceActivity(ledger, "ezren-craft-a-1-longsword", 1, "Session 1 downtime");
    expect(first.activity.progressDays).toBe(1);
    expect(first.activity.status).toBe("in-progress");
    expect(first.becameReady).toBe(false);
    const second = advanceActivity(first.ledger, "ezren-craft-a-1-longsword", 2, "Session 2 downtime");
    expect(second.activity.progressDays).toBe(3);
    expect(second.activity.status).toBe("in-progress");
    expect(second.becameReady).toBe(false);
  });

  it("advance to the required days makes the activity ready", () => {
    let ledger = demoCrafting();
    ledger = advanceActivity(ledger, "ezren-craft-a-1-longsword", 3, "Session 1 downtime").ledger;
    const done = advanceActivity(ledger, "ezren-craft-a-1-longsword", 1, "Session 2 downtime");
    expect(done.activity.progressDays).toBe(4);
    expect(done.activity.status).toBe("ready");
    expect(done.becameReady).toBe(true);
  });

  it("a ready activity completes with its outcome", () => {
    let ledger = demoCrafting();
    ledger = advanceActivity(ledger, "ezren-craft-a-1-longsword", 4, "Downtime").ledger;
    const completed = completeActivity(
      ledger,
      "ezren-craft-a-1-longsword",
      "The +1 longsword is finished and in Ezren's hands.",
      "GM confirmed pickup next session",
      "2026-11-20",
    );
    expect(completed.activity.status).toBe("complete");
  });

  it("advance caps at the days needed and refuses non-progress kinds", () => {
    let ledger = demoCrafting();
    const capped = advanceActivity(ledger, "ezren-craft-a-1-longsword", 99, "Downtime");
    expect(capped.activity.progressDays).toBe(4);

    const shopping = demoInProgress();
    expect(() => advanceActivity(shopping, "valeros-buy-a-healing-potion", 1, SOURCE)).toThrow(
      /only crafting, training, and research/,
    );
  });

  it("advance refuses a proposed activity and a bad day count", () => {
    let ledger = emptyLedger();
    ledger = startActivity(ledger, {
      kind: "crafting",
      character: "Ezren",
      title: "Craft a sword",
      days: 4,
      source: SOURCE,
    }).ledger;
    expect(() => advanceActivity(ledger, "ezren-craft-a-sword", 1, SOURCE)).toThrow(
      /not in-progress/,
    );
    const inProgress = confirmActivity(ledger, "ezren-craft-a-sword").ledger;
    expect(() => advanceActivity(inProgress, "ezren-craft-a-sword", 0, SOURCE)).toThrow(
      DowntimeError,
    );
    expect(() => advanceActivity(inProgress, "ezren-craft-a-sword", 1.5, SOURCE)).toThrow(
      DowntimeError,
    );
  });
});

describe("healing is proposed, never applied", () => {
  it("proposeHealing quotes the rest rule and stays proposed until the GM confirms", () => {
    let ledger = emptyLedger();
    const { ledger: next, activity } = proposeHealing(ledger, {
      character: "Merisiel",
      rest: "rest8h",
      source: "Merisiel asked to rest between sessions",
    });
    expect(activity.kind).toBe("healing");
    expect(activity.status).toBe("proposed");
    expect(activity.proposedOutcome).toContain("level × your Constitution modifier");
    expect(activity.proposedOutcome).toContain("GM confirms");
    expect(activity.title).toBe("Rest (8 hours)");
    // The GM gate still applies: completing the proposal directly fails.
    expect(() =>
      completeActivity(next, activity.id, "Healed.", SOURCE),
    ).toThrow(/confirm it first/);
    // Confirm, then complete with the GM's stated outcome.
    const confirmed = confirmActivity(next, activity.id).ledger;
    const completed = completeActivity(
      confirmed,
      activity.id,
      "Long rest: Merisiel recovered to full HP.",
      "GM stated the rest result in chat",
    );
    expect(completed.activity.outcome).toBe("Long rest: Merisiel recovered to full HP.");
  });

  it("proposeHealing rejects an unknown rest rule", () => {
    expect(() =>
      proposeHealing(emptyLedger(), { character: "Merisiel", rest: "powerNap", source: SOURCE }),
    ).toThrow(/Unknown rest rule/);
  });

  it("the rest rules are PF2e data with a Treat Wounds option", () => {
    expect(REST_RULES.map((r) => r.key)).toEqual(["rest8h", "treatWounds"]);
    expect(getRestRule("treatWounds")?.rule).toContain("DC 15");
    expect(getRestRule("nope")).toBeUndefined();
  });
});

describe("money and per-character ledgers", () => {
  it("spentGp counts confirmed activities only — proposed and cancelled cost nothing", () => {
    let ledger = emptyLedger();
    ledger = startActivity(ledger, {
      kind: "shopping",
      character: "Valeros",
      title: "Buy a potion",
      costGp: 4,
      source: SOURCE,
    }).ledger;
    expect(spentGp(ledger)).toBe(0);
    ledger = confirmActivity(ledger, "valeros-buy-a-potion").ledger;
    expect(spentGp(ledger)).toBe(4);
    ledger = startActivity(ledger, {
      kind: "shopping",
      character: "Kyra",
      title: "Buy a scroll",
      costGp: 10,
      source: SOURCE,
    }).ledger;
    expect(spentGp(ledger)).toBe(4); // Kyra's is still proposed
    expect(spentGp(ledger, "Kyra")).toBe(0);
    ledger = cancelActivity(ledger, "kyra-buy-a-scroll", SOURCE).ledger;
    expect(spentGp(ledger)).toBe(4);
    ledger = completeActivity(ledger, "valeros-buy-a-potion", "Bought it.", SOURCE).ledger;
    expect(spentGp(ledger)).toBe(4);
    expect(spentGp(ledger, "Valeros")).toBe(4);
  });

  it("characterLedger reports spent, gained, and days still owed", () => {
    let ledger = demoCrafting();
    ledger = advanceActivity(ledger, "ezren-craft-a-1-longsword", 1, "Downtime").ledger;
    const view = characterLedger(ledger, "Ezren");
    expect(view.spentGp).toBe(35);
    expect(view.gained).toEqual([]);
    expect(view.daysRemaining).toBe(3);
    const done = completeActivity(
      advanceActivity(ledger, "ezren-craft-a-1-longsword", 3, "Downtime").ledger,
      "ezren-craft-a-1-longsword",
      "The +1 longsword is finished.",
      SOURCE,
    ).ledger;
    const doneView = characterLedger(done, "Ezren");
    expect(doneView.gained).toEqual(["The +1 longsword is finished."]);
    expect(doneView.daysRemaining).toBe(0);
  });

  it("listCharacters and listActivities filter", () => {
    const ledger = demoLedger();
    expect(listCharacters(ledger)).toEqual(["Valeros", "Ezren", "Kyra", "Merisiel"]);
    expect(listActivities(ledger, { kind: "crafting" })).toHaveLength(1);
    expect(listActivities(ledger, { character: "Kyra", status: "in-progress" })).toHaveLength(1);
    expect(listActivities(ledger, { status: "proposed" })).toHaveLength(1);
  });
});

describe("summary renderer", () => {
  it("an empty ledger says so", () => {
    expect(summarizeDowntime(emptyLedger())).toContain("No downtime yet");
  });

  it("the demo summary has what happened, what it cost, what is in progress, and what awaits confirmation", () => {
    const text = summarizeDowntime(demoLedger());
    expect(text).toContain("What happened");
    expect(text).toContain("Valeros — Buy a healing potion");
    expect(text).toContain("What it cost");
    expect(text).toContain("Valeros: 4 gp");
    expect(text).toContain("Still in progress");
    expect(text).toContain("Ezren — Craft a +1 longsword (3/4 days)");
    expect(text).toContain("Awaiting GM confirmation");
    expect(text).toContain("Merisiel — Rest (8 hours)");
    expect(text).not.toContain("Ready next session");
  });

  it("a ready activity appears under Ready next session", () => {
    let ledger = demoCrafting();
    ledger = advanceActivity(ledger, "ezren-craft-a-1-longsword", 4, "Downtime").ledger;
    expect(summarizeDowntime(ledger)).toContain("Ready next session");
    expect(summarizeDowntime(ledger)).toContain("Ezren — Craft a +1 longsword");
  });

  it("activityToText shows status, cost, progress, and the proposed outcome only while proposed", () => {
    const { activity } = startActivity(emptyLedger(), {
      kind: "healing",
      character: "Merisiel",
      title: "Rest (8 hours)",
      proposedOutcome: "PF2e — Rest (8 hours): recover HP...",
      source: SOURCE,
    });
    const text = activityToText(activity);
    expect(text).toContain("Proposed (needs GM confirmation)");
    expect(text).toContain("Proposed outcome: PF2e");
    const completed = completeActivity(
      confirmActivity(startActivity(emptyLedger(), {
        kind: "shopping",
        character: "Valeros",
        title: "Buy rope",
        costGp: 1,
        source: SOURCE,
      }).ledger, "valeros-buy-rope").ledger,
      "valeros-buy-rope",
      "Bought rope.",
      SOURCE,
    ).activity;
    expect(activityToText(completed)).toContain("Outcome: Bought rope.");
    expect(activityToText(completed)).not.toContain("Proposed outcome");
  });

  it("the index HTML lists each character's spent total and pending items", () => {
    const html = downtimeIndexHtml(demoLedger());
    expect(html).toContain("Valeros");
    expect(html).toContain("spent 4 gp");
    expect(html).toContain("1 awaiting GM confirmation");
  });
});

describe("serialize / parse round-trip", () => {
  it("round-trips the demo ledger with crafting progress intact", () => {
    const ledger = demoLedger();
    const parsed = parseLedger(serializeLedger(ledger));
    expect(parsed).toEqual(ledger);
    const sword = getActivity(parsed, "ezren-craft-a-1-longsword")!;
    expect(sword.progressDays).toBe(3);
    expect(sword.days).toBe(4);
    expect(sword.status).toBe("in-progress");
  });

  it("rejects corrupt ledgers", () => {
    expect(() => parseLedger("not json")).toThrow(DowntimeError);
    expect(() => parseLedger(JSON.stringify({ version: 2, activities: [] }))).toThrow(
      /Unsupported downtime ledger version/,
    );
    expect(() => parseLedger(JSON.stringify({ version: 1, activities: {} }))).toThrow(
      /needs an activities array/,
    );
    expect(() =>
      parseLedger(
        JSON.stringify({
          version: 1,
          activities: [
            {
              id: "x",
              kind: "fishing",
              character: "Valeros",
              title: "Fish",
              status: "proposed",
              days: 0,
              progressDays: 0,
              source: SOURCE,
              createdAt: "2026-11-20",
            },
          ],
        }),
      ),
    ).toThrow(/unknown kind/);
    expect(() =>
      parseLedger(
        JSON.stringify({
          version: 1,
          activities: [
            {
              id: "x",
              kind: "shopping",
              character: "Valeros",
              title: "Buy rope",
              status: "done",
              days: 0,
              progressDays: 0,
              source: SOURCE,
              createdAt: "2026-11-20",
            },
          ],
        }),
      ),
    ).toThrow(/unknown status/);
    expect(() =>
      parseLedger(
        JSON.stringify({
          version: 1,
          activities: [
            {
              id: "x",
              kind: "crafting",
              character: "Ezren",
              title: "Craft a sword",
              status: "in-progress",
              days: 2,
              progressDays: 5,
              source: SOURCE,
              createdAt: "2026-11-20",
            },
          ],
        }),
      ),
    ).toThrow(/more progress days/);
    const dup = {
      id: "x",
      kind: "shopping",
      character: "Valeros",
      title: "Buy rope",
      status: "proposed",
      days: 0,
      progressDays: 0,
      source: SOURCE,
      createdAt: "2026-11-20",
    };
    expect(() =>
      parseLedger(JSON.stringify({ version: 1, activities: [dup, dup] })),
    ).toThrow(/Duplicate downtime activity id/);
  });
});

describe("demo ledger", () => {
  it("builds with one of each shape: done shopping, partial crafting, in-progress training, proposed healing", () => {
    const ledger = demoLedger();
    expect(ledger.activities).toHaveLength(4);
    expect(listActivities(ledger, { status: "complete" })).toHaveLength(1);
    expect(listActivities(ledger, { status: "in-progress" })).toHaveLength(2);
    expect(listActivities(ledger, { status: "proposed" })).toHaveLength(1);
    expect(spentGp(ledger)).toBe(39); // 4 gp potion + 35 gp sword materials
    const sword = getActivity(ledger, "ezren-craft-a-1-longsword")!;
    expect(sword.progressDays).toBe(3);
  });
});
