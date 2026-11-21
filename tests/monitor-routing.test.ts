/**
 * Tests for the monitor routing round-up (BRA-244 stage-then-fire,
 * BRA-275 clocks, BRA-242 prop recording, BRA-205 rules whispers):
 * src/session/monitor.ts with a fake live object. No Foundry
 * connection needed — run with `bun test`.
 *
 * The pure parsers are tested directly; the loop branches are tested
 * through runMonitor with a fake live that answers the calls the
 * staging / clocks / rules / prop paths actually make (world
 * snapshot, pack-doc reads, Tile creates).
 */
import { describe, expect, it, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseStageReply,
  stagePreviewLine,
  parseClockCommand,
  applyClockCommand,
  parseRulesQuestion,
  classifyMessage,
  handleWhisperStage,
  handleStageReply,
  runMonitor,
  WHISPER_CLARIFY,
} from "../src/session/monitor.js";
import { stageCutscene, emptyBeatStore, listBeats } from "../src/session/staging.js";
import {
  createClock,
  saveClockState,
  loadClockState,
  emptyClockStore,
} from "../src/session/clocks.js";
import {
  BuildSession,
  saveBuildState,
  loadBuildState,
} from "../src/session/build-loop.js";
import type { ChatMessage } from "../src/types.js";
import type { FoundryLive } from "../src/live.js";

// Dave (Gamemaster) and Meroki (mcp-api) — user ids, not credentials.
const GM = "KpemqVj5YCznuMRK";
const OWN = "74bQ3Z3siKIJsXF2";
const PLAYER = "G4LfGOoX5ex27D5B";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    author: GM,
    content: "hello",
    style: 1,
    timestamp: 0,
    ...partial,
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-routing-"));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------- fake live

interface SentMsg {
  content: string;
  opts: Record<string, unknown>;
}

const FLAT_FOOTED_PACK = {
  id: "pf2e.conditionitems",
  label: "PF2e Conditions",
  type: "Item",
  index: [{ _id: "flat-footed", name: "Flat-Footed", type: "condition" }],
};

const FLAT_FOOTED_DOC = {
  _id: "flat-footed",
  name: "Flat-Footed",
  type: "condition",
  system: {
    description: {
      // Same shape as the rules module's own demo corpus: the first
      // sentence carries the rule, so the top passage answers it.
      value:
        "<p>While flat-footed, you take a –2 circumstance penalty to AC. You are flat-footed while you are unable to move or you are unaware of an attack.</p>",
    },
  },
};

const WORLD_ACTORS = [
  { _id: "a-ogre", name: "Ogre" },
  { _id: "a-mouse", name: "Mouse" },
  { _id: "a-ezren", name: "Ezren" },
  { _id: "a-kyra", name: "Kyra" },
  { _id: "a-merisiel", name: "Merisiel" },
  {
    _id: "a-valeros",
    name: "Valeros",
    system: { attributes: { hp: { value: 32, max: 32 }, ac: { value: 18 } } },
  },
];

function fakeLive(overrides: Record<string, unknown> = {}) {
  const sent: SentMsg[] = [];
  const idem: SentMsg[] = [];
  let n = 0;
  const worldData = {
    scenes: [
      {
        _id: "scene-1",
        name: "Entry Hall",
        tokens: [],
        lights: [],
        tiles: [],
        walls: [],
      },
      {
        // The mice-ogre script's scene, with the south wall its
        // breakWall step smashes (within 150px of (800, 1600)).
        _id: "scene-2",
        name: "Lich's Lair — Entry Hall",
        tokens: [],
        lights: [],
        tiles: [],
        walls: [{ _id: "w1", c: [750, 1600, 850, 1600] }],
      },
    ],
    packs: [FLAT_FOOTED_PACK],
  };
  const live = {
    userId: OWN,
    sent,
    idem,
    getChatMessages: (_limit: number) => [],
    getUsers: () => [{ _id: GM, name: "Gamemaster", role: 4, active: true }],
    getCombatState: () => null,
    getWorldSummary: () => ({ title: "TestBed", counts: {} }),
    getActiveSceneId: () => "scene-1",
    searchActors: async (_name: string, _opts?: unknown) => ({ actors: WORLD_ACTORS }),
    getActorDetails: async (id: string) => WORLD_ACTORS.find((a) => a._id === id) ?? null,
    raw: () => ({
      getJournals: () => [],
      getWorldData: () => worldData,
      getScenes: () => worldData.scenes,
      searchActors: async (_q: unknown) => ({ actors: WORLD_ACTORS }),
      getRawActor: (id: string) => WORLD_ACTORS.find((a) => a._id === id),
    }),
    modifyDocument: async (
      type: string,
      action: string,
      opts: Record<string, unknown> = {},
    ) => {
      if (type === "Tile" && action === "create") return [{ _id: "tile-1" }];
      if (action === "get") {
        const query = opts.query as { _id?: string } | undefined;
        if (query?._id === "flat-footed") return [FLAT_FOOTED_DOC];
        return [];
      }
      return [];
    },
    on: (_fn: unknown) => () => {},
    sendChat: async (content: string, opts: Record<string, unknown> = {}) => {
      sent.push({ content, opts });
      return `sent-${++n}`;
    },
    sendChatIdempotent: async (content: string, opts: Record<string, unknown> = {}) => {
      idem.push({ content, opts });
      return { id: `idem-${++n}`, duplicate: false };
    },
    rollDice: async (formula: string) => ({
      formula,
      total: 17,
      breakdown: "12 + 5",
      timestamp: new Date().toISOString(),
      source: "local" as const,
    }),
    waitForChat: async () => ({ timedOut: true, newMessages: [], lastSeen: null }),
    ...overrides,
  };
  return live;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const CHAT_SCRIPT = {
  version: 1,
  name: "Test Whisper",
  steps: [
    { kind: "chat", content: "Something stirs in the dark." },
    { kind: "pause", ms: 10 },
  ],
};

const CHAT_SCRIPT_V2 = {
  version: 1,
  name: "Test Whisper v2",
  steps: [
    { kind: "chat", content: "Something else stirs in the dark." },
    { kind: "pause", ms: 10 },
  ],
};

function scriptWhisper(script: unknown, id: string): ChatMessage {
  return msg({
    id,
    content: `play this:\n\`\`\`json\n${JSON.stringify(script)}\n\`\`\``,
    whisper: [OWN],
  });
}

// ---------------------------------------------------------------- pure: stage replies

describe("parseStageReply", () => {
  it("matches bare fire / edit / drop, case-insensitive, with trailing punctuation", () => {
    expect(parseStageReply("fire")).toEqual({ action: "fire" });
    expect(parseStageReply("Fire!")).toEqual({ action: "fire" });
    expect(parseStageReply("EDIT")).toEqual({ action: "edit" });
    expect(parseStageReply("drop.")).toEqual({ action: "drop" });
  });

  it("accepts a filler word or a beat id after the verb", () => {
    expect(parseStageReply("fire it")).toEqual({ action: "fire" });
    expect(parseStageReply("fire please")).toEqual({ action: "fire" });
    expect(parseStageReply("fire staged-mice-ogre-a1b2c3d4")).toEqual({
      action: "fire",
      beatId: "staged-mice-ogre-a1b2c3d4",
    });
    expect(parseStageReply("drop staged-test-whisper-01234567")).toEqual({
      action: "drop",
      beatId: "staged-test-whisper-01234567",
    });
  });

  it("does not match near-misses — they fall through to ordinary routing", () => {
    expect(parseStageReply("fire the cannons")).toBeNull();
    expect(parseStageReply("fired")).toBeNull();
    expect(parseStageReply("drop the beat")).toBeNull();
    expect(parseStageReply("please fire")).toBeNull();
    expect(parseStageReply("fire at will")).toBeNull();
    expect(parseStageReply("")).toBeNull();
  });
});

describe("stagePreviewLine", () => {
  it("shows the summary, the first lines, and the one-word reply — never the whole script", () => {
    const staged = stageCutscene(CHAT_SCRIPT, { actors: [], scenes: [], combat: null });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const line = stagePreviewLine(staged.beat);
    expect(line).toContain(`🎭 Staged "Test Whisper" (${staged.beat.id}):`);
    expect(line).toContain("Something stirs in the dark.");
    expect(line).toContain('Reply "fire" to play it, "edit" to change it, or "drop" to discard it.');
  });

  it("truncates after three preview lines and counts the rest", () => {
    const script = {
      version: 1,
      name: "Long",
      steps: [
        { kind: "chat", content: "one" },
        { kind: "chat", content: "two" },
        { kind: "chat", content: "three" },
        { kind: "chat", content: "four" },
        { kind: "chat", content: "five" },
      ],
    };
    const staged = stageCutscene(script, { actors: [], scenes: [], combat: null });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const line = stagePreviewLine(staged.beat);
    expect(line).toContain("one");
    expect(line).toContain("three");
    expect(line).toContain("…and 2 more steps.");
    expect(line).not.toContain("four");
  });
});

// ---------------------------------------------------------------- pure: clocks

describe("parseClockCommand", () => {
  it("parses the issue's start phrasings through the clocks module", () => {
    expect(parseClockCommand("start a 6-segment clock: the pursuit")).toEqual({
      kind: "create",
      name: "the pursuit",
      total: 6,
    });
    expect(
      parseClockCommand("start a 4-segment clock: the guards arrive — at zero: the alarm sounds"),
    ).toEqual({
      kind: "create",
      name: "the guards arrive",
      total: 4,
      consequence: "the alarm sounds",
    });
  });

  it("asks for the missing half of a start instead of guessing", () => {
    expect(parseClockCommand("start a clock: the pursuit")).toEqual({
      kind: "clarify",
      question: 'How many segments should the "the pursuit" clock have?',
    });
    expect(parseClockCommand("start the ritual clock")).toEqual({
      kind: "clarify",
      // The clocks module does not extract the name when there is no
      // count — the question is generic, and the GM answers with both.
      question: "How many segments should the clock have?",
    });
  });

  it("parses tick / fill / resolve / reset / drop / stop by name", () => {
    expect(parseClockCommand("tick the ritual clock")).toEqual({
      kind: "tick",
      name: "ritual",
      by: 1,
    });
    expect(parseClockCommand("tick the ritual clock by 2")).toEqual({
      kind: "tick",
      name: "ritual",
      by: 2,
    });
    expect(parseClockCommand("advance the ritual clock")).toEqual({
      kind: "tick",
      name: "ritual",
      by: 1,
    });
    expect(parseClockCommand("the dragon clock ticks")).toEqual({
      kind: "tick",
      name: "dragon",
      by: 1,
    });
    expect(parseClockCommand("the dragon clock ticks by 3")).toEqual({
      kind: "tick",
      name: "dragon",
      by: 3,
    });
    expect(parseClockCommand("fill the ritual clock to 4")).toEqual({
      kind: "fill",
      name: "ritual",
      to: 4,
    });
    expect(parseClockCommand("resolve the ritual clock")).toEqual({
      kind: "resolve",
      name: "ritual",
    });
    expect(parseClockCommand("reset the ritual clock")).toEqual({
      kind: "reset",
      name: "ritual",
    });
    expect(parseClockCommand("drop the omen clock")).toEqual({
      kind: "drop",
      name: "omen",
    });
    expect(parseClockCommand("stop the omen clock")).toEqual({
      kind: "drop",
      name: "omen",
    });
  });

  it("parses pause as a pause command — the module has no pause op, the loop clarifies", () => {
    expect(parseClockCommand("pause the ritual clock")).toEqual({
      kind: "pause",
      name: "ritual",
    });
  });

  it("parses list commands", () => {
    expect(parseClockCommand("show the clocks")).toEqual({ kind: "list" });
    expect(parseClockCommand("list clocks")).toEqual({ kind: "list" });
    expect(parseClockCommand("what clocks are running")).toEqual({ kind: "list" });
  });

  it("asks how far to fill when no count is given", () => {
    expect(parseClockCommand("fill the ritual clock")).toEqual({
      kind: "clarify",
      question: 'Fill the "ritual" clock to how many segments?',
    });
  });

  it("returns null for lines that are not clock instructions", () => {
    expect(parseClockCommand("build a clock tower")).toBeNull();
    expect(parseClockCommand("the clock is broken")).toBeNull();
    expect(parseClockCommand("what time is it")).toBeNull();
    expect(parseClockCommand("tick the ritual")).toBeNull();
  });
});

describe("applyClockCommand", () => {
  it("creates, ticks, fills, resolves, resets, and drops — each line is the clock's new state", () => {
    let store = emptyClockStore();
    let res = applyClockCommand(
      store,
      { kind: "create", name: "the pursuit", total: 6 },
      "m1",
    );
    store = res.store;
    expect("line" in res && res.line).toContain("🕐 the pursuit [░░░░░░] 0/6");
    res = applyClockCommand(store, { kind: "tick", name: "the pursuit", by: 2 }, "m2");
    store = res.store;
    expect("line" in res && res.line).toContain("🕐 the pursuit [██░░░░] 2/6");
    res = applyClockCommand(store, { kind: "fill", name: "the pursuit", to: 5 }, "m3");
    store = res.store;
    expect("line" in res && res.line).toContain("5/6");
    // Only a fired clock can be resolved: fill to the total first.
    res = applyClockCommand(store, { kind: "fill", name: "the pursuit", to: 6 }, "m4");
    store = res.store;
    expect("line" in res && res.line).toContain("⏰ the pursuit hit zero");
    res = applyClockCommand(store, { kind: "resolve", name: "the pursuit" }, "m5");
    store = res.store;
    expect("line" in res && res.line).toContain("✅ the pursuit resolved");
    res = applyClockCommand(store, { kind: "reset", name: "the pursuit" }, "m6");
    store = res.store;
    expect("line" in res && res.line).toContain("🕐 the pursuit [░░░░░░] 0/6");
    res = applyClockCommand(store, { kind: "drop", name: "the pursuit" }, "m7");
    store = res.store;
    expect("line" in res && res.line).toContain("🚫 the pursuit dropped");
  });

  it("ticks by the name the parser produces, with or without the article", () => {
    // The start line names the clock "the pursuit"; the tick line
    // parses to "pursuit". The toggle resolves it — and the reverse
    // (a clock named "ritual", ticked as "the ritual") works too.
    let store = emptyClockStore();
    let res = applyClockCommand(store, { kind: "create", name: "the pursuit", total: 6 }, "m1");
    store = res.store;
    res = applyClockCommand(store, { kind: "tick", name: "pursuit", by: 1 }, "m2");
    expect("line" in res && res.line).toContain("1/6");
    store = res.store;
    res = applyClockCommand(store, { kind: "create", name: "ritual", total: 4 }, "m3");
    store = res.store;
    res = applyClockCommand(store, { kind: "tick", name: "the ritual", by: 1 }, "m4");
    expect("line" in res && res.line).toContain("🕐 ritual [█░░░] 1/4");
  });

  it("a fired clock's line carries its consequence", () => {
    let store = emptyClockStore();
    let res = applyClockCommand(
      store,
      { kind: "create", name: "the guards arrive", total: 2, consequence: "the alarm sounds" },
      "m1",
    );
    store = res.store;
    res = applyClockCommand(store, { kind: "tick", name: "the guards arrive", by: 2 }, "m2");
    expect("line" in res && res.line).toContain("⏰ the guards arrive hit zero");
    expect("line" in res && res.line).toContain("the alarm sounds");
  });

  it("pause is an honest clarify, not a state change", () => {
    const store = emptyClockStore();
    const res = applyClockCommand(store, { kind: "pause", name: "the pursuit" }, "m1");
    expect(res.store).toBe(store);
    expect("clarify" in res && res.clarify).toContain("ending combat pauses");
  });

  it("an unknown name throws the module's error, which lists the clocks that exist", () => {
    let store = emptyClockStore();
    const res = applyClockCommand(store, { kind: "create", name: "the pursuit", total: 6 }, "m1");
    store = res.store;
    expect(() => applyClockCommand(store, { kind: "tick", name: "the omen", by: 1 }, "m2")).toThrow(
      /the pursuit/,
    );
  });

  it("a second clock with the same name gets its id in the line", () => {
    let store = emptyClockStore();
    let res = applyClockCommand(store, { kind: "create", name: "the pursuit", total: 6 }, "m1");
    store = res.store;
    res = applyClockCommand(store, { kind: "create", name: "the pursuit", total: 4 }, "m2");
    expect("line" in res && res.line).toContain("(id: ");
  });

  it("list renders the whole store, or 'No clocks.' when empty", () => {
    expect(applyClockCommand(emptyClockStore(), { kind: "list" }, "m1")).toMatchObject({
      line: "No clocks.",
    });
    let store = emptyClockStore();
    const res = applyClockCommand(store, { kind: "create", name: "the pursuit", total: 6 }, "m1");
    store = res.store;
    const listed = applyClockCommand(store, { kind: "list" }, "m2");
    expect("line" in listed && listed.line).toContain("the pursuit");
  });
});

// ---------------------------------------------------------------- pure: rules questions

describe("parseRulesQuestion", () => {
  it("matches rules questions: a question shape plus a rules term", () => {
    expect(parseRulesQuestion("what does flat-footed do?")).toBe("what does flat-footed do?");
    expect(parseRulesQuestion("how many actions does it take to reload a crossbow?")).toBe(
      "how many actions does it take to reload a crossbow?",
    );
    expect(parseRulesQuestion("can I stride and strike in one turn?")).toBe(
      "can I stride and strike in one turn?",
    );
    expect(parseRulesQuestion("what is the DC to treat wounds?")).toBe(
      "what is the DC to treat wounds?",
    );
  });

  it("needs both halves — a question without a rules term, or a term without a question", () => {
    expect(parseRulesQuestion("what does the door do?")).toBeNull();
    expect(parseRulesQuestion("how many soldiers are there?")).toBeNull();
    expect(parseRulesQuestion("how do I ride a dragon to the moon?")).toBeNull();
    expect(parseRulesQuestion("the flat-footed condition")).toBeNull();
    expect(parseRulesQuestion("reload the crossbow")).toBeNull();
  });
});

describe("classifyMessage with clocks", () => {
  it("a clock line classifies as clock, after light and before build", () => {
    expect(
      classifyMessage(msg({ author: PLAYER, content: "start a 6-segment clock: the pursuit" }), OWN, "Meroki"),
    ).toBe("clock");
  });

  it("'build a clock tower' is not a clock command", () => {
    expect(
      classifyMessage(msg({ author: PLAYER, content: "build a clock tower" }), OWN, "Meroki"),
    ).not.toBe("clock");
  });
});

// ---------------------------------------------------------------- stage-then-fire, direct handlers

describe("handleWhisperStage + handleStageReply", () => {
  it("stages a script and whispers the preview; fire plays it in the background", async () => {
    const live = fakeLive();
    const staged = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s1", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: CHAT_SCRIPT },
      { onLog: () => {}, beatStore: emptyBeatStore() },
    );
    expect(staged.outcome.state).toBe("staged");
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain('🎭 Staged "Test Whisper"');
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
    expect(live.idem).toHaveLength(0);

    const fired = await handleStageReply(
      live as unknown as FoundryLive,
      msg({ id: "s2", content: "fire", whisper: [OWN] }),
      GM,
      staged.store,
      { action: "fire" },
      { onLog: () => {} },
    );
    expect(fired.handled).toBe(true);
    expect(live.sent.some((m) => m.content.includes('playing "Test Whisper"'))).toBe(true);
    await waitFor(() => live.idem.some((m) => m.content === "Something stirs in the dark."));
    await waitFor(() => live.sent.some((m) => m.content.includes("finished")));
  });

  it("staging the same script twice is a duplicate, not a second beat", async () => {
    const live = fakeLive();
    const first = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s3", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: CHAT_SCRIPT },
      { onLog: () => {}, beatStore: emptyBeatStore() },
    );
    expect(first.outcome.state).toBe("staged");
    const second = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s4", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: CHAT_SCRIPT },
      { onLog: () => {}, beatStore: first.store },
    );
    expect(second.outcome).toMatchObject({ state: "staged", duplicate: true });
    expect(live.sent[1].content).toContain("already staged");
  });

  it("a script that cannot stage is refused with its errors, and nothing is staged", async () => {
    const live = fakeLive();
    const bad = {
      version: 1,
      name: "Bad",
      steps: [{ kind: "place", sceneId: "scene-1", actor: "Nobody", x: 0, y: 0 }],
    };
    const res = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s5", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: bad },
      { onLog: () => {}, beatStore: emptyBeatStore() },
    );
    expect(res.outcome.state).toBe("rejected");
    expect(live.sent[0].content).toContain("doesn't stage");
    expect(live.sent[0].content).toContain("actor not found");
    expect(Object.keys(res.store.beats)).toHaveLength(0);
  });

  it("a named sequence stages against the world snapshot", async () => {
    const live = fakeLive();
    const res = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s6", content: "run the mice and the ogre", whisper: [OWN] }),
      GM,
      { kind: "named", key: "mice-ogre" },
      { onLog: () => {}, beatStore: emptyBeatStore() },
    );
    expect(res.outcome.state).toBe("staged");
    if (res.outcome.state === "staged") expect(res.outcome.name).toBe("Mice and the Ogre");
    expect(live.sent[0].content).toContain('🎭 Staged "Mice and the Ogre"');
  });

  it("drop discards the beat with one confirmation line; a later fire finds nothing staged", async () => {
    const live = fakeLive();
    const staged = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s7", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: CHAT_SCRIPT },
      { onLog: () => {}, beatStore: emptyBeatStore() },
    );
    const dropped = await handleStageReply(
      live as unknown as FoundryLive,
      msg({ id: "s8", content: "drop", whisper: [OWN] }),
      GM,
      staged.store,
      { action: "drop" },
      { onLog: () => {} },
    );
    expect(dropped.handled).toBe(true);
    expect(live.sent[1].content).toBe('Dropped "Test Whisper".');
    const after = await handleStageReply(
      live as unknown as FoundryLive,
      msg({ id: "s9", content: "fire", whisper: [OWN] }),
      GM,
      dropped.store,
      { action: "fire" },
      { onLog: () => {} },
    );
    expect(after.handled).toBe(false);
    expect(live.sent).toHaveLength(2);
  });

  it("edit opens the wait; the next pasted script re-stages under a new id", async () => {
    const live = fakeLive();
    const staged = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s10", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: CHAT_SCRIPT },
      { onLog: () => {}, beatStore: emptyBeatStore() },
    );
    const edited = await handleStageReply(
      live as unknown as FoundryLive,
      msg({ id: "s11", content: "edit", whisper: [OWN] }),
      GM,
      staged.store,
      { action: "edit" },
      { onLog: () => {} },
    );
    expect(edited.handled).toBe(true);
    expect(edited.pendingEdit).not.toBeNull();
    expect(live.sent[1].content).toContain("Paste the revised script");
    const restaged = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s12", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: CHAT_SCRIPT_V2 },
      { onLog: () => {}, beatStore: edited.store, pendingEditBeatId: edited.pendingEdit },
    );
    expect(restaged.outcome.state).toBe("staged");
    expect(restaged.pendingEdit).toBeNull();
    if (restaged.outcome.state === "staged") {
      expect(restaged.outcome.name).toBe("Test Whisper v2");
      expect(restaged.outcome.id).not.toBe(
        staged.outcome.state === "staged" ? staged.outcome.id : "",
      );
    }
    expect(live.sent[2].content).toContain('🎭 Staged "Test Whisper v2"');
    // One staged beat (the revision); the old beat stays in the store
    // as dropped, so the history is auditable.
    const beats = listBeats(restaged.store);
    expect(beats.filter((b) => b.status === "staged")).toHaveLength(1);
    expect(beats.filter((b) => b.status === "dropped")).toHaveLength(1);
  });

  it("a failed revision leaves the old beat staged and the wait open", async () => {
    const live = fakeLive();
    const staged = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s13", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: CHAT_SCRIPT },
      { onLog: () => {}, beatStore: emptyBeatStore() },
    );
    const edited = await handleStageReply(
      live as unknown as FoundryLive,
      msg({ id: "s14", content: "edit", whisper: [OWN] }),
      GM,
      staged.store,
      { action: "edit" },
      { onLog: () => {} },
    );
    const bad = {
      version: 1,
      name: "Bad",
      steps: [{ kind: "place", sceneId: "scene-1", actor: "Nobody", x: 0, y: 0 }],
    };
    const restaged = await handleWhisperStage(
      live as unknown as FoundryLive,
      msg({ id: "s15", content: "x", whisper: [OWN] }),
      GM,
      { kind: "script", script: bad },
      { onLog: () => {}, beatStore: edited.store, pendingEditBeatId: edited.pendingEdit },
    );
    expect(restaged.outcome.state).toBe("rejected");
    expect(restaged.pendingEdit).toBe(edited.pendingEdit);
    expect(live.sent[2].content).toContain("The old beat is unchanged");
    expect(Object.keys(restaged.store.beats)).toHaveLength(1);
  });

  it("a named beat id that is not staged is refused by whisper", async () => {
    const live = fakeLive();
    const res = await handleStageReply(
      live as unknown as FoundryLive,
      msg({ id: "s16", content: "fire staged-nope-00000000", whisper: [OWN] }),
      GM,
      emptyBeatStore(),
      { action: "fire", beatId: "staged-nope-00000000" },
      { onLog: () => {} },
    );
    expect(res.handled).toBe(true);
    expect(live.sent[0].content).toContain('No staged beat "staged-nope-00000000"');
  });
});

// ---------------------------------------------------------------- loop: clocks

describe("runMonitor clocks (fake live, --once)", () => {
  it("starts a clock in one chat message and persists it to the state file", async () => {
    const dir = tmpDir();
    const clockPath = path.join(dir, "clocks.json");
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [
          msg({
            id: "c1",
            author: PLAYER,
            content: "start a 6-segment clock: the pursuit",
          }),
        ],
        lastSeen: "c1",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clockStatePath: clockPath,
      onLog: () => {},
    });
    expect(summary.clocksHandled).toBe(1);
    expect(summary.answered).toBe(1);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toBe("🕐 the pursuit [░░░░░░] 0/6 — 6 rounds left");
    expect(live.sent[0].opts.whisperTo).toBeUndefined();
    const saved = loadClockState(clockPath);
    expect(saved?.clocks).toHaveLength(1);
    expect(saved?.clocks[0].name).toBe("the pursuit");
  });

  it("creates then ticks in one batch; a second run ticks the persisted clock", async () => {
    const dir = tmpDir();
    const clockPath = path.join(dir, "clocks.json");
    const batch = (messages: ChatMessage[]) =>
      fakeLive({
        waitForChat: async () => ({
          timedOut: false,
          newMessages: messages,
          lastSeen: messages[messages.length - 1]?.id ?? null,
        }),
      });
    const live = batch([
      msg({ id: "c2", author: PLAYER, content: "start a 6-segment clock: the pursuit" }),
      msg({ id: "c3", author: PLAYER, content: "tick the pursuit clock by 2" }),
    ]);
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clockStatePath: clockPath,
      onLog: () => {},
    });
    expect(summary.clocksHandled).toBe(2);
    expect(live.sent[1].content).toBe("🕐 the pursuit [██░░░░] 2/6 — 4 rounds left");
    expect(loadClockState(clockPath)?.clocks[0].filled).toBe(2);

    const live2 = batch([
      msg({ id: "c4", author: PLAYER, content: "tick the pursuit clock" }),
    ]);
    const summary2 = await runMonitor(live2 as unknown as FoundryLive, {
      once: true,
      clockStatePath: clockPath,
      onLog: () => {},
    });
    expect(summary2.clocksHandled).toBe(1);
    expect(live2.sent[0].content).toContain("3/6");
  });

  it("an unknown clock name clarifies with the clocks that exist, never a guess", async () => {
    const dir = tmpDir();
    const clockPath = path.join(dir, "clocks.json");
    const store = createClock(emptyClockStore(), {
      name: "the pursuit",
      total: 6,
      source: "seed",
    }).store;
    saveClockState(store, clockPath);
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [
          msg({ id: "c5", author: PLAYER, content: "tick the omen clock" }),
        ],
        lastSeen: "c5",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clockStatePath: clockPath,
      onLog: () => {},
    });
    expect(summary.clocksHandled).toBe(0);
    expect(summary.clarifications).toBe(1);
    expect(live.sent[0].content).toContain("the pursuit");
    expect(live.sent[0].content).toContain("omen");
  });

  it("a start without a count asks in chat; a pause gets the honest no-pause line", async () => {
    const dir = tmpDir();
    const clockPath = path.join(dir, "clocks.json");
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [
          msg({ id: "c6", author: PLAYER, content: "start the ritual clock" }),
          msg({ id: "c7", author: PLAYER, content: "pause the ritual clock" }),
        ],
        lastSeen: "c7",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clockStatePath: clockPath,
      onLog: () => {},
    });
    expect(summary.clarifications).toBe(2);
    expect(live.sent[0].content).toContain("How many segments should the clock have?");
    expect(live.sent[1].content).toContain("ending combat pauses");
  });

  it("a whispered clock command is confirmed privately", async () => {
    const dir = tmpDir();
    const clockPath = path.join(dir, "clocks.json");
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [
          msg({
            id: "c8",
            content: "start a 4-segment clock: the ritual",
            whisper: [OWN],
          }),
        ],
        lastSeen: "c8",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clockStatePath: clockPath,
      onLog: () => {},
    });
    expect(summary.clocksHandled).toBe(1);
    expect(summary.whispersHandled).toBe(1);
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
  });

  it("a running clock ticks once per new combat round, with a chat line", async () => {
    const dir = tmpDir();
    const clockPath = path.join(dir, "clocks.json");
    const store = createClock(emptyClockStore(), {
      name: "the pursuit",
      total: 6,
      source: "seed",
    }).store;
    saveClockState(store, clockPath);
    const live = fakeLive({
      getCombatState: () => ({
        _id: "c1",
        scene: "scene-1",
        round: 2,
        turn: null,
        active: true,
        combatants: [],
      }),
      waitForChat: async () => ({ timedOut: true, newMessages: [], lastSeen: null }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clockStatePath: clockPath,
      onLog: () => {},
    });
    expect(summary.clocksHandled).toBe(1);
    expect(live.sent.some((m) => m.content === "🕐 the pursuit [█░░░░░] 1/6 — 5 rounds left")).toBe(
      true,
    );
    expect(loadClockState(clockPath)?.clocks[0].filled).toBe(1);
  });

  it("re-polling the same round does not double-tick", async () => {
    const dir = tmpDir();
    const clockPath = path.join(dir, "clocks.json");
    const store = createClock(emptyClockStore(), {
      name: "the pursuit",
      total: 6,
      source: "seed",
    }).store;
    saveClockState(store, clockPath);
    const combat = {
      _id: "c1",
      scene: "scene-1",
      round: 2,
      turn: null,
      active: true,
      combatants: [],
    };
    const live = fakeLive({
      getCombatState: () => combat,
      waitForChat: async () => ({ timedOut: true, newMessages: [], lastSeen: null }),
    });
    const run = () =>
      runMonitor(live as unknown as FoundryLive, {
        once: true,
        clockStatePath: clockPath,
        onLog: () => {},
      });
    await run();
    const second = await run();
    expect(second.clocksHandled).toBe(0);
    expect(loadClockState(clockPath)?.clocks[0].filled).toBe(1);
  });
});

// ---------------------------------------------------------------- loop: stage-then-fire

describe("runMonitor stage-then-fire (fake live)", () => {
  function queuedLive(queue: ChatMessage[]) {
    let calls = 0;
    const total = queue.length;
    const live = fakeLive({
      waitForChat: async () => {
        calls += 1;
        if (queue.length === 0) return { timedOut: true, newMessages: [], lastSeen: null };
        const m = queue.shift()!;
        return { timedOut: false, newMessages: [m], lastSeen: m.id };
      },
    });
    return { live, shouldStop: () => calls >= total };
  }

  it("script → staged preview → 'fire' plays it; the preview and ack are private, the effect is public", async () => {
    const { live, shouldStop } = queuedLive([
      scriptWhisper(CHAT_SCRIPT, "w20"),
      msg({ id: "w21", content: "fire", whisper: [OWN] }),
    ]);
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: false,
      onLog: () => {},
      shouldStop,
    });
    expect(summary.messagesSeen).toBe(2);
    expect(summary.whispersHandled).toBe(2);
    expect(summary.stagesHandled).toBe(2);
    expect(summary.answered).toBe(2);
    const preview = live.sent.find((m) => m.content.includes("🎭 Staged"));
    expect(preview).toBeDefined();
    expect(preview?.opts.whisperTo).toEqual([GM]);
    const ack = live.sent.find((m) => m.content.includes('playing "Test Whisper"'));
    expect(ack?.opts.whisperTo).toEqual([GM]);
    await waitFor(() => live.idem.some((m) => m.content === "Something stirs in the dark."));
    expect(live.idem[0].opts.whisperTo).toBeUndefined();
    await waitFor(() => live.sent.some((m) => m.content.includes("finished")));
  });

  it("'drop' discards the beat; a later 'fire' gets the generic clarification", async () => {
    const { live, shouldStop } = queuedLive([
      scriptWhisper(CHAT_SCRIPT, "w22"),
      msg({ id: "w23", content: "drop", whisper: [OWN] }),
      msg({ id: "w24", content: "fire", whisper: [OWN] }),
    ]);
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: false,
      onLog: () => {},
      shouldStop,
    });
    expect(summary.stagesHandled).toBe(2);
    expect(live.sent.some((m) => m.content === 'Dropped "Test Whisper".')).toBe(true);
    expect(live.sent.some((m) => m.content === WHISPER_CLARIFY)).toBe(true);
    expect(live.idem).toHaveLength(0);
  });

  it("'fire' with two staged beats and no id asks which one, listing both", async () => {
    const { live, shouldStop } = queuedLive([
      scriptWhisper(CHAT_SCRIPT, "w25"),
      scriptWhisper(CHAT_SCRIPT_V2, "w26"),
      msg({ id: "w27", content: "fire", whisper: [OWN] }),
    ]);
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: false,
      onLog: () => {},
      shouldStop,
    });
    expect(summary.stagesHandled).toBe(3);
    const ask = live.sent.find((m) => m.content.includes("More than one beat is staged"));
    expect(ask).toBeDefined();
    expect(ask?.content).toContain("Test Whisper");
    expect(ask?.content).toContain("Test Whisper v2");
    expect(ask?.content).toContain("staged-");
    expect(live.idem).toHaveLength(0);
  });

  it("'fire' with nothing staged is not a stage reply — it gets the generic clarification", async () => {
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [msg({ id: "w28", content: "fire", whisper: [OWN] })],
        lastSeen: "w28",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.stagesHandled).toBe(0);
    expect(summary.clarifications).toBe(1);
    expect(live.sent[0].content).toBe(WHISPER_CLARIFY);
  });
});

// ---------------------------------------------------------------- loop: rules whispers

describe("runMonitor rules whispers (fake live, --once)", () => {
  it("a whispered rules question is answered from the books, with its citation", async () => {
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [msg({ id: "r1", content: "what does flat-footed do?", whisper: [OWN] })],
        lastSeen: "r1",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.rulesHandled).toBe(1);
    expect(summary.whispersHandled).toBe(1);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain("–2 circumstance penalty to AC");
    expect(live.sent[0].content).toContain("Source:");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
  });

  it("a rules question the books do not answer says so, with closest matches — never a ruling", async () => {
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [
          msg({
            id: "r2",
            content: "how many actions does it take to reload a crossbow?",
            whisper: [OWN],
          }),
        ],
        lastSeen: "r2",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.rulesHandled).toBe(1);
    expect(live.sent[0].content).toContain("Not found in the installed books");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
  });

  it("a whispered question without a rules term is not stolen by the rules branch", async () => {
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [msg({ id: "r3", content: "what does the door do?", whisper: [OWN] })],
        lastSeen: "r3",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.rulesHandled).toBe(0);
    expect(summary.clarifications).toBe(1);
    expect(live.sent[0].content).toBe(WHISPER_CLARIFY);
  });

  it("a public rules question stays needs-agent — the branch is whisper-only", async () => {
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [
          msg({ id: "r4", author: PLAYER, content: "what does flat-footed do?" }),
        ],
        lastSeen: "r4",
      }),
    });
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.rulesHandled).toBe(0);
    expect(live.sent).toHaveLength(0);
    expect(logs.some((l) => l.event === "needs-agent")).toBe(true);
  });

  it("a data question keeps priority over the rules branch", async () => {
    // "armor class" is a rules term, so this whisper would match the
    // rules branch too — but the data-question branch is checked
    // first, and Valeros's AC comes from his sheet, not the books.
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [
          msg({ id: "r5", content: "what's Valeros's armor class?", whisper: [OWN] }),
        ],
        lastSeen: "r5",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.rulesHandled).toBe(0);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toBe("**Valeros**'s AC is 18.");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
  });
});

// ---------------------------------------------------------------- loop: prop recording

describe("runMonitor cutscene prop recording (fake live)", () => {
  it("a fired cutscene's prop is recorded into the build session's spec and saved", async () => {
    const dir = tmpDir();
    const buildPath = path.join(dir, "build.json");
    // Seed a build: one room, active, saved to the state file.
    const session = new BuildSession();
    session.apply(
      {
        type: "create-room",
        name: "Entry Hall",
        gridW: 8,
        gridH: 6,
        doors: [{ wall: "south" }],
        chest: false,
        torches: false,
        fog: false,
      },
      "seed",
    );
    saveBuildState(session, new Map(), buildPath);
    expect(session.current().activeRoom).not.toBeNull();

    const propScript = {
      version: 1,
      name: "Bones Drop",
      steps: [
        {
          kind: "prop",
          sceneId: "scene-1",
          src: "pack/bones.png",
          x: 200,
          y: 100,
          width: 200,
          height: 200,
        },
      ],
    };
    let calls = 0;
    const queue = [scriptWhisper(propScript, "p1"), msg({ id: "p2", content: "fire", whisper: [OWN] })];
    const live = fakeLive({
      waitForChat: async () => {
        calls += 1;
        if (queue.length === 0) return { timedOut: true, newMessages: [], lastSeen: null };
        const m = queue.shift()!;
        return { timedOut: false, newMessages: [m], lastSeen: m.id };
      },
    });
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: false,
      buildStatePath: buildPath,
      onLog: (l) => logs.push(l as Record<string, unknown>),
      shouldStop: () => calls >= 3,
    });
    expect(summary.stagesHandled).toBe(2);
    // The Tile create went through, and the recording landed in the log.
    await waitFor(() => logs.some((l) => l.event === "prop-recorded"));
    expect(logs.find((l) => l.event === "prop-recorded")).toMatchObject({ room: expect.any(String) });
    // The state file's room spec now carries the bones at (2, 1).
    const restored = loadBuildState(buildPath);
    const room = restored?.session.current().dungeon.rooms[0];
    expect(room?.dressing).toHaveLength(1);
    expect(room?.dressing?.[0]).toMatchObject({ tile: "bones", gx: 2, gy: 1 });
  });
});
