/**
 * Tests for GM-whisper handling (BRA-185, FR-18 gap):
 * src/session/whisper.ts (pure classification + named loader) and the
 * monitor loop's whisper routing (src/session/monitor.ts) with a fake
 * live object. No Foundry connection needed — run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  isGmWhisper,
  classifyWhisper,
  extractScriptJson,
  matchNamedSequence,
  loadNamedSequence,
} from "../src/session/whisper.js";
import { validateCutscene } from "../src/session/cutscene.js";
import {
  handleWhisperSequence,
  runMonitor,
  WHISPER_CLARIFY,
} from "../src/session/monitor.js";
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

describe("isGmWhisper", () => {
  it("a whisper from the GM addressed to us is a GM whisper", () => {
    expect(isGmWhisper(msg({ whisper: [OWN] }), OWN, GM)).toBe(true);
  });

  it("a whisper to us among several recipients still counts", () => {
    expect(isGmWhisper(msg({ whisper: [PLAYER, OWN] }), OWN, GM)).toBe(true);
  });

  it("a public message (no whisper list) is not a whisper", () => {
    expect(isGmWhisper(msg({}), OWN, GM)).toBe(false);
  });

  it("a whisper to someone else is not ours", () => {
    expect(isGmWhisper(msg({ whisper: [PLAYER] }), OWN, GM)).toBe(false);
  });

  it("a whisper from a player is not a GM whisper", () => {
    expect(isGmWhisper(msg({ author: PLAYER, whisper: [OWN] }), OWN, GM)).toBe(false);
  });

  it("an empty whisper list is not a whisper", () => {
    expect(isGmWhisper(msg({ whisper: [] }), OWN, GM)).toBe(false);
  });

  it("unknown ids disable whisper detection", () => {
    expect(isGmWhisper(msg({ whisper: [OWN] }), null, GM)).toBe(false);
    expect(isGmWhisper(msg({ whisper: [OWN] }), OWN, null)).toBe(false);
  });
});

describe("extractScriptJson", () => {
  it("pulls a fenced json block out of prose", () => {
    const text = 'play this:\n```json\n{"version":1,"name":"x","steps":[]}\n```\nplease';
    expect(extractScriptJson(text)).toEqual({
      jsonText: '{"version":1,"name":"x","steps":[]}',
      fenced: true,
    });
  });

  it("pulls a bare inline object", () => {
    expect(extractScriptJson('here {"version":1} go')).toEqual({
      jsonText: '{"version":1}',
      fenced: false,
    });
  });

  it("braces inside strings do not close the object early", () => {
    expect(extractScriptJson('{"name":"a } b","version":1}')).toEqual({
      jsonText: '{"name":"a } b","version":1}',
      fenced: false,
    });
  });

  it("returns null with no object at all", () => {
    expect(extractScriptJson("run the mice and the ogre")).toBeNull();
    expect(extractScriptJson("")).toBeNull();
  });

  it("returns null for an unbalanced bare paste", () => {
    expect(extractScriptJson('{"version":1,"steps":[')).toBeNull();
  });

  it("a fenced but unbalanced block is still returned, so the parse error can be reported", () => {
    expect(extractScriptJson('```json\n{"version":1,\n```')).toEqual({
      jsonText: '{"version":1,',
      fenced: true,
    });
  });
});

describe("classifyWhisper", () => {
  const script = { version: 1, name: "Test", steps: [{ kind: "pause", ms: 10 }] };

  it("an embedded script parses to script", () => {
    const text = `play this:\n\`\`\`json\n${JSON.stringify(script)}\n\`\`\``;
    const got = classifyWhisper(text);
    expect(got.kind).toBe("script");
    if (got.kind === "script") expect(got.script).toEqual(script);
  });

  it("a broken JSON block is script-invalid, not other", () => {
    const got = classifyWhisper('play this: ```json\n{"version":1,\n```');
    expect(got.kind).toBe("script-invalid");
    if (got.kind === "script-invalid") expect(got.error.length).toBeGreaterThan(0);
  });

  it("a bare (unfenced) script object still counts as a script", () => {
    const got = classifyWhisper(JSON.stringify(script));
    expect(got.kind).toBe("script");
  });

  it("a fenced object is a script attempt even without script shape", () => {
    const got = classifyWhisper('```json\n{"a": 1}\n```');
    expect(got.kind).toBe("script");
  });

  it("braces in prose do not hijack a build request", () => {
    expect(classifyWhisper("add a {door} to the south wall")).toEqual({ kind: "other" });
  });

  it("naming a sequence routes to named", () => {
    expect(classifyWhisper("run the mice and the ogre")).toEqual({
      kind: "named",
      key: "mice-ogre",
    });
    expect(classifyWhisper("the tentacle twist, right after")).toEqual({
      kind: "named",
      key: "tentacle-twist",
    });
  });

  it("describing a sequence routes to named", () => {
    expect(classifyWhisper("mice rush in biting, then the ogre smashes the wall")).toEqual({
      kind: "named",
      key: "mice-ogre",
    });
    expect(classifyWhisper("a tentacle rips through the ogre's stomach")).toEqual({
      kind: "named",
      key: "tentacle-twist",
    });
  });

  it("anything else is other — build, question, and chatter fall through", () => {
    expect(classifyWhisper("add a door to the south wall")).toEqual({ kind: "other" });
    expect(classifyWhisper("whose turn is it?")).toEqual({ kind: "other" });
    expect(classifyWhisper("the players are screaming")).toEqual({ kind: "other" });
  });
});

describe("matchNamedSequence", () => {
  it("matches aliases as whole phrases", () => {
    expect(matchNamedSequence("run mice-ogre")).toBe("mice-ogre");
    expect(matchNamedSequence("let's do the mice and the ogre")).toBe("mice-ogre");
    expect(matchNamedSequence("the tentacle twist")).toBe("tentacle-twist");
  });

  it("does not match on a single shared word", () => {
    expect(matchNamedSequence("the ogre is dead")).toBeNull();
    expect(matchNamedSequence("mice are everywhere")).toBeNull();
    expect(matchNamedSequence("what a twist")).toBeNull();
  });
});

describe("loadNamedSequence", () => {
  it("both demo scripts load and validate", () => {
    for (const key of ["mice-ogre", "tentacle-twist"] as const) {
      const script = loadNamedSequence(key);
      expect(validateCutscene(script).ok).toBe(true);
    }
  });

  it("an unknown key throws a plain error", () => {
    expect(() => loadNamedSequence("nope" as never)).toThrow("Unknown named sequence");
  });
});

// ---------------------------------------------------------------- fake live

interface SentMsg {
  content: string;
  opts: Record<string, unknown>;
}

function fakeLive(overrides: Record<string, unknown> = {}) {
  const sent: SentMsg[] = [];
  const idem: SentMsg[] = [];
  let n = 0;
  const live = {
    userId: OWN,
    sent,
    idem,
    getChatMessages: (_limit: number) => [],
    getUsers: () => [{ _id: GM, name: "Gamemaster", role: 4, active: true }],
    getCombatState: () => null,
    getWorldSummary: () => ({ title: "TestBed", counts: {} }),
    raw: () => ({ getJournals: () => [] }),
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

describe("handleWhisperSequence", () => {
  it("plays an embedded script: ack whispered to the GM, script line public, then finished", async () => {
    const live = fakeLive();
    const outcome = await handleWhisperSequence(
      live as unknown as FoundryLive,
      msg({ id: "w1", content: `play this:\n\`\`\`json\n${JSON.stringify(CHAT_SCRIPT)}\n\`\`\`` }),
      GM,
      { kind: "script", script: CHAT_SCRIPT },
      { onLog: () => {} },
    );
    expect(outcome).toEqual({ state: "started", name: "Test Whisper" });
    // The ack is a whisper to the GM, sent before the play starts.
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain('playing "Test Whisper"');
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
    // The script's own chat step plays publicly (that is the visible effect).
    await waitFor(() => live.idem.some((m) => m.content === "Something stirs in the dark."));
    expect(live.idem[0].opts.whisperTo).toBeUndefined();
    // And the GM gets a private "finished" when the timeline ends.
    await waitFor(() => live.sent.some((m) => m.content.includes("finished")));
  });

  it("refuses an invalid script with its validation errors, whispered, and plays nothing", async () => {
    const live = fakeLive();
    const bad = { version: 2, name: "Bad", steps: [{ kind: "explode" }] };
    const outcome = await handleWhisperSequence(
      live as unknown as FoundryLive,
      msg({ id: "w2", content: "x" }),
      GM,
      { kind: "script", script: bad },
      { onLog: () => {} },
    );
    expect(outcome.state).toBe("rejected");
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain("doesn't validate");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
    expect(live.idem).toHaveLength(0);
  });

  it("refuses an unparseable script block and says what failed", async () => {
    const live = fakeLive();
    const outcome = await handleWhisperSequence(
      live as unknown as FoundryLive,
      msg({ id: "w3", content: "x" }),
      GM,
      { kind: "script-invalid", error: "Unexpected token } in JSON" },
      { onLog: () => {} },
    );
    expect(outcome.state).toBe("rejected");
    expect(live.sent[0].content).toContain("couldn't read that script");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
  });

  it("a named sequence that cannot play fails privately, not publicly", async () => {
    // The fake has no actors, so the mice-ogre play fails at the first
    // place step — the GM hears about it in a whisper, the table sees
    // nothing except the ack (which is also a whisper).
    const live = fakeLive();
    const outcome = await handleWhisperSequence(
      live as unknown as FoundryLive,
      msg({ id: "w4", content: "run the mice and the ogre" }),
      GM,
      { kind: "named", key: "mice-ogre" },
      { onLog: () => {} },
    );
    expect(outcome).toEqual({ state: "started", name: "Mice and the Ogre" });
    expect(live.sent[0].content).toContain('playing "Mice and the Ogre"');
    await waitFor(() => live.sent.some((m) => m.content.includes("stopped")));
    expect(live.sent.every((m) => m.opts.whisperTo !== undefined)).toBe(true);
  });
});

describe("runMonitor with a GM whisper (fake live, --once)", () => {
  it("a whispered embedded script is played; the ack is private, the effect is public", async () => {
    const whisper = msg({
      id: "w10",
      content: `play this:\n\`\`\`json\n${JSON.stringify(CHAT_SCRIPT)}\n\`\`\``,
      whisper: [OWN],
    });
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [whisper],
        lastSeen: whisper.id,
      }),
    });
    const logs: unknown[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: (l) => logs.push(l),
    });
    expect(summary.messagesSeen).toBe(1);
    expect(summary.whispersHandled).toBe(1);
    expect(summary.answered).toBe(1);
    await waitFor(() => live.sent.some((m) => m.content.includes('playing "Test Whisper"')));
    const ack = live.sent.find((m) => m.content.includes("playing"));
    expect(ack?.opts.whisperTo).toEqual([GM]);
    await waitFor(() => live.idem.some((m) => m.content === "Something stirs in the dark."));
  });

  it("a whispered question is answered back as a whisper, from live data", async () => {
    const whisper = msg({ id: "w11", content: "whose turn is it?", whisper: [OWN] });
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [whisper],
        lastSeen: whisper.id,
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.whispersHandled).toBe(1);
    expect(summary.answered).toBe(1);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toBe("No combat is running right now.");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
  });

  it("a whispered roll gets a clarification whisper, not a public roll", async () => {
    const whisper = msg({ id: "w12", content: "roll 1d20+5", whisper: [OWN] });
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [whisper],
        lastSeen: whisper.id,
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.whispersHandled).toBe(1);
    expect(summary.clarifications).toBe(1);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain("Rolls live in public chat");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
    expect(live.idem).toHaveLength(0);
  });

  it("a whispered non-instruction gets the generic clarification, privately", async () => {
    const whisper = msg({ id: "w13", content: "the players are screaming", whisper: [OWN] });
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [whisper],
        lastSeen: whisper.id,
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.whispersHandled).toBe(1);
    expect(summary.clarifications).toBe(1);
    expect(live.sent[0].content).toBe(WHISPER_CLARIFY);
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
  });

  it("public routing is unchanged: a public roll still rolls publicly", async () => {
    const pub = msg({
      id: "w14",
      author: PLAYER,
      content: "roll 1d20+5",
    });
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [pub],
        lastSeen: pub.id,
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      onLog: () => {},
    });
    expect(summary.rollsHandled).toBe(1);
    expect(summary.whispersHandled).toBe(0);
    expect(live.sent.some((m) => m.content.includes("17"))).toBe(true);
    expect(live.sent.every((m) => m.opts.whisperTo === undefined)).toBe(true);
  });
});
