/**
 * Zone → cutscene link tests (FR-4 / BRA-196) — pure validation,
 * planning, arming state, and watcher dispatch against a fake live
 * client. No Foundry connection: the live play is next session's
 * live-test checklist.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  LinkArming,
  resolveZoneSet,
  planZoneCutsceneSet,
} from "../src/session/zone-cutscene.js";
import { TrapWatcher } from "../src/session/traps.js";
import type { ZoneSet } from "../src/session/traps.js";
import { validateCutscene } from "../src/session/cutscene.js";

const SCRIPT = {
  version: 1,
  name: "Test Cutscene",
  steps: [
    { kind: "chat", content: "Something happens." },
    { kind: "pause", ms: 500 },
    { kind: "chat", content: "It is done." },
  ],
};

function zoneSetDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sceneId: "scene-1",
    zones: [
      {
        name: "Loose flagstone",
        shape: { kind: "rect", x: 1200, y: 600, w: 200, h: 200 },
        triggerFor: "pcs",
        fireOnce: true,
        actions: [{ type: "cutscene", script: SCRIPT }],
      },
      {
        name: "Pit",
        shape: { kind: "circle", x: 300, y: 300, r: 100 },
        actions: [
          { type: "chat", text: "{token} falls in!" },
          { type: "damage", amount: 5 },
        ],
      },
    ],
    ...overrides,
  };
}

const noFile = (_p: string): string => {
  throw new Error("ENOENT: no such file or directory");
};

describe("resolveZoneSet", () => {
  it("accepts an inline cutscene and inherits the zone sceneId", () => {
    const r = resolveZoneSet(zoneSetDoc(), noFile);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cut = r.zoneSet.zones[0].actions[0];
    expect(cut.type).toBe("cutscene");
    if (cut.type === "cutscene") {
      expect(cut.script.sceneId).toBe("scene-1");
      expect(cut.script.name).toBe("Test Cutscene");
      expect(cut.sceneIdInherited).toBe(true);
    }
  });

  it("resolves a cutscene file path through the injected loader", () => {
    const doc = zoneSetDoc();
    const zones = doc.zones as Record<string, unknown>[];
    (zones[0].actions as Record<string, unknown>[])[0].script = "./trapdoor.json";
    const r = resolveZoneSet(doc, (p) => {
      expect(p).toBe("./trapdoor.json");
      return JSON.stringify(SCRIPT);
    });
    expect(r.ok).toBe(true);
  });

  it("reports a missing cutscene file, bad JSON, and a bad script", () => {
    const doc = zoneSetDoc();
    const zones = doc.zones as Record<string, unknown>[];
    (zones[0].actions as Record<string, unknown>[])[0].script = "./missing.json";
    const missing = resolveZoneSet(doc, noFile);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join(" ")).toContain("missing.json");

    const badJson = resolveZoneSet(doc, () => "{not json");
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.errors.join(" ")).toContain("not valid JSON");

    const badScript = resolveZoneSet(doc, () =>
      JSON.stringify({ version: 1, name: "Bad", steps: [{ kind: "teleport" }] }),
    );
    expect(badScript.ok).toBe(false);
    if (!badScript.ok) expect(badScript.errors.join(" ")).toContain("unknown kind");
  });

  it("rejects a cutscene whose sceneId disagrees with the zone set", () => {
    const doc = zoneSetDoc();
    const zones = doc.zones as Record<string, unknown>[];
    (zones[0].actions as Record<string, unknown>[])[0].script = {
      ...SCRIPT,
      sceneId: "somewhere-else",
    };
    const r = resolveZoneSet(doc, noFile);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("omit sceneId to inherit");
  });

  it("accepts a cutscene whose sceneId matches, without inheriting", () => {
    const doc = zoneSetDoc();
    const zones = doc.zones as Record<string, unknown>[];
    (zones[0].actions as Record<string, unknown>[])[0].script = {
      ...SCRIPT,
      sceneId: "scene-1",
    };
    const r = resolveZoneSet(doc, noFile);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cut = r.zoneSet.zones[0].actions[0];
    if (cut.type === "cutscene") expect(cut.sceneIdInherited).toBe(false);
  });

  it("rejects duplicate zone names, bad shapes, and bad enums", () => {
    const dup = zoneSetDoc();
    (dup.zones as Record<string, unknown>[]).push({
      name: "Pit",
      shape: { kind: "rect", x: 0, y: 0, w: 10, h: 10 },
      actions: [{ type: "chat", text: "hi" }],
    });
    const d = resolveZoneSet(dup, noFile);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.errors.join(" ")).toContain("duplicate zone name");

    const badShape = zoneSetDoc();
    ((badShape.zones as Record<string, unknown>[])[0].shape as Record<string, unknown>).w = 0;
    const b = resolveZoneSet(badShape, noFile);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors.join(" ")).toContain('"w" must be >= 1');

    const badCircle = zoneSetDoc();
    (badCircle.zones as Record<string, unknown>[])[1].shape = { kind: "circle", x: 1, y: 1 };
    const c = resolveZoneSet(badCircle, noFile);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.errors.join(" ")).toContain('"r" is required');

    const badFor = zoneSetDoc();
    ((badFor.zones as Record<string, unknown>[])[0] as Record<string, unknown>).triggerFor = "everyone";
    const f = resolveZoneSet(badFor, noFile);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.errors.join(" ")).toContain("triggerFor");
  });

  it("rejects unknown fields, unknown action types, and empty actions", () => {
    const badField = zoneSetDoc();
    ((badField.zones as Record<string, unknown>[])[0] as Record<string, unknown>).fireOunce = true;
    const f = resolveZoneSet(badField, noFile);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.errors.join(" ")).toContain('unknown field "fireOunce"');

    const badAction = zoneSetDoc();
    ((badAction.zones as Record<string, unknown>[])[1].actions as Record<string, unknown>[])[0] = {
      type: "explode",
      amount: 99,
    };
    const a = resolveZoneSet(badAction, noFile);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors.join(" ")).toContain("unknown type");

    const noActions = zoneSetDoc();
    ((noActions.zones as Record<string, unknown>[])[1] as Record<string, unknown>).actions = [];
    const n = resolveZoneSet(noActions, noFile);
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.errors.join(" ")).toContain("non-empty array");

    const noScript = zoneSetDoc();
    ((noScript.zones as Record<string, unknown>[])[0].actions as Record<string, unknown>[])[0] = {
      type: "cutscene",
    };
    const s = resolveZoneSet(noScript, noFile);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.errors.join(" ")).toContain('"script"');
  });

  it("lists every error, not just the first", () => {
    const r = resolveZoneSet({ zones: [] }, noFile);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2); // sceneId + zones
  });
});

describe("planZoneCutsceneSet", () => {
  it("plans one link per cutscene zone and lists plain zones", () => {
    const resolved = resolveZoneSet(zoneSetDoc(), noFile);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const planned = planZoneCutsceneSet(resolved.zoneSet);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.sceneId).toBe("scene-1");
    expect(planned.plan.links).toHaveLength(1);
    const link = planned.plan.links[0];
    expect(link.zone).toBe("Loose flagstone");
    expect(link.cutsceneName).toBe("Test Cutscene");
    expect(link.scriptSteps).toBe(3);
    expect(link.expandedSteps).toBe(3);
    expect(link.kinds).toEqual(["chat", "pause", "chat"]);
    expect(link.triggerFor).toBe("pcs");
    expect(link.mode).toBe("once");
    expect(link.sceneIdInherited).toBe(true);
    expect(planned.plan.plainZones).toEqual(["Pit"]);
  });

  it("reports a formation that needs live state as a plan error", () => {
    const doc = zoneSetDoc();
    const zones = doc.zones as Record<string, unknown>[];
    (zones[0].actions as Record<string, unknown>[])[0].script = {
      version: 1,
      name: "Token center",
      steps: [
        {
          kind: "formation",
          shape: "ring",
          count: 3,
          actor: "Soldier",
          center: { token: "Valeros" },
          radius: 100,
        },
      ],
    };
    const resolved = resolveZoneSet(doc, noFile);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const planned = planZoneCutsceneSet(resolved.zoneSet);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.errors.join(" ")).toContain("cannot expand offline");
  });
});

describe("LinkArming", () => {
  it("once mode fires exactly once until re-armed", () => {
    const arming = new LinkArming();
    expect(arming.shouldFire("z", "tok-a", "once")).toBe(true);
    expect(arming.shouldFire("z", "tok-a", "once")).toBe(false);
    expect(arming.shouldFire("z", "tok-b", "once")).toBe(false);
    arming.leave("z", "tok-a");
    expect(arming.shouldFire("z", "tok-a", "once")).toBe(false); // leaving does not re-arm once
    expect(arming.isArmed("z", "once")).toBe(false);
    arming.arm("z");
    expect(arming.isArmed("z", "once")).toBe(true);
    expect(arming.shouldFire("z", "tok-b", "once")).toBe(true);
  });

  it("once mode honors manual disarm", () => {
    const arming = new LinkArming();
    arming.disarm("z");
    expect(arming.shouldFire("z", "tok-a", "once")).toBe(false);
    expect(arming.isArmed("z", "once")).toBe(false);
    arming.arm("z");
    expect(arming.shouldFire("z", "tok-a", "once")).toBe(true);
  });

  it("per-token mode fires once per token and re-arms on leave", () => {
    const arming = new LinkArming();
    expect(arming.shouldFire("z", "tok-a", "per-token")).toBe(true);
    expect(arming.shouldFire("z", "tok-a", "per-token")).toBe(false);
    expect(arming.shouldFire("z", "tok-b", "per-token")).toBe(true);
    expect(arming.shouldFire("z", "tok-a", "per-token")).toBe(false);
    arming.leave("z", "tok-a");
    expect(arming.shouldFire("z", "tok-a", "per-token")).toBe(true);
    arming.disarm("z");
    expect(arming.shouldFire("z", "tok-c", "per-token")).toBe(false);
    arming.arm("z");
    expect(arming.shouldFire("z", "tok-c", "per-token")).toBe(true);
  });
});

interface FakeToken {
  _id: string;
  name: string;
  actorId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

function fakeLive(tokens: FakeToken[], actorTypes: Record<string, string>, chats: string[]) {
  return {
    raw: () => ({
      getScenes: () => [{ _id: "scene-1", tokens, grid: { size: 100 } }],
      getRawActor: (id: string) => ({ type: actorTypes[id] ?? "character" }),
    }),
    sendChat: async (text: string) => {
      chats.push(text);
    },
  };
}

function cutsceneZoneSet(): ZoneSet {
  const checked = validateCutscene(SCRIPT);
  if (!checked.ok) throw new Error("test fixture script invalid");
  return {
    sceneId: "scene-1",
    zones: [
      {
        name: "Loose flagstone",
        shape: { kind: "rect", x: 1200, y: 600, w: 200, h: 200 },
        triggerFor: "pcs",
        fireOnce: true,
        actions: [{ type: "cutscene", script: checked.script }],
      },
      {
        name: "Pit",
        shape: { kind: "circle", x: 300, y: 300, r: 100 },
        actions: [{ type: "chat", text: "{token} falls in!" }],
      },
    ],
  };
}

describe("TrapWatcher cutscene dispatch", () => {
  it("plays the cutscene once on first entry, then never again until armed", async () => {
    const tokens: FakeToken[] = [
      { _id: "tok-a", name: "Valeros", actorId: "actor-a", x: 1250, y: 650 },
    ];
    const chats: string[] = [];
    const played: { name: string; runKey?: string }[] = [];
    const watcher = new TrapWatcher(
      fakeLive(tokens, { "actor-a": "character" }, chats) as never,
      cutsceneZoneSet(),
      100,
      {
        cutscenePlayer: async (_live, script, opts) => {
          played.push({ name: script.name, runKey: opts?.runKey });
        },
      },
    );
    expect(watcher.isArmed("Loose flagstone")).toBe(true);
    const fires1 = await watcher.checkOnce();
    expect(fires1).toHaveLength(1);
    expect(fires1[0].zone).toBe("Loose flagstone");
    expect(played).toHaveLength(1);
    expect(played[0].name).toBe("Test Cutscene");
    expect(watcher.isArmed("Loose flagstone")).toBe(false);

    // Still inside on the next poll: no replay.
    expect(await watcher.checkOnce()).toHaveLength(0);
    expect(played).toHaveLength(1);
    // Leave and re-enter: still spent.
    tokens[0].x = 100;
    tokens[0].y = 100;
    expect(await watcher.checkOnce()).toHaveLength(0);
    tokens[0].x = 1250;
    tokens[0].y = 650;
    expect(await watcher.checkOnce()).toHaveLength(0);
    expect(played).toHaveLength(1);
    // Creator re-arms: it fires again.
    watcher.arm("Loose flagstone");
    expect(watcher.isArmed("Loose flagstone")).toBe(true);
    expect(await watcher.checkOnce()).toHaveLength(1);
    expect(played).toHaveLength(2);
  });

  it("per-token zones still fire once per token and re-arm on leave", async () => {
    const tokens: FakeToken[] = [
      { _id: "tok-a", name: "Valeros", actorId: "actor-a", x: 300, y: 300 },
      { _id: "tok-b", name: "Kyra", actorId: "actor-b", x: 300, y: 300 },
    ];
    const chats: string[] = [];
    const watcher = new TrapWatcher(
      fakeLive(tokens, { "actor-a": "character", "actor-b": "character" }, chats) as never,
      cutsceneZoneSet(),
    );
    const fires1 = await watcher.checkOnce();
    expect(fires1).toHaveLength(2);
    expect(chats).toEqual(["Valeros falls in!", "Kyra falls in!"]);
    expect(await watcher.checkOnce()).toHaveLength(0);
    tokens[0].x = 900;
    tokens[0].y = 900;
    expect(await watcher.checkOnce()).toHaveLength(0);
    tokens[0].x = 300;
    tokens[0].y = 300;
    const fires2 = await watcher.checkOnce();
    expect(fires2).toHaveLength(1);
    expect(fires2[0].tokenName).toBe("Valeros");
  });

  it("triggerFor pcs skips npcs", async () => {
    const tokens: FakeToken[] = [
      { _id: "tok-n", name: "Goblin", actorId: "actor-n", x: 1250, y: 650 },
    ];
    const chats: string[] = [];
    const played: string[] = [];
    const watcher = new TrapWatcher(
      fakeLive(tokens, { "actor-n": "npc" }, chats) as never,
      cutsceneZoneSet(),
      100,
      { cutscenePlayer: async (_live, script) => void played.push(script.name) },
    );
    expect(await watcher.checkOnce()).toHaveLength(0);
    expect(played).toHaveLength(0);
    expect(watcher.isArmed("Loose flagstone")).toBe(true); // never spent
  });

  it("manual disarm blocks the cutscene until armed again", async () => {
    const tokens: FakeToken[] = [
      { _id: "tok-a", name: "Valeros", actorId: "actor-a", x: 1250, y: 650 },
    ];
    const chats: string[] = [];
    const played: string[] = [];
    const watcher = new TrapWatcher(
      fakeLive(tokens, { "actor-a": "character" }, chats) as never,
      cutsceneZoneSet(),
      100,
      { cutscenePlayer: async (_live, script) => void played.push(script.name) },
    );
    watcher.disarm("Loose flagstone");
    expect(await watcher.checkOnce()).toHaveLength(0);
    expect(played).toHaveLength(0);
    watcher.arm("Loose flagstone");
    expect(await watcher.checkOnce()).toHaveLength(1);
    expect(played).toHaveLength(1);
  });
});

describe("examples/trapdoor demo files", () => {
  it("trapdoor.json validates as a cutscene", () => {
    const parsed = JSON.parse(fs.readFileSync("examples/trapdoor.json", "utf-8"));
    const r = validateCutscene(parsed);
    expect(r.ok).toBe(true);
  });

  it("trapdoor-zones.json resolves and plans to one once-mode link", () => {
    const parsed = JSON.parse(fs.readFileSync("examples/trapdoor-zones.json", "utf-8"));
    const dir = "examples";
    const resolved = resolveZoneSet(parsed, (p) =>
      fs.readFileSync(nodePath.resolve(dir, p), "utf-8"),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const planned = planZoneCutsceneSet(resolved.zoneSet);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.links).toHaveLength(1);
    const link = planned.plan.links[0];
    expect(link.zone).toBe("Loose flagstone");
    expect(link.cutsceneName).toBe("The Floor Gives Way");
    expect(link.mode).toBe("once");
    expect(link.triggerFor).toBe("pcs");
    expect(link.scriptSteps).toBe(5);
    expect(link.expandedSteps).toBe(5);
    expect(link.kinds).toEqual(["chat", "swapTile", "light", "pause", "chat"]);
    expect(link.sceneIdInherited).toBe(true);
    expect(planned.plan.plainZones).toEqual([]);
  });
});
