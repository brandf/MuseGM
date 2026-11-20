/**
 * Meroki Pins — Foundry VTT module, v1 (0.1.0).
 *
 * What it does
 *   Adds a "Meroki Pin" toggle tool to the Notes toolbar. Click the tool,
 *   click the map, type the request in the dialog, and the module drops a
 *   map Note pin at those canvas coordinates. The pin is backed by a
 *   JournalEntry page carrying the request plus flags.meroki.request.
 *   Muse (the Meroki monitor) watches for new pins, acts on them — e.g.
 *   a secret door at the pinned spot plus the room behind it — replies
 *   in chat, and marks the pin resolved.
 *
 *   v1 is one request per pin. A real back-and-forth thread on a pin is v2.
 *
 * Why a toolbar tool and not a right-click menu (the original idea)
 *   Right-click on the canvas is already taken (ping / pan), and the v14
 *   ContextMenu API for a canvas context-menu entry was not verifiable
 *   offline — Dave's Foundry was off and no 14.370 client bundle was on
 *   disk to check it against. The toolbar tool is the v1 path; the
 *   context-menu entry is a v1.1 TODO (see bottom of this file).
 *
 * API notes — what is verified vs. what is assumed
 *   VERIFIED (public docs, Nov 19 2026):
 *     - Hooks.on("getSceneControlButtons", fn) is the hook modules use to
 *       add scene-control tools; in v13+ `controls` is an ARRAY of control
 *       groups, each with a `tools` array (SceneControls.controls is
 *       Array.<SceneControl> in the official API docs).
 *     - Toggle tools use an `onChange(event, active)` callback (shown in
 *       the lib-df-buttons / UI Extender tool-registration examples,
 *       which build on this same hook).
 *     - `new Dialog({title, content, buttons, default, close})` +
 *       `dialog.render(true)` is the still-documented V1 Dialog API
 *       (foundryvtt.com/api Dialog page). V1 Application classes are
 *       deprecated in v13+ but still ship in v14; DialogV2 is the modern
 *       replacement and a migration is a TODO once its exact
 *       `DialogV2.wait` button-callback signature is verified against
 *       the 14.370 bundle.
 *   ASSUMED (standard Foundry/Pixi patterns — verify on first install):
 *     - `canvas.app.stage.once("pointerdown", fn)` receives a Pixi
 *       FederatedPointerEvent; `event.getLocalPosition(canvas.app.stage)`
 *       returns canvas/world coordinates (the stage is the world root,
 *       so stage-local == scene coordinates).
 *     - `event.button === 0` means the primary (left) mouse button.
 *     - The Notes layer's click handler ignores clicks while a different
 *       tool is active, so arming this toggle tool does not ALSO open a
 *       core note dialog. (If it does, close the extra dialog — the pin
 *       still gets created. See "Known rough edges" in the README.)
 *     - `game.user.can("JOURNAL_CREATE")` is the permission check for
 *       creating journal entries; `Note.create(data, {parent: scene})`
 *       creates the embedded Note; `CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML`
 *       is 1. All are guarded or commented where a wrong guess would
 *       break the flow.
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
 */

const MODULE_ID = "meroki-pins";
const FLAG_SCOPE = "meroki";
const TOOL_NAME = "meroki-pin";
const PIN_TEXT_COLOR = "#e8c15a"; // gold — Meroki's pin color, stands out from core notes
const MAX_REQUEST_LENGTH = 2000;

/** True while the next canvas click should open the pin dialog. */
let placementArmed = false;

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
  try {
    if (typeof game?.user?.can === "function" && !game.user.can("JOURNAL_CREATE")) {
      ui.notifications.warn("Meroki Pins: you need permission to create journal entries to drop a pin.");
      return;
    }
  } catch (_e) { /* fall through */ }

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
  await openPinDialog(x, y);
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

/**
 * V1 Dialog with a text box. The textarea is read back with
 * document.querySelector by id (not from the callback's `html` arg) so
 * the code does not depend on whether the dialog hands back jQuery or a
 * plain HTMLElement.
 */
function openPinDialog(x, y) {
  return new Promise((resolve) => {
    const dialog = new Dialog({
      title: "Drop a Meroki Pin",
      content: `
        <p>Leave a note for Meroki at <strong>(${x}, ${y})</strong> on
        <strong>${escapeHtml(canvas.scene.name ?? "this scene")}</strong>.</p>
        <textarea id="meroki-pin-request" rows="5" style="width:100%; resize:vertical;"
          placeholder="e.g. put a secret door here that leads into a room that is the love nest room"></textarea>
        <p class="hint" style="opacity:0.75; font-size:0.9em;">One request per pin.
        Meroki picks it up from the journal, builds what you asked for, and
        replies in chat when it is done.</p>`,
      buttons: {
        drop: {
          icon: '<i class="fa-solid fa-map-pin"></i>',
          label: "Drop Pin",
          callback: async () => {
            const text = (document.querySelector("#meroki-pin-request")?.value ?? "").trim();
            if (!text) {
              ui.notifications.warn("Meroki Pins: write the request first.");
              return;
            }
            if (text.length > MAX_REQUEST_LENGTH) {
              ui.notifications.warn(`Meroki Pins: keep it under ${MAX_REQUEST_LENGTH} characters.`);
              return;
            }
            await createPin(x, y, text);
          },
        },
        cancel: {
          icon: '<i class="fa-solid fa-xmark"></i>',
          label: "Cancel",
        },
      },
      default: "drop",
      render: () => document.querySelector("#meroki-pin-request")?.focus(),
      close: () => resolve(),
    });
    dialog.render(true);
  });
}

/* ------------------------------------------------------------------ */
/* Pin creation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Creates the JournalEntry (request + flags) and the Note pin on the
 * current scene pointing at the entry's first page.
 */
async function createPin(x, y, request) {
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

/* ------------------------------------------------------------------ */
/* TODO (v1.1)                                                         */
/* ------------------------------------------------------------------ */
// - Right-click canvas context-menu entry ("Drop a Meroki Pin here"):
//   needs the v14 ContextMenu API verified against the 14.370 client
//   bundle (class path + constructor shape). The toolbar tool is the v1
//   path; add the menu entry once verified, keep both.
// - Migrate the dialog from V1 Dialog to foundry.applications.api.DialogV2
//   once DialogV2.wait's button-callback signature is verified the same way.
// - After a pin is placed, switch the active tool back to the Notes tool
//   (ui.controls tool-activation API — also to verify against the bundle);
//   v1 leaves the toggle armed state to the user (click another tool).
