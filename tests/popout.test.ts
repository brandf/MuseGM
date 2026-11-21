/**
 * Reveal popout tests (BRA-236, FR-18 phase three) — the client-side
 * half of the image reveal. Pure payload build/validate, the socket
 * emit helper against a fake live, and the sequence player's reveal /
 * dismissReveal steps. No Foundry connection: whether the module
 * actually pops on players' screens is live-tested next session.
 */
import { describe, it, expect } from "bun:test";
import {
  POPOUT_MODULE_ID,
  POPOUT_SOCKET_EVENT,
  buildPopoutDismiss,
  buildPopoutShow,
  emitPopout,
  validatePopoutMessage,
} from "../src/session/popout.js";
import type { PopoutMessage } from "../src/session/popout.js";
import { runSequence } from "../src/session/sequence.js";
import { validateCutscene } from "../src/session/cutscene.js";
import type { FoundryLive } from "../src/live.js";

// ---------------------------------------------------------------- fake live

interface SentMsg {
  content: string;
  opts: Record<string, unknown>;
}

interface EmittedMsg {
  event: string;
  args: unknown[];
}

function fakeLive(opts: { socket?: { emit: (event: string, ...args: unknown[]) => void } | null } = {}) {
  const sent: SentMsg[] = [];
  const emitted: EmittedMsg[] = [];
  const socket =
    opts.socket === undefined
      ? { emit: (event: string, ...args: unknown[]) => { emitted.push({ event, args }); } }
      : opts.socket;
  const live = {
    sent,
    emitted,
    sendChat: async (content: string, o: Record<string, unknown> = {}) => {
      sent.push({ content, opts: o });
      return "sent-1";
    },
    raw: () => ({ socket }),
  };
  return live;
}

function validScript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "Test Scene",
    sceneId: "Test Scene",
    steps: [{ kind: "chat", content: "Hello." }],
    ...overrides,
  };
}

// ---------------------------------------------------------------- builders

describe("buildPopoutShow / buildPopoutDismiss", () => {
  it("builds a show message on the module socket event", () => {
    expect(POPOUT_MODULE_ID).toBe("meroki-reveal");
    expect(POPOUT_SOCKET_EVENT).toBe("module.meroki-reveal");
    const built = buildPopoutShow("worlds/testbed/x.png", "The ogre splits open.");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.message.action).toBe("show");
    expect(built.message.image).toBe("worlds/testbed/x.png");
    expect(built.message.caption).toBe("The ogre splits open.");
    expect(built.message.id.startsWith("popout-")).toBe(true);
  });

  it("omits the caption key when none is given, and keeps an explicit id", () => {
    const built = buildPopoutShow("worlds/testbed/x.png", undefined, "popout-fixed");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect("caption" in built.message).toBe(false);
    expect(built.message.id).toBe("popout-fixed");
  });

  it("rejects an empty image, a non-string image, a non-string caption — and collects all errors", () => {
    expect(buildPopoutShow("").ok).toBe(false);
    expect(buildPopoutShow(42).ok).toBe(false);
    expect(buildPopoutShow("x.png", 7).ok).toBe(false);
    const bad = buildPopoutShow("", 7);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors).toHaveLength(2);
    expect(bad.errors.join(" ")).toContain("image");
    expect(bad.errors.join(" ")).toContain("caption");
  });

  it("builds a dismiss with and without an id", () => {
    expect(buildPopoutDismiss()).toEqual({ action: "dismiss" });
    expect(buildPopoutDismiss("popout-abc")).toEqual({ action: "dismiss", id: "popout-abc" });
  });
});

describe("validatePopoutMessage", () => {
  it("accepts show and dismiss messages built by the builders", () => {
    const show = buildPopoutShow("x.png", "Look.");
    expect(show.ok).toBe(true);
    if (!show.ok) return;
    expect(validatePopoutMessage(show.message).ok).toBe(true);
    expect(validatePopoutMessage(buildPopoutDismiss()).ok).toBe(true);
    expect(validatePopoutMessage(buildPopoutDismiss("popout-1")).ok).toBe(true);
  });

  it("rejects non-objects, unknown actions, and malformed shows/dismisses", () => {
    for (const bad of [null, undefined, "show", 42, [], { action: "explode", image: "x.png", id: "p1" }]) {
      expect(validatePopoutMessage(bad).ok).toBe(false);
    }
    expect(validatePopoutMessage({ action: "show", caption: "x", id: "p1" }).ok).toBe(false);
    expect(validatePopoutMessage({ action: "show", image: "", id: "p1" }).ok).toBe(false);
    expect(validatePopoutMessage({ action: "show", image: "x.png", caption: 3, id: "p1" }).ok).toBe(false);
    expect(validatePopoutMessage({ action: "show", image: "x.png" }).ok).toBe(false);
    expect(validatePopoutMessage({ action: "dismiss", id: "" }).ok).toBe(false);
  });
});

describe("emitPopout", () => {
  it("emits the message on the module socket event and reports success", () => {
    const live = fakeLive();
    const show = buildPopoutShow("x.png", "Look.");
    expect(show.ok).toBe(true);
    if (!show.ok) return;
    expect(emitPopout(live as unknown as FoundryLive, show.message)).toEqual({ emitted: true });
    expect(live.emitted).toHaveLength(1);
    expect(live.emitted[0].event).toBe("module.meroki-reveal");
    expect(live.emitted[0].args[0]).toEqual(show.message);
  });

  it("reports a missing socket instead of throwing, and never emits", () => {
    const live = fakeLive({ socket: null });
    const show = buildPopoutShow("x.png");
    expect(show.ok).toBe(true);
    if (!show.ok) return;
    const result = emitPopout(live as unknown as FoundryLive, show.message);
    expect(result.emitted).toBe(false);
    if (result.emitted) return;
    expect(result.reason).toContain("Socket is not connected");
    expect(live.emitted).toHaveLength(0);
  });

  it("reports a throwing emit instead of throwing", () => {
    const live = fakeLive({
      socket: {
        emit: () => {
          throw new Error("boom");
        },
      },
    });
    const show = buildPopoutShow("x.png");
    expect(show.ok).toBe(true);
    if (!show.ok) return;
    const result = emitPopout(live as unknown as FoundryLive, show.message);
    expect(result.emitted).toBe(false);
    if (result.emitted) return;
    expect(result.reason).toContain("boom");
  });
});

// ---------------------------------------------------------------- sequence wiring

describe("runSequence: reveal popout + dismissReveal", () => {
  it("popout mode posts the chat image AND emits the show, reporting popout:true", async () => {
    const live = fakeLive();
    const out = await runSequence(live as unknown as FoundryLive, [
      { kind: "reveal", image: "worlds/testbed/x.png", caption: "Look.", mode: "popout" },
    ]);
    expect(out.ok).toBe(true);
    // Degraded path first: the inline chat image always posts.
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].content).toContain("worlds/testbed/x.png");
    // Then the socket popout on top of it.
    expect(live.emitted).toHaveLength(1);
    expect(live.emitted[0].event).toBe("module.meroki-reveal");
    const msg = live.emitted[0].args[0] as PopoutMessage;
    expect(msg.action).toBe("show");
    if (msg.action !== "show") return;
    expect(msg.image).toBe("worlds/testbed/x.png");
    expect(msg.caption).toBe("Look.");
    const result = out.steps[0].result as Record<string, unknown>;
    expect(result.mode).toBe("popout");
    expect(result.popout).toBe(true);
    expect(result.popoutId).toBe(msg.id);
  });

  it("popout mode with no socket still posts the chat image and reports popout:false with a reason", async () => {
    const live = fakeLive({ socket: null });
    const out = await runSequence(live as unknown as FoundryLive, [
      { kind: "reveal", image: "worlds/testbed/x.png", mode: "popout" },
    ]);
    expect(out.ok).toBe(true);
    expect(live.sent).toHaveLength(1);
    expect(live.emitted).toHaveLength(0);
    const result = out.steps[0].result as Record<string, unknown>;
    expect(result.popout).toBe(false);
    expect(typeof result.note).toBe("string");
    expect((result.note as string).length).toBeGreaterThan(0);
  });

  it("chat mode posts the image and emits nothing", async () => {
    const live = fakeLive();
    const out = await runSequence(live as unknown as FoundryLive, [
      { kind: "reveal", image: "worlds/testbed/x.png", caption: "Look.", mode: "chat" },
    ]);
    expect(out.ok).toBe(true);
    expect(live.sent).toHaveLength(1);
    expect(live.emitted).toHaveLength(0);
    expect(out.steps[0].result).toEqual({ id: "sent-1", mode: "chat" });
  });

  it("dismissReveal emits a dismiss (with id when given) and reports dismissed:true", async () => {
    const live = fakeLive();
    const out = await runSequence(live as unknown as FoundryLive, [
      { kind: "dismissReveal", id: "popout-abc" },
    ]);
    expect(out.ok).toBe(true);
    expect(live.sent).toHaveLength(0); // a dismiss is silent — no chat post
    expect(live.emitted).toHaveLength(1);
    expect(live.emitted[0].args[0]).toEqual({ action: "dismiss", id: "popout-abc" });
    expect(out.steps[0].result).toEqual({ dismissed: true, popoutId: "popout-abc" });

    const live2 = fakeLive();
    const out2 = await runSequence(live2 as unknown as FoundryLive, [{ kind: "dismissReveal" }]);
    expect(out2.steps[0].result).toEqual({ dismissed: true });
    expect(live2.emitted[0].args[0]).toEqual({ action: "dismiss" });
  });

  it("dismissReveal with no socket reports dismissed:false with a reason, and the run stays ok", async () => {
    const live = fakeLive({ socket: null });
    const out = await runSequence(live as unknown as FoundryLive, [{ kind: "dismissReveal" }]);
    expect(out.ok).toBe(true);
    const result = out.steps[0].result as Record<string, unknown>;
    expect(result.dismissed).toBe(false);
    expect(typeof result.note).toBe("string");
  });
});

describe("validateCutscene: dismissReveal", () => {
  it("accepts dismissReveal with and without an id", () => {
    expect(
      validateCutscene(validScript({ steps: [{ kind: "dismissReveal" }] })).ok,
    ).toBe(true);
    expect(
      validateCutscene(validScript({ steps: [{ kind: "dismissReveal", id: "popout-abc" }] })).ok,
    ).toBe(true);
  });

  it("rejects a non-string id and an unknown field on dismissReveal", () => {
    expect(
      validateCutscene(validScript({ steps: [{ kind: "dismissReveal", id: 7 }] })).ok,
    ).toBe(false);
    expect(
      validateCutscene(validScript({ steps: [{ kind: "dismissReveal", image: "x.png" }] })).ok,
    ).toBe(false);
  });

  it("accepts a script that reveals in popout mode and later dismisses it", () => {
    expect(
      validateCutscene(
        validScript({
          steps: [
            { kind: "reveal", image: "worlds/testbed/x.png", caption: "Look.", mode: "popout" },
            { kind: "pause", ms: 5000 },
            { kind: "dismissReveal" },
          ],
        }),
      ).ok,
    ).toBe(true);
  });
});
