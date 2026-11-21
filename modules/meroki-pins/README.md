# Meroki Pins

Drop a pin on the map with a note for Meroki — Muse, your AI game-master
assistant. Right-click a wall and say *"put a secret door here that leads
into a room that is the love nest room"*, and Meroki builds it.

## What it does

- Adds a **Meroki Pin** toggle tool to the **Notes** toolbar (left side of
  the screen, the map-notes group).
- Right-click the canvas and pick **Drop a Meroki Pin here** from the
  context menu — the dialog opens at the right-clicked spot. Right-click
  still pings as usual; the menu is an extra entry, not a replacement.
- Click the tool, click the map, type the request. A gold map pin appears
  at that spot, backed by a journal entry named `Meroki Pin: <first words>`.
- After a pin is placed from the toolbar tool, the tool disarms and the
  controls switch back to the Notes tool automatically. A pin dropped
  from the context menu leaves the controls alone (nothing was armed).
- The journal entry's page holds the request text. Both the entry and the
  pin carry `flags.meroki.request`, so Muse can find them.
- Muse (the Meroki monitor, running outside Foundry) watches for new pins,
  acts on them — e.g. a secret door in the pinned wall plus the room behind
  it — replies in Foundry chat, and marks the pin resolved. Replies also
  land on the pin's journal page.
- v1 is **one request per pin**. A real back-and-forth thread on a pin is v2.

## Install (Dave's call — his Foundry, his world)

1. Copy this `meroki-pins` folder into Foundry's `Data/modules/` directory
   (same place any other module lives). The folder must be named
   `meroki-pins` and contain `module.json` at its top level.
2. Restart Foundry (or reload the module list).
3. In the world, open **Settings → Manage Modules**, tick **Meroki Pins**,
   save. No configuration needed.
4. Open a scene, open the **Notes** toolbar, click the **Meroki Pin**
   (map-pin icon), click the map, type the request, **Drop Pin**.

Requires Foundry VTT **14** (verified against 14.370). No other modules,
no system dependency — it works in any world. It does not need the
Foundry MCP module or anything on the server side; it only writes
JournalEntry and Note documents through Foundry's own API.

## Permissions

- Dropping a pin creates a journal entry and a map note, so the user
  needs permission to create journal entries. The GM always has it.
  Players need the **Create Journal Entries** permission in the world,
  otherwise the module warns and refuses to arm.
- Only the pin's author and the GM can see the journal entry's contents
  unless the entry's permissions are opened up — pins are private by
  default, same as any journal entry.

## What Muse does with a pin (the contract)

The monitor watches Foundry's document broadcasts for new
JournalEntry / Note documents carrying these flags:

```js
// JournalEntry.flags.meroki
{ request: string, status: "open" | "done", scene: string, x: number, y: number }

// Note.flags.meroki
{ request: string, status: "open" | "done", entryId: string }
```

Flow: pin dropped (`status: "open"`) → Muse picks it up, builds what was
asked, replies in chat → Muse sets `flags.meroki.status = "done"` on both
the entry and the pin (and may append its reply to the journal page).
A pin with `status: "done"` is finished; dropping a new pin starts a new
request. Muse never edits the request text itself.

## Known rough edges (v1.1, untested live yet)

- **Live install/test is pending** — this was built offline while Dave's
  Foundry was down. First install needs a live check: drop a test pin,
  confirm the pin + journal entry land, and confirm the monitor sees the
  broadcast. See BACKLOG.md. The live checklist for v1.1:
  - Right-click the canvas: the menu opens AND the ping still pulses.
  - The menu entry opens the dialog at the right-clicked spot (coords).
  - Drop Pin from the toolbar tool: the toggle visually switches off
    and the controls go back to the Notes tool.
  - Drop Pin from the menu: the controls do NOT switch (nothing was
    armed, nothing to disarm).
  - `DialogV2.wait` resolves as documented (drop → entry id, cancel →
    "cancel", X/Esc → null, empty text → warning + no pin).
  - The menu entry is hidden when no scene is active.
- **Right-click menu + DialogV2 verified against docs, not the bundle.**
  The 14.370 client bundle is not on disk on the build VM, so the
  `ContextMenu` constructor shape, the `DialogV2.wait` button-callback
  signature, and `ui.controls.activate` were verified against the
  official Foundry VTT v14 API docs and the
  `@league-of-foundry-developers/foundry-vtt-types` 13.346 type
  definitions (both read 2026-11-21; details in the script header).
  The offline test suite (`tests/meroki-pins-module.test.ts`, 17 checks)
  verifies the module's wiring against stubbed globals with those exact
  shapes — it cannot verify Foundry's side. If the live checks above
  fail, the failure is in the docs-vs-bundle gap, not the wiring.
- **Core note dialog may also open.** If the Notes tool itself is the
  active tool when you arm the pin, Foundry may open its own note dialog
  on the same click. Just close it — the Meroki pin is still created.
  Arming from the Select tool avoids it entirely.
- **Empty text closes the dialog.** Clicking Drop Pin with an empty
  request warns and closes the dialog (a DialogV2 button submits on
  click; a callback cannot veto closing). Same behavior as the old V1
  dialog. Just drop a new pin.
- **Dialog is DialogV2.** The pin dialog uses
  `foundry.applications.api.DialogV2.wait` since v1.1. If DialogV2 is
  missing (older Foundry than 14), the module shows an error instead of
  opening the dialog — there is no V1 fallback.

## Files

- `module.json` — manifest (id `meroki-pins`, version 0.2.0, core 14).
- `scripts/meroki-pins.js` — the whole module: toolbar tool, context-menu
  entry, one-shot click-to-place, DialogV2 dialog, JournalEntry + Note
  creation, tool switch-back after placement. API uncertainties are
  marked inline as VERIFIED vs ASSUMED.
- `README.md` — this file.
