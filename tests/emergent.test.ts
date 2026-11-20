/**
 * Emergent-sequence engine tests (FR-18) — round clock, rush,
 * lights-out, wall-break, emerge, and the reveal-image step. Pure
 * validation, expansion, and light math. No Foundry connection: the
 * live handlers (waitRound polling, lightsOut animation, wall delete,
 * image chat post) are live-tested next session, in a real
 * mid-session moment.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import {
  validateCutscene,
  expandCutscene,
} from "../src/session/cutscene.js";
import { lightsOutPlan } from "../src/session/lights.js";
import type { LightDoc } from "../src/session/lights.js";
import {
  buildRevealPrompt,
  revealImageChatHtml,
  validateReveal,
  escapeHtml,
} from "../src/session/reveal.js";

function validScript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "Test Scene",
    sceneId: "Test Scene",
    steps: [{ kind: "chat", content: "Hello." }],
    ...overrides,
  };
}

function rushStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "rush",
    tokens: ["Mouse", "Mouse"],
    from: { x: 800, y: 1500 },
    through: [{ x: 800, y: 800 }],
    to: { x: 800, y: 100 },
    ...overrides,
  };
}

describe("validateCutscene: waitRound (FR-18 round clock)", () => {
  it("accepts absolute and relative rounds", () => {
    expect(validateCutscene(validScript({ steps: [{ kind: "waitRound", round: 6 }] })).ok).toBe(true);
    expect(
      validateCutscene(validScript({ steps: [{ kind: "waitRound", round: 5, relative: true }] })).ok,
    ).toBe(true);
  });

  it("rejects round < 1 (absolute or relative) and lists the error", () => {
    const zero = validateCutscene(validScript({ steps: [{ kind: "waitRound", round: 0 }] }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.errors.join(" ")).toContain("round");
    const neg = validateCutscene(
      validScript({ steps: [{ kind: "waitRound", round: -2, relative: true }] }),
    );
    expect(neg.ok).toBe(false);
  });

  it("rejects a non-integer round and an unknown field", () => {
    const frac = validateCutscene(validScript({ steps: [{ kind: "waitRound", round: 2.5 }] }));
    expect(frac.ok).toBe(false);
    const badField = validateCutscene(
      validScript({ steps: [{ kind: "waitRound", round: 3, rounds: 3 }] }),
    );
    expect(badField.ok).toBe(false);
    if (!badField.ok) expect(badField.errors.join(" ")).toContain("unknown field");
  });
});

describe("validateCutscene: rush (FR-18 pass-through)", () => {
  it("accepts a rush with a bite", () => {
    expect(
      validateCutscene(
        validScript({
          steps: [rushStep({ bite: { damage: "1d4", targets: ["Ezren", "Kyra"] } })],
        }),
      ).ok,
    ).toBe(true);
  });

  it("rejects empty tokens, missing from/to, and a bad through list", () => {
    expect(validateCutscene(validScript({ steps: [rushStep({ tokens: [] })] })).ok).toBe(false);
    expect(validateCutscene(validScript({ steps: [rushStep({ tokens: [""] })] })).ok).toBe(false);
    const { from: _f, ...noFrom } = rushStep();
    expect(validateCutscene(validScript({ steps: [noFrom] })).ok).toBe(false);
    expect(validateCutscene(validScript({ steps: [rushStep({ through: [{ x: 1 }] })] })).ok).toBe(false);
    expect(validateCutscene(validScript({ steps: [rushStep({ through: "hall" })] })).ok).toBe(false);
  });

  it("rejects a bite without a damage formula and bad bite targets", () => {
    expect(validateCutscene(validScript({ steps: [rushStep({ bite: {} })] })).ok).toBe(false);
    expect(
      validateCutscene(validScript({ steps: [rushStep({ bite: { damage: "1d4", targets: [""] } })] })).ok,
    ).toBe(false);
  });
});

describe("validateCutscene: lightsOut + breakWall (FR-18)", () => {
  it("accepts lightsOut with and without timing overrides", () => {
    expect(validateCutscene(validScript({ steps: [{ kind: "lightsOut" }] })).ok).toBe(true);
    expect(
      validateCutscene(validScript({ steps: [{ kind: "lightsOut", durationMs: 400, steps: 4 }] })).ok,
    ).toBe(true);
  });

  it("accepts breakWall by wallId or by point, never both, never neither", () => {
    expect(validateCutscene(validScript({ steps: [{ kind: "breakWall", wallId: "abc" }] })).ok).toBe(true);
    expect(
      validateCutscene(validScript({ steps: [{ kind: "breakWall", at: { x: 800, y: 1600 } }] })).ok,
    ).toBe(true);
    const both = validateCutscene(
      validScript({ steps: [{ kind: "breakWall", wallId: "abc", at: { x: 1, y: 2 } }] }),
    );
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.errors.join(" ")).toContain("exactly one");
    expect(validateCutscene(validScript({ steps: [{ kind: "breakWall" }] })).ok).toBe(false);
  });
});

describe("validateCutscene: reveal image + emerge (FR-18 phase three)", () => {
  it("accepts an image reveal with what: 'image' and without what (the brief's shape)", () => {
    const withWhat = validateCutscene(
      validScript({
        steps: [{ kind: "reveal", what: "image", image: "worlds/testbed/x.png", mode: "chat" }],
      }),
    );
    expect(withWhat.ok).toBe(true);
    const briefShape = validateCutscene(
      validScript({
        steps: [{ kind: "reveal", image: "worlds/testbed/x.png", caption: "Look.", mode: "popout" }],
      }),
    );
    expect(briefShape.ok).toBe(true);
  });

  it("rejects an image reveal with no image, a bad mode, and an id alongside it", () => {
    expect(validateCutscene(validScript({ steps: [{ kind: "reveal", what: "image" }] })).ok).toBe(false);
    const badMode = validateCutscene(
      validScript({ steps: [{ kind: "reveal", image: "x.png", mode: "carrier-pigeon" }] }),
    );
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) expect(badMode.errors.join(" ")).toContain("mode");
    const withId = validateCutscene(
      validScript({ steps: [{ kind: "reveal", image: "x.png", id: "abc" }] }),
    );
    expect(withId.ok).toBe(false);
  });

  it("keeps the document reveal working (what + id) and rejects image fields on it", () => {
    expect(
      validateCutscene(validScript({ steps: [{ kind: "reveal", what: "tile", id: "abc" }] })).ok,
    ).toBe(true);
    const mixed = validateCutscene(
      validScript({ steps: [{ kind: "reveal", what: "tile", id: "abc", image: "x.png" }] }),
    );
    expect(mixed.ok).toBe(false);
  });

  it("accepts emerge and rejects a missing actor, corpse, or bad at", () => {
    expect(
      validateCutscene(
        validScript({ steps: [{ kind: "emerge", fromToken: "Ogre", actor: "Tentacle Creature" }] }),
      ).ok,
    ).toBe(true);
    expect(
      validateCutscene(validScript({ steps: [{ kind: "emerge", actor: "Tentacle Creature" }] })).ok,
    ).toBe(false);
    expect(
      validateCutscene(validScript({ steps: [{ kind: "emerge", fromToken: "Ogre" }] })).ok,
    ).toBe(false);
    expect(
      validateCutscene(
        validScript({ steps: [{ kind: "emerge", fromToken: "Ogre", actor: "X", at: { x: 1 } }] }),
      ).ok,
    ).toBe(false);
  });
});

describe("expandCutscene: rush", () => {
  it("expands 6 tokens into per-token move chains, waypoints in order", () => {
    const script = validScript({
      steps: [
        rushStep({
          tokens: ["Mouse", "Mouse", "Mouse", "Mouse", "Mouse", "Mouse"],
          bite: { damage: "1d4", targets: ["Ezren", "Kyra", "Merisiel", "Valeros"] },
          staggerMs: 400,
        }),
      ],
    });
    const validated = validateCutscene(script);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const expanded = expandCutscene(validated.script);
    // Per mouse: place + move(through) + roll(bite) + move(to) = 4;
    // 5 stagger pauses between the 6 mice.
    expect(expanded.length).toBe(6 * 4 + 5);
    const places = expanded.filter((s) => s.kind === "place");
    expect(places.length).toBe(6);
    expect(places.map((s) => (s as { name?: string }).name)).toEqual([
      "Mouse 1", "Mouse 2", "Mouse 3", "Mouse 4", "Mouse 5", "Mouse 6",
    ]);
    // First mouse's chain, in order: place, move to the waypoint,
    // bite roll, move to the exit.
    expect(expanded[0].kind).toBe("place");
    expect(expanded[1]).toMatchObject({ kind: "move", x: 800, y: 800 });
    expect(expanded[2]).toMatchObject({ kind: "roll", formula: "1d4", showInChat: true });
    expect(expanded[3]).toMatchObject({ kind: "move", x: 800, y: 100 });
    // Stagger pause sits between mouse 1's chain and mouse 2's place.
    expect(expanded[4]).toMatchObject({ kind: "pause", ms: 400 });
    expect(expanded[5].kind).toBe("place");
  });

  it("names bite targets round-robin from the author's ordered list", () => {
    const script = validScript({
      steps: [
        rushStep({
          tokens: ["Mouse", "Mouse", "Mouse"],
          bite: { damage: "1d4", targets: ["Ezren", "Kyra"] },
        }),
      ],
    });
    const validated = validateCutscene(script);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const rolls = expandCutscene(validated.script).filter((s) => s.kind === "roll");
    expect(rolls.map((s) => (s as { flavor?: string }).flavor)).toEqual([
      "Mouse 1 bites Ezren",
      "Mouse 2 bites Kyra",
      "Mouse 3 bites Ezren",
    ]);
  });

  it("emits a target-less bite roll when no targets are given, and no bite without bite", () => {
    const noTargets = validateCutscene(validScript({ steps: [rushStep({ bite: { damage: "1d4" } })] }));
    expect(noTargets.ok).toBe(true);
    if (!noTargets.ok) return;
    const rolls = expandCutscene(noTargets.script).filter((s) => s.kind === "roll");
    expect(rolls.length).toBe(2);
    expect((rolls[0] as { flavor?: string }).flavor).toContain("rushes past");
    const noBite = validateCutscene(validScript({ steps: [rushStep()] }));
    expect(noBite.ok).toBe(true);
    if (!noBite.ok) return;
    expect(expandCutscene(noBite.script).filter((s) => s.kind === "roll").length).toBe(0);
  });
});

describe("expandCutscene: emerge + pass-through steps", () => {
  it("places the new token at the corpse token's position, key naming the corpse", () => {
    const script = validScript({
      steps: [{ kind: "emerge", fromToken: "Ogre", actor: "Tentacle Creature", name: "Horror" }],
    });
    const validated = validateCutscene(script);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const expanded = expandCutscene(validated.script, {
      centerOf: (token) => {
        expect(token).toBe("Ogre");
        return { x: 800, y: 1200 };
      },
    });
    expect(expanded.length).toBe(1);
    expect(expanded[0]).toMatchObject({
      kind: "place",
      actor: "Tentacle Creature",
      x: 800,
      y: 1200,
      name: "Horror",
    });
    expect((expanded[0] as { key?: string }).key).toContain("from-Ogre");
  });

  it("uses at when given and never calls the resolver", () => {
    const script = validScript({
      steps: [
        { kind: "emerge", fromToken: "Ogre", actor: "Tentacle Creature", at: { x: 100, y: 200 } },
      ],
    });
    const validated = validateCutscene(script);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const expanded = expandCutscene(validated.script, {
      centerOf: () => {
        throw new Error("resolver must not be called when at is given");
      },
    });
    expect(expanded[0]).toMatchObject({ kind: "place", x: 100, y: 200 });
  });

  it("throws a clear error when the corpse needs resolving and no resolver is given", () => {
    const script = validScript({
      steps: [{ kind: "emerge", fromToken: "Ogre", actor: "Tentacle Creature" }],
    });
    const validated = validateCutscene(script);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(() => expandCutscene(validated.script)).toThrow(/live resolver/);
  });

  it("passes waitRound, lightsOut, and breakWall through with the script sceneId", () => {
    const script = validScript({
      steps: [
        { kind: "waitRound", round: 5, relative: true },
        { kind: "lightsOut" },
        { kind: "breakWall", at: { x: 800, y: 1600 } },
      ],
    });
    const validated = validateCutscene(script);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const expanded = expandCutscene(validated.script);
    expect(expanded).toMatchObject([
      { kind: "waitRound", round: 5, relative: true },
      { kind: "lightsOut", sceneId: "Test Scene" },
      { kind: "breakWall", sceneId: "Test Scene", at: { x: 800, y: 1600 } },
    ]);
  });
});

describe("lightsOutPlan", () => {
  it("fades every light to dim 0 / bright 0 / alpha 0, keeping the color", () => {
    const lights: LightDoc[] = [
      { _id: "a", x: 100, y: 100, config: { dim: 350, bright: 150, color: "#ff9a3c", alpha: 0.4 } },
      { _id: "b", x: 200, y: 200, config: { dim: 300, bright: 120, color: "#ff9a3c", alpha: 0.4 } },
      { _id: "c", x: 300, y: 300, config: { dim: 0, bright: 0, color: "#ffffff", alpha: 0 } },
    ];
    const plan = lightsOutPlan(lights);
    expect(plan.length).toBe(3);
    expect(plan[0]).toMatchObject({
      lightId: "a",
      from: { dim: 350, bright: 150, color: "#ff9a3c", alpha: 0.4 },
      to: { dim: 0, bright: 0, color: "#ff9a3c", alpha: 0 },
    });
    // A light already dark is still in the plan — nothing is missed.
    expect(plan[2].to).toMatchObject({ dim: 0, bright: 0, alpha: 0 });
    // Fast fade, not a snap: under a second, several steps.
    expect(plan[0].durationMs).toBeLessThanOrEqual(1000);
    expect(plan[0].steps).toBeGreaterThanOrEqual(2);
  });

  it("rejects a bad duration or step count", () => {
    const lights: LightDoc[] = [{ _id: "a", x: 0, y: 0 }];
    expect(() => lightsOutPlan(lights, { durationMs: 0 })).toThrow(/durationMs/);
    expect(() => lightsOutPlan(lights, { steps: 0 })).toThrow(/steps/);
  });
});

describe("reveal helpers", () => {
  it("builds a prompt naming the room, the corpse, and the creature — not generic gore", () => {
    const prompt = buildRevealPrompt(
      { name: "Lich's Lair — Entry Hall", description: "torch-lit stone hall" },
      { creature: "a thick, pale tentacle", corpse: "the dead ogre", action: "rips upward through its stomach" },
    );
    expect(prompt).toContain("Lich's Lair — Entry Hall");
    expect(prompt).toContain("the dead ogre");
    expect(prompt).toContain("a thick, pale tentacle");
    expect(prompt).toContain("rips upward through its stomach");
    expect(prompt.toLowerCase()).not.toContain("blood");
    expect(prompt.toLowerCase()).not.toContain("gore");
  });

  it("renders the chat HTML with the image inline and the caption under it, escaped", () => {
    const html = revealImageChatHtml("worlds/testbed/x.png", "A <tentacle> & more");
    expect(html).toContain('<img src="worlds/testbed/x.png"');
    expect(html).toContain("A &lt;tentacle&gt; &amp; more");
    expect(html).not.toContain("<tentacle>");
    expect(revealImageChatHtml("worlds/testbed/x.png")).not.toContain("<p");
    expect(escapeHtml(`"quoted"`)).toBe("&quot;quoted&quot;");
  });

  it("validateReveal accepts chat/popout and rejects a missing image or bad mode", () => {
    expect(validateReveal({ kind: "reveal", image: "x.png", mode: "chat" }).ok).toBe(true);
    expect(validateReveal({ kind: "reveal", image: "x.png", mode: "popout" }).ok).toBe(true);
    expect(validateReveal({ kind: "reveal" }).ok).toBe(false);
    const bad = validateReveal({ kind: "reveal", image: "x.png", mode: "smoke-signal" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toContain("mode");
  });
});

describe("demo scripts end to end", () => {
  it("mice-ogre validates and expands 10 -> 38, ogre phase on the round clock", () => {
    const parsed: unknown = JSON.parse(
      fs.readFileSync("examples/mice-ogre.json", "utf-8"),
    );
    const validated = validateCutscene(parsed);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.script.steps.length).toBe(10);
    const expanded = expandCutscene(validated.script);
    expect(expanded.length).toBe(38);
    const kinds = expanded.map((s) => s.kind);
    // The ogre phase starts after the mice: place, move, face, roar,
    // wall smash, lights out — gated by the round clock.
    const waitIdx = kinds.indexOf("waitRound");
    expect(waitIdx).toBeGreaterThan(0);
    expect(kinds.slice(waitIdx)).toEqual([
      "waitRound", "place", "move", "face", "chat", "breakWall", "lightsOut", "chat",
    ]);
    const wait = expanded[waitIdx] as { round?: number; relative?: boolean };
    expect(wait.round).toBe(5);
    expect(wait.relative).toBe(true);
  });

  it("tentacle-twist validates and expands 7 -> 7, emerge from the ogre's corpse", () => {
    const parsed: unknown = JSON.parse(
      fs.readFileSync("examples/tentacle-twist.json", "utf-8"),
    );
    const validated = validateCutscene(parsed);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.script.steps.length).toBe(7);
    const expanded = expandCutscene(validated.script);
    expect(expanded.length).toBe(7);
    const kinds = expanded.map((s) => s.kind);
    expect(kinds).toEqual(["chat", "pause", "chat", "reveal", "place", "ping", "chat"]);
    const place = expanded[4] as { kind: string; actor?: string; x?: number; y?: number; key?: string };
    expect(place.actor).toBe("Tentacle Creature");
    expect(place.x).toBe(800);
    expect(place.y).toBe(1200);
    expect(place.key).toContain("from-Ogre");
    const reveal = expanded[3] as { kind: string; image?: string; mode?: string };
    expect(reveal.image).toBe("worlds/testbed/tentacle-emergence.png");
    expect(reveal.mode).toBe("chat");
  });
});
