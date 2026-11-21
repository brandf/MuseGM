import { describe, expect, it, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  VehicleError,
  addAlongside,
  addVehicle,
  advanceVehicle,
  advanceVehicleLive,
  boardVehicle,
  boardVehicleLive,
  carPosition,
  createVehicle,
  defaultVehicleStatePath,
  emptyVehicleStore,
  getVehicle,
  leaveVehicle,
  leaveVehicleLive,
  loadVehicleState,
  parseVehicle,
  parseVehicleStore,
  pointAtDistance,
  removeAlongside,
  removeVehicle,
  renderVehicle,
  resolveVehicleTarget,
  resumeVehicle,
  routeLength,
  saveVehicleState,
  setSpeed,
  stopVehicle,
  updateVehicle,
  vehicleIdFromName,
  vehicleTokenPositions,
  type Vehicle,
  type VehicleStore,
} from "../src/session/vehicles.js";
import { validateCutscene, expandCutscene, expandVehicleMove } from "../src/session/cutscene.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vehicles-test-"));
  tmpDirs.push(dir);
  return path.join(dir, ".vehicle-state.json");
}

/** The demo train — same spec as the CLI --demo. */
function demoTrain(): Vehicle {
  return createVehicle({
    name: "The Iron Horse",
    kind: "train",
    route: [
      { x: 0, y: 10 },
      { x: 18, y: 10 },
      { x: 26, y: 14 },
      { x: 26, y: 24 },
    ],
    speedCellsPerRound: 4,
    gapCells: 0.5,
    cars: [
      { id: "locomotive", name: "Locomotive", lengthCells: 3 },
      { id: "tender", name: "Tender", lengthCells: 2 },
      { id: "boxcar", name: "Boxcar", lengthCells: 4 },
      { id: "flatcar", name: "Flatcar", lengthCells: 4 },
      { id: "caboose", name: "Caboose", lengthCells: 3 },
    ],
    deadline: {
      name: "the trestle bridge",
      atDistance: 30,
      consequence: "The trestle bridge is ahead — the heist window is closing.",
    },
    tokenId: "iron-horse-loco",
    sceneId: "demo-scene",
    riders: [
      { tokenId: "valeros", name: "Valeros", carId: "boxcar", offsetCells: 1, lateralCells: 0 },
      { tokenId: "kyra", name: "Kyra", carId: "caboose", offsetCells: 1, lateralCells: 0 },
    ],
    alongside: [
      { tokenId: "merisiel", name: "Merisiel", behindCells: 2, lateralCells: -3 },
      { tokenId: "ezren", name: "Ezren", behindCells: 6, lateralCells: 3 },
    ],
    source: "test",
  });
}

function smallTrain(): Vehicle {
  return createVehicle({
    name: "Pony Express",
    kind: "wagon",
    route: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    speedCellsPerRound: 2,
    cars: [{ id: "wagon", name: "Wagon", lengthCells: 2 }],
    source: "test",
  });
}

describe("vehicleIdFromName", () => {
  it("slugs names", () => {
    expect(vehicleIdFromName("The Iron Horse")).toBe("the-iron-horse");
    expect(vehicleIdFromName("!!!")).toBe("vehicle");
  });
});

describe("route geometry", () => {
  it("routeLength sums the segments", () => {
    const route = [
      { x: 0, y: 10 },
      { x: 18, y: 10 },
      { x: 26, y: 14 },
      { x: 26, y: 24 },
    ];
    expect(routeLength(route)).toBeCloseTo(36.944, 3);
  });

  it("pointAtDistance walks the polyline with headings and clamps", () => {
    const route = [
      { x: 0, y: 10 },
      { x: 18, y: 10 },
      { x: 26, y: 14 },
      { x: 26, y: 24 },
    ];
    const start = pointAtDistance(route, 0);
    expect(start.x).toBe(0);
    expect(start.y).toBe(10);
    expect(start.headingDeg).toBe(0);
    const bend = pointAtDistance(route, 22);
    expect(bend.x).toBeCloseTo(21.578, 3);
    expect(bend.y).toBeCloseTo(11.789, 3);
    expect(bend.headingDeg).toBeCloseTo(26.565, 3);
    const past = pointAtDistance(route, 40);
    expect(past.x).toBe(26);
    expect(past.y).toBe(24);
    expect(past.headingDeg).toBe(90);
    const before = pointAtDistance(route, -5);
    expect(before.x).toBe(0);
    expect(before.y).toBe(10);
  });
});

describe("createVehicle", () => {
  it("creates a train with the whole vehicle on the route by default", () => {
    const v = demoTrain();
    expect(v.id).toBe("the-iron-horse");
    expect(v.routeLength).toBeCloseTo(36.944, 3);
    // Extent: 3+2+4+4+3 + 4*0.5 = 18 — the front starts at 18 so
    // the caboose's back sits exactly on the route start.
    expect(v.distance).toBe(18);
    expect(v.status).toBe("running");
    expect(v.deadlineFired).toBe(false);
    expect(v.riders).toHaveLength(2);
    expect(v.alongside).toHaveLength(2);
    expect(v.history).toHaveLength(1);
    expect(v.history[0].kind).toBe("create");
    expect(v.history[0].source).toBe("test");
  });

  it("places cars front-to-back with gaps", () => {
    const v = demoTrain();
    // Locomotive center: front 18 - 1.5 = 16.5; caboose center:
    // front 3 - 1.5 = 1.5 — both on the first (straight) segment.
    const loco = carPosition(v, 0);
    expect(loco.x).toBeCloseTo(16.5, 3);
    expect(loco.y).toBe(10);
    const caboose = carPosition(v, 4);
    expect(caboose.x).toBeCloseTo(1.5, 3);
    expect(caboose.y).toBe(10);
  });

  it("places riders in their cars and escorts alongside", () => {
    const v = demoTrain();
    const positions = vehicleTokenPositions(v);
    expect(positions).toHaveLength(5);
    const byId = Object.fromEntries(positions.map((p) => [p.tokenId, p]));
    // Locomotive token at the front.
    expect(byId["iron-horse-loco"].x).toBe(18);
    expect(byId["iron-horse-loco"].y).toBe(10);
    // Valeros: boxcar front 12, offset 1 -> (11, 10).
    expect(byId["valeros"].x).toBe(11);
    expect(byId["valeros"].y).toBe(10);
    // Kyra: caboose front 3, offset 1 -> (2, 10).
    expect(byId["kyra"].x).toBe(2);
    expect(byId["kyra"].y).toBe(10);
    // Merisiel: behind 2 (along 16), lateral -3 (right side) -> (16, 13).
    expect(byId["merisiel"].x).toBe(16);
    expect(byId["merisiel"].y).toBe(13);
    // Ezren: behind 6 (along 12), lateral 3 (left side) -> (12, 7).
    expect(byId["ezren"].x).toBe(12);
    expect(byId["ezren"].y).toBe(7);
  });

  it("lists every validation error instead of failing on the first", () => {
    expect(() =>
      createVehicle({
        name: "  ",
        kind: "",
        route: [{ x: 0, y: 0 }],
        speedCellsPerRound: 0,
        cars: [],
        source: "",
      }),
    ).toThrow(/"name"/);
    try {
      createVehicle({
        name: "  ",
        kind: "",
        route: [{ x: 0, y: 0 }],
        speedCellsPerRound: 0,
        cars: [],
        source: "",
      });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('"name"');
      expect(msg).toContain('"kind"');
      expect(msg).toContain('"route"');
      expect(msg).toContain('"speedCellsPerRound"');
      expect(msg).toContain('"cars"');
      expect(msg).toContain('"source"');
    }
  });

  it("rejects bad waypoints, cars, and route-too-short", () => {
    const base = {
      name: "X",
      kind: "train",
      route: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      speedCellsPerRound: 1,
      cars: [{ id: "a", name: "A", lengthCells: 2 }],
      source: "test",
    };
    expect(() => createVehicle({ ...base, route: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }] })).toThrow(
      /integer/,
    );
    expect(() => createVehicle({ ...base, route: [{ x: 0, y: 0 }, { x: 0, y: 0 }] })).toThrow(
      /same cell/,
    );
    expect(() =>
      createVehicle({
        ...base,
        cars: [
          { id: "a", name: "A", lengthCells: 2 },
          { id: "a", name: "B", lengthCells: 2 },
        ],
      }),
    ).toThrow(/used twice/);
    expect(() => createVehicle({ ...base, cars: [{ id: "a", name: "A", lengthCells: 0 }] })).toThrow(
      /lengthCells/,
    );
    expect(() => createVehicle({ ...base, gapCells: -1 })).toThrow(/gapCells/);
    // Route 10 cells, vehicle 12 cells long — too short.
    expect(() =>
      createVehicle({
        ...base,
        cars: [{ id: "a", name: "A", lengthCells: 12 }],
      }),
    ).toThrow(/route must be at least as long/);
    expect(() => createVehicle({ ...base, startDistance: 11 })).toThrow(/startDistance/);
  });

  it("rejects deadlines that can never fire or are already passed", () => {
    const base = {
      name: "X",
      kind: "train",
      route: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      speedCellsPerRound: 1,
      cars: [{ id: "a", name: "A", lengthCells: 2 }],
      source: "test",
    };
    expect(() =>
      createVehicle({
        ...base,
        deadline: { name: "bridge", atDistance: 11, consequence: "boom" },
      }),
    ).toThrow(/past the end/);
    // Default start is the extent (2), so a deadline at 2 is passed.
    expect(() =>
      createVehicle({
        ...base,
        deadline: { name: "bridge", atDistance: 2, consequence: "boom" },
      }),
    ).toThrow(/already be passed/);
    expect(() =>
      createVehicle({
        ...base,
        deadline: { name: "", atDistance: 5, consequence: "boom" },
      }),
    ).toThrow(/deadline\.name/);
    expect(() =>
      createVehicle({
        ...base,
        deadline: { name: "bridge", atDistance: 5, consequence: "" },
      }),
    ).toThrow(/deadline\.consequence/);
  });

  it("rejects bad riders and escorts", () => {
    const base = {
      name: "X",
      kind: "train",
      route: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      speedCellsPerRound: 1,
      cars: [{ id: "a", name: "A", lengthCells: 2 }],
      source: "test",
    };
    expect(() =>
      createVehicle({
        ...base,
        riders: [{ tokenId: "t1", carId: "nope", offsetCells: 0, lateralCells: 0 }],
      }),
    ).toThrow(/one of the cars/);
    expect(() =>
      createVehicle({
        ...base,
        riders: [{ tokenId: "t1", carId: "a", offsetCells: 3, lateralCells: 0 }],
      }),
    ).toThrow(/offsetCells/);
    expect(() =>
      createVehicle({
        ...base,
        alongside: [{ tokenId: "t1", behindCells: 0, lateralCells: 0 }],
      }),
    ).toThrow(/standing on the rails/);
    expect(() =>
      createVehicle({
        ...base,
        riders: [{ tokenId: "t1", carId: "a", offsetCells: 0, lateralCells: 0 }],
        alongside: [{ tokenId: "t1", behindCells: 0, lateralCells: 2 }],
      }),
    ).toThrow(/already aboard or alongside/);
  });
});

describe("advanceVehicle", () => {
  it("advances by speed * rounds and moves riders with it", () => {
    const v = demoTrain();
    const advanced = advanceVehicle(v, { rounds: 1, source: "combat round 1" });
    expect(advanced.vehicle.distance).toBe(22);
    expect(advanced.movedCells).toBe(4);
    expect(advanced.events).toEqual([]);
    const positions = vehicleTokenPositions(advanced.vehicle);
    const byId = Object.fromEntries(positions.map((p) => [p.tokenId, p]));
    // Valeros: boxcar front 16, offset 1 -> (15, 10).
    expect(byId["valeros"].x).toBe(15);
    expect(byId["valeros"].y).toBe(10);
    // Merisiel rounds the bend: along 20, heading ~26.6deg.
    expect(byId["merisiel"].x).toBeCloseTo(18.447, 3);
    expect(byId["merisiel"].y).toBeCloseTo(13.578, 3);
    expect(advanced.vehicle.history).toHaveLength(2);
    expect(advanced.vehicle.history[1].kind).toBe("advance");
    // The input vehicle is untouched (immutable ops).
    expect(v.distance).toBe(18);
  });

  it("fires the deadline exactly once, then arrives at the end", () => {
    let v = demoTrain();
    const r1 = advanceVehicle(v, { rounds: 2, source: "combat round 2" });
    expect(r1.vehicle.distance).toBe(26);
    expect(r1.events).toEqual([]);
    v = r1.vehicle;
    const r2 = advanceVehicle(v, { rounds: 1, source: "combat round 3" });
    expect(r2.vehicle.distance).toBe(30);
    expect(r2.events).toEqual([
      {
        type: "deadline",
        name: "the trestle bridge",
        consequence: "The trestle bridge is ahead — the heist window is closing.",
      },
    ]);
    expect(r2.vehicle.deadlineFired).toBe(true);
    v = r2.vehicle;
    const r3 = advanceVehicle(v, { rounds: 2, source: "combat round 5" });
    expect(r3.vehicle.distance).toBeCloseTo(36.944, 3);
    expect(r3.vehicle.status).toBe("arrived");
    expect(r3.events).toEqual([{ type: "arrived" }]);
    // No second deadline: it already fired.
    expect(r3.events.filter((e) => e.type === "deadline")).toHaveLength(0);
    const r4 = advanceVehicle(r3.vehicle, { rounds: 1, source: "combat round 6" });
    expect(r4.movedCells).toBe(0);
    expect(r4.events).toEqual([{ type: "not-advanced", reason: "The Iron Horse has already arrived." }]);
    expect(r4.vehicle.distance).toBeCloseTo(36.944, 3);
  });

  it("rejects bad rounds and a missing source", () => {
    const v = smallTrain();
    expect(() => advanceVehicle(v, { rounds: 0, source: "x" })).toThrow(/"rounds"/);
    expect(() => advanceVehicle(v, { rounds: 1.5, source: "x" })).toThrow(/"rounds"/);
    expect(() => advanceVehicle(v, { rounds: 1, source: "  " })).toThrow(/"source"/);
  });
});

describe("riders and escorts", () => {
  it("boards, leaves, and validates both", () => {
    let v = smallTrain();
    v = boardVehicle(v, { tokenId: "t1", name: "Valeros", carId: "wagon", offsetCells: 1, source: "gm" });
    expect(v.riders).toHaveLength(1);
    expect(() =>
      boardVehicle(v, { tokenId: "t1", carId: "wagon", source: "gm" }),
    ).toThrow(/already aboard/);
    expect(() => boardVehicle(v, { tokenId: "t2", carId: "nope", source: "gm" })).toThrow(
      /Unknown car/,
    );
    expect(() => boardVehicle(v, { tokenId: "t2", carId: "wagon", offsetCells: 5, source: "gm" })).toThrow(
      /offsetCells/,
    );
    v = leaveVehicle(v, { tokenId: "t1", source: "gm" });
    expect(v.riders).toHaveLength(0);
    expect(() => leaveVehicle(v, { tokenId: "t1", source: "gm" })).toThrow(/not aboard/);
  });

  it("adds and removes escorts, keeping pace", () => {
    let v = smallTrain();
    v = addAlongside(v, { tokenId: "e1", name: "Merisiel", behindCells: 1, lateralCells: -2, source: "gm" });
    expect(v.alongside).toHaveLength(1);
    expect(() => addAlongside(v, { tokenId: "e1", lateralCells: 2, source: "gm" })).toThrow(
      /already aboard/,
    );
    expect(() => addAlongside(v, { tokenId: "e2", lateralCells: 0, source: "gm" })).toThrow(
      /standing on the rails/,
    );
    const advanced = advanceVehicle(v, { rounds: 1, source: "combat round 1" });
    // Wagon starts at 2 (its extent), speed 2 -> 4. Escort behind 1
    // -> along 3, lateral -2 (right side, heading east) -> (3, 2).
    const pos = vehicleTokenPositions(advanced.vehicle).find((p) => p.tokenId === "e1");
    expect(pos?.x).toBe(3);
    expect(pos?.y).toBe(2);
    const removed = removeAlongside(advanced.vehicle, { tokenId: "e1", source: "gm" });
    expect(removed.alongside).toHaveLength(0);
    expect(() => removeAlongside(removed, { tokenId: "e1", source: "gm" })).toThrow(
      /not alongside/,
    );
  });
});

describe("stop / resume / setSpeed", () => {
  it("halts, refuses to advance while stopped, resumes, and re-speeds", () => {
    let v = smallTrain();
    v = stopVehicle(v, { source: "gm" });
    expect(v.status).toBe("stopped");
    expect(() => stopVehicle(v, { source: "gm" })).toThrow(/already stopped/);
    const held = advanceVehicle(v, { rounds: 1, source: "combat round 1" });
    expect(held.movedCells).toBe(0);
    expect(held.events).toEqual([{ type: "not-advanced", reason: "Pony Express is stopped." }]);
    v = resumeVehicle(held.vehicle, { source: "gm" });
    expect(v.status).toBe("running");
    expect(() => resumeVehicle(v, { source: "gm" })).toThrow(/Only a stopped vehicle/);
    v = setSpeed(v, { speed: 5, source: "gm" });
    expect(v.speedCellsPerRound).toBe(5);
    expect(() => setSpeed(v, { speed: 0, source: "gm" })).toThrow(/"speed"/);
    const arrived = advanceVehicle(v, { rounds: 10, source: "combat round 9" });
    expect(arrived.vehicle.status).toBe("arrived");
    expect(() => stopVehicle(arrived.vehicle, { source: "gm" })).toThrow(/already arrived/);
  });
});

describe("renderVehicle", () => {
  it("renders running, stopped, and arrived lines with the deadline", () => {
    const v = demoTrain();
    expect(renderVehicle(v)).toBe(
      "🚂 The Iron Horse (train) — 18/36.9 cells — running at 4/round — 2 riders aboard, 2 alongside — deadline \"the trestle bridge\" in 12 cells",
    );
    const stopped = stopVehicle(v, { source: "gm" });
    expect(renderVehicle(stopped)).toContain("— stopped —");
    const arrived = advanceVehicle(v, { rounds: 10, source: "gm" }).vehicle;
    expect(renderVehicle(arrived)).toContain("— arrived —");
    expect(renderVehicle(arrived)).toContain('deadline "the trestle bridge" fired');
  });
});

describe("store", () => {
  it("adds, resolves, updates, and removes vehicles", () => {
    let store: VehicleStore = emptyVehicleStore();
    const train = demoTrain();
    const wagon = smallTrain();
    store = addVehicle(store, train);
    store = addVehicle(store, wagon);
    expect(() => addVehicle(store, demoTrain())).toThrow(/already exists/);
    expect(getVehicle(store, "the-iron-horse").name).toBe("The Iron Horse");
    expect(() => getVehicle(store, "nope")).toThrow(/No vehicle/);
    expect(resolveVehicleTarget(store, "the-iron-horse")).toBe(train);
    expect(resolveVehicleTarget(store, "The Iron Horse")).toBe(train);
    expect(resolveVehicleTarget(store, "iron")).toBe(train);
    expect(() => resolveVehicleTarget(store, "e")).toThrow(/matches several/);
    expect(() => resolveVehicleTarget(store, "zzz")).toThrow(/No vehicle matches/);
    const faster = setSpeed(train, { speed: 6, source: "gm" });
    store = updateVehicle(store, faster);
    expect(getVehicle(store, "the-iron-horse").speedCellsPerRound).toBe(6);
    store = removeVehicle(store, "pony-express");
    expect(store.vehicles).toHaveLength(1);
    expect(() => updateVehicle(store, smallTrain())).toThrow(/No vehicle/);
    expect(() => removeVehicle(store, "pony-express")).toThrow(/No vehicle/);
  });
});

describe("serialize / parse", () => {
  it("round-trips a vehicle and a store", () => {
    const v = advanceVehicle(demoTrain(), { rounds: 3, source: "combat round 3" }).vehicle;
    const parsed = parseVehicle(JSON.parse(JSON.stringify(v)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.vehicle.distance).toBe(30);
      expect(parsed.vehicle.deadlineFired).toBe(true);
    }
    const store: VehicleStore = { vehicles: [v, smallTrain()] };
    const reparsed = parseVehicleStore(JSON.parse(JSON.stringify({ version: 1, vehicles: store.vehicles })));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.store.vehicles).toHaveLength(2);
  });

  it("rejects corrupt stores and inconsistent vehicles", () => {
    expect(parseVehicleStore({ version: 2, vehicles: [] }).ok).toBe(false);
    expect(parseVehicleStore({ version: 1, vehicles: "nope" }).ok).toBe(false);
    expect(parseVehicleStore(null).ok).toBe(false);
    const v = JSON.parse(JSON.stringify(demoTrain())) as Record<string, unknown>;
    v.routeLength = 999;
    expect(parseVehicle(v).ok).toBe(false);
    const fired = JSON.parse(JSON.stringify(demoTrain())) as Record<string, unknown>;
    fired.distance = 35;
    expect(parseVehicle(fired).ok).toBe(false);
    const badHistory = JSON.parse(JSON.stringify(demoTrain())) as Record<string, unknown>;
    (badHistory.history as Record<string, unknown>[])[0].source = 42;
    expect(parseVehicle(badHistory).ok).toBe(false);
    expect(parseVehicle({ name: "x" }).ok).toBe(false);
    const dup: VehicleStore = { vehicles: [demoTrain(), demoTrain()] };
    expect(parseVehicleStore({ version: 1, vehicles: dup.vehicles }).ok).toBe(false);
  });

  it("round-trips the state file and tolerates corrupt/missing files", () => {
    const file = tmpState();
    expect(loadVehicleState(file)).toBeNull();
    const store: VehicleStore = { vehicles: [demoTrain()] };
    saveVehicleState(store, file);
    const loaded = loadVehicleState(file);
    expect(loaded?.vehicles).toHaveLength(1);
    expect(loaded?.vehicles[0].id).toBe("the-iron-horse");
    fs.writeFileSync(file, "{not json", "utf-8");
    expect(loadVehicleState(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 9, vehicles: [] }), "utf-8");
    expect(loadVehicleState(file)).toBeNull();
    expect(defaultVehicleStatePath()).toContain(".vehicle-state.json");
  });
});

describe("cutscene move-vehicle step", () => {
  const script = {
    version: 1,
    name: "train-robbery",
    sceneId: "demo-scene",
    steps: [{ kind: "move-vehicle", vehicle: "the-iron-horse", rounds: 3 }],
  };

  it("validates the step and rejects bad rounds and unknown fields", () => {
    expect(validateCutscene(script).ok).toBe(true);
    const badRounds = validateCutscene({
      version: 1,
      name: "x",
      steps: [{ kind: "move-vehicle", vehicle: "v", rounds: 0 }],
    });
    expect(badRounds.ok).toBe(false);
    if (!badRounds.ok) expect(badRounds.errors.join(" ")).toContain('"rounds"');
    const badField = validateCutscene({
      version: 1,
      name: "x",
      steps: [{ kind: "move-vehicle", vehicle: "v", frobnicate: true }],
    });
    expect(badField.ok).toBe(false);
    if (!badField.ok) expect(badField.errors.join(" ")).toContain("frobnicate");
    const noVehicle = validateCutscene({
      version: 1,
      name: "x",
      steps: [{ kind: "move-vehicle", rounds: 1 }],
    });
    expect(noVehicle.ok).toBe(false);
  });

  it("expands into move steps for every shifted token plus the deadline chat", () => {
    const vehicle = demoTrain();
    const expanded = expandCutscene(script as never, {
      vehicles: { "the-iron-horse": vehicle },
    });
    // 5 tokens move (loco + 2 riders + 2 escorts) + 1 deadline chat.
    const moves = expanded.filter((s) => s.kind === "move");
    expect(moves).toHaveLength(5);
    const chats = expanded.filter((s) => s.kind === "chat");
    expect(chats).toHaveLength(1);
    expect((chats[0] as { content: string }).content).toContain("the trestle bridge");
    // Locomotive at distance 30 -> (26, ~17.06) -> px (2600, 1706).
    const loco = moves.find((s) => (s as { token: string }).token === "iron-horse-loco") as {
      x: number;
      y: number;
    };
    expect(loco.x).toBe(2600);
    expect(loco.y).toBe(1706);
    // Valeros: boxcar front 24, offset 1 -> along 23 -> px (2247, 1224).
    const valeros = moves.find((s) => (s as { token: string }).token === "valeros") as {
      x: number;
      y: number;
    };
    expect(valeros.x).toBe(2247);
    expect(valeros.y).toBe(1224);
  });

  it("returns the advanced vehicle so the caller can persist it", () => {
    const vehicle = demoTrain();
    const result = expandVehicleMove(script as never, script.steps[0] as never, 0, {
      "the-iron-horse": vehicle,
    });
    expect(result.vehicle.distance).toBe(30);
    expect(result.vehicle.deadlineFired).toBe(true);
    // The snapshot itself is untouched.
    expect(vehicle.distance).toBe(18);
  });

  it("throws when the vehicle is unknown or no snapshot is passed", () => {
    expect(() => expandCutscene(script as never, { vehicles: {} })).toThrow(/unknown vehicle/);
    expect(() => expandCutscene(script as never, {})).toThrow(/no vehicles passed/);
    expect(() =>
      expandCutscene({ version: 1, name: "x", steps: [{ kind: "move-vehicle", vehicle: "v" }] } as never, {
        vehicles: {},
      }),
    ).toThrow(/no sceneId/);
  });

  it("emits no moves for a stopped vehicle", () => {
    const stopped = stopVehicle(demoTrain(), { source: "gm" });
    const expanded = expandCutscene(script as never, {
      vehicles: { "the-iron-horse": stopped },
    });
    expect(expanded).toHaveLength(0);
  });
});

describe("live layer (fake live)", () => {
  function fakeLive() {
    const sent: string[] = [];
    const calls: { doc: string; op: string; args: Record<string, unknown> }[] = [];
    return {
      sent,
      calls,
      modifyDocument: async (
        doc: string,
        op: string,
        args: Record<string, unknown>,
      ): Promise<unknown[]> => {
        calls.push({ doc, op, args });
        return [];
      },
      sendChat: async (content: string): Promise<string> => {
        sent.push(content);
        return "msg-1";
      },
    };
  }

  it("advances live: one batched Token update in px, no chat when nothing fires", async () => {
    const live = fakeLive();
    const vehicle = demoTrain();
    const result = await advanceVehicleLive(live as never, vehicle, {
      rounds: 1,
      source: "combat round 1",
    });
    expect(result.movedCells).toBe(4);
    expect(result.events).toEqual([]);
    expect(result.lines).toEqual([]);
    expect(live.sent).toEqual([]);
    expect(live.calls).toHaveLength(1);
    expect(live.calls[0].doc).toBe("Token");
    expect(live.calls[0].op).toBe("update");
    expect(live.calls[0].args.parentUuid).toBe("Scene.demo-scene");
    const updates = live.calls[0].args.updates as { _id: string; x: number; y: number }[];
    expect(updates).toHaveLength(5);
    const byId = Object.fromEntries(updates.map((u) => [u._id, u]));
    // Locomotive front at distance 22 — past the bend at x=18, so
    // (21.578, 11.789), not (22, 10).
    expect(byId["iron-horse-loco"]).toEqual({ _id: "iron-horse-loco", x: 2158, y: 1179 });
    expect(byId["valeros"]).toEqual({ _id: "valeros", x: 1500, y: 1000 });
    expect(byId["kyra"]).toEqual({ _id: "kyra", x: 600, y: 1000 });
    expect(byId["merisiel"]).toEqual({ _id: "merisiel", x: 1845, y: 1358 });
    expect(byId["ezren"]).toEqual({ _id: "ezren", x: 1600, y: 700 });
    expect(result.movedTokens).toHaveLength(5);
  });

  it("announces the deadline and arrival in chat", async () => {
    const live = fakeLive();
    let vehicle = demoTrain();
    const r1 = await advanceVehicleLive(live as never, vehicle, { rounds: 3, source: "combat round 3" });
    expect(r1.events).toHaveLength(1);
    expect(r1.lines).toEqual([
      "🚂 The Iron Horse reaches the trestle bridge — The trestle bridge is ahead — the heist window is closing.",
    ]);
    expect(live.sent).toEqual(r1.lines);
    vehicle = r1.vehicle;
    const r2 = await advanceVehicleLive(live as never, vehicle, { rounds: 2, source: "combat round 5" });
    expect(r2.events).toEqual([{ type: "arrived" }]);
    expect(r2.lines).toEqual(["🚂 The Iron Horse has reached the end of the line."]);
  });

  it("boards live: snaps the token to its seat and announces", async () => {
    const live = fakeLive();
    const vehicle = demoTrain();
    const result = await boardVehicleLive(live as never, vehicle, {
      tokenId: "rogue",
      name: "Rogue",
      carId: "flatcar",
      offsetCells: 2,
      lateralCells: 1,
      source: "gm",
    });
    // Flatcar front 7.5, offset 2 -> along 5.5 -> (5.5, 10), lateral 1
    // (left of eastward travel) -> (5.5, 9) -> px (550, 900).
    expect(result.movedTo).toEqual({ x: 550, y: 900 });
    expect(result.line).toBe("🚂 Rogue boards The Iron Horse — Flatcar.");
    expect(live.sent).toEqual([result.line]);
    expect(live.calls).toHaveLength(1);
    const updates = live.calls[0].args.updates as { _id: string; x: number; y: number }[];
    expect(updates).toEqual([{ _id: "rogue", x: 550, y: 900 }]);
    expect(result.vehicle.riders).toHaveLength(3);
  });

  it("leaves live: announces, moves nothing", async () => {
    const live = fakeLive();
    const vehicle = demoTrain();
    const result = await leaveVehicleLive(live as never, vehicle, {
      tokenId: "valeros",
      source: "gm",
    });
    expect(result.line).toBe("🚂 Valeros steps off The Iron Horse.");
    expect(live.sent).toEqual([result.line]);
    expect(live.calls).toHaveLength(0);
    expect(result.vehicle.riders).toHaveLength(1);
    await expect(
      leaveVehicleLive(live as never, vehicle, { tokenId: "nope", source: "gm" }),
    ).rejects.toThrow(/not aboard/);
  });

  it("refuses live moves without a scene", async () => {
    const live = fakeLive();
    const vehicle = createVehicle({
      name: "Ghost",
      kind: "ship",
      route: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      speedCellsPerRound: 1,
      cars: [{ id: "hull", name: "Hull", lengthCells: 2 }],
      source: "test",
    });
    await expect(
      advanceVehicleLive(live as never, vehicle, { rounds: 1, source: "gm" }),
    ).rejects.toThrow(/no sceneId/);
    await expect(
      boardVehicleLive(live as never, vehicle, { tokenId: "t", carId: "hull", source: "gm" }),
    ).rejects.toThrow(/no sceneId/);
  });
});
