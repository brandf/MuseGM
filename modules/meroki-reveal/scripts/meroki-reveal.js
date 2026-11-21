/**
 * Meroki Reveal — Foundry VTT module, v1 (0.1.0).
 *
 * What it does
 *   Listens on the module socket for reveal messages from Muse (the
 *   Meroki monitor, running outside Foundry as the mcp-api user) and
 *   pops the revealed image up full-screen on every connected
 *   client's screen — the Act Four moment: the image fills the
 *   players' screens before any stat block does.
 *
 *   - show:    { action: "show", image, caption?, id } — full-screen
 *              overlay with the image and the caption under it.
 *   - dismiss: { action: "dismiss", id? } — close the popout on
 *              every client. `id` names one popout; omitted closes
 *              whatever is open.
 *
 *   The GM side (Muse) decides when a popout appears and when it goes
 *   away. A player closing it locally (X button, click outside the
 *   image, or Esc) closes only their own screen — a player can always
 *   get rid of a popout, and the GM can always clear everyone else's
 *   with a dismiss.
 *
 *   Second reveal while one is open: REPLACE. A reveal is "this
 *   moment" — the newest moment supersedes. The overlay swaps the
 *   image + caption in place; there is never a queue of stale moments.
 *
 *   No module, no popout — and that is fine: the reveal step ALWAYS
 *   posts the same image inline in chat first, so a player without
 *   this module sees the chat image, never nothing. A broken image
 *   URL shows the caption plus a "see the chat log" line, and dismiss
 *   is always available — the overlay can never trap a player on a
 *   dead image.
 *
 * API notes — what is verified vs. what is assumed
 *   VERIFIED (public docs, Nov 20 2026):
 *     - game.socket.emit("module.<module-id>", data) /
 *       game.socket.on("module.<module-id>", fn) is the documented
 *       module-socket pattern: the server relays the message to
 *       every connected client. No new server component is needed.
 *     - Hooks.once("ready", fn) fires after the socket is connected,
 *       so the listener is registered there, not on init.
 *   ASSUMED (standard Foundry/DOM patterns — verify on first install):
 *     - z-index 9999 sits above Foundry app windows and dialogs. If
 *       a dialog covers the popout live, raise it.
 *     - An image URL that renders in the chat <img> also loads in
 *       this overlay's <img> (same origin, same path). The chat
 *       image is the falsifiable check for this.
 *     - document keydown catches Esc while the overlay is open.
 *
 * The popout contract (keep in sync with src/session/popout.ts and
 * the module README — the TS side builds these messages, this file
 * renders them):
 *   show:    { action: "show", image: string, caption?: string, id: string }
 *   dismiss: { action: "dismiss", id?: string }
 * Malformed messages are warned about and ignored — never thrown
 * into Foundry's socket dispatch, where an exception could break
 * other socket traffic.
 */

const MODULE_ID = "meroki-reveal";
const SOCKET_EVENT = `module.${MODULE_ID}`;

/** The open overlay element, or null. At most one popout is ever open. */
let overlay = null;
/** Id of the popout currently shown, or null. */
let currentId = null;
/** Esc-key handler while an overlay is open, so it can be removed. */
let escHandler = null;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Meroki Reveal loaded — full-screen reveal popouts.`);
});

Hooks.once("ready", () => {
  if (typeof game === "undefined" || !game.socket) {
    console.warn(`${MODULE_ID} | No game.socket — popouts will not arrive.`);
    return;
  }
  game.socket.on(SOCKET_EVENT, onPopoutMessage);
});

/* ------------------------------------------------------------------ */
/* Socket messages                                                     */
/* ------------------------------------------------------------------ */

/**
 * One entry point for every popout message. Validates the shape
 * (same rules as validatePopoutMessage in src/session/popout.ts),
 * warns and ignores malformed messages, never throws.
 */
function onPopoutMessage(msg) {
  try {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      console.warn(`${MODULE_ID} | Ignoring malformed popout message (not an object).`);
      return;
    }
    if (msg.action === "show") {
      if (typeof msg.image !== "string" || msg.image.length === 0) {
        console.warn(`${MODULE_ID} | Ignoring show with no image.`);
        return;
      }
      if (msg.caption !== undefined && typeof msg.caption !== "string") {
        console.warn(`${MODULE_ID} | Ignoring show with a non-string caption.`);
        return;
      }
      if (typeof msg.id !== "string" || msg.id.length === 0) {
        console.warn(`${MODULE_ID} | Ignoring show with no id.`);
        return;
      }
      showPopout(msg.image, msg.caption, msg.id);
    } else if (msg.action === "dismiss") {
      if (msg.id !== undefined && (typeof msg.id !== "string" || msg.id.length === 0)) {
        console.warn(`${MODULE_ID} | Ignoring dismiss with a bad id.`);
        return;
      }
      dismissPopout(msg.id);
    } else {
      console.warn(`${MODULE_ID} | Ignoring popout message with unknown action: ${JSON.stringify(msg.action)}.`);
    }
  } catch (e) {
    // Never let a bad popout message break other socket traffic.
    console.warn(`${MODULE_ID} | Popout message failed: ${e?.message ?? e}`);
  }
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

/**
 * Show the popout — or replace the open one (second reveal while one
 * is open swaps the image + caption in place; there is no queue).
 */
function showPopout(image, caption, id) {
  if (overlay) {
    // Replace: same overlay, new moment.
    currentId = id;
    replaceContent(image, caption);
    return;
  }
  currentId = id;
  overlay = document.createElement("div");
  overlay.id = "meroki-reveal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Meroki reveal");
  overlay.style.cssText = [
    "position: fixed", "inset: 0", "z-index: 9999",
    "display: flex", "align-items: center", "justify-content: center",
    "background: rgba(0, 0, 0, 0.85)", "cursor: pointer",
  ].join("; ");
  // Backdrop click dismisses locally. Clicks on the figure itself do
  // not (a misclick on the image mid-gasp should not kill the moment).
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeOverlay();
  });

  const figure = document.createElement("figure");
  figure.style.cssText = [
    "margin: 0", "max-width: min(92vw, 1200px)", "max-height: 90vh",
    "display: flex", "flex-direction: column", "align-items: center",
    "cursor: default",
  ].join("; ");
  figure.addEventListener("click", (event) => event.stopPropagation());
  figure.appendChild(buildImage(image, caption));
  if (caption) {
    const cap = document.createElement("figcaption");
    cap.textContent = caption;
    cap.style.cssText = [
      "margin-top: 12px", "color: #e8e6df", "font-size: 1.15em",
      "text-align: center", "max-width: 80vw",
    ].join("; ");
    figure.appendChild(cap);
  }
  const hint = document.createElement("div");
  hint.textContent = "Click outside the image or press Esc to close";
  hint.style.cssText = "margin-top: 10px; color: rgba(232, 230, 223, 0.6); font-size: 0.85em;";
  figure.appendChild(hint);
  overlay.appendChild(figure);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close reveal";
  closeBtn.setAttribute("aria-label", "Close reveal");
  closeBtn.style.cssText = [
    "position: absolute", "top: 16px", "right: 20px",
    "width: 40px", "height: 40px", "border-radius: 50%",
    "border: 1px solid rgba(255, 255, 255, 0.35)",
    "background: rgba(0, 0, 0, 0.6)", "color: #fff",
    "font-size: 18px", "cursor: pointer",
  ].join("; ");
  closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    closeOverlay();
  });
  overlay.appendChild(closeBtn);

  document.body.appendChild(overlay);
  escHandler = (event) => {
    if (event.key === "Escape") closeOverlay();
  };
  document.addEventListener("keydown", escHandler);
}

/** Swap the open overlay's image + caption for a new moment. */
function replaceContent(image, caption) {
  if (!overlay) return;
  const figure = overlay.querySelector("figure");
  if (!figure) return;
  const oldImg = figure.querySelector("img, .meroki-reveal-fallback");
  if (oldImg) oldImg.replaceWith(buildImage(image, caption));
  const cap = figure.querySelector("figcaption");
  if (caption) {
    if (cap) cap.textContent = caption;
    else {
      const el = document.createElement("figcaption");
      el.textContent = caption;
      el.style.cssText = [
        "margin-top: 12px", "color: #e8e6df", "font-size: 1.15em",
        "text-align: center", "max-width: 80vw",
      ].join("; ");
      figure.insertBefore(el, figure.lastChild);
    }
  } else if (cap) {
    cap.remove();
  }
}

/**
 * The <img> for a popout. On load failure it swaps itself for a
 * fallback block (caption + "see the chat log") so a dead URL can
 * never trap a player behind an empty overlay.
 */
function buildImage(image, caption) {
  const img = document.createElement("img");
  img.src = image;
  img.alt = caption ?? "Meroki reveal";
  img.style.cssText = [
    "max-width: 92vw", "max-height: 80vh", "object-fit: contain",
    "border-radius: 8px", "border: 1px solid rgba(255, 255, 255, 0.15)",
    "box-shadow: 0 8px 48px rgba(0, 0, 0, 0.8)",
  ].join("; ");
  img.addEventListener("error", () => {
    const fallback = document.createElement("div");
    fallback.className = "meroki-reveal-fallback";
    fallback.style.cssText = [
      "max-width: 80vw", "padding: 24px 32px", "text-align: center",
      "color: #e8e6df", "border: 1px solid rgba(255, 255, 255, 0.2)",
      "border-radius: 8px", "background: rgba(20, 20, 24, 0.9)",
    ].join("; ");
    fallback.textContent = caption
      ? `${caption} — the image failed to load; see the chat log for the inline version.`
      : "The reveal image failed to load — see the chat log for the inline version.";
    img.replaceWith(fallback);
  });
  return img;
}

/**
 * GM dismiss: close the open popout on this client. An id names one
 * popout — a dismiss for a different id is ignored. No id closes
 * whatever is open.
 */
function dismissPopout(id) {
  if (!overlay) return;
  if (id !== undefined && id !== currentId) return;
  closeOverlay();
}

/** Local close: remove the overlay and the Esc listener. */
function closeOverlay() {
  if (overlay) overlay.remove();
  overlay = null;
  currentId = null;
  if (escHandler) {
    document.removeEventListener("keydown", escHandler);
    escHandler = null;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// (No helpers needed: captions are set with textContent, never
// innerHTML, so there is nothing to escape.)
