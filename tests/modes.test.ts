/**
 * Tests for session modes (BRA-233): src/session/modes.ts (pure
 * parsing, brief detection, state persistence) and the monitor loop's
 * mode routing (src/session/monitor.ts) with a fake live object. No
 * Foundry connection needed — run with `bun test`.
 */
import { describe, expect, it, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isModeState,
  isSessionMode,
  loadModeState,
  modeSwitchLine,
  parseBriefRequest,
  parseModeSwitch,
  saveModeState,
  type SessionMode,
} from "../src/session/modes.js";
import { runMonitor } from "../src/session/monitor.js";
import {
  BuildSession,
  loadBuildState,
  saveBuildState,
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "musegm-modes-"));
  tmpDirs.push(d);
  return d;
}

interface SentMsg {
  content: string;
  opts: Record<string, unknown>;
}

function fakeLive(
  messages: ChatMessage[],
  overrides: Record<string, unknown> = {},
) {
  const sent: SentMsg[] = [];
  let n = 0;
  const live = {
    userId: OWN,
    sent,
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

/** A floor brief in the spec's own words (FR-15's example, shortened). */
const FLOOR_BRIEF =
  "Here's an entire floor of a dungeon, roughly: three pressure-plate puzzles in three different rooms to unlock a door. " +
  "A riddle type thing over here. Two minor encounters, one of which is an ambush. Then the big boss battle. Some intrigue.";

describe("parseModeSwitch", () => {
  it("the issue's hands-on phrasing switches to hands-on", () => {
    expect(parseModeSwitch("let's go hands-on on this room")).toBe("hands-on");
  });

  it("the issue's co-design phrasing switches to co-design", () => {
    expect(parseModeSwitch("take the brief from here")).toBe("co-design");
    expect(parseModeSwitch("take the brief")).toBe("co-design");
  });

  it("switch-to phrasings work for every mode", () => {
    expect(parseModeSwitch("switch to improvise mode")).toBe("improvise");
    expect(parseModeSwitch("switch to co-design mode")).toBe("co-design");
    expect(parseModeSwitch("switch to hands-on")).toBe("hands-on");
  });

  it("back-to and bare mode phrasings work", () => {
    expect(parseModeSwitch("back to hands-on")).toBe("hands-on");
    expect(parseModeSwitch("hands-on mode")).toBe("hands-on");
    expect(parseModeSwitch("let's improvise")).toBe("improvise");
    expect(parseModeSwitch("let's co-design this floor")).toBe("co-design");
    expect(parseModeSwitch("go improv")).toBe("improvise");
    expect(parseModeSwitch("emergent mode")).toBe("improvise");
  });

  it("a switch naming two modes takes the one after to/into", () => {
    expect(parseModeSwitch("switch from hands-on to co-design")).toBe("co-design");
    expect(parseModeSwitch("switch from co-design to hands-on")).toBe("hands-on");
  });

  it("a switch line that also names a build switches — it does not build", () => {
    expect(parseModeSwitch("switch to hands-on mode and add a door")).toBe("hands-on");
  });

  it("ordinary chat never switches", () => {
    for (const line of [
      "the ogre is dead",
      "let's go",
      "add a door here",
      "what's the brief?",
      "the hands-on approach",
      "I need a brief",
      "build an 8x6 room",
      "roll 1d20+5",
      "whose turn is it?",
    ]) {
      expect(parseModeSwitch(line), line).toBeNull();
    }
  });

  it("two modes with no direction is ambiguous, not a guess", () => {
    expect(parseModeSwitch("hands-on and co-design")).toBeNull();
  });
});

describe("parseBriefRequest", () => {
  it("the FR-15 example brief matches, with its signals", () => {
    const brief = parseBriefRequest(FLOOR_BRIEF);
    expect(brief).not.toBeNull();
    for (const sig of ["puzzle", "riddle", "encounter", "boss", "intrigue"]) {
      expect(brief!.signals).toContain(sig);
    }
  });

  it("two plan signals are enough, even without a floor phrase", () => {
    expect(parseBriefRequest("two minor encounters, one an ambush, then the boss")).not.toBeNull();
  });

  it("a bare floor phrase is a brief", () => {
    expect(parseBriefRequest("here's an entire floor")).not.toBeNull();
  });

  it("builds, rolls, and ordinary chat are never briefs", () => {
    for (const line of [
      "build an 8x6 room with a south door",
      "add a door here",
      "the ogre is dead",
      "add a boss",
      "what's the riddle?",
      "roll 1d20+5",
    ]) {
      expect(parseBriefRequest(line), line).toBeNull();
    }
  });
});

describe("modeSwitchLine", () => {
  it("names the target mode and what it means", () => {
    expect(modeSwitchLine("hands-on", "co-design")).toContain("Co-design mode");
    expect(modeSwitchLine("co-design", "improvise")).toContain("Improvise mode");
    expect(modeSwitchLine("improvise", "hands-on")).toContain("Hands-on mode");
  });

  it("a same-mode switch says so instead of pretending to switch", () => {
    expect(modeSwitchLine("hands-on", "hands-on")).toBe("Already in Hands-on mode.");
  });
});

describe("mode state persistence", () => {
  it("save/load round-trips every mode", () => {
    const dir = tmpDir();
    for (const mode of ["hands-on", "co-design", "improvise"] as SessionMode[]) {
      const file = path.join(dir, `${mode}.json`);
      saveModeState(mode, file);
      expect(loadModeState(file)).toBe(mode);
    }
  });

  it("a missing file loads as null (fresh session, hands-on)", () => {
    expect(loadModeState(path.join(tmpDir(), "nope.json"))).toBeNull();
  });

  it("a corrupt or wrong-shaped file loads as null, never throws", () => {
    const dir = tmpDir();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json", "utf-8");
    expect(loadModeState(bad)).toBeNull();
    const wrong = path.join(dir, "wrong.json");
    fs.writeFileSync(wrong, JSON.stringify({ version: 1, mode: "director" }), "utf-8");
    expect(loadModeState(wrong)).toBeNull();
    const old = path.join(dir, "old.json");
    fs.writeFileSync(old, JSON.stringify({ version: 2, mode: "hands-on" }), "utf-8");
    expect(loadModeState(old)).toBeNull();
  });

  it("isSessionMode / isModeState validate strictly", () => {
    expect(isSessionMode("hands-on")).toBe(true);
    expect(isSessionMode("director")).toBe(false);
    expect(isSessionMode(null)).toBe(false);
    expect(isModeState({ version: 1, mode: "improvise" })).toBe(true);
    expect(isModeState({ version: 1, mode: "hands-on", extra: 1 })).toBe(true);
    expect(isModeState({ mode: "hands-on" })).toBe(false);
  });
});

describe("runMonitor mode switching (fake live, --once)", () => {
  it("the GM switches to co-design publicly: log line + public confirmation + persisted", async () => {
    const dir = tmpDir();
    const modePath = path.join(dir, "mode.json");
    const buildPath = path.join(dir, "build.json");
    const live = fakeLive([msg({ id: "s1", content: "take the brief from here" })]);
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      modeStatePath: modePath,
      buildStatePath: buildPath,
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.mode).toBe("co-design");
    expect(summary.modeSwitches).toBe(1);
    expect(summary.answered).toBe(1);
    const started = logs.find((l) => l.event === "started");
    expect(started?.mode).toBe("hands-on");
    const switched = logs.find((l) => l.event === "mode-switch");
    expect(switched).toMatchObject({ from: "hands-on", to: "co-design", same: false });
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain("Co-design mode");
    expect(live.sent[0].opts.whisperTo).toBeUndefined();
    expect(loadModeState(modePath)).toBe("co-design");
  });

  it("switching to the current mode is a no-op that says so", async () => {
    const dir = tmpDir();
    const modePath = path.join(dir, "mode.json");
    const live = fakeLive([msg({ id: "s2", content: "let's go hands-on on this room" })]);
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      mode: "hands-on",
      modeStatePath: modePath,
      buildStatePath: path.join(dir, "build.json"),
      onLog: () => {},
    });
    expect(summary.mode).toBe("hands-on");
    expect(summary.modeSwitches).toBe(0);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toBe("Already in Hands-on mode.");
    expect(loadModeState(modePath)).toBe("hands-on");
  });

  it("a player cannot switch the mode", async () => {
    const dir = tmpDir();
    const live = fakeLive([
      msg({ id: "s3", author: PLAYER, content: "let's go hands-on on this room" }),
    ]);
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      modeStatePath: path.join(dir, "mode.json"),
      buildStatePath: path.join(dir, "build.json"),
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.mode).toBe("hands-on");
    expect(summary.modeSwitches).toBe(0);
    expect(logs.some((l) => l.event === "mode-switch")).toBe(false);
    expect(live.sent).toHaveLength(0);
    expect(summary.skipped).toBe(1);
  });

  it("a whispered switch is confirmed privately", async () => {
    const dir = tmpDir();
    const live = fakeLive([
      msg({ id: "s4", content: "let's improvise", whisper: [OWN] }),
    ]);
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      modeStatePath: path.join(dir, "mode.json"),
      buildStatePath: path.join(dir, "build.json"),
      onLog: () => {},
    });
    expect(summary.mode).toBe("improvise");
    expect(summary.modeSwitches).toBe(1);
    expect(summary.whispersHandled).toBe(1);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain("Improvise mode");
    expect(live.sent[0].opts.whisperTo).toEqual([GM]);
  });

  it("the mode persists across restarts and the build state survives the switch", async () => {
    const dir = tmpDir();
    const modePath = path.join(dir, "mode.json");
    const buildPath = path.join(dir, "build.json");
    // Seed a build: one room, saved to the state file.
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

    const live = fakeLive([msg({ id: "s5", content: "take the brief from here" })]);
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      modeStatePath: modePath,
      buildStatePath: buildPath,
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.mode).toBe("co-design");
    // The build state file still holds the room — the switch did not touch it.
    const restored = loadBuildState(buildPath);
    expect(restored?.session.current().dungeon.rooms).toHaveLength(1);
    expect(restored?.session.current().dungeon.rooms[0].name).toBe("Entry Hall");
    expect(logs.find((l) => l.event === "build-state-restored")).toMatchObject({
      rooms: 1,
    });

    // A second run with no mode option reads the mode back from the file.
    const live2 = fakeLive([]);
    const summary2 = await runMonitor(live2 as unknown as FoundryLive, {
      once: true,
      modeStatePath: modePath,
      buildStatePath: buildPath,
      onLog: () => {},
    });
    expect(summary2.mode).toBe("co-design");
    expect(summary2.modeSwitches).toBe(0);
  });

  it("a floor brief in co-design mode is a brief event, not needs-agent", async () => {
    const dir = tmpDir();
    const live = fakeLive([msg({ id: "s6", content: FLOOR_BRIEF })]);
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      mode: "co-design",
      modeStatePath: path.join(dir, "mode.json"),
      buildStatePath: path.join(dir, "build.json"),
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.mode).toBe("co-design");
    const brief = logs.find((l) => l.event === "brief");
    expect(brief).toBeDefined();
    expect(brief?.mode).toBe("co-design");
    expect(brief?.signals).toContain("boss");
    expect(logs.some((l) => l.event === "needs-agent")).toBe(false);
    expect(live.sent).toHaveLength(0);
  });

  it("the same brief in hands-on mode is plain needs-agent", async () => {
    const dir = tmpDir();
    const live = fakeLive([msg({ id: "s7", content: FLOOR_BRIEF })]);
    const logs: Record<string, unknown>[] = [];
    await runMonitor(live as unknown as FoundryLive, {
      once: true,
      modeStatePath: path.join(dir, "mode.json"),
      buildStatePath: path.join(dir, "build.json"),
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(logs.some((l) => l.event === "brief")).toBe(false);
    expect(logs.some((l) => l.event === "needs-agent")).toBe(true);
  });

  it("builds still run (dry-run) in co-design mode — the mode is not a lockout", async () => {
    const dir = tmpDir();
    const buildPath = path.join(dir, "build.json");
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
    const live = fakeLive([msg({ id: "s8", content: "add a door on the north wall" })]);
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      dryRun: true,
      mode: "co-design",
      modeStatePath: path.join(dir, "mode.json"),
      buildStatePath: buildPath,
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.mode).toBe("co-design");
    const build = logs.find((l) => l.event === "build");
    expect(build).toBeDefined();
    expect(build?.dryRun).toBe(true);
  });
});
