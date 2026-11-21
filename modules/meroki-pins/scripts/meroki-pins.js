/**
 * Meroki Pins — Foundry VTT module, v1.1 (0.2.0).
 *
 * What it does
 *   Drops a Note pin backed by a JournalEntry carrying
 *   `flags.meroki.request`. Two ways to drop one:
 *   - Notes-toolbar toggle ("Meroki Pin"): click the tool, click the map,
 *     type the request in the dialog. (v1 path, unchanged.)
 *   - Right-click the canvas and pick "Drop a Meroki Pin here" from the
 *     context menu: the dialog opens at the right-clicked spot. (v1.1.)
 *   After a pin is placed from the toolbar tool, the tool disarms and the
 *   controls switch back to the Notes tool automatically. (v1.1.)
 *   Muse (the Meroki monitor) watches for new pins, acts on them — e.g.
 *   a secret door at the pinned spot plus the room behind it — replies
 *   in chat, and marks the pin resolved.
 *
 *   v1.1 is one request per pin. A real back-and-forth thread on a pin is v2.
 *
 * Why the context menu does not fight the ping
 *   Right-click on the canvas is already ping / pan. The menu is an
 *   ADDITIONAL listener on the board element: it neither prevents the
 *   event nor stops its propagation, so core's ping still fires (a pulse
 *   where you right-clicked) and the menu opens on top of it. The menu
 *   entry then opens the same dialog the toolbar tool opens, at the
 *   right-clicked coordinates (recorded by our own `contextmenu`
 *   listener — the ContextMenu entry callback only receives the target
 *   element, never the pointer position).
 *
 * API notes — what is verified vs. what is assumed
 *   VERIFIED (official Foundry VTT v14 API docs, foundryvtt.com/api, and
 *   the @league-of-foundry-developers/foundry-vtt-types 13.346 type
 *   definitions, both read 2026-11-21 — the 14.370 client bundle itself
 *   is NOT on disk, see the live-check list at the bottom):
 *     - `foundry.applications.ux.ContextMenu` (v14 API index lists it
 *       under that path). `new ContextMenu(container, selector,
 *       menuItems, options)` with `options: { jQuery: false,
 *       fixed?: boolean, eventName?: string, onOpen?, onClose? }` —
 *       `jQuery: false` is the v14 default (per the types' deprecation
 *       note) and is passed explicitly. Entry shape: `{ name, icon?,
 *       group?, callback: (target: HTMLElement) => void,
 *       condition?: boolean | ((target) => boolean) }`. `fixed: true`
 *       positions the menu at the pointer in the viewport instead of
 *       injecting it into the target.
 *     - `foundry.applications.api.DialogV2.wait(config)` where config
 *       is `Partial<ApplicationConfiguration & DialogV2Configuration &
 *       DialogV2WaitOptions>`: `window: { title }` for the title,
 *       `content` (string or element), `buttons: DialogV2Button[]`
 *       with `{ action, label, callback?, default?, icon? }`,
 *       `rejectClose` (false = dismiss resolves null instead of
 *       throwing), `render?: (event, dialog) => any`.
 *     - `DialogV2ButtonCallback` is `(event: PointerEvent |
 *       SubmitEvent, button: HTMLButtonElement, dialog: DialogV2) =>
 *       Promise<any>`. `wait` resolves to the clicked button's `action`
 *       identifier, OR to the value returned by its callback. The drop
 *       callback returns the created JournalEntry id (or false when the
 *       text fails validation); Cancel has no callback so `wait`
 *       resolves to "cancel"; dismissing resolves to null.
 *     - `ui.controls.activate(options)` with `ActivateOptions = {
 *       event?, control?, tool?, toggles?: Record<string, boolean> }`.
 *       Passing `toggles: { "meroki-pin": false }` turns the toggle
 *       off through its `onChange(event, false)` — the same path as
 *       clicking the tool off. No tool name is guessed: activating the
 *       "notes" control with no `tool` keeps the control's current /
 *       default tool. (`activeControl` / `activeTool` / `initialize`
 *       are deprecated since v13 until v15 — `activate` is the v14 way.)
 *   ASSUMED (standard Foundry/Pixi patterns — verify on first install):
 *     - `canvas.app.stage.once("pointerdown", fn)` receives a Pixi
 *       FederatedPointerEvent; `event.getLocalPosition(canvas.app.stage)`
 *       returns canvas/world coordinates (the stage is the world root,
 *       so stage-local == scene coordinates).
 *     - `event.button === 0` means the primary (left) mouse button.
 *     - `document.getElementById("board")` is the board div containing
 *       the `<canvas>` element (`canvas.app.view`); a ContextMenu on it
 *       with selector `"canvas"` fires for right-clicks on the map.
 *     - A DOM `contextmenu` event's client coords convert to world
 *       coords via `canvas.app.stage.toLocal(new PIXI.Point(sx, sy))`
 *       where (sx, sy) is the position within the canvas element
 *       (`getBoundingClientRect` origin). Same assumption class as the
 *       v1 `getLocalPosition` one.
 *     - Core's canvas ping handler does not `stopPropagation()` on the
 *       `contextmenu` event, so a menu bound on the board still opens
 *       (and the ping still pulses). If core ever swallows the event,
 *       the menu silently never opens while the toolbar tool keeps
 *       working — that is the live-check item, not a crash.
 *     - `game.user.can("JOURNAL_CREATE")` is the permission check for
 *       creating journal entries; `Note.create(data, {parent: scene})`
 *       creates the embedded Note; `CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML`
 *       is 1. All are guarded or commented where a wrong guess would
 *       break the flow.
 *     - The Notes layer's click handler ignores clicks while a different
 *       tool is active, so arming this toggle tool does not ALSO open a
 *       core note dialog. (If it does, close the extra dialog — the pin
 *       still gets created. See "Known rough edges" in the README.)
 *
 * The pin contract (what the monitor looks for — keep in sync with the
 * module README and BACKLOG.md):
 *   JournalEntry.flags.meroki = { request, status: "open"|"done",
 *     scene, x, y }              — the request lives here; the journal
 *     page holds the human-readable text.
 *   Note.flags.meroki = { request, status: "open"|"done", entryId }
 *     — the visible pin; the monitor can find the entry from it.
 *   The monitor marks a pin done by setting flags.meroki.status = "done"
 *   on both documents (and may append its reply to the journal page).
 *
 * Live checks (need Dave's Foundry up — the 14.370 bundle is not on
 * disk, so these were verified against the v14 docs/types only):
 *   - Right-click the canvas: the menu opens AND the ping still pulses.
 *   - Menu entry opens the dialog at the right-clicked spot (coords).
 *   - Drop Pin from the toolbar tool: the toggle visually switches off
 *     and the controls go back to the Notes tool.
 *   - Drop Pin from the menu: the controls do NOT switch (nothing was
 *     armed, nothing to disarm).
 *   - DialogV2.wait resolves as documented (drop → entry id, cancel →
 *     "cancel", X/Esc → null, empty text → warning + no pin).
 */

const MODULE_ID = "meroki-pins";
const FLAG_SCOPE = "meroki";
const TOOL_NAME = "meroki-pin";
const PIN_TEXT_COLOR = "#e8c15a"; // gold — Meroki's pin color, stands out from core notes
const MAX_REQUEST_LENGTH = 2000;
/** How long a recorded right-click position stays usable (ms). */
const CONTEXT_MENU_POSITION_TTL_MS = 10_000;

/** True while the next canvas click should open the pin dialog. */
let placementArmed = false;
/** The canvas context menu instance (built once). */
let canvasContextMenu = null;
/** Last right-clicked world position, recorded by our own listener. */
let lastContextMenuPos = null;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Meroki Pins loaded — Notes toolbar, "Meroki Pin" tool.`);
});

/* ------------------------------------------------------------------ */
/* Scene control tool                                                  */
/* ------------------------------------------------------------------ */

Hooks.on("getSceneControlButtons", (controls) => {
  if (!Array.isArray(controls)) return; // v13+ passes an array; minimum core is 14
  const notes = controls.find((c) => c.name === "notes");
  if (!notes || !Array.isArray(notes.tools)) return;
  if (notes.tools.some((t) => t.name === TOOL_NAME)) return; // don't double-register

  notes.tools.push({
    name: TOOL_NAME,
    title: "Meroki Pin",
    icon: "fa-solid fa-map-pin",
    toggle: true,
    visible: true,
    // Toggle tools report state changes through onChange. onClick is kept
    // as a fallback for the older button-style dispatch: armPlacement is
    // idempotent, so a double fire (onClick + onChange) is harmless, and
    // disarming only ever happens through onChange(false) or after a pin
    // is placed. See the header notes on what is verified vs assumed.
    onChange: (_event, active) => {
      if (active) armPlacement();
      else disarmPlacement();
    },
    onClick: () => {
      if (!placementArmed) armPlacement();
    },
  });
});

/* ------------------------------------------------------------------ */
/* Canvas context menu (v1.1)                                          */
/* ------------------------------------------------------------------ */

// The board element exists from page load, but registering is cheap to
// retry: register on ready, and again on canvasReady if the first try
// found no board yet. Guarded so the menu is built exactly once.
Hooks.once("ready", registerCanvasContextMenu);
Hooks.on("canvasReady", registerCanvasContextMenu);

/**
 * Build the canvas right-click menu once. The ContextMenu class is
 * resolved defensively (`foundry.applications.ux.ContextMenu`, falling
 * back to the legacy global) — if neither exists the menu is skipped
 * with a warning and the toolbar tool keeps working.
 */
function registerCanvasContextMenu() {
  if (canvasContextMenu) return;
  const board = document.getElementById("board");
  if (!board) return; // too early; canvasReady will retry
  const ContextMenuClass =
    globalThis.foundry?.applications?.ux?.ContextMenu ?? globalThis.ContextMenu;
  if (typeof ContextMenuClass !== "function") {
    console.warn(`${MODULE_ID} | No ContextMenu class found — right-click menu disabled, toolbar tool still works.`);
    return;
  }
  // Record the right-click position BEFORE the menu opens: the entry
  // callback only receives the target element, never the pointer event.
  // Our recorder runs first (registered before the ContextMenu's own
  // listener) and does not preventDefault / stopPropagation, so core's
  // ping still fires.
  board.addEventListener("contextmenu", recordContextMenuPosition);
  canvasContextMenu = new ContextMenuClass(
    board,
    "canvas",
    [
      {
        name: "Drop a Meroki Pin here",
        icon: '<i class="fa-solid fa-map-pin"></i>',
        condition: () => !!canvas?.scene && canCreateJournal(),
        callback: () => {
          if (!canvas?.scene) {
            ui.notifications.warn("Meroki Pins: open a scene first, then drop a pin.");
            return;
          }
          if (!canCreateJournal()) {
            ui.notifications.warn("Meroki Pins: you need permission to create journal entries to drop a pin.");
            return;
          }
          const pos = lastContextMenuPos;
          if (!pos || Date.now() - pos.at > CONTEXT_MENU_POSITION_TTL_MS) {
            ui.notifications.warn("Meroki Pins: right-click the map again, then pick the menu entry.");
            return;
          }
          void openPinDialog(pos.x, pos.y, { fromToolbar: false });
        },
      },
    ],
    { jQuery: false, fixed: true },
  );
}

/** Remember where the last right-click on the board landed, in world coords. */
function recordContextMenuPosition(event) {
  const pos = clientToWorld(event.clientX, event.clientY);
  if (pos) lastContextMenuPos = { ...pos, at: Date.now() };
}

/**
 * Convert viewport (client) coordinates to scene/world coordinates.
 * The canvas element's bounding rect gives the position within the
 * canvas; the stage's world transform maps that to world coords.
 * Returns null when the canvas is not ready.
 */
function clientToWorld(clientX, clientY) {
  try {
    const view = canvas?.app?.view;
    const stage = canvas?.app?.stage;
    if (!view || !stage || typeof stage.toLocal !== "function") return null;
    const rect = view.getBoundingClientRect();
    const point = new PIXI.Point(clientX - rect.left, clientY - rect.top);
    const world = stage.toLocal(point);
    return { x: Math.round(world.x), y: Math.round(world.y) };
  } catch (_e) {
    return null;
  }
}

/** Permission check for creating journal entries (fail-open: creation surfaces the real error). */
function canCreateJournal() {
  try {
    if (typeof game?.user?.can === "function") return game.user.can("JOURNAL_CREATE");
  } catch (_e) { /* fall through */ }
  return true;
}

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */

/**
 * Arm one-shot placement: the next left-click on the canvas opens the
 * pin dialog at the clicked canvas coordinates.
 */
function armPlacement() {
  if (placementArmed) return;
  if (!canvas?.scene) {
    ui.notifications.warn("Meroki Pins: open a scene first, then drop a pin.");
    return;
  }
  // Pre-check the journal permission so a player without it gets a clear
  // message instead of a failed create. Non-fatal: if the check itself is
  // unavailable, creation will surface the real error.
  if (!canCreateJournal()) {
    ui.notifications.warn("Meroki Pins: you need permission to create journal entries to drop a pin.");
    return;
  }

  placementArmed = true;
  ui.notifications.info("Meroki Pin armed — click the map where the pin goes.");
  canvas.app.stage.once("pointerdown", onCanvasPointerDown);
}

function disarmPlacement() {
  if (!placementArmed) return;
  placementArmed = false;
  canvas.app.stage.off("pointerdown", onCanvasPointerDown);
}

/**
 * One-shot canvas click handler. Disarms first so a double-click or a
 * second click can never open two dialogs.
 */
async function onCanvasPointerDown(event) {
  placementArmed = false;
  if (event.button !== 0) return; // left click only — right-click stays ping/pan
  const pos = event.getLocalPosition(canvas.app.stage);
  const x = Math.round(pos.x);
  const y = Math.round(pos.y);
  await openPinDialog(x, y, { fromToolbar: true });
}

/* ------------------------------------------------------------------ */
/* Dialog (DialogV2, v1.1)                                             */
/* ------------------------------------------------------------------ */

/**
 * DialogV2 with a text box. `DialogV2.wait` resolves to the clicked
 * button's `action` id, or to the value its callback returns — the drop
 * callback returns the created JournalEntry id (or `false` when the
 * text fails validation); Cancel has no callback so `wait` resolves to
 * "cancel"; dismissing (X / Esc) resolves to null (`rejectClose:
 * false`). The textarea is read back with `document.querySelector` by
 * id (not from the callback's `button` arg) so the code does not depend
 * on the dialog's element plumbing.
 *
 * V1 parity note: like the old V1 dialog, clicking Drop Pin with empty
 * text warns and closes the dialog — DialogV2 buttons submit on click
 * and a callback cannot veto closing. The user just drops a new pin.
 */
async function openPinDialog(x, y, { fromToolbar } = {}) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait !== "function") {
    ui.notifications.error("Meroki Pins: DialogV2 is not available in this Foundry version.");
    return null;
  }
  const result = await DialogV2.wait({
    window: { title: "Drop a Meroki Pin" },
    content: `
      <p>Leave a note for Meroki at <strong>(${x}, ${y})</strong> on
      <strong>${escapeHtml(canvas.scene.name ?? "this scene")}</strong>.</p>
      <textarea id="meroki-pin-request" rows="5" style="width:100%; resize:vertical;"
        placeholder="e.g. put a secret door here that leads into a room that is the love nest room"></textarea>
      <p class="hint" style="opacity:0.75; font-size:0.9em;">One request per pin.
      Meroki picks it up from the journal, builds what you asked for, and
      replies in chat when it is done.</p>`,
    buttons: [
      {
        action: "drop",
        label: "Drop Pin",
        icon: "fa-solid fa-map-pin",
        default: true,
        callback: async (_event, _button, _dialog) => {
          const text = (document.querySelector("#meroki-pin-request")?.value ?? "").trim();
          if (!text) {
            ui.notifications.warn("Meroki Pins: write the request first.");
            return false;
          }
          if (text.length > MAX_REQUEST_LENGTH) {
            ui.notifications.warn(`Meroki Pins: keep it under ${MAX_REQUEST_LENGTH} characters.`);
            return false;
          }
          return createPin(x, y, text, { fromToolbar });
        },
      },
      {
        action: "cancel",
        label: "Cancel",
        icon: "fa-solid fa-xmark",
      },
    ],
    rejectClose: false,
    render: (_event, _dialog) => document.querySelector("#meroki-pin-request")?.focus(),
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Pin creation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Creates the JournalEntry (request + flags) and the Note pin on the
 * current scene pointing at the entry's first page. Returns the created
 * entry id. When the pin came from the toolbar tool, the tool is
 * disarmed and the controls switch back to the Notes tool afterwards;
 * a context-menu pin leaves the controls alone (nothing was armed).
 */
async function createPin(x, y, request, { fromToolbar } = {}) {
  const short = request.length > 40 ? `${request.slice(0, 40).trimEnd()}…` : request;
  const pageHtml = `<p>${escapeHtml(request).replace(/\n/g, "<br>")}</p>`;
  const sceneId = canvas.scene.id;

  const entry = await JournalEntry.create({
    name: `Meroki Pin: ${short}`,
    pages: [
      {
        type: "text",
        name: "Request",
        text: { content: pageHtml, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
      },
    ],
    flags: {
      [FLAG_SCOPE]: { request, status: "open", scene: sceneId, x, y },
    },
  });

  const page = entry.pages.contents[0];
  await Note.create(
    {
      entryId: entry.id,
      pageId: page.id,
      x,
      y,
      textColor: PIN_TEXT_COLOR,
      flags: {
        [FLAG_SCOPE]: { request, status: "open", entryId: entry.id },
      },
    },
    { parent: canvas.scene }
  );

  ui.notifications.info("Meroki Pin dropped — Meroki will pick it up from the journal.");
  if (fromToolbar) await switchToolBack();
  return entry.id;
}

/**
 * Switch the active tool back after a pin is placed: activate the Notes
 * control with the Meroki Pin toggle turned off. The `toggles` record
 * flows through the tool's `onChange(event, false)` — the same path as
 * clicking the tool off — so the toggle's visual state and the armed
 * listener stay in sync. No tool name is guessed: with no `tool` given,
 * the control keeps its current / default tool. Best effort: if the
 * controls API is unavailable the toggle is left for the user to click
 * off (placement itself is already disarmed).
 */
async function switchToolBack() {
  try {
    if (typeof ui?.controls?.activate === "function") {
      await ui.controls.activate({ control: "notes", toggles: { [TOOL_NAME]: false } });
    }
  } catch (_e) {
    // Visual toggle state only; the pin is already placed.
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
