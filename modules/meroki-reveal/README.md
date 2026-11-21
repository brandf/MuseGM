# Meroki Reveal

Full-screen image popouts for Meroki reveals. When Muse (the Meroki
monitor) plays a reveal step — the Act Four moment, an image generated
on the spot from this room and this corpse and this moment — this module
pops the image up on every player's screen, before any stat block.

## What it does

- Listens on the module socket (`module.meroki-reveal`) for messages
  from Muse and shows a full-screen overlay: the image, the caption
  under it, a close button.
- **Second reveal while one is open: REPLACE.** The overlay swaps the
  image + caption in place. A reveal is "this moment" — the newest
  moment supersedes; there is no queue of stale moments.
- **GM-controlled:** Muse decides when a popout appears (a reveal step
  with `mode: "popout"`) and when it goes away (a `dismissReveal`
  step, or a dismiss message). A player closing it locally — X button,
  click outside the image, or Esc — closes only their own screen. A
  player can always get rid of a popout, and the GM can always clear
  everyone else's.
- **Degraded path is the chat image.** The reveal step ALWAYS posts the
  same image inline in chat first. A player without this module sees
  the chat image, never nothing. A broken image URL in the overlay
  shows the caption plus a "see the chat log" line, and dismiss is
  always available — the overlay can never trap a player on a dead
  image.

## Install (Dave's call — his Foundry, his world)

1. Copy this `meroki-reveal` folder into Foundry's `Data/modules/`
   directory (same place any other module lives). The folder must be
   named `meroki-reveal` and contain `module.json` at its top level.
2. Restart Foundry (or reload the module list).
3. In the world, open **Settings → Manage Modules**, tick **Meroki
   Reveal**, save. No configuration needed. Every player needs the
   module enabled to see popouts — anyone without it still gets the
   inline chat image.

Requires Foundry VTT **14** (verified against 14.370). No other modules,
no system dependency — it works in any world. It does not need the
Foundry MCP module or anything on the server side; it only listens on
the module socket.

## What Muse sends (the contract)

The GM side (Muse, over the MCP-client socket) emits on
`module.meroki-reveal`:

```js
// Show — pops the image full-screen on every connected client.
{ action: "show", image: "worlds/testbed/reveal-xyz.png", caption: "The ogre's corpse splits open.", id: "popout-..." }

// Dismiss — closes the popout on every client. `id` names one popout;
// omitted = close whatever is open.
{ action: "dismiss" }
{ action: "dismiss", id: "popout-..." }
```

The TS side builds these messages (`src/session/popout.ts`:
`buildPopoutShow` / `buildPopoutDismiss` / `validatePopoutMessage`)
and emits them (`emitPopout`); the sequence player's reveal step
(`mode: "popout"`) and `dismissReveal` step send them. The client
module validates the shape of every incoming message and ignores
malformed ones with a console warning — never throwing into Foundry's
socket dispatch.

## Known rough edges (v1, untested live yet)

- **Live install/test is pending** — this was built offline while Dave's
  Foundry was down. First install needs a live check: run a cutscene
  with a popout reveal, confirm every client sees it, confirm Esc /
  backdrop / X dismisses locally, confirm a `dismissReveal` step
  clears everyone. See the live checklist below.
- **No sender authentication.** Foundry's module-socket pattern does
  not attach a sender id, so the module validates shape only. In
  practice only Muse's tooling emits these, and the GM can dismiss
  anything that appears. A forged popout carries only an image URL
  and a caption.
- **Overlay z-index is 9999.** Assumed to sit above Foundry app
  windows and dialogs — if a dialog covers the popout live, raise it.
- **The overlay is DOM, not canvas.** It covers the whole browser
  window, including the chat sidebar — that is the point (the image
  fills the players' screens), but it also means a player cannot read
  chat while a popout is open. They can always dismiss it.

## Live checklist (needs Dave's Foundry up — session-only)

1. Install the module, enable it in the world, all players reload.
2. Muse runs a cutscene with a reveal step (`mode: "popout"`, image
   already uploaded): every client with the module sees the image
   full-screen with its caption; a client without the module sees
   only the inline chat image.
3. Player presses Esc / clicks outside the image / clicks X: closes
   locally, other players still see it.
4. Muse runs a `dismissReveal` step: closes on every client that
   still has it open.
5. Muse runs a second popout reveal while one is open: the overlay
   swaps to the new image + caption (replace, no queue, no second
   overlay).
6. Reveal with a bad image path: overlay shows the caption + "see
   the chat log" line, still dismissible.

## Files

- `module.json` — manifest (id `meroki-reveal`, version 0.1.0, core 14).
- `scripts/meroki-reveal.js` — the whole module: socket listener,
  overlay, replace/dismiss, image-error fallback. API uncertainties
  are marked inline as VERIFIED vs ASSUMED.
- `README.md` — this file.
