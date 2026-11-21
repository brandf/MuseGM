/**
 * Offline tests for the Meroki Pins Foundry module script
 * (modules/meroki-pins/scripts/meroki-pins.js).
 *
 * The module runs inside Foundry, so it is loaded here by evaluating its
 * source with stubbed Foundry globals (Hooks, canvas, game, ui, document,
 * JournalEntry, Note, CONST, PIXI, foundry). The stubs record every call,
 * so these tests verify the module's WIRING against the APIs verified in
 * the module header: the ContextMenu constructor args, the DialogV2.wait
 * config shape + button-callback signature, and the ui.controls.activate
 * call that switches the tool back. They do not verify Foundry itself —
 * the live checklist (module README) covers the bundle-level behavior.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const MODULE_SOURCE = fs.readFileSync(
  path.join(import.meta.dir, "..", "modules", "meroki-pins", "scripts", "meroki-pins.js"),
  "utf-8",
);

interface StubWorld {
  hooks: Record<string, (...args: any[]) => any>;
  calls: {
    journalCreate: any[];
    noteCreate: any[];
    dialogWait: any[];
    activate: any[];
    contextMenus: any[];
    notifications: { level: string; msg: string }[];
    consoleWarn: string[];
    stageOnce: any[];
    stageOff: any[];
    boardListeners: Record<string, ((e: any) => void)[]>;
  };
  setTextarea: (value: string) => void;
  setDialogBehavior: (b: "drop" | "cancel" | "dismiss") => void;
  setBoardPresent: (present: boolean) => void;
  setDialogV2: (d: any) => void;
  setContextMenuClass: (c: any) => void;
  setScene: (scene: any) => void;
  canvasEl: any;
  boardEl: any;
  fire: (hook: string, ...args: any[]) => any;
  dispatchBoard: (type: string, event: any) => void;
}

function loadModule(): StubWorld {
  const calls: StubWorld["calls"] = {
    journalCreate: [],
    noteCreate: [],
    dialogWait: [],
    activate: [],
    contextMenus: [],
    notifications: [],
    consoleWarn: [],
    stageOnce: [],
    stageOff: [],
    boardListeners: {},
  };
  const hooks: Record<string, (...args: any[]) => any> = {};
  const Hooks = {
    once: (name: string, fn: (...a: any[]) => any) => {
      hooks[name] = fn;
    },
    on: (name: string, fn: (...a: any[]) => any) => {
      hooks[name] = fn;
    },
  };

  let textareaValue = "";
  let dialogBehavior: "drop" | "cancel" | "dismiss" = "drop";
  let boardPresent = true;
  let scene: any = { id: "scene-1", name: "Entry Hall" };

  const canvasEl = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
  };
  const boardEl = {
    id: "board",
    addEventListener: (type: string, fn: (e: any) => void) => {
      (calls.boardListeners[type] ??= []).push(fn);
    },
  };
  const stage = {
    // Fake 2x world transform: proves coords flow through toLocal,
    // not straight from the client event.
    toLocal: (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 }),
    once: (type: string, fn: (e: any) => void) => {
      calls.stageOnce.push({ type, fn });
    },
    off: (type: string, fn: (e: any) => void) => {
      calls.stageOff.push({ type, fn });
    },
  };
  const canvas = {
    get scene() {
      return scene;
    },
    app: { stage, view: canvasEl },
  };
  const game = { user: { can: (_perm: string) => true } };
  const ui = {
    notifications: {
      info: (msg: string) => calls.notifications.push({ level: "info", msg }),
      warn: (msg: string) => calls.notifications.push({ level: "warn", msg }),
      error: (msg: string) => calls.notifications.push({ level: "error", msg }),
    },
    controls: {
      activate: async (opts: any) => {
        calls.activate.push(opts);
      },
    },
  };
  const textareaEl = {
    get value() {
      return textareaValue;
    },
    focus: () => {
      (textareaEl as any).focused = true;
    },
    focused: false,
  };
  const documentStub = {
    querySelector: (sel: string) => (sel === "#meroki-pin-request" ? textareaEl : null),
    getElementById: (id: string) => (id === "board" && boardPresent ? boardEl : null),
  };
  const JournalEntry = {
    create: async (data: any) => {
      calls.journalCreate.push(data);
      return { id: "entry-1", pages: { contents: [{ id: "page-1" }] } };
    },
  };
  const Note = {
    create: async (data: any, opts: any) => {
      calls.noteCreate.push({ data, opts });
      return { id: "note-1" };
    },
  };
  const CONST = { JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 } };
  const PIXI = {
    Point: class {
      x: number;
      y: number;
      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
    },
  };
  const consoleStub = {
    log: () => {},
    warn: (msg: string) => calls.consoleWarn.push(String(msg)),
    error: () => {},
  };

  let DialogV2: any = {
    wait: async (config: any) => {
      calls.dialogWait.push(config);
      config.render?.({}, {});
      if (dialogBehavior === "dismiss") return null;
      if (dialogBehavior === "cancel") return "cancel";
      const drop = config.buttons.find((b: any) => b.action === "drop");
      return drop.callback({}, {}, {});
    },
  };
  let ContextMenuClass: any = class {
    constructor(container: any, selector: any, items: any, options: any) {
      calls.contextMenus.push({ container, selector, items, options });
    }
  };
  const foundryStub: any = {
    applications: {
      api: { DialogV2 },
      ux: { ContextMenu: ContextMenuClass },
    },
  };
  // Keep the stub classes in sync when a test swaps them.
  const syncFoundry = () => {
    foundryStub.applications.api.DialogV2 = DialogV2;
    foundryStub.applications.ux.ContextMenu = ContextMenuClass;
  };

  const loader = new Function(
    "Hooks",
    "canvas",
    "game",
    "ui",
    "document",
    "JournalEntry",
    "Note",
    "CONST",
    "PIXI",
    "console",
    "globalThis",
    MODULE_SOURCE,
  );
  loader(Hooks, canvas, game, ui, documentStub, JournalEntry, Note, CONST, PIXI, consoleStub, {
    foundry: foundryStub,
  });

  return {
    hooks,
    calls,
    setTextarea: (v: string) => {
      textareaValue = v;
    },
    setDialogBehavior: (b: "drop" | "cancel" | "dismiss") => {
      dialogBehavior = b;
    },
    setBoardPresent: (p: boolean) => {
      boardPresent = p;
    },
    setDialogV2: (d: any) => {
      DialogV2 = d;
      syncFoundry();
    },
    setContextMenuClass: (c: any) => {
      ContextMenuClass = c;
      syncFoundry();
    },
    setScene: (s: any) => {
      scene = s;
    },
    canvasEl,
    boardEl,
    fire: (hook: string, ...args: any[]) => hooks[hook]?.(...args),
    dispatchBoard: (type: string, event: any) => {
      for (const fn of calls.boardListeners[type] ?? []) fn(event);
    },
  };
}

/** Register the toolbar tool and return its definition. */
function getTool(world: StubWorld): any {
  const controls: any[] = [{ name: "notes", tools: [] }];
  world.fire("getSceneControlButtons", controls);
  return controls[0].tools.find((t: any) => t.name === "meroki-pin");
}

function pointerdownAt(x: number, y: number): any {
  return {
    button: 0,
    getLocalPosition: (_stage: any) => ({ x, y }),
  };
}

describe("meroki-pins module — toolbar tool", () => {
  it("registers a toggle tool in the Notes control", () => {
    const world = loadModule();
    const tool = getTool(world);
    expect(tool).toBeDefined();
    expect(tool.toggle).toBe(true);
    expect(tool.title).toBe("Meroki Pin");
    expect(typeof tool.onChange).toBe("function");
  });

  it("does not double-register", () => {
    const world = loadModule();
    const controls: any[] = [{ name: "notes", tools: [{ name: "meroki-pin" }] }];
    world.fire("getSceneControlButtons", controls);
    expect(controls[0].tools).toHaveLength(1);
  });

  it("arming then clicking opens the DialogV2 dialog at the click", async () => {
    const world = loadModule();
    const tool = getTool(world);
    tool.onChange({}, true);
    expect(world.calls.stageOnce).toHaveLength(1);
    expect(world.calls.stageOnce[0].type).toBe("pointerdown");

    world.setTextarea("chest here");
    const handler = world.calls.stageOnce[0].fn;
    await handler(pointerdownAt(400, 300));

    expect(world.calls.dialogWait).toHaveLength(1);
    const config = world.calls.dialogWait[0];
    expect(config.window.title).toBe("Drop a Meroki Pin");
    expect(config.content).toContain("(400, 300)");
    expect(config.content).toContain("Entry Hall");
    expect(Array.isArray(config.buttons)).toBe(true);
    expect(config.buttons.map((b: any) => b.action)).toEqual(["drop", "cancel"]);
    expect(config.buttons[0].default).toBe(true);
    expect(config.rejectClose).toBe(false);
    expect(typeof config.render).toBe("function");
  });

  it("drop creates the JournalEntry + gold Note and switches the tool back", async () => {
    const world = loadModule();
    const tool = getTool(world);
    tool.onChange({}, true);
    world.setTextarea("put a secret door here");
    await world.calls.stageOnce[0].fn(pointerdownAt(400, 300));

    expect(world.calls.journalCreate).toHaveLength(1);
    const entry = world.calls.journalCreate[0];
    expect(entry.flags.meroki).toEqual({
      request: "put a secret door here",
      status: "open",
      scene: "scene-1",
      x: 400,
      y: 300,
    });
    expect(world.calls.noteCreate).toHaveLength(1);
    const note = world.calls.noteCreate[0];
    expect(note.data.entryId).toBe("entry-1");
    expect(note.data.pageId).toBe("page-1");
    expect(note.data.x).toBe(400);
    expect(note.data.y).toBe(300);
    expect(note.data.textColor).toBe("#e8c15a");
    expect(note.data.flags.meroki).toEqual({
      request: "put a secret door here",
      status: "open",
      entryId: "entry-1",
    });
    expect(note.opts.parent).toBeDefined();

    // Tool disarms / switches back after the pin is placed.
    expect(world.calls.activate).toEqual([
      { control: "notes", toggles: { "meroki-pin": false } },
    ]);
  });

  it("onChange(false) disarms placement", () => {
    const world = loadModule();
    const tool = getTool(world);
    tool.onChange({}, true);
    const handler = world.calls.stageOnce[0].fn;
    tool.onChange({}, false);
    expect(world.calls.stageOff).toEqual([{ type: "pointerdown", fn: handler }]);
  });

  it("right-click on the canvas does not open the dialog", async () => {
    const world = loadModule();
    const tool = getTool(world);
    tool.onChange({}, true);
    await world.calls.stageOnce[0].fn({ button: 2, getLocalPosition: () => ({ x: 1, y: 1 }) });
    expect(world.calls.dialogWait).toHaveLength(0);
  });
});

describe("meroki-pins module — DialogV2 dialog", () => {
  it("empty text warns and creates no pin", async () => {
    const world = loadModule();
    const tool = getTool(world);
    tool.onChange({}, true);
    world.setTextarea("   ");
    await world.calls.stageOnce[0].fn(pointerdownAt(10, 10));
    expect(world.calls.journalCreate).toHaveLength(0);
    expect(world.calls.noteCreate).toHaveLength(0);
    expect(world.calls.notifications.some((n) => n.level === "warn")).toBe(true);
    expect(world.calls.activate).toHaveLength(0);
  });

  it("over-long text warns and creates no pin", async () => {
    const world = loadModule();
    const tool = getTool(world);
    tool.onChange({}, true);
    world.setTextarea("x".repeat(2001));
    await world.calls.stageOnce[0].fn(pointerdownAt(10, 10));
    expect(world.calls.journalCreate).toHaveLength(0);
  });

  it("cancel resolves without creating a pin", async () => {
    const world = loadModule();
    world.setDialogBehavior("cancel");
    const tool = getTool(world);
    tool.onChange({}, true);
    world.setTextarea("chest here");
    await world.calls.stageOnce[0].fn(pointerdownAt(10, 10));
    expect(world.calls.journalCreate).toHaveLength(0);
    expect(world.calls.activate).toHaveLength(0);
  });

  it("dismiss resolves without creating a pin", async () => {
    const world = loadModule();
    world.setDialogBehavior("dismiss");
    const tool = getTool(world);
    tool.onChange({}, true);
    world.setTextarea("chest here");
    await world.calls.stageOnce[0].fn(pointerdownAt(10, 10));
    expect(world.calls.journalCreate).toHaveLength(0);
  });

  it("missing DialogV2 errors instead of throwing", async () => {
    const world = loadModule();
    world.setDialogV2(undefined);
    const tool = getTool(world);
    tool.onChange({}, true);
    world.setTextarea("chest here");
    await world.calls.stageOnce[0].fn(pointerdownAt(10, 10));
    expect(world.calls.journalCreate).toHaveLength(0);
    expect(world.calls.notifications.some((n) => n.level === "error")).toBe(true);
  });
});

describe("meroki-pins module — canvas context menu", () => {
  it("builds the menu once on ready, with the verified constructor shape", () => {
    const world = loadModule();
    world.fire("ready");
    world.fire("canvasReady");
    expect(world.calls.contextMenus).toHaveLength(1);
    const menu = world.calls.contextMenus[0];
    expect(menu.container).toBe(world.boardEl);
    expect(menu.selector).toBe("canvas");
    expect(menu.options).toEqual({ jQuery: false, fixed: true });
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0].name).toBe("Drop a Meroki Pin here");
    expect(menu.items[0].icon).toContain("fa-map-pin");
    expect(typeof menu.items[0].callback).toBe("function");
    expect(typeof menu.items[0].condition).toBe("function");
  });

  it("retries on canvasReady when the board is not there yet", () => {
    const world = loadModule();
    world.setBoardPresent(false);
    world.fire("ready");
    expect(world.calls.contextMenus).toHaveLength(0);
    world.setBoardPresent(true);
    world.fire("canvasReady");
    expect(world.calls.contextMenus).toHaveLength(1);
  });

  it("entry is hidden when no scene is active", () => {
    const world = loadModule();
    world.fire("ready");
    const entry = world.calls.contextMenus[0].items[0];
    expect(entry.condition()).toBe(true);
    world.setScene(null);
    expect(entry.condition()).toBe(false);
  });

  it("right-click then menu entry opens the dialog at the world coords", async () => {
    const world = loadModule();
    world.fire("ready");
    const entry = world.calls.contextMenus[0].items[0];
    // client (100, 50), canvas rect origin (10, 20) -> stage (90, 30),
    // fake 2x toLocal -> world (180, 60).
    world.dispatchBoard("contextmenu", { clientX: 100, clientY: 50 });
    world.setTextarea("torch here");
    entry.callback();
    // The callback fires openPinDialog without awaiting it; let it run.
    await Bun.sleep(0);
    expect(world.calls.dialogWait).toHaveLength(1);
    expect(world.calls.dialogWait[0].content).toContain("(180, 60)");
    expect(world.calls.journalCreate).toHaveLength(1);
    expect(world.calls.journalCreate[0].flags.meroki.x).toBe(180);
    expect(world.calls.journalCreate[0].flags.meroki.y).toBe(60);
    // A context-menu pin leaves the controls alone: nothing was armed.
    expect(world.calls.activate).toHaveLength(0);
  });

  it("menu entry without a prior right-click warns and opens nothing", () => {
    const world = loadModule();
    world.fire("ready");
    const entry = world.calls.contextMenus[0].items[0];
    entry.callback();
    expect(world.calls.dialogWait).toHaveLength(0);
    expect(world.calls.notifications.some((n) => n.level === "warn")).toBe(true);
  });

  it("missing ContextMenu class warns and leaves the toolbar working", () => {
    const world = loadModule();
    world.setContextMenuClass(undefined);
    world.fire("ready");
    expect(world.calls.contextMenus).toHaveLength(0);
    expect(world.calls.consoleWarn.some((w) => w.includes("ContextMenu"))).toBe(true);
    expect(getTool(world)).toBeDefined();
  });
});
