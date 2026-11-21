/**
 * Meroki Dressing — Foundry VTT module, v1 (0.1.0).
 *
 * What it does
 *   Click a torch, candle or brazier on the map and its light flips:
 *   lit -> hidden + alpha 0 with "The torch gutters out."; unlit ->
 *   shown + the item's own alpha with "The torch sputters to life."
 *   The click is the interaction — no arming step, no macro, no chat
 *   command. The toggle is executed by the GM's client (see "Why a
 *   socket" below) and the flavor line is posted in chat as Meroki.
 *
 * The flag contract (what the composer hook writes — keep in sync with
 * src/session/dressing.ts and docs/interactive-dressing.md):
 *   Tile.flags.meroki = { dressingId, lightId, kind, alpha }
 *     dressingId: the dressing item id, e.g. "torch-n-4"
 *     lightId:    the paired AmbientLight _id (written by the hook's
 *                 pairing step, after the light is created)
 *     kind:       "torch" | "candle" | "brazier"
 *     alpha:      the light's lit alpha (torch/candle 0.4, brazier 0.5)
 *   A tile with a dressingId but no lightId was built before the
 *   pairing step ran (or the pairing failed) — the module warns and
 *   does nothing instead of toggling the wrong light.
 *
 * Why a socket
 *   Players cannot update AmbientLight documents directly — Foundry
 *   only lets the GM change scene embeds. So the click never updates
 *   the light itself: the clicking client sends a toggle request over
 *   a socket message, and the designated GM's client (the active GM
 *   with the lowest user id, so exactly one GM executes) flips the
 *   light and posts the chat line. If no GM is connected, the click
 *   warns instead of silently doing nothing. If the clicker IS the
 *   designated GM, the toggle runs directly with no round-trip.
 *
 * Why the click does not fight tokens
 *   The handler only fires on a plain left-click (no modifier keys)
 *   that lands on a visible dressing tile — and only when no visible
 *   token is under the same point. A token standing on a candle cell
 *   wins: the click selects/moves the token and the candle stays lit.
 *   The handler never calls preventDefault or stopPropagation, so
 *   core's own click handling proceeds normally for every click that
 *   is not a dressing toggle.
 *
 * API notes — what is verified vs. what is assumed
 *   VERIFIED (same sources as Meroki Pins — official Foundry VTT v14
 *   API docs, foundryvtt.com/api, and the
 *   @league-of-foundry-developers/foundry-vtt-types 13.346 type
 *   definitions, both read 2026-11-21; the 14.370 client bundle
 *   itself is NOT on disk, see the live-check list at the bottom):
 *     - `canvas.app.stage.once("pointerdown", fn)` / `.on(...)`
 *       receives a Pixi FederatedPointerEvent;
 *       `event.getLocalPosition(canvas.app.stage)` returns
 *       canvas/world coordinates (the stage is the world root).
 *     - `event.button === 0` means the primary (left) mouse button.
 *     - `game.socket.emit("module.<id>", data)` /
 *       `game.socket.on("module.<id>", handler)` is the custom
 *       socket channel pattern for modules.
 *     - `ChatMessage.create({ content, speaker: { alias } })`
 *       posts a chat message.
 *   ASSUMED (standard Foundry/Pixi patterns — verify on first install):
 *     - `canvas.tiles.placeables` holds the scene's Tile placeables
 *       with `.document` (flags, elevation, sort) and bounds
 *       (`.x`, `.y`, `.width`, `.height` in world coordinates), and
 *       `.visible` is false for a hidden tile the user cannot see.
 *     - `canvas.tokens.placeables` holds Token placeables with the
 *       same bounds shape and `.visible`.
 *     - `canvas.scene.lights.get(id)` returns the AmbientLight
 *       document (an EmbeddedCollection), whose `.hidden` is the
 *       on/off state and whose `.update({ hidden, "config.alpha" })`
 *       applies a partial update with dot-notation keys — the same
 *       update shape the monitor sends over the MCP client.
 *     - `game.users` lists connected users with `.isGM`, `.active`
 *       and `.id`; the lowest-id active GM is a stable pick for the
 *       single executor.
 *     - A `pointerdown` listener on the stage fires for canvas
 *       clicks without interfering with core's own handlers, as long
 *       as it neither prevents the event nor stops its propagation
 *       (the Pins module relies on the same property for its armed
 *       placement listener).
 *
 * The chat lines mirror DRESSING_CHAT_LINES in
 * src/session/dressing.ts — the plan is the source of truth, this
 * table is its copy at the table. If the lines change there, change
 * them here too.
 *
 * Live checks (need Dave's Foundry up — the 14.370 bundle is not on
 * disk, so these were verified against the v14 docs/types only):
 *   - Click a torch as the GM: the light goes out, the chat line
 *     posts, a second click relights it with the same alpha.
 *   - Click a torch as a player (GM connected): the same, with the
 *     GM's client doing the flip — the player's client sends only
 *     the socket message.
 *   - Click a torch with no GM connected: a warning, no silent no-op.
 *   - Click a token standing on a candle cell: the token is selected,
 *     the candle does not toggle.
 *   - Click a dressing tile with no lightId in its flags: a warning
 *     naming the dressingId, no toggle.
 *   - Two GMs connected: exactly one chat line per click (only the
 *     designated GM executes).
 *   - Click a bones tile: nothing happens (no dressing flag).
 *   - Cutscene cross-check: a light step dims the torches for the
 *     ambush, then a click relights one — the same light, driven by
 *     two systems, no fight over state.
 */

const MODULE_ID = "meroki-dressing";
const SOCKET_CHANNEL = "module.meroki-dressing";
const FLAG_SCOPE = "meroki";

/**
 * The toggle lines, by kind and new state — a mirror of
 * DRESSING_CHAT_LINES in src/session/dressing.ts. Keep in sync.
 */
const CHAT_LINES = {
  torch: {
    lit: "The torch sputters to life.",
    unlit: "The torch gutters out.",
  },
  candle: {
    lit: "The candle's flame steadies and grows.",
    unlit: "The candle gutters out.",
  },
  brazier: {
    lit: "The brazier roars to life, firelight washing the room.",
    unlit: "The brazier's fire dies down to embers.",
  },
};

/** True once the stage listener is registered (canvasReady re-fires). */
let listenerRegistered = false;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Meroki Dressing loaded — click a torch to light it or put it out.`);
});

// The canvas is rebuilt per scene, so register on canvasReady (and
// once on ready as a backstop). Guarded so the listener is attached
// exactly once per page load.
Hooks.once("ready", registerClickListener);
Hooks.on("canvasReady", registerClickListener);
Hooks.once("ready", registerSocketListener);

function registerClickListener() {
  if (listenerRegistered) return;
  const stage = canvas?.app?.stage;
  if (!stage || typeof stage.on !== "function") return; // too early; canvasReady will retry
  stage.on("pointerdown", onCanvasPointerDown);
  listenerRegistered = true;
}

function registerSocketListener() {
  if (typeof game?.socket?.on !== "function") return;
  game.socket.on(SOCKET_CHANNEL, (payload) => {
    if (!payload || payload.type !== "toggle") return;
    if (!isDesignatedGm()) return; // exactly one GM executes
    void executeToggle(payload);
  });
}

/**
 * The active GM with the lowest user id — the single executor for
 * socket toggle requests. Stable across clients, so a request is
 * never executed twice and never dropped when several GMs are on.
 */
function designatedGm() {
  try {
    const gms = (game?.users ?? []).filter((u) => u.isGM && u.active);
    if (gms.length === 0) return null;
    return gms.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  } catch (_e) {
    return null;
  }
}

function isDesignatedGm() {
  const gm = designatedGm();
  return !!gm && game?.user?.id === gm.id;
}

/**
 * Passive click handler. Fires only for a plain left-click on a
 * visible dressing tile with no visible token under the same point.
 * Never prevents or stops the event — core's click handling proceeds
 * normally for every other click.
 */
function onCanvasPointerDown(event) {
  if (event.button !== 0) return; // left click only
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  const stage = canvas?.app?.stage;
  if (!stage || typeof event.getLocalPosition !== "function") return;
  let pos;
  try {
    pos = event.getLocalPosition(stage);
  } catch (_e) {
    return;
  }
  const x = pos.x;
  const y = pos.y;
  const tile = topmostDressingTileAt(x, y);
  if (!tile) return;
  if (tokenAt(x, y)) return; // a token under the click wins
  const flags = tile.document?.flags?.[FLAG_SCOPE] ?? {};
  const dressingId = flags.dressingId;
  const lightId = flags.lightId;
  const kind = flags.kind;
  const alpha = flags.alpha;
  if (typeof dressingId !== "string" || !dressingId) return; // not a dressing tile after all
  if (typeof lightId !== "string" || !lightId) {
    ui.notifications.warn(
      `Meroki Dressing: "${dressingId}" has no paired light — rebuild the room so the hook can pair it.`,
    );
    return;
  }
  if (!CHAT_LINES[kind] || typeof alpha !== "number") {
    ui.notifications.warn(
      `Meroki Dressing: "${dressingId}" has an incomplete flag (kind ${String(kind)}, alpha ${String(alpha)}) — rebuild the room.`,
    );
    return;
  }
  const payload = { type: "toggle", dressingId, lightId, kind, alpha };
  if (isDesignatedGm()) {
    // The clicker is the executor — no socket round-trip needed.
    void executeToggle(payload);
    return;
  }
  if (!designatedGm()) {
    ui.notifications.warn("Meroki Dressing: no GM is connected, so the torch cannot be toggled right now.");
    return;
  }
  if (typeof game?.socket?.emit === "function") {
    game.socket.emit(SOCKET_CHANNEL, payload);
  } else {
    ui.notifications.warn("Meroki Dressing: the socket is unavailable, so the torch cannot be toggled right now.");
  }
}

/** The topmost visible dressing tile containing (x, y), or null. */
function topmostDressingTileAt(x, y) {
  const tiles = canvas?.tiles?.placeables ?? [];
  let best = null;
  let bestKey = null;
  for (const t of tiles) {
    if (!t.visible) continue;
    const flags = t.document?.flags?.[FLAG_SCOPE];
    if (!flags || typeof flags.dressingId !== "string" || !flags.dressingId) continue;
    if (!containsPoint(t, x, y)) continue;
    // Topmost wins: highest elevation, then highest sort, then latest
    // in the placeables list (later documents draw above earlier ones).
    const key = [t.document?.elevation ?? 0, t.document?.sort ?? 0];
    if (
      !best ||
      key[0] > bestKey[0] ||
      (key[0] === bestKey[0] && key[1] >= bestKey[1])
    ) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

/** True when a visible token's bounds contain (x, y). */
function tokenAt(x, y) {
  const tokens = canvas?.tokens?.placeables ?? [];
  for (const t of tokens) {
    if (!t.visible) continue;
    if (containsPoint(t, x, y)) return true;
  }
  return false;
}

/** Bounds check in world coordinates (tiles and tokens are rects). */
function containsPoint(placeable, x, y) {
  const px = placeable.x ?? 0;
  const py = placeable.y ?? 0;
  const w = placeable.width ?? 0;
  const h = placeable.height ?? 0;
  return x >= px && x < px + w && y >= py && y < py + h;
}

/**
 * Flip one dressing light and post its chat line. Runs only on the
 * designated GM's client. The current state comes from the light
 * document itself (hidden = unlit), so a click after a cutscene dim
 * or a monitor toggle reads the real state instead of a stale flag.
 */
async function executeToggle({ dressingId, lightId, kind, alpha }) {
  const scene = canvas?.scene;
  if (!scene) return;
  const light = scene.lights?.get?.(lightId);
  if (!light) {
    console.warn(`${MODULE_ID} | No light ${lightId} for "${dressingId}" on this scene.`);
    ui.notifications.warn(`Meroki Dressing: the light for "${dressingId}" is gone — rebuild the room.`);
    return;
  }
  const lines = CHAT_LINES[kind];
  if (!lines) {
    console.warn(`${MODULE_ID} | Unknown dressing kind "${kind}" for "${dressingId}".`);
    return;
  }
  const newState = light.hidden ? "lit" : "unlit";
  try {
    await light.update(
      newState === "lit"
        ? { hidden: false, "config.alpha": alpha }
        : { hidden: true, "config.alpha": 0 },
    );
  } catch (e) {
    console.warn(`${MODULE_ID} | Toggling "${dressingId}" failed:`, e);
    ui.notifications.error(`Meroki Dressing: could not toggle "${dressingId}".`);
    return;
  }
  try {
    await ChatMessage.create({
      content: lines[newState],
      speaker: { alias: "Meroki" },
    });
  } catch (e) {
    // The light already flipped; a failed chat line is a warning,
    // not a reason to flip it back.
    console.warn(`${MODULE_ID} | Chat line for "${dressingId}" failed to post:`, e);
  }
}
