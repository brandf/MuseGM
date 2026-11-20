/**
 * Unit tests for the Meroki Pins pure functions (src/session/pins.ts).
 * No Foundry connection needed — run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  extractPin,
  extractRoomName,
  nearestWall,
  parsePinRequest,
  planPinAction,
  splitWallForDoor,
} from "../src/session/pins.js";
import type { WallSeg } from "../src/session/pins.js";

function entryDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "entry-1",
    name: "Meroki Pin: secret door",
    flags: {
      meroki: {
        request: "put a secret door right here that leads into a room that is the love nest room",
        status: "open",
        scene: "scene-1",
        x: 800,
        y: 1600,
      },
    },
    ...over,
  };
}

function noteDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "note-1",
    flags: {
      meroki: { request: "chest here", status: "open", entryId: "entry-9" },
    },
    ...over,
  };
}

describe("extractPin", () => {
  it("extracts a JournalEntry pin", () => {
    const pin = extractPin(entryDoc());
    expect(pin).not.toBeNull();
    expect(pin!.entryId).toBe("entry-1");
    expect(pin!.noteId).toBeUndefined();
    expect(pin!.status).toBe("open");
    expect(pin!.scene).toBe("scene-1");
    expect(pin!.x).toBe(800);
    expect(pin!.y).toBe(1600);
    expect(pin!.request).toContain("secret door");
  });

  it("extracts a Note pin via its entryId", () => {
    const pin = extractPin(noteDoc());
    expect(pin).not.toBeNull();
    expect(pin!.entryId).toBe("entry-9");
    expect(pin!.noteId).toBe("note-1");
    expect(pin!.status).toBe("open");
  });

  it("reads status done", () => {
    const pin = extractPin(
      entryDoc({ flags: { meroki: { request: "x", status: "done", scene: "s", x: 1, y: 2 } } }),
    );
    expect(pin!.status).toBe("done");
  });

  it("returns null without flags.meroki.request", () => {
    expect(extractPin({ _id: "e", flags: {} })).toBeNull();
    expect(extractPin({ _id: "e", flags: { meroki: { status: "open" } } })).toBeNull();
    expect(extractPin({ _id: "e" })).toBeNull();
  });
});

describe("extractRoomName", () => {
  it("finds 'room that is X'", () => {
    expect(
      extractRoomName("put a secret door here that leads into a room that is the love nest room"),
    ).toBe("the love nest");
  });

  it("finds 'room called X' and 'leads into X'", () => {
    expect(extractRoomName("build a room called the vault")).toBe("the vault");
    expect(extractRoomName("secret door leading into the crypt")).toBe("the crypt");
  });

  it("returns undefined with no name", () => {
    expect(extractRoomName("put a secret door here")).toBeUndefined();
    expect(extractRoomName("chest here")).toBeUndefined();
  });
});

describe("parsePinRequest", () => {
  it("secret door wins and keeps the room name", () => {
    const r = parsePinRequest(
      "put a secret door right here that leads into a room that is the love nest room",
    );
    expect(r.kind).toBe("secret-door");
    expect(r.roomName).toBe("the love nest");
  });

  it("secret passage counts as secret door", () => {
    expect(parsePinRequest("secret passage here").kind).toBe("secret-door");
  });

  it("door, chest, light, room", () => {
    expect(parsePinRequest("put a door here").kind).toBe("door");
    expect(parsePinRequest("chest here please").kind).toBe("chest");
    expect(parsePinRequest("add a torch here").kind).toBe("light");
    expect(parsePinRequest("light here").kind).toBe("light");
    expect(parsePinRequest("build a room here").kind).toBe("room");
  });

  it("unknown for anything else", () => {
    expect(parsePinRequest("make it spookier").kind).toBe("unknown");
    expect(parsePinRequest("hello").kind).toBe("unknown");
  });
});

describe("nearestWall", () => {
  const walls: WallSeg[] = [
    { _id: "w-south", x1: 0, y1: 1600, x2: 1600, y2: 1600, door: 0 },
    { _id: "w-north", x1: 0, y1: 0, x2: 1600, y2: 0, door: 0 },
  ];

  it("finds the closest wall", () => {
    const hit = nearestWall(walls, 800, 1550);
    expect(hit?.wall._id).toBe("w-south");
    expect(hit?.dist).toBe(50);
  });

  it("returns null when nothing is close", () => {
    expect(nearestWall(walls, 800, 800)).toBeNull();
    expect(nearestWall(walls, 800, 800, 10)).toBeNull();
  });

  it("measures to the segment, not the infinite line", () => {
    // Past the end of the south wall: distance is to the endpoint (1600,1600).
    const hit = nearestWall(walls, 1750, 1600);
    expect(hit?.wall._id).toBe("w-south");
    expect(hit?.dist).toBe(150);
  });
});

describe("splitWallForDoor", () => {
  const wall: WallSeg = { _id: "w1", x1: 0, y1: 1600, x2: 1600, y2: 1600, door: 0 };

  it("splits a door-sized piece out of the middle", () => {
    const { keep, door } = splitWallForDoor(wall, 800, 1600);
    expect(door).toEqual({ x1: 750, y1: 1600, x2: 850, y2: 1600, door: 0 });
    expect(keep).toHaveLength(2);
    expect(keep[0]).toEqual({ x1: 0, y1: 1600, x2: 750, y2: 1600, door: 0 });
    expect(keep[1]).toEqual({ x1: 850, y1: 1600, x2: 1600, y2: 1600, door: 0 });
  });

  it("clamps at the wall ends", () => {
    const { keep, door } = splitWallForDoor(wall, 20, 1600);
    expect(door.x1).toBe(0);
    expect(keep).toHaveLength(1); // only the far side remains
  });

  it("a short wall becomes the door itself", () => {
    const short: WallSeg = { _id: "w2", x1: 750, y1: 1600, x2: 850, y2: 1600, door: 0 };
    const { keep, door } = splitWallForDoor(short, 800, 1600);
    expect(keep).toEqual([]);
    expect(door).toEqual(short);
  });
});

describe("planPinAction", () => {
  const walls: WallSeg[] = [
    { _id: "w-south", x1: 0, y1: 1600, x2: 1600, y2: 1600, door: 0 },
    { _id: "w-north", x1: 0, y1: 0, x2: 1600, y2: 0, door: 0 },
  ];
  const size = { width: 1600, height: 1600 };

  it("secret door: splits the wall, door type 2, room behind it", () => {
    const pin = extractPin(entryDoc())!;
    const plan = planPinAction(parsePinRequest(pin.request), pin, walls, size);
    expect(plan.kind).toBe("secret-door");
    if (plan.kind !== "secret-door") return;
    expect(plan.wallId).toBe("w-south");
    expect(plan.door.door).toBe(2);
    expect(plan.keep).toHaveLength(2);
    // The pin is on the south wall (y=1600, scene center y=800): the room
    // is south of the wall, so its NORTH wall faces the old room.
    expect(plan.room.name).toBe("the love nest");
    expect(plan.room.doors).toEqual([{ wall: "north", at: 4 }]);
    expect(plan.reply).toContain("Secret door");
    expect(plan.reply).toContain("the love nest");
  });

  it("plain door: same split, door type 1, no room", () => {
    const pin = extractPin(
      entryDoc({
        flags: {
          meroki: { request: "put a door here", status: "open", scene: "scene-1", x: 800, y: 1600 },
        },
      }),
    )!;
    const plan = planPinAction(parsePinRequest(pin.request), pin, walls, size);
    expect(plan.kind).toBe("door");
    if (plan.kind !== "door") return;
    expect(plan.door.door).toBe(1);
  });

  it("no wall near the pin → no-wall with a useful reply", () => {
    const pin = extractPin(
      entryDoc({
        flags: {
          meroki: { request: "secret door here", status: "open", scene: "scene-1", x: 800, y: 800 },
        },
      }),
    )!;
    const plan = planPinAction(parsePinRequest(pin.request), pin, walls, size);
    expect(plan.kind).toBe("no-wall");
    if (plan.kind !== "no-wall") return;
    expect(plan.reply).toContain("right on the wall");
  });

  it("room: builds a named room, no wall needed", () => {
    const pin = extractPin(
      entryDoc({
        flags: {
          meroki: { request: "build a room called the vault", status: "open", scene: "scene-1", x: 800, y: 800 },
        },
      }),
    )!;
    const plan = planPinAction(parsePinRequest(pin.request), pin, walls, size);
    expect(plan.kind).toBe("room");
    if (plan.kind !== "room") return;
    expect(plan.room.name).toBe("the vault");
  });

  it("chest and light plan at the pin", () => {
    const chestPin = extractPin(
      entryDoc({
        flags: { meroki: { request: "chest here", status: "open", scene: "scene-1", x: 400, y: 400 } },
      }),
    )!;
    const chestPlan = planPinAction(parsePinRequest(chestPin.request), chestPin, walls, size);
    expect(chestPlan.kind).toBe("chest");
    if (chestPlan.kind === "chest") {
      expect(chestPlan.x).toBe(400);
      expect(chestPlan.y).toBe(400);
    }
    const lightPin = extractPin(
      entryDoc({
        flags: { meroki: { request: "torch here", status: "open", scene: "scene-1", x: 200, y: 200 } },
      }),
    )!;
    expect(planPinAction(parsePinRequest(lightPin.request), lightPin, walls, size).kind).toBe("light");
  });

  it("unknown: replies asking for clarification, builds nothing", () => {
    const pin = extractPin(
      entryDoc({
        flags: { meroki: { request: "make it spookier", status: "open", scene: "scene-1", x: 800, y: 800 } },
      }),
    )!;
    const plan = planPinAction(parsePinRequest(pin.request), pin, walls, size);
    expect(plan.kind).toBe("unknown");
    if (plan.kind !== "unknown") return;
    expect(plan.reply).toContain("didn't understand");
  });

  it("a pin with no scene → no-scene", () => {
    const pin = extractPin({
      _id: "e2",
      flags: { meroki: { request: "chest here", status: "open" } },
    })!;
    const plan = planPinAction(parsePinRequest(pin.request), pin, walls, size);
    expect(plan.kind).toBe("no-scene");
  });
});
