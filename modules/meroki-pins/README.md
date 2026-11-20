# Meroki Pins

Drop a pin on the map with a note for Meroki — Muse, your AI game-master
assistant. Right-click a wall and say *"put a secret door here that leads
into a room that is the love nest room"*, and Meroki builds it.

## What it does

- Adds a **Meroki Pin** toggle tool to the **Notes** toolbar (left side of
  the screen, the map-notes group).
- Click the tool, click the map, type the request. A gold map pin appears
  at that spot, backed by a journal entry named `Meroki Pin: <first words>`.
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

## Known rough edges (v1, untested live yet)

- **Live install/test is pending** — this was built offline while Dave's
  Foundry was down. First install needs a live check: drop a test pin,
  confirm the pin + journal entry land, and confirm the monitor sees the
  broadcast. See BACKLOG.md.
- **Right-click menu is v1.1.** The original idea was a right-click
  context-menu entry on the canvas, but right-click is already ping/pan
  and the v14 `ContextMenu` API could not be verified offline. The
  toolbar tool is the v1 path; the menu entry gets added once the API is
  verified against the 14.370 client bundle.
- **Core note dialog may also open.** If the Notes tool itself is the
  active tool when you arm the pin, Foundry may open its own note dialog
  on the same click. Just close it — the Meroki pin is still created.
  Arming from the Select tool avoids it entirely.
- **Dialog is V1.** The pin dialog uses Foundry's V1 `Dialog` (deprecated
  but still shipped in v14). Migrating to `DialogV2` is a v1.1 item once
  its button-callback signature is verified against the bundle.
- **Tool stays armed visually.** After a pin is placed, switch tools
  manually — v1 does not programmatically switch the active tool back.

## Files

- `module.json` — manifest (id `meroki-pins`, version 0.1.0, core 14).
- `scripts/meroki-pins.js` — the whole module: toolbar tool, one-shot
  click-to-place, dialog, JournalEntry + Note creation. API
  uncertainties are marked inline as VERIFIED vs ASSUMED.
- `README.md` — this file.
