/**
 * Tests for named-light chat routing (BRA-240, FR-7 follow-up):
 * src/session/light-commands.ts (pure parsing + confirmation lines)
 * and the monitor loop's light branch (src/session/monitor.ts) with a
 * fake live object. No Foundry connection needed — run with `bun test`.
 *
 * The one live-animation test takes ~2s (the library's default 2s
 * fade, 12 steps); everything else is dry-run or pure.
 */
import { describe, expect, it, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  describeLightCommand,
  parseLightCommand,
  type LightCommand,
} from "../src/session/light-commands.js";
import { classifyMessage, runMonitor } from "../src/session/monitor.js";
import type { ChatMessage } from "../src/types.js";
import type { FoundryLive } from "../src/live.js";

// Dave (Gamemaster) and Meroki (mcp-api) — user ids, not credentials.
const GM = "KpemqVj5YCznuMRK";
const OWN = "74bQ3Z3siKIJsXF2";

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "musegm-lights-"));
  tmpDirs.push(d);
  return d;
}

describe("parseLightCommand", () => {
  it("dims the braziers — the issue's example", () => {
    expect(parseLightCommand("dim the braziers")).toEqual({
      name: "the braziers",
      target: { dim: 0, bright: 0 },
      action: "dim",
      kind: "brazier",
    });
  });

  it("is case-insensitive and tolerates punctuation + leading fluff", () => {
    // The name keeps the GM's casing (the resolver normalizes it);
    // the target and action are the same for every phrasing.
    const target = { dim: 0, bright: 0 };
    expect(parseLightCommand("Dim the Braziers!")).toEqual({
      name: "the Braziers",
      target,
      action: "dim",
      kind: "brazier",
    });
    for (const line of [
      "please dim the braziers",
      "can you dim the braziers?",
      "meroki, dim the braziers",
      "dim the braziers, please",
    ]) {
      expect(parseLightCommand(line)).toEqual({
        name: "the braziers",
        target,
        action: "dim",
        kind: "brazier",
      });
    }
  });

  it("every off verb fades the group out", () => {
    for (const verb of [
      "dim",
      "darken",
      "snuff",
      "extinguish",
      "douse",
      "put out",
      "turn off",
      "switch off",
      "fade out",
    ]) {
      const cmd = parseLightCommand(`${verb} the torches`);
      expect(cmd?.target).toEqual({ dim: 0, bright: 0 });
      expect(cmd?.action).toBe("dim");
    }
  });

  it("dim to N sets the dim radius with a bright core at half", () => {
    expect(parseLightCommand("dim the braziers to 100")).toEqual({
      name: "the braziers",
      target: { dim: 100, bright: 50 },
      action: "set",
      kind: "brazier",
    });
    expect(parseLightCommand("dim the braziers to 0")?.target).toEqual({
      dim: 0,
      bright: 0,
    });
  });

  it("every on verb relights to the kind's canonical radii", () => {
    // Dressing generator presets (dressing.ts): torch 300/120, candle
    // 120/60, brazier 400/200. Color and alpha are never touched.
    expect(parseLightCommand("light the braziers")?.target).toEqual({
      dim: 400,
      bright: 200,
    });
    expect(parseLightCommand("turn on the torches")?.target).toEqual({
      dim: 300,
      bright: 120,
    });
    expect(parseLightCommand("brighten the candles")?.target).toEqual({
      dim: 120,
      bright: 60,
    });
    expect(parseLightCommand("relight the torches")?.action).toBe("light");
    expect(parseLightCommand("ignite the braziers")?.action).toBe("light");
    expect(parseLightCommand("switch on the candles")?.action).toBe("light");
    expect(parseLightCommand("fade in the torches")?.action).toBe("light");
  });

  it("make brighter / glow relights; make dimmer fades out", () => {
    expect(parseLightCommand("make the braziers brighter")).toEqual({
      name: "the braziers",
      target: { dim: 400, bright: 200 },
      action: "light",
      kind: "brazier",
    });
    expect(parseLightCommand("make the braziers glow")?.action).toBe("light");
    expect(parseLightCommand("make the braziers glow red")).toEqual({
      name: "the braziers",
      target: { dim: 400, bright: 200, color: "#ff0000" },
      action: "light",
      kind: "brazier",
      colorWord: "red",
    });
    expect(parseLightCommand("make the braziers dimmer")?.action).toBe("dim");
    expect(parseLightCommand("make the braziers dimmer")?.target).toEqual({
      dim: 0,
      bright: 0,
    });
  });

  it("brighten to N sets the bright radius only", () => {
    expect(parseLightCommand("brighten the torches to 200")).toEqual({
      name: "the torches",
      target: { bright: 200 },
      action: "set",
      kind: "torch",
    });
  });

  it("explicit fields parse, in any combination", () => {
    expect(parseLightCommand("make the braziers dim 100 bright 50")).toEqual({
      name: "the braziers",
      target: { dim: 100, bright: 50 },
      action: "set",
      kind: "brazier",
    });
    expect(parseLightCommand("set the torches to dim 200 bright 100")?.target).toEqual({
      dim: 200,
      bright: 100,
    });
    expect(parseLightCommand("set the braziers alpha 0.5")?.target).toEqual({
      alpha: 0.5,
    });
    expect(parseLightCommand("make the braziers dim 100")?.target).toEqual({
      dim: 100,
    });
  });

  it("color words and hex parse; color words keep their word", () => {
    expect(parseLightCommand("make the braziers red")).toEqual({
      name: "the braziers",
      target: { color: "#ff0000" },
      action: "set",
      kind: "brazier",
      colorWord: "red",
    });
    expect(parseLightCommand("make the braziers #ff0000")).toEqual({
      name: "the braziers",
      target: { color: "#ff0000" },
      action: "set",
      kind: "brazier",
    });
    // The codebase's own hexes: amber = torch amber, gold = candle
    // gold, orange = brazier orange.
    expect(parseLightCommand("make the torches amber")?.target).toEqual({
      color: "#ff9a3c",
    });
    expect(parseLightCommand("make the candles gold")?.target).toEqual({
      color: "#ffc46b",
    });
    expect(parseLightCommand("make the braziers orange")?.target).toEqual({
      color: "#ff8c2e",
    });
  });

  it("a color word inside the name survives (dim the red braziers)", () => {
    const cmd = parseLightCommand("dim the red braziers");
    expect(cmd?.name).toBe("the red braziers");
    expect(cmd?.target).toEqual({ dim: 0, bright: 0 });
  });

  it("dim works on any light-kind name, even without a relight kind", () => {
    expect(parseLightCommand("dim the center light")?.name).toBe("the center light");
    expect(parseLightCommand("dim the center light")?.kind).toBeUndefined();
    expect(parseLightCommand("dim the chandelier")?.name).toBe("the chandelier");
    expect(parseLightCommand("dim the lights")?.name).toBe("the lights");
  });

  it("relight needs a torch, candle, or brazier in the name", () => {
    expect(parseLightCommand("brighten the center light")).toBeNull();
    expect(parseLightCommand("light the chandelier")).toBeNull();
  });

  it("is not a light command: builds, rooms, fog, chat", () => {
    expect(parseLightCommand("add torches")).toBeNull();
    expect(parseLightCommand("add a door on the north wall")).toBeNull();
    expect(parseLightCommand("make the room darker")).toBeNull();
    expect(parseLightCommand("make the north half underwater")).toBeNull();
    expect(parseLightCommand("turn off the fog")).toBeNull();
    expect(parseLightCommand("dim the room")).toBeNull();
    expect(parseLightCommand("the braziers")).toBeNull();
    expect(parseLightCommand("the braziers are too bright")).toBeNull();
    expect(parseLightCommand("let's go hands-on on this room")).toBeNull();
  });

  it("is not a light command: compounds, bare make/set, bad numbers", () => {
    expect(parseLightCommand("dim the braziers and add a door")).toBeNull();
    expect(parseLightCommand("dim the braziers and the torches")).toBeNull();
    expect(parseLightCommand("make the braziers")).toBeNull();
    expect(parseLightCommand("set the braziers")).toBeNull();
    expect(parseLightCommand("set the braziers to 100")).toBeNull();
    expect(parseLightCommand("set the braziers alpha 2")).toBeNull();
    expect(parseLightCommand("dim the braziers red")).toBeNull();
    expect(parseLightCommand("dim the braziers brighter")).toBeNull();
    expect(parseLightCommand("make the braziers dance")).toBeNull();
  });
});

describe("describeLightCommand", () => {
  const dimCmd: LightCommand = {
    name: "the braziers",
    target: { dim: 0, bright: 0 },
    action: "dim",
    kind: "brazier",
  };
  const lightCmd: LightCommand = {
    name: "the braziers",
    target: { dim: 400, bright: 200 },
    action: "light",
    kind: "brazier",
  };
  it("states the change in the GM's terms", () => {
    expect(describeLightCommand(dimCmd, "the braziers")).toBe("🔦 Dimmed the braziers.");
    expect(describeLightCommand(lightCmd, "the braziers")).toBe("🔦 Lit the braziers.");
    expect(
      describeLightCommand(
        { name: "x", target: { dim: 100, bright: 50 }, action: "set" },
        "the braziers",
      ),
    ).toBe("🔦 Set the braziers to dim 100, bright 50.");
    expect(
      describeLightCommand(
        { name: "x", target: { color: "#ff0000" }, action: "set", colorWord: "red" },
        "the braziers",
      ),
    ).toBe("🔦 Changed the braziers to red.");
  });

  it("uses the resolved display name, not the query", () => {
    // The GM said "brazier"; the group is "the braziers".
    expect(describeLightCommand(dimCmd, "the braziers")).toBe("🔦 Dimmed the braziers.");
  });
});

describe("classifyMessage light routing", () => {
  it("dim the braziers is light; make the torches brighter is light, not unsupported", () => {
    expect(classifyMessage(msg({ content: "dim the braziers" }), OWN, "Meroki")).toBe("light");
    expect(
      classifyMessage(msg({ content: "make the torches brighter" }), OWN, "Meroki"),
    ).toBe("light");
  });

  it("build requests still classify as build", () => {
    // classifyMessage needs a build context for the build parse (the
    // loop always provides one); without it, builds fall to "chat".
    const ctx = {};
    expect(classifyMessage(msg({ content: "add torches" }), OWN, "Meroki", ctx)).toBe(
      "build",
    );
    expect(
      classifyMessage(msg({ content: "add a door on the north wall" }), OWN, "Meroki", ctx),
    ).toBe("build");
  });

  it("dim the room and turn off the fog are not light", () => {
    const ctx = {};
    expect(classifyMessage(msg({ content: "dim the room" }), OWN, "Meroki", ctx)).toBe(
      "chat",
    );
    expect(classifyMessage(msg({ content: "turn off the fog" }), OWN, "Meroki", ctx)).toBe(
      "build",
    );
  });
});

// ---------------------------------------------------------------- fake live

interface SentMsg {
  content: string;
  opts: Record<string, unknown>;
}

interface ModifyCall {
  type: string;
  action: string;
  operation: Record<string, unknown>;
}

const SCENE_ID = "scene-1";

function lightDoc(
  id: string,
  name: string | null,
  dim = 400,
  bright = 200,
  color = "#ff8c2e",
  alpha = 0.5,
) {
  return {
    _id: id,
    x: 100,
    y: 100,
    config: { dim, bright, color, alpha },
    flags: name ? { "foundry-live": { lightName: name } } : {},
  };
}

function worldData() {
  return {
    scenes: [
      {
        _id: SCENE_ID,
        name: "Entry Hall",
        active: true,
        lights: [
          lightDoc("b1", "the braziers"),
          lightDoc("b2", "the braziers"),
          lightDoc("t1", "the torches", 300, 120, "#ff9a3c", 0.4),
          lightDoc("e1", "the entry torches", 300, 120, "#ff9a3c", 0.4),
          lightDoc("a1", "the altar candles", 120, 60, "#ffc46b", 0.4),
          lightDoc("a2", "the table candles", 120, 60, "#ffc46b", 0.4),
          lightDoc("u1", null),
        ],
      },
    ],
  };
}

function fakeLive(
  messages: ChatMessage[],
  overrides: Record<string, unknown> = {},
) {
  const sent: SentMsg[] = [];
  const modified: ModifyCall[] = [];
  let n = 0;
  const live = {
    userId: OWN,
    sent,
    modified,
    getChatMessages: (_limit: number) => [],
    getUsers: () => [{ _id: GM, name: "Gamemaster", role: 4, active: true }],
    getCombatState: () => null,
    getWorldSummary: () => ({ title: "TestBed", counts: {} }),
    getActiveSceneId: () => SCENE_ID,
    raw: () => ({ getWorldData: () => worldData(), getJournals: () => [] }),
    modifyDocument: async (
      type: string,
      action: string,
      operation: Record<string, unknown>,
    ) => {
      modified.push({ type, action, operation });
      return [];
    },
    on: (_fn: unknown) => () => {},
    sendChat: async (content: string, opts: Record<string, unknown> = {}) => {
      sent.push({ content, opts });
      return `sent-${++n}`;
    },
    sendChatIdempotent: async (content: string, opts: Record<string, unknown> = {}) => {
      return { id: `idem-${++n}`, duplicate: false };
    },
    waitForChat: async () => ({
      timedOut: false,
      newMessages: messages,
      lastSeen: messages.length > 0 ? messages[messages.length - 1].id : null,
    }),
    ...overrides,
  };
  return live;
}

function runOpts(dir: string, extra: Record<string, unknown> = {}) {
  return {
    once: true,
    modeStatePath: path.join(dir, "mode.json"),
    buildStatePath: path.join(dir, "build.json"),
    onLog: () => {},
    ...extra,
  };
}

describe("runMonitor light routing (fake live, --once, dry-run)", () => {
  it("dim the braziers logs a light event and posts nothing", async () => {
    const dir = tmpDir();
    const live = fakeLive([msg({ id: "l1", content: "dim the braziers" })]);
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      ...runOpts(dir, { dryRun: true }),
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(logs.some((l) => l.event === "light" && l.dryRun === true)).toBe(true);
    expect(logs.some((l) => l.event === "light" && l.name === "the braziers")).toBe(true);
    expect(live.sent).toHaveLength(0);
    expect(live.modified).toHaveLength(0);
    expect(summary.lightsHandled).toBe(0); // dry-run executes nothing
  });

  it("make the torches brighter routes to light, not build-unsupported", async () => {
    const dir = tmpDir();
    const live = fakeLive([msg({ id: "l2", content: "make the torches brighter" })]);
    const logs: Record<string, unknown>[] = [];
    await runMonitor(live as unknown as FoundryLive, {
      ...runOpts(dir, { dryRun: true }),
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(logs.some((l) => l.event === "light")).toBe(true);
    expect(logs.some((l) => l.event === "build-unsupported")).toBe(false);
    expect(live.sent).toHaveLength(0);
  });

  it("make the room darker is not a light command", async () => {
    const dir = tmpDir();
    const live = fakeLive([msg({ id: "l3", content: "make the room darker" })]);
    const logs: Record<string, unknown>[] = [];
    await runMonitor(live as unknown as FoundryLive, {
      ...runOpts(dir, { dryRun: true }),
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(logs.some((l) => l.event === "light")).toBe(false);
  });

  it("dim the braziers and add a door is a build, not a light command", async () => {
    const dir = tmpDir();
    const live = fakeLive([
      msg({ id: "l4", content: "dim the braziers and add a door" }),
    ]);
    const logs: Record<string, unknown>[] = [];
    await runMonitor(live as unknown as FoundryLive, {
      ...runOpts(dir, { dryRun: true }),
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(logs.some((l) => l.event === "light")).toBe(false);
    // "add a door" with no wall is a build clarification, not a build
    // — the point is the build parser owns the line, not the lights.
    expect(logs.some((l) => l.event === "build-clarify")).toBe(true);
  });
});

describe("runMonitor light routing (fake live, --once, live path)", () => {
  it("a whispered dim animates both braziers and confirms privately", async () => {
    const dir = tmpDir();
    const live = fakeLive([
      msg({ id: "l5", content: "dim the braziers", whisper: [OWN] }),
    ]);
    const summary = await runMonitor(
      live as unknown as FoundryLive,
      runOpts(dir),
    );
    // One fade per light (12 steps each), in parallel — the unnamed
    // torch and the other groups are untouched.
    expect(live.modified).toHaveLength(24);
    const ids = new Set(
      live.modified.map(
        (c) =>
          (
            (c.operation.updates as Record<string, unknown>[])[0] as Record<string, unknown>
          )._id as string,
      ),
    );
    expect([...ids].sort()).toEqual(["b1", "b2"]);
    for (const c of live.modified) {
      expect(c.type).toBe("AmbientLight");
      expect(c.action).toBe("update");
    }
    const lastById = new Map<string, Record<string, unknown>>();
    for (const c of live.modified) {
      const upd = (c.operation.updates as Record<string, unknown>[])[0];
      lastById.set(upd._id as string, upd);
    }
    for (const upd of lastById.values()) {
      expect(upd["config.dim"]).toBe(0);
      expect(upd["config.bright"]).toBe(0);
    }
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toBe("🔦 Dimmed the braziers.");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
    expect(summary.lightsHandled).toBe(1);
    expect(summary.whispersHandled).toBe(1);
    expect(summary.answered).toBe(1);
  }, 10000);

  it("an unknown name clarifies with the names that exist, and animates nothing", async () => {
    const dir = tmpDir();
    const live = fakeLive([msg({ id: "l6", content: "dim the chandelier" })]);
    const summary = await runMonitor(
      live as unknown as FoundryLive,
      runOpts(dir),
    );
    expect(live.modified).toHaveLength(0);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain('No light named "the chandelier"');
    expect(live.sent[0].content).toContain("the braziers");
    expect(summary.clarifications).toBe(1);
    expect(summary.lightsHandled).toBe(0);
  });

  it("an ambiguous name clarifies with the matches, and animates nothing", async () => {
    const dir = tmpDir();
    const live = fakeLive([msg({ id: "l7", content: "dim the candles" })]);
    const summary = await runMonitor(
      live as unknown as FoundryLive,
      runOpts(dir),
    );
    expect(live.modified).toHaveLength(0);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain("matches more than one light");
    expect(live.sent[0].content).toContain("the altar candles");
    expect(live.sent[0].content).toContain("the table candles");
    expect(summary.clarifications).toBe(1);
    expect(summary.lightsHandled).toBe(0);
  });

  it("no active scene clarifies, and animates nothing", async () => {
    const dir = tmpDir();
    const live = fakeLive([msg({ id: "l8", content: "dim the braziers" })], {
      getActiveSceneId: () => null,
    });
    const summary = await runMonitor(
      live as unknown as FoundryLive,
      runOpts(dir),
    );
    expect(live.modified).toHaveLength(0);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toBe("I couldn't tell which scene is active.");
    expect(summary.clarifications).toBe(1);
    expect(summary.lightsHandled).toBe(0);
  });
});
