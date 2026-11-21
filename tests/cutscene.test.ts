/**
 * Cutscene engine tests (FR-5, FR-13) — pure validation, formation
 * geometry, expansion, and light math. No Foundry connection: the
 * timeline player itself is live-tested next session.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import {
  validateCutscene,
  expandCutscene,
} from "../src/session/cutscene.js";
import type { CutsceneScript } from "../src/session/cutscene.js";
import {
  ringPositions,
  linePositions,
  wedgePositions,
  angleToFace,
  angleToEast,
} from "../src/session/formations.js";
import { lerpLight, parseHexColor } from "../src/session/lights.js";
import { findTileAtCell } from "../src/session/tile-ops.js";

function validScript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "Test Scene",
    sceneId: "Test Scene",
    steps: [{ kind: "chat", content: "Hello." }],
    ...overrides,
  };
}

describe("validateCutscene", () => {
  it("accepts a minimal valid script", () => {
    const r = validateCutscene(validScript());
    expect(r.ok).toBe(true);
  });

  it("rejects a non-object, a bad version, and a missing name", () => {
    expect(validateCutscene(null).ok).toBe(false);
    expect(validateCutscene(validScript({ version: 2 })).ok).toBe(false);
    expect(validateCutscene(validScript({ name: "" })).ok).toBe(false);
    expect(validateCutscene(validScript({ steps: [] })).ok).toBe(false);
  });

  it("rejects an unknown step kind and an unknown step field", () => {
    const badKind = validateCutscene(validScript({ steps: [{ kind: "teleport", x: 1 }] }));
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.errors[0]).toContain("unknown kind");
    const badField = validateCutscene(
      validScript({ steps: [{ kind: "pause", ms: 100, raduis: 5 }] }),
    );
    expect(badField.ok).toBe(false);
    if (!badField.ok) expect(badField.errors[0]).toContain('unknown field "raduis"');
  });

  it("lists every error, not just the first", () => {
    const r = validateCutscene(
      validScript({
        version: 3,
        steps: [
          { kind: "move", token: "X" },
          { kind: "pause", ms: -5 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects bad formation shapes and counts", () => {
    const bad = validateCutscene(
      validScript({
        steps: [
          { kind: "formation", shape: "circle", count: 9, actor: "Soldier", center: { x: 1, y: 1 }, radius: 100 },
          { kind: "formation", shape: "ring", count: 0, actor: "Soldier", center: { x: 1, y: 1 }, radius: 100 },
          { kind: "formation", shape: "ring", count: 9, actor: "Soldier", radius: -5 },
        ],
      }),
    );
    expect(bad.ok).toBe(false);
    // shape error (1) + count error (1) + missing center and bad radius (2).
    if (!bad.ok) expect(bad.errors.length).toBe(4);
  });

  it("rejects a face step with no target", () => {
    const r = validateCutscene(validScript({ steps: [{ kind: "face", token: "X" }] }));
    expect(r.ok).toBe(false);
  });

  it("accepts a face step with an absolute rotation", () => {
    const r = validateCutscene(
      validScript({ steps: [{ kind: "face", token: "X", rotation: 180 }] }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a bad light color and a bad light selector", () => {
    const badColor = validateCutscene(
      validScript({ steps: [{ kind: "light", light: { id: "abc" }, color: "red" }] }),
    );
    expect(badColor.ok).toBe(false);
    const badSel = validateCutscene(
      validScript({ steps: [{ kind: "light", light: { near: { x: 1, y: 1 } } }] }),
    );
    expect(badSel.ok).toBe(false);
  });

  it("light: accepts {name}, and rejects blank names, two selectors, and from + name", () => {
    const byName = validateCutscene(
      validScript({ steps: [{ kind: "light", light: { name: "the braziers" }, dim: 0 }] }),
    );
    expect(byName.ok).toBe(true);
    const blank = validateCutscene(
      validScript({ steps: [{ kind: "light", light: { name: "   " }, dim: 0 }] }),
    );
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors.join(" ")).toContain("non-empty string");
    const both = validateCutscene(
      validScript({ steps: [{ kind: "light", light: { id: "abc", name: "the braziers" }, dim: 0 }] }),
    );
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.errors.join(" ")).toContain("exactly one");
    const fromName = validateCutscene(
      validScript({
        steps: [{ kind: "light", light: { name: "the braziers" }, dim: 0, from: { dim: 300 } }],
      }),
    );
    expect(fromName.ok).toBe(false);
    if (!fromName.ok) expect(fromName.errors.join(" ")).toContain("does not apply to a group");
    // {id} + from is still fine — from is how the id/at path seeds the fade.
    const idFrom = validateCutscene(
      validScript({
        steps: [{ kind: "light", light: { id: "abc" }, dim: 0, from: { dim: 300 } }],
      }),
    );
    expect(idFrom.ok).toBe(true);
  });

  it("swapTile: exactly one of tile/cell, and a non-empty to", () => {
    const both = validateCutscene(
      validScript({ steps: [{ kind: "swapTile", tile: "abc", cell: { x: 1, y: 2 }, to: "a.png" }] }),
    );
    expect(both.ok).toBe(false);
    const neither = validateCutscene(
      validScript({ steps: [{ kind: "swapTile", to: "a.png" }] }),
    );
    expect(neither.ok).toBe(false);
    const badCell = validateCutscene(
      validScript({ steps: [{ kind: "swapTile", cell: { x: 1 }, to: "a.png" }] }),
    );
    expect(badCell.ok).toBe(false);
    const byId = validateCutscene(
      validScript({ steps: [{ kind: "swapTile", tile: "abc123", to: "a.png" }] }),
    );
    expect(byId.ok).toBe(true);
    const byCell = validateCutscene(
      validScript({ steps: [{ kind: "swapTile", cell: { x: 300, y: 400 }, to: "a.png" }] }),
    );
    expect(byCell.ok).toBe(true);
  });
});

describe("angleToFace", () => {
  it("is 0 north, 90 east, 180 south, 270 west", () => {
    expect(angleToFace({ x: 0, y: 0 }, { x: 0, y: -100 })).toBe(0);
    expect(angleToFace({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe(90);
    expect(angleToFace({ x: 0, y: 0 }, { x: 0, y: 100 })).toBe(180);
    expect(angleToFace({ x: 0, y: 0 }, { x: -100, y: 0 })).toBe(270);
    expect(angleToFace({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });
});

describe("angleToEast", () => {
  it("is 0 east, 90 south, 180 west, -90 north (screen coords, unnormalized)", () => {
    expect(angleToEast({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe(0);
    expect(angleToEast({ x: 0, y: 0 }, { x: 0, y: 100 })).toBe(90);
    expect(angleToEast({ x: 0, y: 0 }, { x: -100, y: 0 })).toBe(180);
    expect(angleToEast({ x: 0, y: 0 }, { x: 0, y: -100 })).toBe(-90);
    expect(angleToEast({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });

  it("is angleToFace minus 90 for the cardinal directions", () => {
    const pairs: [{ x: number; y: number }, { x: number; y: number }][] = [
      [{ x: 0, y: 0 }, { x: 0, y: -100 }],
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0, y: 100 }],
      [{ x: 0, y: 0 }, { x: -100, y: 0 }],
    ];
    for (const [from, to] of pairs) {
      const north = angleToFace(from, to);
      const east = angleToEast(from, to);
      // Same physical direction, different zero: east = north - 90 (mod 360, unnormalized).
      const diff = (((east - (north - 90)) % 360) + 360) % 360;
      expect(diff === 0 || diff === 360).toBe(true);
    }
  });
});

describe("ringPositions", () => {
  it("places 9 evenly on a circle, all facing the center", () => {
    const center = { x: 800, y: 800 };
    const pts = ringPositions(9, center, 400);
    expect(pts).toHaveLength(9);
    for (const p of pts) {
      expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeCloseTo(400, 0);
    }
    const angles = pts
      .map((p) => Math.atan2(p.y - center.y, p.x - center.x))
      .sort((a, b) => a - b);
    for (let i = 0; i < angles.length; i++) {
      const gap = angles[(i + 1) % angles.length] - angles[i];
      const deg = ((gap < 0 ? gap + 2 * Math.PI : gap) * 180) / Math.PI;
      expect(deg).toBeCloseTo(40, 0);
    }
    // Position 0 is at the top (north) and faces south, toward the center.
    expect(pts[0].x).toBe(800);
    expect(pts[0].y).toBe(400);
    expect(pts[0].facingDeg).toBe(180);
  });

  it("rejects a bad count and radius", () => {
    expect(() => ringPositions(0, { x: 0, y: 0 }, 100)).toThrow();
    expect(() => ringPositions(3, { x: 0, y: 0 }, -1)).toThrow();
  });
});

describe("linePositions and wedgePositions", () => {
  it("line hits both ends, evenly spaced, facing along the line", () => {
    const pts = linePositions(3, { x: 0, y: 0 }, { x: 200, y: 0 });
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ x: 0, y: 0, facingDeg: 90 });
    expect(pts[1]).toEqual({ x: 100, y: 0, facingDeg: 90 });
    expect(pts[2]).toEqual({ x: 200, y: 0, facingDeg: 90 });
    expect(linePositions(1, { x: 5, y: 6 }, { x: 9, y: 9 })).toHaveLength(1);
  });

  it("wedge starts at the apex, is symmetric, faces its direction", () => {
    const pts = wedgePositions(5, { x: 0, y: 0 }, 180, { spreadDeg: 60, spacing: 100 });
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual({ x: 0, y: 0, facingDeg: 180 });
    for (const p of pts) expect(p.facingDeg).toBe(180);
    // Rank 1: one on each arm, symmetric in x.
    expect(pts[1].x).toBe(-pts[2].x);
    expect(pts[1].y).toBe(pts[2].y);
  });

  it("wedge armOrder right-first swaps the arms within each rank (BRA-201)", () => {
    const opts = { spreadDeg: 60, spacing: 100 };
    const def = wedgePositions(5, { x: 0, y: 0 }, 180, opts);
    const rev = wedgePositions(5, { x: 0, y: 0 }, 180, { ...opts, armOrder: "right-first" });
    expect(rev).toHaveLength(5);
    expect(rev[0]).toEqual({ x: 0, y: 0, facingDeg: 180 });
    for (const p of rev) expect(p.facingDeg).toBe(180);
    // Same five positions, arms swapped within each rank.
    expect(rev[1]).toEqual(def[2]);
    expect(rev[2]).toEqual(def[1]);
    expect(rev[3]).toEqual(def[4]);
    expect(rev[4]).toEqual(def[3]);
  });

  it("wedge rejects a bad armOrder", () => {
    expect(() =>
      wedgePositions(3, { x: 0, y: 0 }, 180, { armOrder: "middle-first" as never }),
    ).toThrow(/armOrder/);
  });
});

describe("expandCutscene", () => {
  it("expands a ring formation of 9 with entry + props into 44 steps", () => {
    const r = validateCutscene(
      validScript({
        steps: [
          {
            kind: "formation",
            shape: "ring",
            count: 9,
            actor: "Soldier",
            center: { x: 800, y: 800 },
            radius: 400,
            enterFrom: { x: 800, y: 1500 },
            speed: 300,
            staggerMs: 600,
            namePrefix: "Ambush Soldier",
            prop: { src: "worlds/testbed/spear.png", width: 200, height: 200 },
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = expandCutscene(r.script);
    // 9 members x (place, move, face, prop) + 8 stagger pauses = 44.
    expect(steps).toHaveLength(44);
    expect(steps[0].kind).toBe("place");
    expect((steps[0] as { name?: string }).name).toBe("Ambush Soldier 1");
    // Keys are deterministic and unique per member.
    const keys = steps
      .filter((s) => s.kind === "place")
      .map((s) => (s as { key?: string }).key);
    expect(new Set(keys).size).toBe(9);
    expect(keys[0]).toBe("cutscene:Test Scene:0-1");
    // The prop is centered on its member and rotated to face the center.
    const prop = steps.find((s) => s.kind === "prop") as {
      x: number; y: number; rotation: number;
    };
    expect(prop).toBeDefined();
    // Member 1 is at (800, 400); prop is 200x200 centered on (850, 450).
    expect(prop.x).toBe(750);
    expect(prop.y).toBe(350);
    expect(prop.rotation).toBe(180);
    // Stagger pauses sit between members.
    expect(steps.filter((s) => s.kind === "pause")).toHaveLength(8);
  });

  it("places directly when there is no enterFrom", () => {
    const r = validateCutscene(
      validScript({
        steps: [
          { kind: "formation", shape: "ring", count: 3, actor: "Guard", center: { x: 0, y: 0 }, radius: 100 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = expandCutscene(r.script);
    expect(steps).toHaveLength(6); // 3 x (place, face)
    expect(steps.every((s) => s.kind === "place" || s.kind === "face")).toBe(true);
  });

  it("resolves a token center through the resolver, and errors without one", () => {
    const script = validScript({
      steps: [
        { kind: "formation", shape: "ring", count: 2, actor: "Guard", center: { token: "Valeros" }, radius: 100 },
      ],
    }) as unknown as CutsceneScript;
    expect(() => expandCutscene(script)).toThrow(/live resolver/);
    const steps = expandCutscene(script, {
      centerOf: () => ({ x: 500, y: 500 }),
    });
    expect(steps).toHaveLength(4);
    expect((steps[0] as { x: number; y: number }).x).toBe(500);
  });

  it("injects the script sceneId into steps that omit it", () => {
    const r = validateCutscene(
      validScript({
        steps: [{ kind: "move", token: "X", x: 1, y: 2 }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = expandCutscene(r.script);
    expect((steps[0] as { sceneId?: string }).sceneId).toBe("Test Scene");
  });

  it("passes swapTile through unchanged", () => {
    const r = validateCutscene(
      validScript({
        steps: [{ kind: "swapTile", cell: { x: 300, y: 400 }, to: "worlds/testbed/pit.png" }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = expandCutscene(r.script);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      kind: "swapTile",
      sceneId: "Test Scene",
      cell: { x: 300, y: 400 },
      to: "worlds/testbed/pit.png",
    });
  });
});

describe("lerpLight", () => {
  it("interpolates numbers and color, and rejects a bad color", () => {
    const from = { dim: 100, bright: 50, color: "#000000", alpha: 0.5 };
    const to = { dim: 200, bright: 100, color: "#ffffff", alpha: 1 };
    const mid = lerpLight(from, to, 0.5);
    expect(mid.dim).toBe(150);
    expect(mid.bright).toBe(75);
    expect(mid.alpha).toBe(0.75);
    expect(mid.color).toBe("#808080");
    expect(() => parseHexColor("red")).toThrow();
  });
});

describe("findTileAtCell", () => {
  it("matches on exact top-left, nothing otherwise", () => {
    const tiles = [
      { _id: "a", x: 0, y: 0 },
      { _id: "b", x: 300, y: 400 },
    ];
    expect(findTileAtCell(tiles, 300, 400)?._id).toBe("b");
    expect(findTileAtCell(tiles, 300, 401)).toBeUndefined();
    expect(findTileAtCell([], 0, 0)).toBeUndefined();
  });
});

describe("examples/ambush.json", () => {
  it("validates and expands to the ambush: 9 soldiers, mage, light bloom", () => {
    const raw: unknown = JSON.parse(
      fs.readFileSync("examples/ambush.json", "utf-8"),
    );
    const r = validateCutscene(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = expandCutscene(r.script);
    // chat + formation (44) + pause + place + move + face + light + chat = 51.
    expect(steps).toHaveLength(51);
    const places = steps.filter((s) => s.kind === "place");
    expect(places).toHaveLength(10); // 9 soldiers + the mage
    const light = steps.find((s) => s.kind === "light") as {
      durationMs?: number; dim?: number; bright?: number; color?: string;
    };
    expect(light.durationMs).toBe(3000);
    expect(light.dim).toBe(600);
    expect(light.bright).toBe(300);
    expect(light.color).toBe("#ffd27a");
    const props = steps.filter((s) => s.kind === "prop");
    expect(props).toHaveLength(9);
    expect(props.every((s) => (s as { src?: string }).src === "worlds/testbed/spear.png")).toBe(true);
  });
});
