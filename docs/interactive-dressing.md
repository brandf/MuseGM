# Interactive dressing — how the click wiring works at the table

FR-16: a room built by the composer has its torches and candles placed,
lit, and clickable without any hand work. Clicking toggles the light
and posts a one-line flavor note in chat. The generator
(`src/session/dressing.ts`), the composer hook
(`applyDressingToSpec` / `layoutRoomWithDressing` /
`resolveDressingPairing`) and the click module
(`modules/meroki-dressing/`) are built and unit-tested; this note
covers the wiring as built, and the one small live half left — the
`buildTileRoom` calls that create the tiles/lights and write the
pairing back — plus what still needs a live session.

## What the generator produces

`planDressing(roomSpec, opts)` returns a `DressingPlan`: one item per
torch/candle/brazier (kind, cell, pack tile, placement, paired light,
chat lines per state) plus a `lights` array of the AmbientLight docs to
create, keyed to their items. `toggleDressing(item, state)` is the
toggle: off = `hidden: true` + `config.alpha: 0`; on = `hidden: false`
+ the item's own alpha — a relight restores exactly the same light.
`dressingToRoomSpec(plan)` maps a plan onto the composer hook's inputs
(torches, lights, dressing placements; items without a tile are listed
in `skipped`, never faked). `applyDressingToSpec(spec, plan)` merges a
plan into a room spec; `layoutRoomWithDressing(spec, pack, serverBase,
opts)` plans, merges and lays out in one call; `resolveDressingPairing`
pairs the created Tile and AmbientLight `_id`s back to their items
after the live build.

## The click-wiring decision (decided — Route A, Nov 20)

**Route A** (small module, following the Meroki Pins pattern) — the
module is `modules/meroki-dressing/` (v0.1.0, Foundry 14). The click
itself is the trigger: a passive handler on the canvas fires on a
plain left-click that lands on a visible dressing tile with no visible
token under the same point (a token standing on a candle cell wins —
the click selects the token and the candle stays lit). No arming step:
the design note's open question is answered passive, because the flag
— not the tool — is the guard; arming would add a step to every
torch the players touch.

Why A over the others: B (generated macro) makes the GM the middleman
for every torch and clutters the macro directory — it breaks the
"players go around clicking torches" feeling. C (chat command) is
typing, not clicking, and "the torch" is ambiguous in a room with
seven of them. Only A lets a player walk up to a torch and click it.

Two things the design note did not foresee, both answered in the
module:

- **Players cannot update lights.** Foundry only lets the GM change
  scene embeds, so a player's click can never flip the light
  directly. The module sends the toggle over a socket message
  (`module.meroki-dressing`) and the designated GM's client — the
  active GM with the lowest user id, so exactly one GM executes —
  flips the light and posts the chat line. No GM connected means a
  warning, not a silent no-op.
- **The current state comes from the light document** (`hidden` =
  unlit), not from a flag — so a click after a cutscene dim or a
  monitor toggle reads the real state instead of a stale one.

The tile flag is the whole record the module needs:
`flags.meroki = { dressingId, lightId, kind, alpha }`. Layout time
stamps `{ dressingId }`; the pairing step completes it with the
light `_id`, kind and alpha. A tile with a dressingId but no lightId
was built before pairing ran — the module warns and does nothing
instead of toggling the wrong light.

## What is verified vs what needs a live session

**Verified (offline, Nov 20):**

- The light documents: AmbientLight shape `{x, y, config: {dim,
  bright, angle, color, alpha}, hidden}` and dot-notation updates
  (`config.dim`, `config.alpha`) — the same shape the Lich's Lair
  lighting fix used live on Nov 19, and the same update path
  `animateLight` uses.
- The toggle math: off = hidden + alpha 0, on = shown + the item's
  own alpha (28 unit checks in `tests/dressing.test.ts`).
- The placement rules: torch spacing, door-cell exclusion, no
  overlaps, braziers only in large rooms, candle table/floor fallback.
- The pack tiles: `sconce`, `candle` and `brazier` all exist now
  (100px, dressing layer, standalone prop sprites — never baked into
  a floor tile). The pack is 48 tiles, 0 gaps; the old 46 PNGs are
  byte-identical after the regeneration.
- The alpha gap is closed: `LightSpec` carries an `alpha` field and
  `lightCreateData` honours it (default 0.5 — the old hardcode's
  value), so dressing lights are created with their own alpha
  (torch/candle 0.4, brazier 0.5) instead of a post-create update.
  The post-create route was rejected: one create with the right
  alpha is a single round-trip and the light is never briefly wrong.
- The composer hook: `layoutRoomWithDressing` plans, merges and lays
  out in one call; `resolveDressingPairing` pairs the created _ids
  back to their items and lists every unpaired item instead of
  guessing (`tests/dressing-hook.test.ts`).
- The module code reads correctly against the v14 API docs/types
  (see the VERIFIED vs ASSUMED list in
  `modules/meroki-dressing/scripts/meroki-dressing.js`) — but no
  module code runs offline, so the handler itself is live-only.

**Needs a live session (Dave's Foundry on):**

- The click handler actually firing in Foundry (Route A): does a
  click on a dressing tile reach the module, does the flag lookup
  work, does the light flip visibly, does the chat line post? The
  full live-check list is at the bottom of
  `modules/meroki-dressing/scripts/meroki-dressing.js` — including
  the player-click socket round-trip, the two-GM single-executor
  rule, and the token guard.
- The live half of the hook (see below): `buildTileRoom` runs the
  dressing pass, the tiles + lights land, and the pairing writes the
  completed flags back onto the tiles.
- The cutscene cross-check: a `light` step with a named light (the
  torch's `lightId`) dims the room for the ambush, then the mage's
  bloom brings it back — the same light, driven by two systems.

## The composer hook (built — Nov 20)

The pure half lives in `src/session/dressing.ts`:

1. `layoutRoomWithDressing(spec, pack, serverBase, opts)` — one call
   is the whole hook: `planDressing(spec, opts.plan)` plans the room,
   `applyDressingToSpec` merges the plan into a new spec, `layoutRoom`
   lays it out. It returns `{ plan, spec, layout }`.
2. `applyDressingToSpec(spec, plan)` merges lights (one per item,
   named by kind, with its own alpha and `dressingId`) into
   `spec.lights` and dressing placements (with the item id as both
   prop `id` and `dressingId`) into `spec.dressing`. It does NOT
   merge the torch cells into `spec.torches`: the plan's torch lights
   are already in `lights`, and merging the shorthand too would give
   every torch two lights. It throws, listing every problem, when the
   plan is invalid for the room, names another room, still has tile
   gaps, or collides with a prop id the room already has. A plan with
   tile gaps rejects the whole room — a fresh plan can never have
   gaps (the pack is complete), so a gap is always a stale plan, and
   building a half-dressed room around it would hide the staleness.
   (`dressingToRoomSpec` still returns a `skipped` list for direct
   callers; the hook is strict and never reaches it with a gap.)
3. `layoutRoom` stamps `flags.meroki = { dressingId }` on every
   dressing tile whose placement carries a `dressingId`
   (`src/worldbuilding/tiles-layout.ts`). The light `_id`, kind and
   alpha join the flag in the pairing step — the `_id` does not exist
   at layout time.
4. `resolveDressingPairing(plan, layout, tileIds, lightIds)` pairs
   the created ids back to their items after the live build: the join
   key is the dressing id (layout tiles carry it in
   `flags.meroki.dressingId`, layout lights in
   `LightSpec.dressingId`). It returns `{ pairs, errors }` — a tile
   without a light, a light without a tile, a duplicate dressing id,
   or an id array that does not line up with its layout array are
   all listed, never paired by position alone and never silently
   dropped. Each pair carries the full flag record the live half
   writes onto the tile (`tileFlags`).

The live half is a small change to `buildTileRoom`
(`src/worldbuilding/tiles.ts`, not yet made — the lead owns it):

```ts
const { plan, spec: dressed, layout } = layoutRoomWithDressing(spec, pack, serverBase);
// ... build the scene from `layout` as today (tiles, walls, lights) ...
const { pairs, errors } = resolveDressingPairing(plan, layout, tileIds, lightIds);
if (errors.length > 0) throw new Error(`Dressing pairing failed: ${errors.join(" ")}`);
// Write each pair's tileFlags onto its tile:
//   modifyDocument("Tile", "update", { updates: pairs.map(p => ({ _id: p.tileId, flags: { meroki: p.tileFlags } })), parentUuid })
```

Flag updates merge per scope, so writing `flags.meroki` completes
the `{ dressingId }` the layout stamped — it does not clobber it.
The same hook serves the floor planner and any CLI that builds rooms:
plan, merge, lay out, build, pair, write the flags back.

## The cutscene engine and dressing

A dressing item is addressable by the cutscene engine two ways: the
`light` step takes `{id: <lightId>}` (the reliable path — the id
comes back from `addLights`), or `{at: {x, y}}` (nearest light to a
point, needs the cache). The ambush's "room goes dark, then the mage
lights the center" is a `light` step per torch (dim to 0 over 1s)
followed by the mage's bloom — no new code, just a script that names
the torches.
