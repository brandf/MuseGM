# Interactive dressing — how the click wiring works at the table

FR-16: a room built by the composer has its torches and candles placed,
lit, and clickable without any hand work. Clicking toggles the light
and posts a one-line flavor note in chat. The generator
(`src/session/dressing.ts`) is built and unit-tested; this note covers
the part that is not built yet — the click wiring at the table, and the
composer hook that runs the dressing pass on every room it builds.

## What the generator produces

`planDressing(roomSpec, opts)` returns a `DressingPlan`: one item per
torch/candle/brazier (kind, cell, pack tile, placement, paired light,
chat lines per state) plus a `lights` array of the AmbientLight docs to
create, keyed to their items. `toggleDressing(item, state)` is the
toggle: off = `hidden: true` + `config.alpha: 0`; on = `hidden: false`
+ the item's own alpha — a relight restores exactly the same light.
`dressingToRoomSpec(plan)` maps a plan onto the composer hook's inputs
(torches, lights, dressing placements; items without a tile are listed
in `skipped`, never faked).

## The click-wiring decision (not made yet — decide live)

Three candidate routes. Recommendation: **Route A** (small module,
following the Meroki Pins pattern), because it is the only route where
the click itself is the trigger — no extra step for the players.

### Route A — a small Foundry module ("Meroki Dressing")

A module like `meroki-pins`: it registers a canvas interaction that
fires when a player clicks a dressing tile. The tile carries
`flags.meroki = { dressingId, lightId }` (set at build time); the
module reads the flag, flips the paired AmbientLight (`hidden` +
`config.alpha`, the same update `toggleDressing` returns), and posts
the chat line. Dave installs it once, like the Pins module.

- Pro: the click is the interaction — nothing else to learn or type.
- Con: needs a module Dave installs and trusts; the click handler is
  the one piece with no offline verification (see below).

### Route B — a generated macro the GM runs

The composer generates a macro per room ("Toggle torch at (3,2)")
that flips the light and posts the line. The GM clicks the macro, or
drags it to the hotbar.

- Pro: no module install; macros are core Foundry.
- Con: the players cannot click the torch themselves — the GM is the
  middleman, which breaks the "players go around clicking torches"
  feeling. A macro per torch also clutters the macro directory.

### Route C — the monitor watches for a chat command

A player types "light the torch" (or "blow out the candle") in Foundry
chat; the monitor parses it the way it parses roll requests, resolves
the nearest dressing item to the speaker's token, and toggles it.

- Pro: no install, no macro; reuses the monitor's existing routing.
- Con: typing is not clicking; "the torch" is ambiguous when a room
  has seven of them (nearest-to-token resolves it, but the player has
  to know to stand next to one).

**Open questions for the live session:** does the click handler live
in a module Dave installs (Route A), or is the chat command good
enough for v1 (Route C)? If Route A: does the module use a toolbar
tool the player arms (the Pins pattern — one click arms, next click
places) or a passive click handler that fires on any dressing tile
without arming? The passive handler is nicer (no arming step) but
must not swallow clicks meant for tokens — it only fires when the
click lands on a tile carrying the `flags.meroki.dressingId` flag.

## What is verified vs what needs a live session

**Verified (offline, Nov 20):**

- The light documents: AmbientLight shape `{x, y, config: {dim,
  bright, angle, color, alpha}, hidden}` and dot-notation updates
  (`config.dim`, `config.alpha`) — the same shape the Lich's Lair
  lighting fix used live on Nov 19, and the same update path
  `animateLight` uses.
- The toggle math: off = hidden + alpha 0, on = shown + the item's
  own alpha (28 unit checks).
- The placement rules: torch spacing, door-cell exclusion, no
  overlaps, braziers only in large rooms, candle table/floor fallback.
- The pack tile: `sconce` exists (100px, dressing layer). Candle and
  brazier tiles do NOT exist yet — the plan records them in
  `tileGaps` instead of faking a tile.

**Needs a live session (Dave's Foundry on):**

- The click handler actually firing in Foundry (Route A): does a
  click on a dressing tile reach the module, does the flag lookup
  work, does the light flip visibly, does the chat line post?
- The composer hook: `buildTileRoom` runs the dressing pass, the
  tiles + lights land, and the light `_id`s come back and get written
  into the items' `lightId` (so a later toggle knows which doc to
  update).
- The alpha gap: `LightSpec` carries no alpha and `addLights`
  hardcodes `alpha: 0.5`, but the dressing lights want 0.4 (torch,
  candle) and 0.5 (brazier). The hook must set each light's alpha in
  a post-create update — or `LightSpec`/`addLights` must grow an
  `alpha` field. Decide when the hook is built.
- The candle/brazier tiles: generate them (procedural, like the
  sconce) or the rooms dress with torches only until they exist.
- The cutscene cross-check: a `light` step with a named light (the
  torch's `lightId`) dims the room for the ambush, then the mage's
  bloom brings it back — the same light, driven by two systems.

## The composer hook (when it is built)

In `tiles.ts`, after `layoutRoom` returns and the scene is created:

1. `planDressing(spec, { seed: spec.seed })` — one pass per room.
2. `dressingToRoomSpec(plan)` gives torches/lights/dressing; merge
   them into the spec before `layoutRoom` (torches into
   `spec.torches`, lights into `spec.lights`, dressing into
   `spec.dressing`) — or lay them out after, from the plan directly.
   Merging before is simpler: the existing layout path creates the
   tiles and lights, and `addLights` returns the `_id`s in creation
   order, so the hook can pair each returned `_id` with its item.
3. Write the pairing back: each item's `lightId` + the tile's
   `flags.meroki = { dressingId, lightId }` on the Tile document.
   The tile flag is what Route A reads on click; without it the
   module cannot tell a torch tile from a bones tile.
4. Items in `skipped` (no tile yet) still get their light — a candle
   without a tile is still a clickable light, just an invisible one
   until its tile exists. Or skip the light too, and let the room
   dress with torches only. Decide at hook time; either way, record
   the choice in the plan, not in a comment.

## The cutscene engine and dressing

A dressing item is addressable by the cutscene engine two ways: the
`light` step takes `{id: <lightId>}` (the reliable path — the id
comes back from `addLights`), or `{at: {x, y}}` (nearest light to a
point, needs the cache). The ambush's "room goes dark, then the mage
lights the center" is a `light` step per torch (dim to 0 over 1s)
followed by the mage's bloom — no new code, just a script that names
the torches.
