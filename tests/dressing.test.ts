import { describe, expect, test } from "bun:test";
import {
  BRAZIER_MIN_SIZE,
  dressingToRoomSpec,
  formatDressingPlan,
  planDressing,
  toggleDressing,
  validateDressingPlan,
  type DressingPlan,
} from "../src/session/dressing.js";
import type { RoomSpec } from "../src/worldbuilding/tiles-layout.js";

function room(over: Partial<RoomSpec> = {}): RoomSpec {
  return { name: "Test Room", gridW: 8, gridH: 6, seed: 1, ...over };
}

describe("planDressing — torches", () => {
  test("places torches every 3 cells along each wall, skipping corners", () => {
    const plan = planDressing(room(), { candleCount: 0 });
    const torches = plan.items.filter((i) => i.kind === "torch");
    expect(torches).toHaveLength(8);
    expect(torches.map((t) => `${t.gx},${t.gy}`).sort()).toEqual(
      ["1,0", "4,0", "1,5", "4,5", "0,1", "0,4", "7,1", "7,4"].sort(),
    );
    // No torch in any corner.
    for (const t of torches) {
      expect([t.gx, t.gy]).not.toEqual([0, 0]);
      expect([t.gx, t.gy]).not.toEqual([7, 5]);
    }
  });

  test("never places a torch on a door cell", () => {
    const plan = planDressing(
      room({ doors: [{ wall: "north", at: 4 }, { wall: "south", at: 3 }] }),
      { candleCount: 0 },
    );
    const torches = plan.items.filter((i) => i.kind === "torch");
    expect(torches).toHaveLength(7);
    expect(torches.some((t) => t.gx === 4 && t.gy === 0)).toBe(false);
  });

  test("spacing option is honoured", () => {
    const plan = planDressing(room(), { spacing: 2, candleCount: 0 });
    // North/south (8 cells): at 1,3,5. West/east (6 cells): at 1,3.
    expect(plan.items.filter((i) => i.kind === "torch")).toHaveLength(10);
  });

  test("torch light is warm amber with the lighting-fix values", () => {
    const plan = planDressing(room(), { candleCount: 0 });
    const torch = plan.items.find((i) => i.kind === "torch")!;
    expect(torch.light).toEqual({
      x: torch.gx * 100 + 50,
      y: torch.gy * 100 + 50,
      dim: 300,
      bright: 120,
      color: "#ff9a3c",
      alpha: 0.4,
    });
    expect(torch.tile).toBe("sconce");
    expect(torch.placement).toBe("wall");
  });
});

describe("planDressing — candles", () => {
  test("candles go on table cells when tables are given", () => {
    const plan = planDressing(room(), {
      tables: [
        { gx: 3, gy: 2 },
        { gx: 5, gy: 3 },
      ],
    });
    const candles = plan.items.filter((i) => i.kind === "candle");
    expect(candles).toHaveLength(2);
    expect(candles.map((c) => c.placement)).toEqual(["table", "table"]);
    expect(candles.map((c) => `${c.gx},${c.gy}`).sort()).toEqual(["3,2", "5,3"]);
    expect(candles[0].light.dim).toBe(120);
    expect(candles[0].light.bright).toBe(60);
  });

  test("table candles are capped at maxCandles", () => {
    const tables = Array.from({ length: 8 }, (_, i) => ({ gx: 1 + i, gy: 2 }));
    // gx 1..8 — one is outside the 8-wide room, so 7 valid tables.
    const plan = planDressing(room(), { tables });
    expect(plan.items.filter((i) => i.kind === "candle")).toHaveLength(6);
  });

  test("candles fall back to floor cells next to a wall when there are no tables", () => {
    const plan = planDressing(room(), { candleCount: 2 });
    const candles = plan.items.filter((i) => i.kind === "candle");
    expect(candles).toHaveLength(2);
    for (const c of candles) {
      expect(c.placement).toBe("floor");
      const adjacent =
        c.gx === 1 || c.gx === 6 || c.gy === 1 || c.gy === 4;
      expect(adjacent).toBe(true);
    }
  });

  test("candle and brazier tiles are honestly missing, not faked", () => {
    const plan = planDressing(room({ gridW: 8, gridH: 8 }), {});
    const candle = plan.items.find((i) => i.kind === "candle")!;
    const brazier = plan.items.find((i) => i.kind === "brazier")!;
    expect(candle.tile).toBeNull();
    expect(candle.tileNeeded).toBe("candle");
    expect(brazier.tile).toBeNull();
    expect(brazier.tileNeeded).toBe("brazier");
    expect([...plan.tileGaps].sort()).toEqual(["brazier", "candle"]);
  });
});

describe("planDressing — braziers", () => {
  test("large rooms get a brazier in each corner", () => {
    const plan = planDressing(room({ gridW: 8, gridH: 8 }), { candleCount: 0 });
    const braziers = plan.items.filter((i) => i.kind === "brazier");
    expect(braziers).toHaveLength(4);
    expect(braziers.map((b) => `${b.gx},${b.gy}`).sort()).toEqual(
      ["0,0", "0,7", "7,0", "7,7"].sort(),
    );
    expect(braziers[0].light.dim).toBe(400);
    expect(braziers[0].light.bright).toBe(200);
  });

  test("small rooms get no braziers", () => {
    const plan = planDressing(room(), {});
    expect(plan.items.filter((i) => i.kind === "brazier")).toHaveLength(0);
    expect(BRAZIER_MIN_SIZE).toBe(8);
  });

  test("braziers can be switched off", () => {
    const plan = planDressing(room({ gridW: 8, gridH: 8 }), { braziers: false });
    expect(plan.items.filter((i) => i.kind === "brazier")).toHaveLength(0);
  });
});

describe("planDressing — determinism and shape", () => {
  test("same seed gives an identical plan", () => {
    const a = planDressing(room(), { seed: 7 });
    const b = planDressing(room(), { seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("no two items share a cell", () => {
    const plan = planDressing(room({ gridW: 10, gridH: 10 }), {
      tables: [
        { gx: 1, gy: 1 },
        { gx: 5, gy: 5 },
      ],
    });
    const cells = plan.items.map((i) => `${i.gx},${i.gy}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(validateDressingPlan(plan, room({ gridW: 10, gridH: 10 }))).toEqual([]);
  });

  test("every item has a matching light in the plan", () => {
    const plan = planDressing(room(), {});
    expect(plan.lights).toHaveLength(plan.items.length);
    for (const item of plan.items) {
      const light = plan.lights.find((l) => l.itemId === item.id);
      expect(light).toBeDefined();
      expect(light!.dim).toBe(item.light.dim);
      expect(light!.lightId).toBeNull();
    }
  });
});

describe("toggleDressing", () => {
  test("turning a lit torch off hides it and zeroes the alpha", () => {
    const plan = planDressing(room(), { candleCount: 0 });
    const torch = plan.items.find((i) => i.kind === "torch")!;
    const result = toggleDressing(torch, "unlit");
    expect(result.update).toEqual({ hidden: true, "config.alpha": 0 });
    expect(result.chatLine).toBe("The torch gutters out.");
    expect(result.item.state).toBe("unlit");
    expect(result.lightId).toBeNull();
  });

  test("relighting restores the same light", () => {
    const plan = planDressing(room(), { candleCount: 0 });
    const torch = plan.items.find((i) => i.kind === "torch")!;
    const off = toggleDressing(torch, "unlit");
    const on = toggleDressing(off.item, "lit");
    expect(on.update).toEqual({ hidden: false, "config.alpha": 0.4 });
    expect(on.chatLine).toBe("The torch sputters to life.");
    expect(on.item.light).toEqual(torch.light);
  });

  test("toggle is pure — the input item is untouched", () => {
    const plan = planDressing(room(), { candleCount: 0 });
    const torch = plan.items.find((i) => i.kind === "torch")!;
    toggleDressing(torch, "unlit");
    expect(torch.state).toBe("lit");
  });

  test("each kind has its own toggle lines", () => {
    const plan = planDressing(room({ gridW: 8, gridH: 8 }), {});
    const candle = plan.items.find((i) => i.kind === "candle")!;
    const brazier = plan.items.find((i) => i.kind === "brazier")!;
    expect(toggleDressing(candle, "lit").chatLine).toBe(
      "The candle's flame steadies and grows.",
    );
    expect(toggleDressing(brazier, "unlit").chatLine).toBe(
      "The brazier's fire dies down to embers.",
    );
  });

  test("a built lightId rides through the toggle", () => {
    const plan = planDressing(room(), { candleCount: 0 });
    const torch = { ...plan.items.find((i) => i.kind === "torch")!, lightId: "abc123" };
    expect(toggleDressing(torch, "unlit").lightId).toBe("abc123");
  });
});

describe("validateDressingPlan", () => {
  test("a generated plan is valid", () => {
    const spec = room({ gridW: 8, gridH: 8 });
    expect(validateDressingPlan(planDressing(spec, {}), spec)).toEqual([]);
  });

  test("catches an item outside the room", () => {
    const spec = room();
    const plan = planDressing(spec, {});
    const bad: DressingPlan = {
      ...plan,
      items: [{ ...plan.items[0], gx: 99 }],
    };
    expect(validateDressingPlan(bad, spec).join(" ")).toMatch(/outside/);
  });

  test("catches a light with no matching item", () => {
    const spec = room();
    const plan = planDressing(spec, {});
    const bad: DressingPlan = {
      ...plan,
      lights: [
        ...plan.lights,
        { itemId: "ghost", x: 50, y: 50, dim: 100, bright: 50, color: "#ffffff", alpha: 0.5, lightId: null },
      ],
    };
    expect(validateDressingPlan(bad, spec).join(" ")).toMatch(/no matching item/);
  });

  test("catches an item with no light", () => {
    const spec = room();
    const plan = planDressing(spec, {});
    const bad: DressingPlan = {
      ...plan,
      lights: plan.lights.filter((l) => l.itemId !== plan.items[0].id),
    };
    expect(validateDressingPlan(bad, spec).join(" ")).toMatch(/has no light/);
  });

  test("catches two items on one cell", () => {
    const spec = room();
    const plan = planDressing(spec, {});
    const bad: DressingPlan = {
      ...plan,
      items: [
        plan.items[0],
        { ...plan.items[1], gx: plan.items[0].gx, gy: plan.items[0].gy },
        ...plan.items.slice(2),
      ],
    };
    expect(validateDressingPlan(bad, spec).join(" ")).toMatch(/Two items on cell/);
  });

  test("catches a torch on a door cell", () => {
    const spec = room({ doors: [{ wall: "north", at: 1 }] });
    const plan = planDressing(spec, { candleCount: 0 });
    const bad: DressingPlan = {
      ...plan,
      items: [{ ...plan.items[0], gx: 1, gy: 0 }],
    };
    expect(validateDressingPlan(bad, spec).join(" ")).toMatch(/door cell/);
  });

  test("catches a brazier in a small room", () => {
    const spec = room();
    const plan = planDressing(spec, {});
    const fake = {
      id: "brazier-nw",
      kind: "brazier" as const,
      gx: 0,
      gy: 0,
      tile: null,
      tileNeeded: "brazier",
      placement: "floor" as const,
      light: { x: 50, y: 50, dim: 400, bright: 200, color: "#ff8c2e", alpha: 0.5 },
      lightId: null,
      state: "lit" as const,
      chatLines: { lit: "x", unlit: "y" },
    };
    const bad: DressingPlan = {
      ...plan,
      items: [...plan.items, fake],
      lights: [
        ...plan.lights,
        { itemId: "brazier-nw", ...fake.light, lightId: null },
      ],
    };
    expect(validateDressingPlan(bad, spec).join(" ")).toMatch(/braziers need/);
  });
});

describe("dressingToRoomSpec", () => {
  test("maps a plan onto the composer hook's inputs", () => {
    const spec = room({ doors: [{ wall: "north", at: 4 }, { wall: "south", at: 3 }] });
    const plan = planDressing(spec, {
      tables: [
        { gx: 3, gy: 2 },
        { gx: 5, gy: 3 },
      ],
    });
    const out = dressingToRoomSpec(plan);
    expect(out.torches).toHaveLength(7);
    expect(out.lights).toHaveLength(plan.items.length);
    // Only torches have tiles today; candles are skipped, not faked.
    expect(out.dressing).toHaveLength(7);
    expect(out.skipped).toHaveLength(2);
  });
});

describe("formatDressingPlan", () => {
  test("one line per item", () => {
    const plan = planDressing(room(), { candleCount: 0 });
    const lines = formatDressingPlan(plan);
    expect(lines).toHaveLength(plan.items.length);
    expect(lines[0]).toMatch(/torch .* at \(\d+,\d+\)/);
  });
});
