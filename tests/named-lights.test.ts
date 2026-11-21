/**
 * Tests for FR-7 named lights (BRA-197).
 *
 * Two halves, like the implementation:
 * - Pure (src/session/lights.ts): name normalization, the registry
 *   over a scene's light docs, resolution (exact / unique substring /
 *   unknown / ambiguous), and the per-name plan.
 * - Wiring: the create-doc builder (worldbuilding/index.ts), the
 *   room-spec passthrough (tiles-layout.ts), the dressing hook's
 *   kind names, and the live animate-by-name against a fake world.
 *
 * Import wrinkle: worldbuilding/index.ts pulls in the vendored MCP
 * client (via upload.ts), which validates FOUNDRY_URL at import time
 * — so it is imported dynamically below, after dummy values are set,
 * and the environment is restored right after. No connection is ever
 * made. Run: bun test tests/named-lights.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  animateNamedLights,
  groupNamedLights,
  lightNameOf,
  namedLightPlan,
  namedLightsOf,
  normalizeLightName,
  resolveNamedLights,
  type LightDoc,
} from "../src/session/lights.js";
import { dressingToRoomSpec, planDressing } from "../src/session/dressing.js";
import {
  layoutRoom,
  loadPack,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";
import type { FoundryLive } from "../src/live.js";

// --- dynamic import of the live module (see header) ------------------
const prevEnv = {
  url: process.env.FOUNDRY_URL,
  user: process.env.FOUNDRY_USERNAME,
  pass: process.env.FOUNDRY_PASSWORD,
};
process.env.FOUNDRY_URL ??= "http://localhost:30000";
process.env.FOUNDRY_USERNAME ??= "dummy";
process.env.FOUNDRY_PASSWORD ??= "dummy";
const { lightCreateData } = await import("../src/worldbuilding/index.js");
if (prevEnv.url === undefined) delete process.env.FOUNDRY_URL;
else process.env.FOUNDRY_URL = prevEnv.url;
if (prevEnv.user === undefined) delete process.env.FOUNDRY_USERNAME;
else process.env.FOUNDRY_USERNAME = prevEnv.user;
if (prevEnv.pass === undefined) delete process.env.FOUNDRY_PASSWORD;
else process.env.FOUNDRY_PASSWORD = prevEnv.pass;

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const BASE = "worlds/testbed";

function doc(over: Partial<LightDoc> & { _id: string }): LightDoc {
  return {
    x: 0,
    y: 0,
    config: { dim: 300, bright: 100, color: "#ff9a3c", alpha: 0.5 },
    ...over,
  };
}

function named(id: string, name: string, x = 0, y = 0): LightDoc {
  return doc({
    _id: id,
    x,
    y,
    flags: { "foundry-live": { lightName: name } },
  });
}

const SCENE: LightDoc[] = [
  named("l1", "the braziers", 100, 100),
  named("l2", "the braziers", 300, 100),
  named("l3", "the altar candles", 200, 200),
  named("l4", "the entry torches", 50, 50),
  doc({ _id: "l5", x: 400, y: 400 }), // unnamed — never in a group
];

describe("normalizeLightName", () => {
  it("folds case, drops 'the', collapses whitespace", () => {
    expect(normalizeLightName("The Braziers")).toBe("braziers");
    expect(normalizeLightName("the  altar   candles")).toBe("altar candles");
    expect(normalizeLightName("  TORCHES ")).toBe("torches");
    expect(normalizeLightName("theatre")).toBe("theatre"); // "the" only as a word
  });

  it("returns empty for a blank name", () => {
    expect(normalizeLightName("")).toBe("");
    expect(normalizeLightName("   ")).toBe("");
    expect(normalizeLightName("the")).toBe("");
  });
});

describe("lightNameOf / namedLightsOf / groupNamedLights", () => {
  it("reads the name from the flags, null when absent", () => {
    expect(lightNameOf(named("a", "the braziers"))).toBe("the braziers");
    expect(lightNameOf(doc({ _id: "b" }))).toBeNull();
    expect(lightNameOf(doc({ _id: "c", flags: { "foundry-live": { lightName: "   " } } }))).toBeNull();
    expect(lightNameOf(doc({ _id: "d", flags: { "foundry-live": { lightName: 42 } } }))).toBeNull();
    expect(lightNameOf(doc({ _id: "e", flags: { other: { lightName: "x" } } }))).toBeNull();
  });

  it("lists named lights in scene order, skipping unnamed ones", () => {
    expect(namedLightsOf(SCENE)).toEqual([
      { name: "the braziers", id: "l1" },
      { name: "the braziers", id: "l2" },
      { name: "the altar candles", id: "l3" },
      { name: "the entry torches", id: "l4" },
    ]);
  });

  it("groups by normalized name, first-seen display name kept", () => {
    const lights = [
      named("a", "The Braziers"),
      named("b", "braziers"),
      named("c", "the altar candles"),
    ];
    expect(groupNamedLights(lights)).toEqual([
      { name: "The Braziers", ids: ["a", "b"] },
      { name: "the altar candles", ids: ["c"] },
    ]);
  });

  it("an empty scene has no groups", () => {
    expect(groupNamedLights([])).toEqual([]);
    expect(groupNamedLights([doc({ _id: "x" })])).toEqual([]);
  });
});

describe("resolveNamedLights", () => {
  it("exact match ignores case and 'the'", () => {
    expect(resolveNamedLights(SCENE, "The Braziers")).toEqual({
      name: "the braziers",
      ids: ["l1", "l2"],
    });
    expect(resolveNamedLights(SCENE, "braziers")).toEqual({
      name: "the braziers",
      ids: ["l1", "l2"],
    });
  });

  it("a unique substring match resolves", () => {
    expect(resolveNamedLights(SCENE, "brazier")).toEqual({
      name: "the braziers",
      ids: ["l1", "l2"],
    });
    expect(resolveNamedLights(SCENE, "altar")).toEqual({
      name: "the altar candles",
      ids: ["l3"],
    });
  });

  it("an unknown name errors and lists the names that exist", () => {
    expect(() => resolveNamedLights(SCENE, "the chandelier")).toThrow(
      /No light named "the chandelier".*named lights here: "the braziers", "the altar candles", "the entry torches"/,
    );
  });

  it("a name matching several groups errors and lists the matches", () => {
    const lights = [
      named("a", "the entry torches"),
      named("b", "the torches"),
      named("c", "the braziers"),
    ];
    expect(() => resolveNamedLights(lights, "torch")).toThrow(
      /"torch" matches more than one light: "the entry torches", "the torches" — name one exactly/,
    );
  });

  it("a blank query errors and lists the names to pick from", () => {
    expect(() => resolveNamedLights(SCENE, "  ")).toThrow(
      /Name a light — named lights on this scene: "the braziers", "the altar candles", "the entry torches"/,
    );
  });

  it("a scene with no named lights says so instead of listing names", () => {
    expect(() => resolveNamedLights([doc({ _id: "x" })], "the braziers")).toThrow(
      /has no named lights/,
    );
  });
});

describe("namedLightPlan", () => {
  it("plans one transition per light in the group, from each light's own state", () => {
    const plan = namedLightPlan(SCENE, "the braziers", { dim: 0, bright: 0 }, {});
    expect(plan.name).toBe("the braziers");
    expect(plan.targets).toHaveLength(2);
    expect(plan.targets[0]).toEqual({
      lightId: "l1",
      from: { dim: 300, bright: 100, color: "#ff9a3c", alpha: 0.5 },
      to: { dim: 0, bright: 0, color: "#ff9a3c", alpha: 0.5 },
      durationMs: 2000,
      steps: 12,
    });
    expect(plan.targets[1].lightId).toBe("l2");
  });

  it("a partial target leaves the other fields where they are", () => {
    const plan = namedLightPlan(SCENE, "the altar candles", { color: "#7ec8ff" }, {});
    expect(plan.targets[0].to).toEqual({
      dim: 300,
      bright: 100,
      color: "#7ec8ff",
      alpha: 0.5,
    });
  });

  it("validates the plan the same strict way as the other light plans", () => {
    expect(() => namedLightPlan(SCENE, "the braziers", { color: "red" }, {})).toThrow(
      /Invalid hex color/,
    );
    expect(() => namedLightPlan(SCENE, "the braziers", {}, { durationMs: 0 })).toThrow(
      /durationMs must be > 0/,
    );
    expect(() => namedLightPlan(SCENE, "the braziers", {}, { steps: 0 })).toThrow(
      /steps must be an integer >= 1/,
    );
  });

  it("an unknown name throws before any plan is built", () => {
    expect(() => namedLightPlan(SCENE, "the chandelier", {}, {})).toThrow(/No light named/);
  });
});

describe("lightCreateData — the name flag at build time", () => {
  it("stamps the name into the light's flags", () => {
    const data = lightCreateData({
      x: 100,
      y: 100,
      dim: 300,
      bright: 100,
      name: "the braziers",
    });
    expect(data.flags).toEqual({ "foundry-live": { lightName: "the braziers" } });
    expect(data.config).toEqual({
      dim: 300,
      bright: 100,
      angle: 360,
      color: "#ff9a3c",
      alpha: 0.5,
    });
  });

  it("merges the name flag with the tile-room embed key under one scope", () => {
    const data = lightCreateData(
      { x: 0, y: 0, dim: 100, bright: 50, name: "the altar candles" },
      "tile-room:entry:light:3",
    );
    expect(data.flags).toEqual({
      "foundry-live": {
        tileRoomKey: "tile-room:entry:light:3",
        lightName: "the altar candles",
      },
    });
  });

  it("an unnamed light with no embed key carries no flags at all — behavior unchanged", () => {
    const data = lightCreateData({ x: 0, y: 0, dim: 100, bright: 50 });
    expect("flags" in data).toBe(false);
  });

  it("a blank name stamps nothing", () => {
    const data = lightCreateData({ x: 0, y: 0, dim: 100, bright: 50, name: "   " });
    expect("flags" in data).toBe(false);
  });

  it("trims the stored name", () => {
    const data = lightCreateData({ x: 0, y: 0, dim: 100, bright: 50, name: "  the braziers " });
    expect(data.flags).toEqual({ "foundry-live": { lightName: "the braziers" } });
  });
});

describe("room spec passthrough — layoutRoom", () => {
  it("an explicit named light keeps its name; torch shorthand stays unnamed", () => {
    const spec: RoomSpec = {
      name: "Test Room",
      gridW: 8,
      gridH: 6,
      seed: 42,
      torches: [{ gx: 1, gy: 1 }],
      lights: [{ x: 200, y: 200, dim: 300, bright: 100, name: "the braziers" }],
    };
    const layout = layoutRoom(spec, pack, BASE);
    const namedLights = layout.lights.filter((l) => l.name !== undefined);
    expect(namedLights).toHaveLength(1);
    expect(namedLights[0].name).toBe("the braziers");
    expect(layout.lights).toHaveLength(2);
  });

  it("a room with no names has no named lights — unchanged behavior", () => {
    const spec: RoomSpec = {
      name: "Test Room",
      gridW: 8,
      gridH: 6,
      seed: 42,
      torches: [{ gx: 1, gy: 1 }],
    };
    const layout = layoutRoom(spec, pack, BASE);
    expect(layout.lights).toHaveLength(1);
    expect(layout.lights[0].name).toBeUndefined();
    expect(groupNamedLights(layout.lights.map((l) => ({ ...l, _id: "x" })))).toEqual([]);
  });
});

describe("dressingToRoomSpec — kind names", () => {
  it("names each light for its kind, so a whole kind is addressable", () => {
    const spec: RoomSpec = {
      name: "Test Room",
      gridW: 10,
      gridH: 10,
      seed: 1,
      doors: [{ wall: "north", at: 4 }],
    };
    const plan = planDressing(spec, {
      tables: [
        { gx: 3, gy: 2 },
        { gx: 5, gy: 3 },
      ],
    });
    const out = dressingToRoomSpec(plan);
    const names = new Set(out.lights.map((l) => l.name));
    expect(names.has("the torches")).toBe(true);
    expect(names.has("the candles")).toBe(true);
    expect(names.has("the braziers")).toBe(true);
    expect(out.lights.every((l) => l.name === "the torches" || l.name === "the candles" || l.name === "the braziers")).toBe(true);
    // The names ride the LightSpec shape into the room spec.
    const asLightSpecs = out.lights as { name?: string }[];
    expect(asLightSpecs.every((l) => typeof l.name === "string")).toBe(true);
  });
});

describe("animateNamedLights — live half against a fake world", () => {
  function fakeLive() {
    const calls: { type: string; op: string; args: unknown }[] = [];
    const scenes = [
      {
        _id: "scene-1",
        name: "Entry Hall",
        lights: SCENE,
      },
    ];
    const live = {
      raw: () => ({
        getWorldData: () => ({ scenes }),
      }),
      modifyDocument: async (type: string, op: string, args: unknown) => {
        calls.push({ type, op, args });
        return [{ _id: "ok" }];
      },
    };
    return { live, calls, scenes };
  }

  it("animates every light in the group, and only those", async () => {
    const { live, calls } = fakeLive();
    const out = await animateNamedLights(
      live as unknown as FoundryLive,
      "scene-1",
      "the braziers",
      { dim: 0, bright: 0 },
      { durationMs: 100, steps: 2 },
    );
    expect(out.name).toBe("the braziers");
    expect(out.results.map((r) => r.lightId).sort()).toEqual(["l1", "l2"]);
    expect(out.results[0].final).toEqual({ dim: 0, bright: 0, color: "#ff9a3c", alpha: 0.5 });
    const updated = calls.filter((c) => c.type === "AmbientLight");
    // Two lights x two steps each.
    expect(updated).toHaveLength(4);
    const ids = updated.map(
      (c) => (c.args as { updates: { _id: string }[] }).updates[0]._id,
    );
    expect(ids.sort()).toEqual(["l1", "l1", "l2", "l2"]);
    // The final step lands at the target for each light.
    const finals = updated.filter(
      (c) => (c.args as { updates: { "config.dim": number }[] }).updates[0]["config.dim"] === 0,
    );
    expect(finals).toHaveLength(2);
  });

  it("an unknown name throws before any update is sent", async () => {
    const { live, calls } = fakeLive();
    await expect(
      animateNamedLights(live as unknown as FoundryLive, "scene-1", "the chandelier", { dim: 0 }, {}),
    ).rejects.toThrow(/No light named "the chandelier"/);
    expect(calls).toHaveLength(0);
  });

  it("resolves the scene by name as well as by id", async () => {
    const { live, calls } = fakeLive();
    const out = await animateNamedLights(
      live as unknown as FoundryLive,
      "Entry Hall",
      "altar",
      { dim: 0 },
      { durationMs: 100, steps: 1 },
    );
    expect(out.name).toBe("the altar candles");
    expect(out.results).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
