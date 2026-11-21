# Meroki Dressing

Click a torch, candle or brazier on the map and its light flips —
lit to out, out to lit — with a one-line flavor note in chat. No
arming step, no macro, no chat command: the click is the interaction.

## Install

Copy this folder to Foundry's `Data/modules/meroki-dressing` and
enable **Meroki Dressing** in the world's module settings, the same
way as Meroki Pins. It works alongside Pins — the two modules touch
different documents.

## How it works

A room built by the composer hook carries, on every dressing tile:

```
Tile.flags.meroki = { dressingId, lightId, kind, alpha }
```

- `dressingId` — the dressing item id, e.g. `torch-n-4`
- `lightId` — the paired AmbientLight `_id` (written by the hook's
  pairing step, after the light is created)
- `kind` — `torch` | `candle` | `brazier`
- `alpha` — the light's lit alpha (torch/candle 0.4, brazier 0.5)

The module listens for plain left-clicks on the canvas. A click that
lands on a visible dressing tile — with no visible token under the
same point, so a token standing on a candle cell wins — sends a toggle
request. The light flips (`hidden` + `config.alpha`, the same update
`toggleDressing` in `src/session/dressing.ts` returns) and the flavor
line posts in chat as Meroki.

### Why the GM executes the toggle

Players cannot update AmbientLight documents directly — Foundry only
lets the GM change scene embeds. So the clicking client never updates
the light itself: it sends a toggle request over a socket message
(`module.meroki-dressing`), and the designated GM's client — the
active GM with the lowest user id, so exactly one GM executes —
flips the light and posts the chat line. If no GM is connected, the
click warns instead of silently doing nothing. If the clicker is the
designated GM, the toggle runs directly with no round-trip.

The current state comes from the light document itself (`hidden` =
unlit), so a click after a cutscene dim or a monitor toggle reads the
real state instead of a stale flag. The chat lines mirror
`DRESSING_CHAT_LINES` in `src/session/dressing.ts` — the plan is the
source of truth; if the lines change there, change them here too.

## What is verified vs. what needs a live session

**Verified (offline):** the toggle math (off = hidden + alpha 0, on =
shown + the item's own alpha) and the placement rules are unit-tested
in `tests/dressing.test.ts`; the hook and pairing are unit-tested in
`tests/dressing-hook.test.ts`; the flag contract is what
`layoutRoomWithDressing` + `resolveDressingPairing` produce.

**Needs a live session (Dave's Foundry on):** everything in the
"Live checks" list at the bottom of `scripts/meroki-dressing.js` —
the click actually reaching the module, the socket round-trip from a
player's client, the single-executor rule with two GMs, the token
guard, the missing-lightId warning, and the cutscene cross-check
(a light step dims the torches, then a click relights one).

## Known rough edges

- A tile with a `dressingId` but no `lightId` was built before the
  pairing step ran (or the pairing failed). The module warns and does
  nothing — rebuild the room so the hook can pair it.
- A left-drag pan that starts on a torch tile toggles it: the handler
  fires on plain left-clicks and cannot tell a click from the start
  of a drag. In practice players click tokens, not drag from torch
  tiles; if this bites, the fix is to fire on `pointerup` after a
  short press with no movement.
