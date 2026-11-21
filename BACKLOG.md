# MuseGM backlog

Working through these in order. Check an item off only when it is built
*and* tested live against the TestBed world. Never mark something done
from a code-only test. Credentials are never written in this file.

**Repo:** `brandf/MuseGM` (public, MIT) — created Nov 19, 2026. All the
tools and utilities live here so any table's Muse can run the same kit.
**Multi-Muse:** each table's Muse has its own name and persona — this
table's Muse is **Meroki**; Dave's Muse would be someone else. The repo is
the shared tooling (MuseGM), the persona is per-instance. Two Muses can
connect to the same Foundry session and divide the work (one builds maps
while the other runs combat), coordinating through Foundry chat and the
shared backlog. Coordination design: [docs/multi-muse.md](./docs/multi-muse.md)
(one chat monitor per session; Builder vs Table roles; pin claim protocol;
explicit announced takeover when one goes offline; compound-request
divide-and-conquer). Agent coordination skills: [docs/agent-coordination.md](./docs/agent-coordination.md)
(coordinating through Foundry as the channel, negotiating new protocols
on the fly, teaching each other tricks, and collaborating on the GitHub
repo as contributors — pull before building, announce pushes, review each
other's work).
**AgentTS hookup:** design only so far — see [docs/agentts-hookup.md](./docs/agentts-hookup.md) (recommends AgentTS as orchestrator over the CLIs for bounded jobs; live monitor stays outside AgentTS). **Decision (Brandon, Nov 19): core stays independent of AgentTS; the AgentTS layer is phase two, possibly a separate repo — no AgentTS work in MuseGM until then.** **AgentTS-friendly core (built offline Nov 19, code + unit tests only — NOT live-tested):** retry-safety across the core via `flags["foundry-live"]` keys (`src/idempotency.ts`): `send --dedupe-key`, seeded rolls, `buildEncounter --encounter-key`, `scene create --build-key`, `chest --key`, `sequence --run-key`, CAS `--expect-turn`/`--expect-hp`, tolerant deletes; audit table + live-test checklist in the hookup doc's "AgentTS-friendly core" section. Still open: live confirmation of flags round-trip, dedupe end-to-end, seeded rolls, keyed resume, CAS paths. BRA-202 built offline Nov 20 — [~], live test pending: `src/worldbuilding/tile-keys.ts` (pure key builders + converge planner + scene-doc extractor) + `src/worldbuilding/tiles.ts` (keyed `buildTileRoom`/`rebuildTileRoom`/`buildDungeon`; scene flag + per-embed `<key>:tile|wall|light:<index>` flags; in-process memo with layout fingerprint; idempotent `<key>:announce`) + `src/session/build-exec.ts` (build loop keys rooms by id) + `tests/tile-keys.test.ts` (24 checks, fake-live crash/retry coverage).

**Real-time adventure construction (Brandon's vision, Nov 19):** see [docs/realtime-adventure-construction.md](./docs/realtime-adventure-construction.md) — scoped feature requests FR-1..FR-15: conversational room building, theme re-skin, multi-floor + gated reveal, trigger zones, cutscene scripting + playback (the ambush), props, lighting as a language, undo/tweak, director mode (v2), rapid custom encounter generation, mutable maps + maze generator, iterative refinement (regional overlays + scripted tile swaps), value-budgeted treasure, high-level floor generation (the vague-brief mode), and the speed budget. Governing principle: **Muse authors a small cutscene script (JSON), the engine plays it out on a timed timeline** — not canned responses; Muse's tokens go to decisions, code does the enumeration and playback.

**The toolbox grows (Brandon, Nov 19):** reflect every session on what the toolbox could and couldn't do for the requests; when a request has no tool, build the tool — even a one-off (a maze generator for one maze). If it turns out reusable, it joins the toolbox permanently. The backlog is the toolbox's inventory.

## Priority (triage Nov 19 — build in this order, demo as we go)

**P0 — foundation (must work before anything else demos):** core
connection, sendChat, waitForChat <1s, reads, dice, CLIs, README, live tests.

**P1 — the walkthrough demo (highest table impact, demo in Foundry):**
1. Encounter builder — monsters + room placed, combat ready in seconds
2. Combat autopilot — initiative, turns, conditions, 0 HP callout, auto-end
3. Trap & zone triggers — step on it and it fires live
4. Scene builder — map image to walls, lights, tokens, room description in chat
5. Dice on demand — rolls, secret GM rolls, group checks

**P2 — everyday helpers:** loot pipeline, turn reminders, session recaps,
player Q&A.

**P3 — between sessions:** quest log, downtime, real rule lookup.

Demo plan: a walkthrough in Foundry itself — start in chat (Q&A + a roll),
build an encounter live, run a round of combat with the autopilot, trigger
a trap, walk into a freshly built scene with lights and a chest, open the
chest for loot, then post the recap. Each P1 item gets demoed in Foundry
as soon as it works, before moving to the next.

- [~] Dress-rehearsal runner (BRA-238) — one command that runs the whole walkthrough's checks before a session, offline first, live when Dave's server is up
  - Built offline Nov 20 — [~], live test pending. `src/session/rehearsal.ts` (`defaultRehearsalChecks()` — 32 checks, 16 offline + 16 live, each with an id, title, the BACKLOG item it covers, and a kind; `runRehearsal` runs them in order, one result per check — statuses pass / fail / skip / manual: a live check without a connection is SKIPPED with its precondition (never a pass, never faked), a check needing a human eye/hand reports MANUAL with its exact steps, a throwing check fails with the error message as evidence; failures always carry evidence (expected vs actual); `renderRehearsalReport` + `rehearsalReportToJson`; exit code non-zero iff any check failed — skips and manual checks don't fail a run) + `src/cli/rehearsal.ts` (`--list`, `--run [--json]` offline with live checks skipped, `--run --live [--json]` connects as mcp-api, runs everything, disconnects in `finally`, `--check <id>`) + `tests/rehearsal.test.ts` (18 checks, incl. one default live check executing its `runLive` against a compact fake — which proves the harness's live path, with the documented caveat that the fake never stands in for a live pass). Offline checks exercise the same logic the live checklists exercise, against the pure functions: pack complete (48 tiles, 0 gaps, every PNG on disk at its declared size), room layout, dungeon graph links, maze connectivity, ambush (51 steps), cutscene `{name}` light step, prop recording + re-play dedupe, build-loop move-prop + undo, dressing plan (14 items) + torch toggle, treasure budget (exact — see the lead correction below), rule lookup (found with citation; absent rule plainly not found), quest-log honesty (sourceless note rejected), dice parsing, theme re-skin, clocks (fire exactly once at round 4), encounter-gen (6 NPCs, 6 unique signatures, living kits, 6 placements). Live checks: 8 automatable with real `runLive` (pack upload, dressed room, ambush, rule lookup, quest log, dice, encounter, Lich import by name — no pack id assumed) and 8 manual with exact steps (torch click, token sync, zone cutscene, GM whisper, treasure fill, clock watch, scoreboard, floor-plan execution). Verified offline: `--run` → 16 pass, 0 fail, 16 skip, 0 manual (of 32); `--check treasure-budget` passes; unknown id exits 2; `--json` parses with matching counts. **Lead correction (Nov 20):** the builder's report claimed the treasure fitter's guarantee is "within 10%, not exact" and flagged the BACKLOG wording as imprecise — that is backwards. The code guarantees the total EXACTLY by construction (`totalGp = targetGp`; coins fill the remainder), proven by the lead over 5,600 hoards (budgets 1–50,000 gp, levels 1–12, 200 seeds each, zero mismatches: items + coins always equals totalGp equals the budget). The loose ±10% bounds were in the old test names only. Fixed in this pass: the rehearsal check now asserts exactness (title/comment/bound/message), and the three treasure budget tests now assert `totalGp` exactly (50/500/5000) instead of the ±10% bounds. The BACKLOG treasure wording and the `totalGp` docstring were correct and are unchanged. **Still needs live testing:** the first real run — `bun run rehearsal --run --live` when Dave's server is up (the `--live` path is code-reviewed only, never executed end to end). **Follow-ups (not built):** live runs don't clean up after themselves — `live-dressed-room` and `live-encounter-build` leave clearly-named rehearsal scenes/actors in TestBed (deliberate: deleting live docs in a rehearsal is riskier than leaving named artifacts), but repeated live runs will accumulate them; a cleanup step (or a `--clean` mode) is a follow-up decision. One real wrinkle found by the builder and handled: `worldbuilding/tiles.ts` pulls in the vendored client via `upload.ts`, which validates FOUNDRY_URL at import time — so the live builders load lazily inside `runLive` only, and the offline CLI works with no env at all.

## Core — live Foundry connection (done Nov 19 — status/wait/send tested live)

- [x] `connect()` — patched MIT MCP client (Origin header fix), Socket.IO mode
- [x] `sendChat(content, {alias, style})` — ChatMessage create via `modifyDocument`, `author` field (not `user`)
- [x] `waitForChat({lastSeen, timeout, debounce})` — wakes in <1s on a new message (socket broadcast + 1s poll fallback), debounces bursts
- [x] Event queue — `on(event, cb)` / `waitForEvents()` for chat and document changes
- [x] Reads — `getChatMessages`, `getWorldSummary`, `getUsers`, `getCombatState`, `getSceneInfo`, `searchActors`, `getActorDetails`
- [x] Dice — `rollDice(formula, {flavor, showInChat})`
- [x] CLIs — `wait`, `send`, `status` (Bun runnable, one JSON object out)
- [x] README — setup, env vars, Origin fix + `author` gotcha, how to run the wait loop
- [x] Live tests — status shows 31 actors / 4 scenes / 13 items; wait with old last-seen returns immediately; wait with current id times out; one test send verified by fresh read

## Phase 2 — world building (done Nov 19 — demo built + verified live, then cleaned up)

- [x] Scene from image — `createSceneFromImage({name, imagePath, width, height})`
- [x] Walls — `addWalls(sceneId, walls[])`
- [x] Lights — `addLights(sceneId, lights[])` (color, dim/bright, angle)
- [x] Interactive tokens — chest / lever / door tokens with loot or effects
- [x] Image-upload gap — resolve how a generated map image gets onto the DM's Foundry server (no upload tool in the MCP; document the chosen route, do not fake it)
- [x] Chest interactivity — pick the working PF2e route (token + actor loot, journal, or loot-table roll) and document it

## Map pieces + composer (design decided Nov 19, build offline between sessions)

Brandon's idea: generate a library of small map pieces (bone pile, pillar,
corner wall, rubble, altar, torch sconce, ...) in the dungeon's style, then
a composer program lays them out from a room spec and produces the room.

**Decision (revised Nov 19 — Dave's call): go the TILE route, not baked.**
Dave's point: background vs tiles are two different concepts in Foundry,
and tiles are the faster way to build — generate and upload the modular
pack once, then entire maps are just tile + token placements, no
re-uploading images per room. The earlier bake-first decision is reversed.
- Tiles are FULL SQUARES with the floor baked into each tile (classic
  dungeon-tile style), so no transparency is needed — tiles butt against
  each other on the grid and the shared floor texture hides the seams.
  That removes the cutout problem that motivated baking.
- The pack is generated once in the STYLE.md look and uploaded to the
  server; rooms are data (a layout of tile placements + walls + lights),
  built in seconds with no new generation or upload.
- Dave can rearrange tiles directly in the Foundry UI.
- The baked-image path stays as a fallback for one-off hero rooms only.
- Lighting lesson from Lich's Lair (Nov 19): the demo lights were huge
  and green (dim 1000/550, #39ff6a) — that was the "really bad lighting".
  Fixed live to warm torch-amber pools (dim 300–350, bright 120–150,
  #ff9a3c, alpha 0.4). Tile rooms use Foundry's own lights, not light
  baked into images.
- **Layers (Brandon, Nov 19):** tiles live in layers by sort order, so
  each kind of thing is independent:
  - Base: floor tiles (the plain floor grid).
  - Dressing: bones, chests, pillars, rubble — separate tiles on top of
    the floor, movable and removable on their own.
  - Atmosphere: fog wisps, smoke — their own tiles on top of everything,
    toggleable (hidden flag), movable, modular.
  - Resizing a room is instant: widen by 10 units = add floor-tile
    columns; no new images, no upload.
- **Transparency, solved per layer:** floor/wall tiles are full squares
  (no alpha needed). Dressing pieces are generated on a solid background
  and cut out in code (flood-fill from edges) to transparent PNGs.
  Atmosphere pieces are generated on pure black and converted with
  luminance-as-alpha in code — fog is bright-on-black, so that maps
  cleanly to a soft transparent wisp.
- **Code over AI where code wins (Brandon, Nov 19):** don't use gen-AI
  images for everything. Fog wisps, floor tiles, walls, doors are better
  as procedural art — SVG or PIL-drawn, rendered to PNG with real alpha:
  exact, tileable by construction, seamless, and consistent by definition.
  AI images only where they earn it (organic dressing: bones, chest,
  skeletons), cut out in code. Proof of concept Nov 19: PIL fog-wisp tile
  (transparent, alpha 0–107) + stone floor tile, composited to show the
  layering (`fog-wisp.png`, `floor-with-fog.png` in `~/workspace/foundry-live/`).
  No SVG renderer on the VM (no rsvg/inkscape/cairosvg); PIL is the
  renderer for now, SVG files can be the source of truth later.

**Build list (offline):**
- [~] Tile pack, in layers: floor tiles (full squares, floor included);
  wall pieces (straight, corner, door); dressing (bone pile, skeleton,
  chest, pillar, rubble — solid bg, cut out in code to transparent PNGs);
  atmosphere (fog wisp, smoke — black bg, luminance-as-alpha in code).
  Upload once; manifest under `src/worldbuilding/tiles/`
  - **BUILT offline Nov 19/20 — [~] means built + unit-tested, NOT live-tested
    (the backlog rule: [x] only after a live test against TestBed).**
    `tiles/procedural/generate_tiles.py` → `tiles/pack/` (15 tiles) +
    `tiles/manifest.json` (15 tiles, 3 gaps). All procedural PIL, real
    alpha; floors 100px full squares, walls 100px transparent with the
    band at top, dressing 200px, fog 200/400px. Pack: floor-plain,
    floor-cracked, floor-rubble, floor-dark; wall-straight, wall-corner,
    wall-door; fog-wisp-small, fog-wisp-large, fog-pool; rubble, bones,
    pillar, sconce, ritual-circle. Gaps recorded in the manifest, never
    faked: skeleton, chest, altar (need AI art). `tiles/pack-preview.png`
    is a 6x6 sample room rendered from the pack (`--preview` regenerates
    it byte-identically) — the tiles read as a room: seamless floor,
    wall ring, door with leaf + swing arc, bones/skull, ritual circle,
    pillar, rubble, green fog haze over it all.
  - **GAPS CLOSED Nov 20 — AI dressing tiles, built + unit-tested, live test pending.**
    Skeleton, chest, altar generated with the image tool on flat magenta
    (#FF00FF) backgrounds, top-down, STYLE.md palette — all three came
    back clean on the first pass (articulated skeleton diagonal, chest
    with iron bands + padlock, altar slab with moons/star/skull). Cut out
    by `tiles/procedural/cutout.py` (global chroma-key: key colour sampled
    from the corners, soft alpha ramp 40→90 RGB distance, 1px MinFilter
    on alpha to kill the magenta fringe; then cropped to the opaque
    bounding box and fitted into a 200x200 transparent tile). Verified
    composited over a floor tile — no fringe, floor shows through the
    ribcage gaps. Raw art in `tiles/ai-source/` (media-generation-*-raw
    files + canonical cut `skeleton.png` / `chest.png` / `altar.png`);
    `build_pack()` copies the cut files into the pack and lists them in
    the manifest. **Pack is now 18 tiles, 0 gaps.** Preview regenerated
    with all three in the room (skeleton top-right, chest bottom-left,
    altar bottom-right).
- [~] Composer: room spec (grid width/height, door walls/positions, tile
  layout by layer) → place Tile documents (sort order = layer) + walls +
  lights + tokens on the scene; resize = change grid dims, no new images
  - **BUILT offline Nov 19/20 — [~], live test pending.**
    `src/worldbuilding/tiles-layout.ts` (pure `layoutRoom` — floor
    coverage, wall ring with corner/straight/door tiles + rotations,
    collision walls split around door cells, dressing/fog layers,
    torch shorthand, seeded deterministic floor variants, spec
    validation) + `src/worldbuilding/tiles.ts` (`buildTileRoom`,
    `rebuildTileRoom`, `uploadTilePack`; GM users added as scene owners
    at create — the Lich's Lair ownership gap, fixed here first).
    Split into two modules on purpose: importing `tiles.ts` pulls in the
    vendored MCP client, which validates FOUNDRY_URL at import time and
    breaks plain `bun test` runs — the pure module keeps the math
    testable, same pattern as `src/session/dice.ts`.
  - BRA-202 (Nov 20) — keyed builds: same key twice = one scene + zero further calls + one chat post; a crash mid-build converges on retry (Level finished, full embeds, one post); a changed spec under the same key falls through the memo (layout fingerprint) to a server converge; shrunk specs delete surplus keyed embeds; the GM's hand-placed (unkeyed) embeds are never touched. Live test: keyed build + fresh-connection re-run (same scene id, no duplicates, no second post); rebuild under the key; chat build loop twice → one scene; flags round-trip on 14.370.
    Tile shape verified against the fvtt-types v13 TileDocument schema
    + Foundry v14 API docs: image in `texture.src` (not `img`), x/y are
    the top-left corner, elevation + sort order the layers, rotation is
    clockwise. Layers: floor (0, 0), wall (0, 10), dressing (0, 20),
    fog (elevation 1, sort 0 — overhead, above tokens).
    Tests: `tests/tiles.test.ts`, 25 checks — floor coverage,
    determinism, resize (+10 columns = +10*gridH floor tiles, every src
    still a pack file), wall rotations, door segments, layer
    elevation/sort, hidden/alpha, validation errors, plus the 7-check
    dungeon-graph block (Nov 20). `bun run typecheck`
    clean; `bun test tests/tiles.test.ts tests/dice.test.ts` 41 pass /
    0 fail (25 tiles + 16 dice). tsconfig `rootDir` removed so tests/
    typechecks too.
  - **LIVE-TEST CHECKLIST (next session, Dave's Foundry on):**
    1. `uploadTilePack` — 18 files land in `worlds/testbed/`, GET back
       byte-identical (same check as the map upload).
    2. `buildTileRoom` a 8x6 room with a south door, bones, fog, 2
       torches — scene loads (colour-only Level background!), tiles
       visible on a FRESH connection (the client cache doesn't track
       Tiles, so the building connection can't verify its own creates).
    3. Wall tiles: band on the outer edge on all four sides, door tile
       at the door cell, rotations correct.
    4. Collision walls: tokens stop at the walls, the door segment
       opens/closes (door: 1).
    5. Fog: drifts over tokens, toggles off via `hidden`.
    6. `rebuildTileRoom` with gridW+10 — room widens, no new images.
    7. GM ownership: Dave can edit the scene (he's added at create).
    8. AI tiles: skeleton, chest, altar render clean on the table — no
       magenta fringe, transparency reads as floor through the ribs.
- [~] Dungeon graph: rooms + door links; walking through a door moves the
  party to the next scene at the matching door
  - **BUILT offline Nov 20 — [~], live test pending.**
    `src/worldbuilding/tiles-layout.ts`: `layoutDungeon` (pure) — rooms
    + links validated (duplicate/empty room ids, link ends naming an
    unknown room or a cell that is not a declared door, a door used in
    two links, self-links, duplicated links — reversed duplicates are
    caught as duplicates, not misreported as door reuse — and the graph
    must be connected, BFS from the first room) and laid out; each link
    resolves to arrival cells one cell inside each door
    (`doorEntryCell`, `resolveDoorWalk`). `src/worldbuilding/tiles.ts`:
    `buildDungeon` (one scene per room via `buildTileRoom`, fails before
    creating anything when the graph is invalid) and `walkThroughDoor`
    (deletes each token on the old scene, re-places it in the linked
    room at the matching door's arrival cell — actorLink, so HP and
    conditions survive; new token _ids are returned, old ones are gone).
    Tests: `tests/tiles.test.ts` dungeon block, 7 checks (two-room link
    + arrival cells, entry cells on all four walls, walk resolution both
    ways + unlinked door, three-room chain, all validation errors).
    `bun test tests/tiles.test.ts tests/dice.test.ts` 41 pass / 0 fail.
  - **LIVE-TEST CHECKLIST (next session):**
    1. `buildDungeon` hall → crypt — two scenes created, both load.
    2. `walkThroughDoor` — party steps through the hall's south door
       and appears in the crypt just inside its north door, HP intact.
    3. Walk back through the same doors returns them to the hall.
- [~] Mutable maps + maze generator (FR-12) and regional overlays (FR-13)
  - **BUILT offline Nov 20 — [~], live test pending.**
    `src/worldbuilding/maze.ts` (pure): seeded recursive-backtracker maze
    (`generateMaze` — long winding corridors, spanning-tree construction
    so "perfect" is provable: edges == cells - 1; iterative, no call
    stack risk), `toSquares` (100 m -> 66 squares, 5 ft = 1 square, PF2e
    1 square = 5 ft = 1.524 m), ASCII rendering + analysis helpers
    (connectivity, cell-graph edge count, dead ends). `mulberry32` moved
    here from `tiles-layout.ts` (re-exported, no behaviour change).
    `src/worldbuilding/tiles-layout.ts`: layout ops, all pure and
    non-mutating (input spec untouched, so edit history = list of specs
    and undo = the previous one) — `addCorridor` (from a wall/door cell,
    a direction, a length in m/ft/squares; adds the door to the source
    room when missing; 1–2 wide corridors get open ends, 3+ get doors),
    `linkRooms`, `carveMazeRegion` (odd-sized, strictly interior, no
    overlap, door entries must stay walkable), `widenRoom` (shifts doors,
    dressing, fog, torches, lights, maze regions and overlays when
    growing west/north), `applyOverlay` (FR-13: floor-variant swap in a
    rectangular region only, later overlays win). `RoomSpec` gains
    `openings` (perimeter cells with no wall at all — a 1-wide
    corridor's ends; linkable in the dungeon graph like doors),
    `mazes` and `overlays`. `layoutRoom` renders maze regions (wall
    cells get a wall-straight tile facing the first open neighbour, or
    floor-dark when enclosed; merged collision walls along every
    wall/floor boundary; floor skipped on wall cells; overlays remap the
    rolled floor name inside their region). Room minimum relaxed 3x3 ->
    1x1 (corridors are 1-wide by design; corner tiles deduped by cell)
    and the old tiles test updated to match. CLI: `bun run maze --cells
    10x8 [--seed 7] [--ascii]`, `bun run maze --corridor 100m`.
    Tests: `tests/maze.test.ts`, 35 checks — units, maze properties
    (connected, perfect, dead ends, deterministic, entrance/exit sides),
    all five ops + validation, overlay region-only/1:1/later-wins, and a
    BFS walk from a door through a maze to its exit. Full suite 269
    pass / 0 fail, `bun run typecheck` clean.
  - [~] BRA-226 — Wet-variant floor tiles (floor-wet) for FR-13 overlays. Built offline Nov 20 — `tiles/procedural/generate_tiles.py` (wet_tile — the dry twin's seed for the base, then a deep-blue tint + sheen pools + ripple rings; WET_PACK: floor-wet, floor-wet-cracked, floor-wet-rubble, floor-wet-dark; preview_wet dry/wet split render) + `src/worldbuilding/tiles-layout.ts` (WET_VARIANTS, wetOverlay — unknown bases throw listing the known ones, never silently maps or falls back — applyWetOverlay) + `tests/floor-wet.test.ts` (16 checks). Pack now 33 tiles, 0 gaps; old 29 PNGs byte-identical.
  Live test (needs Dave's Foundry up): build a room with a wet overlay region — the region renders as water, the rest untouched; swapTile a floor-wet tile live; widen a room carrying a wet overlay.
  Follow-ups (not filed in Linear — the workspace hit its free issue limit at BRA-275): western wet tiles (no floor-wet-sand set; wetOverlay fails loudly on floor-sand today — a western wet set with WESTERN_FLOOR_PAL is a small follow-up if a rain-slicked alley is wanted); build-loop chat op — "make this part of the maze partially underwater" has no parser yet; the primitive (applyWetOverlay) is ready.
  - [~] Tile-pack redesign — Lich's Lair style (Brandon, Nov 20): walls with height, clean base tiles, free prop sprites, macro pieces. Built offline Nov 20 — [~], live test pending. `tiles/procedural/generate_tiles.py` (tileable value noise + AI texture references sampled as high-pass detail at 0.12–0.18 alpha; wall tiles are a wall top 0–38px over a 3-course wall face 38–100px, rotation maps each side to its outer edge; wavy grout seams with per-tile paver-cross offset; cracks/moss/vignette/base shadow; contact shadows under props; fog/dust as blurred blobs that never touch a tile edge; AI cutouts — skeleton, chest, open chest, partial skeleton — generated on magenta, cut out by `cutout.py`; the AI altar was retired as a flat blue slab and the altar is drawn in stone with a skull) + `tiles/manifest.json` (new `kind` field: base | macro | prop) + `tests/pack-structure.test.ts` (8 checks) + `tests/props.test.ts` + `tests/floor-wet.test.ts` (33→46). Pack now **46 tiles, 0 gaps, generated in 0.8s**: base 28 (clean dungeon floors 4, stone walls 6 — straight/corner/door/broken/carved/diagonal, fog 3; western floors 4, wood walls 4, dust 3; wet floors 4 from the dry twins' seeds), macro 4 (dais-round 200, pool-round 200, column-broken 200, wall-curved 300 — bounding box snaps to grid, free-form inside), prop 14 (existing 9 upgraded + bones-scattered, skeleton-partial, chest-open, bookshelf, treasure-pile). `floor-rubble` stays as clean uneven flagstones; the rubble *pile* is the `rubble` prop. STYLE.md overturned the strict-top-down rule (floor top-down, walls get height) and added the layering rule (base tiles clean, props free sprites, macro pieces bounding-box grid-aligned). Previews `tiles/pack-preview.png` (dungeon, two rooms same clean floor different props), `pack-preview-western.png`, `pack-preview-wet.png` — lead-verified visually Nov 20: walls read by silhouette, western is the strongest room, the wet split and green fog glow read. Honest limits: fog wisps/dust are subtle at 100px; skulls read slightly cartoonish (two black eye dots); the broken column's capital sits beside the shaft's end; the floor still shows a 2×2 paver rhythm up close. Full suite 943/0 across 37 files, typecheck clean.
  Live test (needs Dave's Foundry up): `uploadTilePack` lands the 46 (GET byte-identical for a wall tile + a prop sprite + a macro piece); build a dungeon room live — walls with height visible on a fresh connection, props placed as separate tiles, macro dais centered in its 2×2; re-skin western live; wet split live.
  Follow-ups (not filed in Linear — the workspace hit its free issue limit at BRA-275): composer gaps the art is waiting on — (1) off-grid prop placement (`validateSpec`/`checkPlacement` enforces integer cells; relax the integer check — tileDoc already computes `x = gx*100` so fractional cells work mechanically); (2) non-square macro pieces (`tileDoc` sets width = height = sizePx; a 300×100 wall run needs a width/height split); (3) diagonal-wall placement (`layoutRoom` emits only axis-aligned walls; needs a diagonal-wall spec + placement math — the art exists and is tested); (4) inner corners / L-shaped rooms (rooms are rectangles; needs an L-shaped room spec).
  - [~] Green eerie fog check (BRA-223) — fog was right in colour, wrong in density; fixed offline Nov 20. `tiles/procedural/generate_tiles.py` (`fog_tile` now draws at native size instead of 100px upscaled 4x with LANCZOS — 6 varied-alpha blobs + 2 off-centre cores + 2 satellite wisps for pools; 4 sine-drift wavy lines over a faint body for wisps; blur ~3px per square) + new `tests/fog.test.ts` (6 checks: green dominance G−R ≥ 20, presence at table scale, not a whiteout, edge rule, dust stays tan). Before: the large wisp was nearly invisible (max alpha 155 spread over 4 squares) and the pool was a uniform bright-green glow blob (max alpha 215, solid core). After (lead-verified by pixel measurement + preview): wisps max alpha 164–169, G−R +62; pool max alpha 187, zero pixels ≥ 200; the dungeon preview's wisp now reads as drifting green smoke over readable pavers. Pack still 46 tiles, 0 gaps; the other 40 tiles are seed-deterministic (unchanged). Full suite 949/0 across 38 files at verification, typecheck clean. Stale artifact flagged, not fixed: the old AI-generated `media-generation-test-map-fog-bones-*.png` bake still shows grey-white smoke (STYLE.md already records it as the pre-fix look); it is superseded by the Lich's Lair image as the reference.
  Live test (needs Dave's Foundry up): 8×6 dungeon room, place `fog-wisp-large` over 4 squares — green wavy smoke visible at normal table zoom, floor grid readable through it; `fog-pool` a soft haze with readable floor beneath, token in it stays visible; toggle fog `hidden` — disappears/reappears without touching the floor; western `dust-wisp-large` reads tan, never green.
  - [~] Tile-composer gaps (redesign follow-ups, no Linear issue — recorded here; Linear is at its free limit). Built offline Nov 20 — [~], live test pending. Only `src/worldbuilding/tiles-layout.ts` + new `tests/tile-composer-gaps.test.ts` (30 checks) changed; `tiles.ts` needed nothing (`buildTileRoom`/`rebuildTileRoom` just call `layoutRoom`); manifest + PNGs + generator untouched, all 46 tile ids intact. (1) Off-grid prop placement: `validateSpec`/`checkPlacement` no longer requires integer `gx`/`gy` for dressing/fog — only the footprint must fit; new `placementCells()` computes the integer cells a footprint rect actually overlaps so maze-wall/cutout checks stay exact off-grid; `placeProp`/`moveProp` accept fractional coords (bones at (2.5, 3.5) → tile `[250, 350, 200, 200]`). (2) Non-square macro pieces: `tileDoc` takes independent width/height; `PackEntry` gained optional `widthPx`/`heightPx` (default `sizePx` — manifest stays square-only); `Placement` gained optional `w`/`h` footprint via `placementFootprint()`; non-whole footprints throw. Correction to the redesign brief, verified from the PNG + generator docstring: **wall-curved's art is natively 300×300** (a quarter-arc corner piece), so a 300×100 run is an explicit flattened footprint in the spec (`{tile:"wall-curved", w:3, h:1}`), not the art's native shape — the default stays 300×300. (3) Diagonal-wall placement: new `RoomSpec.diagonals` (`{gx, gy, rotation?}` 0/90/180/270, default 0 = art as drawn, band NW→SE, face SW); `layoutRoom` places the `wall-diagonal` tile at wall sort + a diagonal collision wall; validation is interior cells only, one diagonal per cell. Theme gap: `themes.ts` has no diagonal field, so the tile name is derived from the theme's straight wall — a western room throws naming the missing `wall-wood-diagonal` instead of silently borrowing stone. (4) L-shaped rooms: new `RoomSpec.cutout` (`{corner: nw|ne|se|sw, w, h}`, corner-relative so `widenRoom` keeps it correct); `cutoutRect()`/`isCutoutCell()`/`boundaryDirs()`/`lShapeRing()` — floor skips cutout cells, the ring walks every floor cell's boundary sides, merges collision edges into runs (door edges stay their own segment); validation: legs ≥ 2 cells, no doors/openings in the cutout, no doors on inner-corner cells, no maze/cutout overlap, no props/torches in the cutout; `widenRoom` shifts `diagonals`. Demo: 8×6 room, NE cutout 2×2 → 44 floor tiles (none in the cutout), 23 wall tiles, 6 merged collision walls tracing the L outline. Full suite 1013/0 across 41 files at verification, typecheck clean.
  Live test (needs Dave's Foundry up): prop at (2.5, 3.5) sits half a square off-grid, not snapped; wall-curved `w:3,h:1` reads as a curved wall, not a distorted smear, and the default 300×300 still reads as a corner; diagonal wall band renders corner-to-corner with the face on the expected side and a token cannot cross it from either side; L-shaped room — no floor in the cutout, inner corner shows a proper corner tile, faces meet cleanly at the re-entrant corner, a token walks the L outline without snagging; rebuild the same keyed L-room after a crash/restart — converge doesn't duplicate the corner tiles.
  Follow-ups: a true 300×100 curved-run tile would need the generator (today's is a squash of the 300×300 arc art); no diagonal door; no western diagonal tile; the build loop (`build-loop.ts`) doesn't know about `diagonals`/`cutout` yet — its ops won't shift or validate them (`widenRoom` does, the chat ops don't); `listProps`/`propIdOf` show fractional coords as `bones@2.5,3.5` — a GM typing that address must type the fraction exactly.
  - **FR-13 note:** the overlay half is built; the scripted trap-door swap half of FR-13 is the cutscene builder's job (a `swapTile` step in the timeline player), not this one.
- [~] Moving vehicles (BRA-235) — a vehicle map that advances each round: cars + a track/route, riders aboard, escorts alongside, the route's deadline as a clock
  - Built offline Nov 20 — [~], live test pending. `src/session/vehicles.ts` (Vehicle: cars front-to-back + route polyline + speed + optional deadline + riders/alongside + append-only history with a required source on every change; createVehicle/advanceVehicle/boardVehicle/leaveVehicle/addAlongside/removeAlongside/stopVehicle/resumeVehicle/setSpeed — all immutable, strict validation, every error listed; pointAtDistance/routeLength geometry; deadline fires exactly once, consequence is data not code; VehicleStore + resolveVehicleTarget + serialize/parse with shape checks + save/loadVehicleState, $FOUNDRY_VEHICLE_STATE or .vehicle-state.json; live layer advanceVehicleLive/boardVehicleLive/leaveVehicleLive — one batched Token update, deadline/arrival lines in chat) + `src/session/cutscene.ts` (move-vehicle intent step — expands from a vehicle snapshot into move steps + deadline/arrival chat) + `src/cli/vehicles.ts` (--demo/--list/--show/--start --spec/--advance/--board/--leave/--alongside-add/--alongside-remove/--stop/--resume/--set-speed/--watch) + `tests/vehicles.test.ts` (31 checks, incl. the live layer against a fake live and the cutscene expansion). Spec: the Great Train Robbery walkthrough in the vision doc (Act Three).
  Live test (needs Dave's Foundry up): start the Iron Horse and advance through rounds 1–5 — tokens shift with it, deadline fires once on round 3, arrival once on round 5; board/leave mid-route; cutscene move-vehicle step plays; watch restart restores from the state file.
  Follow-ups (not filed in Linear — the workspace hit its free issue limit at BRA-275): monitor chat routing ("the train pulls ahead" from a chat sentence); playCutscene vehicles (persist the advanced vehicle after a move-vehicle step plays); stepped glide for live advances instead of one batched position set per round; JournalEntry persistence for the vehicle store; dust/smoke/passing-scenery dressing tied to the advance.
  - **LIVE-TEST CHECKLIST (next session):**
    1. Corridor + maze on the table: hall -> 100 m corridor north ->
       maze room; walk the party through both doors into the maze and
       out the exit, tokens stop at maze walls.
    2. Maze wall tiles face the walkable floor; enclosed wall cells
       read as dark floor, not a hole.
    3. `widenRoom` on a live room (rebuildTileRoom) — room widens, all
       content shifts with it, no new images.
    4. Overlay: "make this part of the maze partially underwater" —
       region goes dark/wet, the rest of the map untouched; re-roll the
       maze seed ("different maze") and it rebuilds.
    5. `bun run maze --cells 12x8 --seed <n>` eyeballed vs the table.
- [~] Prop persistence in the room spec (FR-6, BRA-218) — a prop placed, moved, or removed in one short message; props persist with the room spec
  - Built offline Nov 20 — [~], live test pending. `src/worldbuilding/tiles-layout.ts` (`listPropTiles` — the 9 dressing-layer tiles, sorted; `listProps` / `placeProp` / `moveProp` / `removeProp` — pure, immutable spec ops, stable `prop-N` ids never reused, targets by id / synthesized id / bare tile name when unique / `{tile, gx, gy}`, ambiguous or missing targets throw naming what the room has; `validateRoomSpec` now exported as the single source of truth — rejects unknown dressing tiles, non-dressing tiles on the dressing layer, duplicate prop ids) + `src/worldbuilding/tile-keys.ts` (converge now matches tiles by position + look — sort, elevation, x, y, texture src, rotation — never by flat layout index; fixes the widen ghost-prop bug where a crash-retry after a widen left a bones tile on a wall cell; walls/lights still index-matched, documented follow-up) + `src/worldbuilding/tiles.ts` (converge passes layout tile descriptors) + `tests/props.test.ts` (27 checks) + `tests/tile-keys.test.ts` (26 checks, incl. the widen ghost-prop regression and re-skin tests). Re-skin keeps or swaps props via the existing theme dressing remap (proven by test). **Walls/lights index-match closed Nov 20 (BRA-243):** converge now matches walls (endpoints, canonically ordered + door flag) and lights (x/y + dim/bright/angle/color/alpha + name) by position + look too, via a generic `planMatched` in `src/worldbuilding/tile-keys.ts` (`PlannedWall`/`PlannedLight` + normalizers `plannedWallOf`/`plannedLightOf` with the same defaults `lightCreateData` applies; a wall's `ds` door state and a light's `hidden` are deliberately NOT match fields — state, not look). Key is primary AMONG field matches (a crash duplicate loses to the embed whose key index is the planned index); a key alone never keeps an embed whose fields differ. A tie between two planned slots is a hard error naming the candidates, not a silent duplicate. `dressingId` is not a match field and cannot be one (never sent to Foundry). `convergeTileRoom` passes arrays instead of counts; `keepWallIds`/`keepLightIds` stay in layout order. 12 new checks in `tests/tile-keys.test.ts` (41 in the file). **Live checklist (BRA-243):** build a keyed room, then rebuild with a widen — walls and lights stay in place (no delete + recreate churn, no wall left where a door belongs); add a door to a wall that was plain, rebuild — the plain wall is replaced by a door segment, nothing else moves; re-skin a room to western, rebuild — torch lights recolor to lantern gold (recreated), walls keep their embeds; two named lights at one cell ("the torches" + "the altar candles"), rebuild after reordering the spec's lights list — each keeps its own embed, no swap; hand-write a spec with two identical lights at one cell, rebuild — the build fails with the converge-tie error naming both, instead of silently doubling the light. Acceptance 4 is partial: place works through chat today (pre-existing add-dressing op); move/remove chat ops built Nov 20 (BRA-241 — "move the chest" / "remove the bones" via resolveProp + moveProp/removeProp, ties ask instead of guessing, torches excluded, undo/redo round-trip, 23 checks, full suite green); cutscene-prop recording is built (BRA-242, see the cutscene entry below) — the monitor wiring to pass the spec is built Nov 20 (monitor routing round-up — see the cutscene entry).
  Live test (needs Dave's Foundry up): chat "add a chest in the southeast corner" — chest appears; rebuild the same room — chest at the same cell, no duplicate; widen, then re-run under the same key — no ghost prop, no missing wall; re-skin to western and back — props unchanged.
- [~] Multi-floor + gated reveal (FR-3, BRA-195) — a staircase goes up to a second floor only revealed when the characters actually go up.
  - Built offline Nov 20 — [~], live test pending. `src/worldbuilding/tiles-layout.ts` (RoomSpec.floor, StairLink + GateCondition, layoutDungeon validates stairs like door links + different-floors rule, stairs count as graph edges) + `src/worldbuilding/floors.ts` (validateGate/evaluateGate/describeGate, FloorVisibility, planStairReveal, resolveStairWalk, staircaseZone, FloorSession + revealFloorLive/climbStair, parseBuiltDungeon/parseGateState) + `src/session/traps.ts` (reveal-floor zone action + injectable FloorRevealPlayer) + `src/session/zone-cutscene.ts` (validation) + `src/cli/trap.ts` (--plan floorReveals, --dungeon/--gate-state) + `src/worldbuilding/tiles.ts` (BuiltDungeon stairs + room floors, buildTileRoom hidden navigation, buildDungeon hideFloors) + `tests/floors.test.ts` (36 checks, incl. fake-live reveal + watcher retry). The climb itself triggers the reveal with no creator action in the moment; a gate-blocked reveal tells the table what is missing and stays retryable.
  Live test (needs Dave's Foundry up): build a two-floor dungeon with hideFloors [1] — upper scene navigation off; watch the staircase zone — blocked line while gated, then reveal (navigation on, scene activates, token moves up); walk back down; second token, no duplicate reveal. Note: RoomSpec.hidden + hideFloors are live-checklist-only — no offline fake covers the scene-create path.
  Follow-up NOT filed in Linear (Nov 20 — the workspace hit its free issue limit at BRA-275): monitor stair-walk routing — nothing in the monitor loop resolves a stair walk today; wire resolveStairWalk + climbStair into the monitor (or a GM command), same shape as the door-walk handling. File it in Linear once the limit is lifted.
- [~] Lighting as a language (FR-7) — named lights with timed transitions
  - Timed transitions were built Nov 19 (`src/session/lights.ts` — dim/bright/color lerp, `animateLight`, cutscene `light` step). Built offline Nov 20 — [~], live test pending: named lights (BRA-197). `src/session/lights.ts` (name registry over a scene's light docs — `normalizeLightName` / `lightNameOf` / `groupNamedLights` / `resolveNamedLights` with exact-then-unique-substring matching and errors that list the names that exist / `namedLightPlan` / `animateNamedLights` for the whole group in parallel) + `src/worldbuilding/index.ts` (`LightSpec.name`, stamped into the created light's flags by `addLights`, merged with the tile-room embed key) + `src/session/dressing.ts` (dressing lights named per kind: "the torches" / "the candles" / "the braziers") + `src/cli/scene.ts` (`lights-list`, `lights-name`) + `tests/named-lights.test.ts` (27 checks). A name addresses a group of lights, never one light silently.
  Live test (needs Dave's Foundry up): build a room with a named light and confirm the flag round-trips; `lights-list` shows the group; `lights-name` fades the whole group; unknown names error cleanly with no animation; keyed rebuild keeps the names.
  - [~] BRA-240 — monitor chat routing for named lights ("dim the braziers"). Built offline Nov 20 — `src/session/light-commands.ts` (pure parser: message must lead with the light verb, name must contain a light-kind word; off → {dim: 0, bright: 0}, on → the kind's canonical radii from DRESSING_LIGHTS, explicit dim/bright/alpha/color fields, color words) + `src/session/monitor.ts` (new "light" class checked after roll/question, before build; active scene via getActiveSceneId; animateNamedLights + one confirmation line; unknown/ambiguous names post the resolver's error as a clarification) + `tests/light-commands.test.ts` (27 checks, incl. a live-path whispered dim against a fake live).
  Live test (needs Dave's Foundry up): Dave says "dim the braziers" in public chat — the group fades, one confirmation line posts; whispered "dim the braziers" confirms privately; "make the torches brighter" relights (not "I can't do that yet"); unknown/ambiguous names clarify with the names that exist; "make the braziers red" recolors; no active scene clarifies.
- [~] Chat-driven building loop (FR-1) + undo / tweak (FR-8)
  - **BUILT offline Nov 20 — [~], live test pending.**
    `src/session/build-loop.ts` (pure, never imports the vendored
    client): `parseBuildRequest` — chat line -> one `BuildOp`
    (create-room, widen, add-door, move-door, add-dressing, add-torches,
    add-fog, overlay, add-corridor, undo, redo) or `clarify` (a
    question, never a guess) or `unsupported` ("can't do that yet") or
    `null` (not a build request). Size words (tiny/small/medium/large/
    huge), names (`called`/`named`, entry-hall, crypt/tavern/lair…),
    unit conversion (10 m -> 7 squares via `toSquares`), left/right
    relative to the wall being faced, "that door" resolved only when
    the room has exactly one door (or one on the named wall). Corridor
    keeps the focus on the source room — the next edit lands in the
    room, not in a 1-wide corridor. `applyOp` — pure, non-mutating
    (input spec untouched, so history = list of specs and undo = the
    previous one); `BuildSession` — states + entries + index,
    `peek`/`commit`/`apply`/`undo`/`redo`, history entries carry the
    GM's exact words + the summary ("undid: widen room west by 10").
    `planSync` — diff before/after against built rooms -> {build,
    rebuild, remove}. `formatBuildLine` — one confirmation line per
    build with an icon. `src/session/build-exec.ts` (live, lazily
    imported by the monitor only when a build runs): peek -> validate
    -> commit -> sync via `buildTileRoom`/`rebuildTileRoom`/Scene
    delete; a no-op build posts its summary and makes no Foundry
    calls; an error posts "I couldn't build that — …" and commits
    nothing. `src/worldbuilding/tiles-layout.ts`: `DoorSpec.secret`
    — a secret door renders as a wall-straight tile and gets a
    `door: 2` collision wall (the composer already validated it like
    any door). `src/session/monitor.ts`: new routing kinds `build` /
    `clarify` / `unsupported` — build parse runs after roll/question,
    and only when a build context is passed (without one, build lines
    stay `chat`, unchanged behaviour); the monitor keeps a
    `BuildSession` + built-rooms map and lazily loads the executor.
    `src/cli/monitor.ts`: `--pack <manifest.json>` and
    `--server-base <path>`. CLI: `bun run build-loop --demo` (the
    canned Nov 19 script: build the Entry Hall, secret door, widen,
    100 m corridor, bones, undo, redo — all 7 steps succeed, prints
    one JSON object with the spec diff + the chat line per step) and
    `bun run build-loop --say "<line>" [--spec <dungeon.json>]`.
    Tests: `tests/build-loop.test.ts`, 57 checks — parser (create/
    widen/doors/dressing/fog/overlay/corridor, "build a wider room" is
    a create not a widen, "build a 3-room dungeon" is unsupported,
    non-build lines return null), session (apply/undo/redo, undo at
    the start, redo tail dropped by a new edit, frozen-input
    immutability, focus follows create/corridor), secret-door layout,
    planSync, monitor routing, formatting. Full suite 414 pass /
    0 fail, `bun run typecheck` clean.
  - **Known limitations (follow-ups, not live-test blockers):**
    a failure mid-sync (after commit) leaves the session ahead of
    the table — recover with "undo that" + re-issue. (BRA-225 built
    Nov 20 — [~], live test pending: the session persists to
    `.build-state.json` after each build; rooms are targetable by
    name; "here" resolves from the GM's last ping/cursor; compound
    requests run their ops in order, one line each. See the BRA-225
    sub-entry below.)
  - [~] BRA-225 — build-loop follow-ups (persist session, target rooms by name, resolve "here", compound requests). Built offline Nov 20 — `src/session/build-loop.ts` (BuildSession snapshot/restore + `saveBuildState`/`loadBuildState`, `$FOUNDRY_BUILD_STATE` or `.build-state.json`; room targeting by whole-phrase name match; `resolveHere`/`resolveHereRegion` from the ping point; `parseBuildRequests` compound split on "and"/"then") + `src/session/build-exec.ts` (`executeBuilds`, one line per op, stops on first failure with earlier ops kept) + `src/session/monitor.ts` (state restored on start, saved after each build; per-message ctx with rooms + GM ping; `gmHerePoint`) + `src/live.ts` (incoming `userActivity` listener, `lastPointFor` — the same event ping()/moveCursor() already send) + `src/cli/build-loop.ts` (`--state`, `--here roomId,x,y`, compound `--say`). Unit-tested (32 new checks in `tests/build-loop.test.ts`, incl. a runMonitor dry-run compound + state-restore test).
  - [~] BRA-234 — Door verbs: open/close/lock/unlock/listen at doors — one object, four verbs. Built offline Nov 20 — `src/session/build-loop.ts` (DoorState open/closed/locked + key stored on the door object in the spec; open-door/close-door/lock-door/unlock-door/listen-door ops; resolveDoor — wall/cell/secret/"that door"/ping, never guesses; parseKeyOrMethod; listenSummary — atmosphere from the far side only, never the room name or contents; canWalkThroughDoor movement gate; describe/diff/format show state) + `src/session/monitor.ts` (door verbs ride the build branch — no new message class) + `src/cli/build-loop.ts` (--demo door-verb arc) + `tests/door-verbs.test.ts` (35 checks verified by the lead, incl. runMonitor dry-run).
  Live test (needs Dave's Foundry up): lock with a key, failed open naming the key, wrong-key error, listen hint with no name leak, undo/redo restores state. Note: the live Wall ds update and the canWalkThroughDoor wiring are follow-ups, not this item.
  Follow-ups (not filed in Linear — the workspace hit its free issue limit at BRA-275): executor/composer — update the Wall doc's ds on a door-verb rebuild (build-exec.ts + tiles-layout.ts); wire canWalkThroughDoor into walkThroughDoor and the monitor's door-walk path; player-action unlocks — a player (not the GM) saying "unlock the door" should need the key or a check, distinct from GM fiat.
  Live test (needs Dave's Foundry up):
  1. Build two rooms, restart the monitor, then widen one by name ("widen the Entry Hall") — the build continues, no duplicate scenes.
  2. Dave pings a spot inside a room and says "add a door here" — the door lands on the nearest wall at the pinged cell; then "add some bones here" — bones land on the pinged cell.
  3. "add a door on the north wall and widen the room 10 east" in one message — both happen, two confirmation lines.
  4. "widen the Sunken Chapel" (no such room) — a clarification naming the rooms that exist, nothing built.
  5. Confirm a compound that fails mid-list keeps the earlier ops and reports the failure line.
  - **LIVE-TEST CHECKLIST (next session):**
    1. Chat build, end to end: "build an 8x6 entry hall with a south
       door and a chest" -> the room appears on the table in under
       2 minutes, one confirmation line in chat, nothing else.
    2. Widen live: "make this room 10 units wider" -> rebuildTileRoom
       widens the room with no new images, content shifts with it.
    3. Secret door: "put a secret door in the north wall" -> the tile
       reads as wall on the table, the collision wall is `door: 2`,
       a token can be walked through it.
    4. Undo/redo in chat: "undo that" reverts the last build and
       posts what was undone; "redo" brings it back; "undo" at the
       start of history says "Nothing to undo yet."
    5. Corridor live: "add a corridor going north for 100 meters" ->
       the corridor room appears linked to the hall; walk the party
       through it.
    6. Clarification: "add a door here" posts a question ("Which
       wall?") and builds nothing.
    7. Unsupported: "make it darker" posts "I can't do that yet"
       and builds nothing.
    8. `bun run monitor --once` / `--dry-run` with a build line in
       the log routes it to `build` and (dry-run) posts nothing.
- [ ] Green eerie fog is the dungeon's fog (STYLE.md) — pieces and bakes
  both use it

## Meroki Pins — Foundry module (design decided Nov 19, build offline)

Brandon's idea: right-click the map, leave a pinned comment thread for
Meroki, e.g. right-click a wall and say "put a secret door here that leads
into a room that is the love nest room" (the real lich's lair).

**Design:** a small Foundry module (module.json + client script) installed
on the DM's Foundry and enabled in the world.
- Right-click on the canvas (context menu entry, so it doesn't fight the
  ping) or a "Meroki" tool in the Notes toolbar → dialog with a text box →
  creates a map Note pin at those canvas coordinates, backed by a
  JournalEntry carrying the comment + `flags.meroki.request`.
- The monitor watches for new Note/JournalEntry documents with that flag
  (the MCP client already receives all `modifyDocument` broadcasts) and
  acts on the request — e.g. secret door wall (door=2) at the pinned
  spot + build and link the room behind it — then replies in chat and
  marks the pin resolved.
- Thread: replies go on the pin's journal page + a chat summary. v1 is
  one request per pin; a real back-and-forth thread is v2.
- Install: drop the module folder into Foundry Data/modules, enable it in
  the world. Dave's call.

**Build status (Nov 19, built offline — Dave's Foundry off, no live install/test yet):**
- [x] `modules/meroki-pins/` — `module.json` (id `meroki-pins`, 0.1.0,
  core 14, verified 14.370), `scripts/meroki-pins.js`, `README.md`
- [x] Notes toolbar "Meroki Pin" toggle tool (`getSceneControlButtons`,
  `onChange` arm/disarm) → one-shot click-to-place via stage
  `pointerdown` + `getLocalPosition` → V1 Dialog with a text box →
  creates a JournalEntry (page + `flags.meroki.request/status/scene/x/y`)
  and a Note pin on the current scene (`flags.meroki.request/status/entryId`,
  gold `#e8c15a`). Syntax-checked (`node --check`); no credentials in the files.
- [x] Pin contract documented in the module README + the script header,
  so the monitor side can be built against it (watch JournalEntry/Note
  creates with `flags.meroki.request`, act, reply in chat, set
  `flags.meroki.status = "done"` on both documents).
- [ ] **LIVE install/test pending next session with Dave:** drop the folder
  into Data/modules, enable in the world, drop a test pin, verify the pin
  + journal entry land, verify the monitor sees the `modifyDocument`
  broadcast, verify the Notes-layer click handler does not ALSO open a
  core note dialog while the tool is armed.

**v1.1 (BRA-219 + BRA-220) — built offline Nov 20, [~], live test pending:** right-click context-menu entry + DialogV2 migration + tool switch-back. `modules/meroki-pins/scripts/meroki-pins.js` rewritten (module.json 0.1.0 → 0.2.0): context menu via `foundry.applications.ux.ContextMenu` (container `#board`, selector `"canvas"`, `{jQuery:false, fixed:true}`, entry "Drop a Meroki Pin here", hidden without a scene/journal permission; own `contextmenu` recorder converts client coords → world via `stage.toLocal`, no `preventDefault`/`stopPropagation` so core's ping still fires); dialog migrated to `DialogV2.wait` (buttons array; drop callback returns the created entry id or `false` on validation failure, cancel → `"cancel"`, dismiss → null with `rejectClose:false`, `render` focuses the textarea); after a toolbar-placed pin, `ui.controls.activate({control:"notes", toggles:{"meroki-pin":false}})` disarms the tool and switches back (a context-menu pin leaves the controls alone). New `tests/meroki-pins-module.test.ts` (17 checks, stubbed Foundry globals — verifies wiring: toolbar registration, arm→click→DialogV2 config shape, drop creates the identical JournalEntry + gold Note pin and calls `activate` with the exact args, disarm, right-click path, empty/over-long text, cancel/dismiss, missing DialogV2/ContextMenu degradation). **Key finding: the 14.370 client bundle is NOT on this VM** (whole-disk search for `foundry.js` found nothing — only the MCP socket client, which carries no Dialog/ContextMenu surface). The three APIs were verified against the official Foundry VTT v14 API docs + the `@league-of-foundry-developers/foundry-vtt-types` 13.346 type definitions instead; every bundle-level behaviour is a live-check item, not an assumption. Full suite 1013/0 across 41 files at verification, typecheck clean, `node --check` clean on the script.
  Live test (needs Dave's Foundry up): right-click opens the menu AND the ping still pulses; the menu entry opens the dialog at the right-clicked spot (coords); Drop Pin from the toolbar visually switches the toggle off and returns to the Notes tool; Drop Pin from the menu does NOT switch controls; `wait` resolves as documented (drop → entry id, cancel → `"cancel"`, X/Esc → null, empty text → warning + no pin); entry hidden when no scene is active. Known wart (V1 parity, kept): empty text warns and closes the dialog — a DialogV2 button callback cannot veto closing.
- [ ] Right-click canvas context-menu entry (v1.1) — needs the v14
  `ContextMenu` API verified against the 14.370 client bundle; the toolbar
  tool is the v1 path.
- [x] Monitor side: watch for pins, act, reply, mark done — built offline
  Nov 20 (no live test yet — Foundry was off): `src/session/pins.ts`
  (`extractPin` / `parsePinRequest` / `extractRoomName` / `nearestWall` /
  `splitWallForDoor` / `planPinAction`, all pure + unit-tested) +
  `handlePin` / `PinProcessor` (dedupe in memory + `.pins-state.json`) /
  `findOpenPins` (picks up pins dropped while the monitor was offline).
  Secret door = split a 100px piece out of the nearest wall (door type 2)
  + build the named room behind it as its own tile-room scene with the
  door on the facing side; chest / light / plain door / named room also
  planned; unknown requests get a clarification reply and are marked done
  (so they don't re-fire forever). `tests/pins.test.ts` green. The
  worldbuilding builders are dynamically imported only when a plan
  actually builds, so the tests never touch the MCP client.
  **Still needs live testing:** drop a real pin, watch the monitor pick
  it up, verify the wall split + room build + chat reply + journal
  append + status "done" on both docs.
- [ ] Migrate the dialog from V1 `Dialog` to `DialogV2` once
  `DialogV2.wait`'s button-callback signature is verified against the
  14.370 bundle; same for programmatically switching the active tool back
  after a pin is placed.

## Monitor CLI — first-class loop (built offline Nov 20)

The wait → answer → wait loop the Nov 19 subagent monitor was doing by
hand, now as library code: `bun run monitor` (`src/cli/monitor.ts` +
`src/session/monitor.ts`).

- [x] `runMonitor` — waitForChat loop (starts from the newest message,
  never re-answers history), first cycle scans for open pins dropped
  while offline, combat turn announcements, clean shutdown on
  SIGINT/SIGTERM, JSON log lines on stderr, `--once` prints a summary
  JSON on stdout, `--dry-run` classifies without posting.
- [x] Routing (pure, unit-tested): own messages (by author _id or
  speaker alias) never wake it; empty messages are noise; roll requests
  → `rollForChat`; data questions → `answerQuestion`; everything else
  is logged as "needs-agent" and skipped — the CLI never improvises.
- [x] Questions it answers, from live data only (turn / round / HP /
  AC / initiative / scene). A missing actor / field / combat is reported
  as "couldn't find it", never filled in. `tests/monitor.test.ts` green.
- [x] Turn announcements only: the monitor announces turn changes
  (the GM advancing the tracker). HP / down / combat end belong to the
  autopilot — the code path that changes HP owns the callout — so the
  monitor never double-posts a down message.
- [ ] **LIVE test pending next session:** run `bun run monitor` against
  TestBed, post a roll request + a question in chat, drop a pin, advance
  the tracker, confirm the answers + turn announcement land and the
  "needs-agent" lines stay out of chat.

## Session automation (P1 first, in demo order)

- [x] Encounter builder — name the monsters and the room; place tokens, set HP, roll initiative, combat ready
- [x] Combat autopilot — track initiative, advance turns, conditions with durations that expire, HP watch with a callout at 0 HP, end combat when the last enemy falls
- [x] Trap & zone triggers — watch token movement, fire a trap or a reveal when a token enters a zone
- [~] Zone → cutscene link (FR-4, BRA-196) — a trigger zone plays a cutscene when a token enters it
  - Built offline Nov 20 — [~], live test pending. `src/session/zone-cutscene.ts` (pure: `resolveZoneSet` strict validation — inline script or file path via injected loader, sceneId inheritance + mismatch error; `planZoneCutsceneSet` trigger plan; `LinkArming` dedupe state machine — `once` fires exactly once, `per-token` fires once per token and re-arms on leave, manual arm/disarm) + `src/session/traps.ts` (`cutscene` ZoneAction, injectable `CutscenePlayer`, watcher plays the cutscene on entry) + `src/cli/trap.ts` (resolve + plan a zones file, `--plan` needs no connection) + `examples/trapdoor.json` + `examples/trapdoor-zones.json` + `tests/zone-cutscene.test.ts` (19 checks). Deliberately NOT wired into the monitor — the trap CLI's watch is the live executor, and a second watcher would double-fire. **Still needs live testing:** a real zones file watched against TestBed (token enters a zone, cutscene plays once, re-entry does not replay; per-token zone fires for a second token; disarm/arm); cutscene sceneId inheritance on a live scene. Known risk: the demo's `swapTile` uses the cell form, which has no tile cache yet — it may fail live; fallback is the tile `_id` from a fresh scene read, and without `--continue-on-error` the cutscene stops at a failed swap (light dim never runs) — decide whether the watcher should play with `continueOnError`. Spec: `docs/realtime-adventure-construction.md` FR-4.
- [x] Scene builder — map image to walls, lights, tokens; auto-post the room description into chat when players enter
  - Done Nov 19: `src/worldbuilding/` + `src/cli/scene.ts` demo. Upload verified live (400×300 PNG → `worlds/testbed/test-map.png`, byte-identical on GET). Demo scene rebuilt after the `background.src` fix: 4 walls, 2 lights, chest (50gp + 2× Healing Potion) verified in a fresh snapshot, then cleaned up (world back to 4 scenes / 31 actors). Caveat: the background is set per the v14 schema and accepted by the server, but the worldData snapshot never exposes `background` for any scene — the GM needs to open the scene once to visually confirm the map. See `src/worldbuilding/README.md`.
  - BUG found Nov 19: scenes created via the MCP get ownership `{default: 0, mcp-api: 3}` only — the GM (Dave) is not an owner and could not edit "Lich's Lair — Entry Hall". Fixed live by adding Dave as owner (level 3). TODO: `createSceneFromImage` (and any scene create) must add the GM user(s) as owners — look up users, find role GM, include them in `ownership` at level 3.
  - BUG found Nov 19 (the real load failure): in Foundry 14 the map lives on a **Level**, not on the scene — the scene MUST have at least one Level or the canvas has nothing to render and the scene will not load. My scenes were created with scene-level `background: {src}` only, so Lich's Lair had `levels: []` and `initialLevel: null` while every working scene has a `defaultLevel0000` with `background.src` on it. The earlier "background.src fix" was wrong — that update was accepted with no error and did nothing. Fixed live: created a Level on Lich's Lair with `background.src: worlds/testbed/test-map.png` and set `initialLevel` to the level's real _id (the server assigns its own _id — a requested `defaultLevel0000` was ignored). Verified on a fresh connection. `createSceneFromImage` in `src/worldbuilding/index.ts` now creates the Level + sets `initialLevel` for every new scene.
- [x] Dice on demand — rolls requested in chat, secret GM rolls, group checks for the whole party
  - Built offline Nov 20 (no live test yet — Foundry was off): `src/session/dice.ts` + `src/cli/dice.ts` + `tests/dice.test.ts` (16 unit tests green, typecheck clean). Pure functions `parseRollRequest` / `formatRollResult` / `formatGroupCheckResult` / `firstDieResult` (no I/O, tested); live `rollForChat` (returns null for non-requests, reports a bad formula in chat with the roller's own error), `secretRoll` (whisper to the GM — role 4, fallback user named "Gamemaster" — plus a public "rolls behind the screen" line with no result), `groupCheck` (one roll per `character`-type actor, summary best-first with nat 20/1 marks). CLI `--parse` works with no connection (imports only the parser — importing live.js validates FOUNDRY_URL at import time). **Still needs live testing:** a real `--roll` / `--secret` / `--group` against TestBed, and the monitor calling `parseRollRequest` on chat.
  - Visible rolls: the monitor's `/tmp/post-roll.mjs` was lost with /tmp — reconstructed as `postVisibleRoll` (rollDice + sendChat; the posted message IS the visible roll). A native Foundry roll card (`rolls` payload) is not reachable from the local roller (totals + breakdown string only, no per-die results) — future item if the REST dice transport is ever used.
- [x] `moveTokenTo(tokenId, x, y, {speed})` — high-level smooth movement: steps the token in small increments so it glides instead of teleporting; test whether Foundry's native animation already does this and use it if so
  - Done Nov 19: `src/session/movement.ts` (`moveTokenTo` / `placeToken` / `deleteToken` / `resolveScene` / `resolveToken` / `getSceneTokens`) + `src/cli/move.ts`. Native-animation finding: a single Token update DOES animate on clients (`animate` defaults to true in the 14.370 bundle), so stepping is for long paths / controlled speed, not short hops. Demo live on Otari (inactive scene): Kobold Warrior token `VbfTstrhKePRJ2qK` glided 200,200 → 800,200 in 12 steps / 3279ms at 300px/s, final position verified by a FRESH connection, token deleted. Two real bugs found and fixed in the demo: (1) the demo CLI's `process.exit(0)` in a `finally` swallowed the failure and reported success — all three new CLIs now use the `main().catch` pattern; (2) a connection never sees its own creates/moves in its cache, so `moveTokenTo` takes a `TokenRef` descriptor (`{id, name, x, y}` from the create response) as the start position when the cache lacks the token, and the sequence runner tracks tokens it placed. Scene/token are resolved against current state at call time, never from earlier probes.
- [x] Sequence runner — fire off a timed sequence of actions (move → pause → roll → apply effect → chat) that plays out on the code side, paced, with no round-trip to Muse per step
  - Done Nov 19: `src/session/sequence.ts` (`runSequence`) + `src/cli/sequence.ts` (`--file` / `demo`). Steps: place, deleteToken, move, pause, chat, roll, damage, heal, effect, ping, cursor, waitChat; stops on first failure unless `--continue-on-error`; per-step log returned. Demo live on Otari: 6 steps (place → move → pause 1000ms → roll 1d20+5 = 20 → pulse ping → delete), all ok in 4230ms, token cleaned up (Otari tokens: []).
  - Extended Nov 20 (cutscene engine): new step kinds `face`, `light`, `prop`, `reveal`, `wait`, `swapTile`; `place` keeps its `key` (formation retry-safety). See the cutscene entry below.
- [~] Cutscene script engine (FR-5) + scripted tile swaps (FR-13) — Muse authors a small JSON script, the engine plays it on a timed timeline
  - Built offline Nov 20 — [~], live test pending. `src/session/cutscene.ts` (versioned script schema, strict validation — every error listed, never a silent skip; formation expansion; `playCutscene` via runSequence) + `src/session/formations.ts` (ring/line/wedge + facing angles, pure) + `src/session/lights.ts` (timed light transitions — dim/bright/color lerp, `animateLight`) + `src/session/tile-ops.ts` (FR-13 `swapTile`: texture swap in place by Tile _id or by cell when the cache carries tiles) + `src/cli/cutscene.ts` (`--file`, `--validate-only` needs no connection) + `examples/ambush.json` (the ambush: 9 soldiers glide in, spears, mage, center light blooms — validates, expands to 51 steps) + `tests/cutscene.test.ts` (22 checks). **Cutscene-player gaps built offline Nov 20 (BRA-239 + BRA-242) — [~], live test pending.** BRA-239: a cutscene `light` step now accepts `{name}` alongside `{id}` / `{at:{x,y}}` — validation requires exactly one selector (blank name, two selectors, unknown selector field all rejected with the reason); the player calls the existing `animateNamedLights`, and the `from` decision is that the plan carries it — each light starts from its own current state, read from the cache at plan time (`namedLightPlan`) — a named step carrying `from` is rejected in validation AND in the player (for direct `runSequence` callers), since one `from` cannot describe a group in different states; unknown/ambiguous names error listing the names that exist before any update is sent. BRA-242: cutscene `prop` steps are recorded in the room spec — new pure `recordCutsceneProp` in `src/worldbuilding/tiles-layout.ts` (resolves the played src to a pack tile by basename via `propTileNameForSrc`, converts px to cells, calls the existing `placeProp`; unknown src / ambiguous basename / floor-tile src / out-of-room placements throw naming the known props; position keeps the exact fractional cell, footprint rounds to whole cells — a 150px prop records 2 cells wide; a re-play dedupes on same tile + cell + rotation) + `RunSequenceOptions.roomSpec` (`{spec, pack, onSpec}`) — after each played `prop` step the player records it and hands the updated spec back through `onSpec`; a recording failure is reported on the step (`recorded:false` + `recordError`) but does NOT fail the step — the prop is on the table, it just won't survive a rebuild; with no spec supplied the step says so explicitly. New `tests/cutscene-player.test.ts` (18 checks) + 1 validation check in `tests/cutscene.test.ts`; lead-verified 45/0 across both files. Honest limits: the player can only record when the caller supplies the spec — **the monitor wiring is built Nov 20 (monitor routing round-up):** `handleWhisperSequence` takes optional `roomSpec` and forwards it to `playCutscene`; the loop builds it fresh at fire time from the build session's active room (`buildRoomSpecOption` — pack loaded lazily, load failure logs `room-spec-unavailable` and plays without a spec); `onSpec` rebases onto the session's *current* spec (only new placements by id, so a GM edit mid-play is never overwritten), commits as an `add-dressing` history entry, and saves the state file — so the next rebuild restores the prop and "undo that" takes it back. No active spec → props play unrecorded, step result says so. Tested end-to-end with a seeded build state: fired bones prop at (200,100) lands in the state file's room spec as `bones` at (2,1). **Live checklist:** build a room in chat, fire a cutscene with a prop step in it → prop appears on the table AND survives the next rebuild of that room; "undo that" takes the recording back. The Tile create itself still duplicates on a re-run (pre-existing player limit — only the spec is protected); `breakWall` rubble tiles are not recorded (created directly, not via `prop` steps); named lights need the scene's lights in the connection's worldData cache — with no cached lights the step errors rather than guessing. **Live checklists:** named lights — cutscene `{name:"the braziers"}` fades all braziers together, candles untouched; two group lights at different dims fade from their own states with no jump; unknown name errors listing the names that exist, nothing animates; ambiguous substring errors asking for one exactly; `{id}` + `from` still works. Prop recording — cutscene with a `prop` step (bones, known cell) with the spec wired in, then rebuild — bones back at the same cell; re-run the same cutscene — spec still holds exactly one bones prop; a prop with a non-pack src plays but reports unrecorded, and a rebuild drops it; a cutscene played with no spec reports unrecorded while the prop stays visible until rebuild; formation props (ambush spears) recorded — run the ambush, rebuild, spears survive. Spec: `docs/realtime-adventure-construction.md` FR-5 + FR-13.
  - [~] BRA-231 — stage-then-fire gate. Built offline Nov 20 — `src/session/staging.ts` (`stageCutscene` validates the whole script + resolves every reference against a world snapshot, returning every error in step order; beat store — stage/fire/drop/edit/list, serialize/parse, deterministic `staged-<slug>-<hash8>` ids; `snapshotWorld` + `playStagedCutscene`, which hash-checks the beat before playing and refuses a script edited after staging) + `src/cli/cutscene.ts` (`--stage` / `--fire` / `--snapshot-world` / `--help`) + `tests/staging.test.ts` (20 checks, incl. mice-ogre staging against a fixture world — 38 expanded steps, 0 warnings). A staging failure leaves the table untouched; staging is a pre-flight check, not a lock — the world can change between stage and fire. **Monitor routing built offline Nov 20 (BRA-244):** whispered scripts/named sequences no longer play on receipt — `handleWhisperStage` snapshots the world, stages via `stageCutscene`, and whispers the preview (`stagePreviewLine`: summary + first 3 lines + warnings + the reply instruction, beat id included); `handleStageReply` handles `fire` (hash-checked, then plays in the background through the existing `handleWhisperSequence` path, so the ack/completion whispers and latency hooks are unchanged), `edit` (next pasted script re-stages under a new id; a failed revision leaves the old beat staged and the wait open), `drop` (one confirmation line). `parseStageReply` matches exactly `fire`/`edit`/`drop` + optional id/filler — "fire the cannons", "fired", "drop the beat" fall through to ordinary routing. A bare fire with exactly one staged beat fires it; with several, the GM is asked to name one by id; with none staged, it falls through to `WHISPER_CLARIFY`. Staging is awaited in the loop (unlike the old background play) so the beat store holds the beat before the GM's "fire" is read. New `MonitorSummary.stagesHandled`. **Behavior change (deliberate, this is the BRA-231 design):** whispered scripts used to play immediately; now they stage and wait for "fire". The FR-18 latency budget now runs from "fire" to first effect, not from the whisper — the perf test asserts the first-effect/per-step labels carry the fire message's id. Tests: `tests/monitor-routing.test.ts` (48 checks) + updated `tests/whisper.test.ts` (34) and `tests/perf.test.ts` (26). **Still needs live testing:** stage mice-ogre mid-session → Dave gets the preview by whisper → says "fire" → the ambush plays; also try "edit" + a revised paste (new id, new preview) and "drop". **Follow-ups (not built):** the beat store is in-memory only for the run — a restart loses staged beats (staging.ts has serialize/parse but no default file path); a named sequence while an edit is pending stages fresh and clears the edit wait.
  Live test (needs Dave's Foundry up): `--snapshot-world` against TestBed, `--stage` mice-ogre — clean stage; `--fire` on the GM's nod — nothing visible to the table until fired, then plays fully; fire/edit/drop each in one message; stage a script with a bad reference — error names the real missing thing, nothing posted.
- [~] Theme re-skin (FR-2, BRA-194) — one word ("western") rebuilds the same room spec with a different look
  - Built offline Nov 20 — [~], live test pending. `src/worldbuilding/themes.ts` (ThemeSpec: floor/wall tile names, atmosphere + dressing remaps, torch palette, Level background colour; DUNGEON_THEME = the pre-theme look made explicit, proven identical by test; WESTERN_THEME = sandstone floors, wood-plank walls, dust instead of fog, lantern-gold torch #ffb347 dim 280/bright 110, background #0d0a07; `resolveTheme` case-insensitive, unknown names throw listing known themes; `themeTileGaps` fails loudly naming theme + tile, never fakes one) + `src/worldbuilding/tiles-layout.ts` (`RoomSpec.theme`, `layoutRoom`/`layoutDungeon` theme param, default dungeon) + `src/worldbuilding/tiles.ts` (`buildTileRoom`/`rebuildTileRoom`/`buildDungeon` theme param; Level background from theme) + `tiles/procedural/generate_tiles.py` (WESTERN_PACK, 10 tiles) + `tests/themes.test.ts` (20 checks). Pack now 29 tiles, 0 gaps; old 19 PNGs byte-identical; western preview verified visually. **Still needs live testing:** `uploadTilePack` lands the 10 new western tiles (GET byte-identical for floor-sand, wall-wood-door, dust-wisp-large); build an 8×6 western room on TestBed (scene loads, sandstone + wood ring + door visible on a fresh connection); re-skin live (same room built dungeon, then `rebuildTileRoom` with theme "western" — same scene/walls/doors, new look); fog remap live (western room with fog "fog-wisp-large" shows dust, not green fog; toggles via `hidden`); torch palette live (western torch reads lantern gold vs dungeon amber); Level background (western scene's Level is warm dark brown #0d0a07); `buildDungeon` with theme "western" (all rooms western, links resolve, `walkThroughDoor` works). Follow-ups (not gaps): western dressing tiles (cactus/wagon/barrel), sci-fi/dragon/Care Bears themes (one ThemeSpec + generator variant each), build-loop "make it western" chat op, floor-plan theme param. Spec: `docs/realtime-adventure-construction.md` FR-2.
- [~] Emergent sequences (FR-18) — the GM whispers an idea mid-session and a whole sequence plays out, unplanned
  - Built offline Nov 20 — [~], live test pending. New cutscene steps, all validated the same strict way (every error listed, never a silent skip): `waitRound` (round clock — the sequence advances on combat rounds, polls combat state every 2s, relative or absolute, 30-min default timeout; already-past rounds return at once), `rush` (pure expansion: one token per actor, placed at the door, gliding through each waypoint in order to the far door, staggered; a bite after each `through` waypoint is one visible roll in chat — the roll IS the damage roll, targets round-robin from the author's ordered list; applying the rolled damage to HP is the GM's call, the runner has no variable passing so a rolled amount cannot feed a `damage` step in the same expansion), `lightsOut` (pure `lightsOutPlan` in lights.ts — every light to dim 0 / bright 0 / alpha 0, color kept, fast 800ms fade in parallel, not a snap), `breakWall` (by Wall _id or nearest wall to a point via pins.ts `nearestWall` — `sceneWalls` now exported for it; deletes the Wall doc, drops a rubble tile at the break by default), `emerge` (pure expansion: new token placed at a corpse token's position — `at` when given so --validate-only works, else the live player resolves the corpse token; the corpse is recorded in the place key, which the step log carries), and the `reveal` image shape (`src/session/reveal.ts`: `buildRevealPrompt` grounds the prompt in the room + corpse + creature, no generic gore; `revealImageChatHtml` posts the image inline in chat; `validateReveal`; popout mode now reaches the client-side popout (BRA-236 below — the `meroki-reveal` module pops the image full-screen; the chat post is always the fallback). `examples/mice-ogre.json` (Brandon's proving case: 6 mice rush + bite, 5 rounds, ogre enters, roars, smashes the south wall, lights out — validates, 10 → 38 steps) + `examples/tentacle-twist.json` (phase three: looting → tentacle rips through the ogre's stomach → reveal image → the Tentacled Horror emerges at the corpse — validates, 7 → 7 steps) + `tests/emergent.test.ts` (26 checks). **Live test is a real mid-session moment, not a lab case:** Dave (or Brandon) whispers the idea privately mid-session, Muse builds the script on the fly and it plays — the checklist is: the mice rush + bite rolls land in chat, the ogre arrives on the round clock after five rounds, the wall smash drops rubble, the lights go out as a fade, and the twist's reveal image lands in chat at the moment of the emergence (inline rendering + the uploaded image URL resolving for every client). Monitor GM-whisper handling is built — see the BRA-185 sub-entry below. Spec: `docs/realtime-adventure-construction.md` FR-18.
  - [~] BRA-185 — monitor GM-whisper handling (FR-18 gap). A GM whisper to Meroki is an instruction, not chatter. `src/session/whisper.ts` classifies (embedded script / named sequence / other); `src/session/monitor.ts` routes whispers to the cutscene engine (ack whisper, background play, runKey `whisper:<msgId>`), the build loop, or live-data answers — all handler replies whispered to the GM, script chat steps stay public. Unit-tested (34 checks in `tests/whisper.test.ts`).
  - [~] BRA-236 — Reveal popout: the image fills the players' screens. Built offline Nov 20 — [~], live test pending. New `src/session/popout.ts` (`buildPopoutShow`/`buildPopoutDismiss`/`validatePopoutMessage`/`emitPopout` — validation lists every error; emit never throws, returns `{emitted:false, reason}`) + new client module `modules/meroki-reveal/` (`module.json` id `meroki-reveal`, core 14, verified 14.370; `scripts/meroki-reveal.js` — captions via textContent, never innerHTML) + `tests/popout.test.ts` (17 checks). Trigger is a Foundry module-socket message on the same MCP-client socket that already emits pings (`game.socket.emit("module.meroki-reveal", ...)`; plain emit, not volatile — a reveal is a deliberate GM moment). Second reveal while one is open REPLACES (newest moment supersedes; no hidden queue); the GM clears everyone with a new `dismissReveal` step (silent, no chat post), a player closing locally (X / backdrop / Esc) closes only their own screen. Degraded path: the reveal step ALWAYS posts the chat image first, then attempts the popout — a player without the module sees the chat image, never nothing; a broken image URL shows caption + "see the chat log" and stays dismissible. Wiring: `src/session/sequence.ts` (reveal-image case posts chat then emits when `mode:"popout"`, result carries `popout:true/false` + `popoutId`/`note`; new `dismissReveal` step kind) + `src/session/cutscene.ts` (`dismissReveal` in `SEQUENCE_KINDS`/`STEP_FIELDS` + validation). Trade-off flagged in the file: `emitPopout` reaches the socket via a `live.raw()` cast (as live.ts's own private `rawSocket()` does) — if a public emit method is ever added to FoundryLive, call it instead. Full suite 966/0 across 39 files at verification, typecheck clean.
  Live test (needs Dave's Foundry up): install `meroki-reveal` in `Data/modules`, enable, all players reload; cutscene reveal step with `mode:"popout"` — every client with the module sees the image full-screen with caption, a client without it sees only the inline chat image; player Esc/backdrop/X closes locally, others still see it; `dismissReveal` closes on every client; second popout while one is open swaps in place (no second overlay, no queue); reveal with a bad image path shows caption + "see the chat log", still dismissible.
  Follow-up (not filed in Linear — the workspace hit its free issue limit at BRA-275): no monitor-chat command for dismiss yet ("dismiss the popout" from the GM in chat would be monitor routing, not built here). Honest limits: socket relay, the z-index-9999 overlay sitting above Foundry dialogs, and the image URL loading in the overlay exactly as in chat are all ASSUMED until a session proves them; the module is DOM, not canvas — while a popout is open it covers the whole window including chat, so a player can't read chat until they dismiss it.
  - [~] BRA-228 — Clocks: visible countdown/progress clocks on the table. Built offline Nov 20 — `src/session/clocks.ts` (Clock + ClockStore, immutable ops: create/tick/fill/resolve/reset/drop; `advanceClocksToRound` — one tick per new combat round, re-poll is a no-op, new combat resets tracking; `parseClockStart` — one-sentence start; `renderClock`/`renderClockStore`; serialize/parseClockStore; save/loadClockState, `$FOUNDRY_CLOCK_STATE` or `.clock-state.json`; `readCombatRound` + `announceClockLive`) + `src/cli/clocks.ts` (`--demo/--list/--show/--start/--tick/--fill/--resolve/--reset/--drop/--watch`) + `tests/clocks.test.ts` (25 checks). A fired clock fires exactly once; the consequence is data the caller delivers, not code. **Monitor routing built offline Nov 20 (BRA-275):** new `MessageClass "clock"`, `parseClockCommand` (starts via the module's own `parseClockStart`; tick/fill/resolve/reset/drop/stop/pause by name; subject-first "the dragon clock ticks"; `show/list/what clocks are running`) and pure `applyClockCommand`. Unknown names / bad states surface the module's own `ClockError` as a clarification (it lists the clocks that exist). One confirmation line per action; a second clock sharing a name gets its id in the line. The store loads at startup (`MonitorOptions.clockStatePath`, `--clock-state` in the CLI) and saves after every change. Every running clock ticks once per new combat round from its own try block after the combat announcements (idempotent per round via the store cursor; a fired clock's line carries its consequence). New `MonitorSummary.clocksHandled`. Real bug found and fixed while testing: the parser strips the article ("tick the pursuit clock" → `pursuit`) but the clocks module keeps it (clock named `the pursuit`), so every tick by name failed with `No clock named "pursuit"` — fixed in `applyClockCommand` with an article toggle: if the spoken name matches nothing, try it with the leading "the" added/removed, only when the direct name matches nothing, so it never guesses between two clocks (pure test, both directions). **Still needs live testing:** Dave says "start a 6-segment clock: the pursuit" → clock starts; "tick the pursuit clock" → 1/6 line; run a combat round → one tick line per running clock; "stop the omen clock" drops it; "tick the missing clock" clarifies with the list. **Follow-ups (not built):** never run the clocks `--watch` CLI against the same state file as the monitor — two writers could double-tick; a start without a count asks "How many segments should the clock have?" (the clocks module doesn't extract the name when there's no count, so the question is generic); resolve only works on a fired clock (module semantics).
  Live test (needs Dave's Foundry up): `--start` announces in chat; `--watch` ticks once per combat round; fire at zero posts once; two same-name clocks addressed by id; watch restart restores from the state file; new combat ticks round 1 again.
  Follow-ups NOT filed in Linear (Nov 20 — the workspace hit its free issue limit at BRA-275; see the note at the top of this file): monitor routing for clocks is built (BRA-275, Nov 20 — see the clocks entry above); JournalEntry persistence for the clock store; pause/resume for clocks (unimplementable against the clocks module — no pause op exists; "pause" gets the honest clarify: clocks only tick on combat rounds, so ending combat pauses it, or say 'stop the X clock' to drop it); consequence execution — map a fired clock to a staged cutscene. File these in Linear once the limit is lifted.
- [~] Scoreboard: visible score/points tracking for contests (BRA-237) — first to N wins, fouls subtract
  - Built offline Nov 20 — [~], live test pending. `src/session/scoreboard.ts` (startScoreboard — name/target/≥2 teams; awardPoints/setPoints with a required source on every change; resolveTeam with exact-then-unique-substring matching and errors that list the teams; first to target wins immediately, won boards are terminal; endScoreboard — leader wins, tie ends with no winner; parseScoreboardRequest — start/award/foul/show/end phrasings, ambiguity clarifies; save/loadScoreboardState, `$FOUNDRY_SCOREBOARD_STATE` or `.scoreboard-state.json`) + live layer (JournalEntry "Scoreboard", observer, one page per board with the board JSON in page flags, index page, one chat line per change) + `src/cli/scoreboard.ts` (`--demo/--list/--show/--start/--award/--set/--end`) + `tests/scoreboard.test.ts` (32 checks, incl. the live layer against a fake live).
  Live test (needs Dave's Foundry up): start a dragon-soccer board and confirm the journal page + chat line; award a goal and a foul; third goal declares the winner; read back on a fresh connection (flags round-trip); two boards stay separate.
  Follow-up NOT filed in Linear (Nov 20 — the workspace hit its free issue limit at BRA-275): monitor chat routing for scoreboard (parseScoreboardRequest into monitor.ts). File it in Linear once the limit is lifted.
  Live test (needs Dave's Foundry up):
  1. Dave (GM) whispers Meroki "run the mice and the ogre" → ack whisper arrives instantly; mice rush in with visible bite rolls, ogre breaks the wall ~5 rounds later, lights go out; "finished" whisper at the end.
  2. Dave whispers an embedded fenced-JSON script (chat-only steps) → it plays; then whispers a broken script → rejection whisper quoting the validation errors, nothing plays.
  3. Dave whispers a build request ("add a door to the south wall") and a question ("whose turn is it?") → both answered back as whispers, build happens / answer comes from live data.
  4. Dave whispers "roll 1d20+5" → clarification whisper, nothing public.
  5. Confirm the table never sees the setup: all handler replies are whispers; only the script's own chat steps appear publicly.
  6. Latency: whisper → first visible effect within 1–2 minutes.
  7. After an ogre fight, whisper the tentacle twist → emerge + reveal image posts inline in chat.
- [x] Ping & cursor — `ping(x, y, {style})` via the `userActivity` socket message (`{cursor, ping: {scene, pull, style, zoom}}`); cursor position rides the same message. Proven live Nov 19 (test ping sent on Landing)
  - Done Nov 19: `FoundryLive.ping()` / `moveCursor()` in `src/live.ts` + `src/cli/ping.ts`. Protocol verified in the 14.370 client bundle: `socket.volatile.emit("userActivity", userId, {cursor, ping: {scene, pull, style, zoom}})`; valid styles are pulse/alert/chevron/arrow, and the GM PULL ping is style "chevron" with `pull: true` (the library maps `style: "pull"` to that). Demo live: one pulse ping at 400,400 on the active scene (Floor 1 at the time) + one cursor-only move to 500,500 — both emitted cleanly. Caveat: volatile emit has no server ack, so the result means "emitted on a live socket", not "seen by a client". No chat spam from any of the three demos.
- [~] Loot pipeline — generate treasure, put it in a chest token, hand it to the right character sheet on open
  - Built offline Nov 20 — [~] means built + unit-tested, NOT live-tested (the backlog rule: [x] only after a live test against TestBed). `src/session/loot.ts` (pure `generateLoot` / `splitCoins` / `lootValueGp` / `formatLoot` — seeded deterministic RNG, house treasure table clearly labeled NOT the PF2e rulebook table; live `fillChest` / `generateAndFillChest` / `openChest` over `modifyDocument`, same chest route as `addChest`) + `src/cli/loot.ts` (`--generate` needs no connection) + `tests/loot.test.ts` (13 checks). Coins go in as one "Coins" treasure item — a PF2e loot actor has no coin purse; the GM converts them on handover. **Still needs live testing:** a real `--fill` + `--open` against TestBed.
- [~] Value-budgeted treasure (FR-14) — "I want 500 gp worth of treasure, and make it interesting"
  - Built offline Nov 20 — [~], live test pending. `src/session/treasure.ts` (pure `generateTreasure` / `treasureValueGp` / `formatTreasure` — seeded deterministic RNG, reuses loot's `rngFromSeed` + `splitCoins`) + `src/cli/treasure.ts` (`--budget <gp> --level <n> [--seed] [--theme]` needs no connection) + `tests/treasure.test.ts` (17 checks). Budget fitting: 1–2 signature items (20–35% of budget each, capped 45%, topped up instead of dumping into coins when the pool is thin) + greedy unique-item selection + stack growth on gems/consumables + coins as the small remainder, so the total lands exactly on the budget; pool is the union of all level bands at or below the level (a small budget at a high level still has cheap items to spend on — caught by a failing test, fixed). Every item gets a unique story line (owner/place/quirk, themed: dungeon/gothic/underwater/crypt); signature items have a named homebrew ability (labeled homebrew in data + text) and the artwork hook (`art: null` + `artPrompt` per signature item — one square image each, filled in later by the art generator; artwork never blocks the drop). House table, clearly labeled NOT the PF2e rulebook table. **Live layer + art step built offline Nov 20 (BRA-200) — [~], live test pending.** `treasureToItemDocs` (pure: Coins item first, then every item; weapon→weapon, armor→armor, consumable→consumable, equipment→equipment, gem/art→treasure, signature→treasure — unique named homebrew items, not rulebook weapons, the GM re-types one in Foundry if they want it equipped; every doc's description carries the provenance story, signature docs add the ability labeled (homebrew); `img` set only when the item's `art` is an http(s) URL — a local path is never pointed at from a live item) + `fillTreasureChest` / `generateAndFillTreasureChest` (same chest route as loot.ts `fillChest`; failure is never silent — a thrown create lists every item in `failed` with the error, a partial create lists the uncreated tail with the counts; empty chest id / empty hoard reported as failures with reasons) + new `src/session/treasure-art.ts` (`planTreasureArt` — one entry per signature item: ready with prompt + deterministic path `treasure-art-<slug>.png`, has-art, or skipped-no-prompt, no prompt ever invented; `applyTreasureArt` — wires the file path into `art` when the expected file exists, updates both `hoard.items` and `hoard.signatureItems`, input hoard not mutated; generation itself runs through the agent media step, same path as the vision-doc illustrations — this module is the wiring, it does not pretend to generate images) + CLI `--fill` (live) and `--art` (offline) modes + `tests/treasure.test.ts` (39 checks). **Still needs live testing:** `--fill --chest <loot-actor-id> --budget 500 --level 3` against TestBed (hoard lands, `placement.failed` empty, `placedValueGp` equals the budget); open the chest as a player (story in the description, signature ability labeled homebrew); open onto a character sheet via `loot.ts openChest`; `--fill` against a bad chest id (every item named with the reason); art end to end (media step generates from the plan's prompt, save to `treasure-art/`, re-run `--art`, upload to Foundry, confirm the item shows it).
- [~] Turn reminders — whisper the player whose turn starts with what they can do and what conditions they have
  - Built offline Nov 20 — [~], live test pending. `src/session/reminders.ts` (pure `buildTurnReminder` / `formatConditions` / `hpStatus` — generic PF2e 3-action hint, NOT tailored to the character's feats/spells; downed combatants get a "you're down" line, not actions) + `src/cli/remind.ts` (`--demo` needs no connection). Live `remindTurn` whispers to the current combatant's owning player (non-GM OWNER from actor ownership; public post when no owner is found) — needs a new `CombatAutopilot.listConditions()` accessor (added, read-only). **Still needs live testing:** a real `--combat` against TestBed.
- [~] Session recaps — read the chat log after a game, write the recap into a journal entry
  - Built offline Nov 20 — [~], live test pending. `src/session/recap.ts` (pure `buildRecap` / `recapToText` / `recapToJournalHtml`). HONESTY RULE: the recap only reports what the log contains — kills/loot/combat/rolls/rooms are pattern-matched from Meroki's announcement lines with the source message cited; player chatter is never turned into facts; a quiet log says "nothing notable". Live `postRecap` reads the log, creates the journal entry via `createJournalEntry`, and posts the summary to chat. `src/cli/recap.ts` (`--from-json` needs no connection) + `tests/recap.test.ts` (12 checks, fixture log modeled on the Nov 19 session). **Still needs live testing:** a real `--post` against TestBed.
- [~] Player Q&A — answer AC, inventory, spells left, etc. straight from actor data
  - Built offline Nov 20 — [~], live test pending. `src/session/qa.ts` (pure `parseQuestion` / `answerQuestion` / `readAc` / `readHp` / `readInventory` / `readSpellsLeft` / `findItem`). HONESTY RULE: every value comes from the actor record; a missing field answers "can't find X on the sheet" — nothing is invented. Defensive readers over the raw PF2e record (several known paths; handles both spell-slot shapes — `value/max` and `prepared` lists — and PF2e's 3-letter ability keys). `src/cli/qa.ts` (`--fixture` needs no connection; `--actor` resolves by id or name) + `tests/qa.test.ts` (12 checks). **Still needs live testing:** a real `--actor` question against a TestBed PC.
  - P2 test totals (verified Nov 20): `bun test tests/` 87 pass / 0 fail — 46 new P2 checks (loot 12, reminders 8, recap 12, qa 14) + 16 dice + 25 tiles (the tile file grew since the earlier 18 — a concurrent worker added checks); `bun run typecheck` clean.
- [~] BRA-230 — FR-10 speed-budget instrumentation. `src/session/perf.ts` (LatencyLog on an injectable clock; SPEED_BUDGETS with a cited source per budget; p50/p95 session report) + `src/session/monitor.ts` (detect per message from msg.timestamp; one action record per handled message — roll/question/room-build/whisper-first-effect; per-step cutscene durations via onLatency; one latency line per action, one latency-over-budget warning per over-budget stage; MonitorSummary.latency). Unit-tested (26 checks in `tests/perf.test.ts`).
  Live test (needs Dave's Foundry up): run a real session with the monitor on; confirm latency lines per action and the shutdown report; time a real room build and a whispered mice-ogre first effect against the budgets (ambush <30s, room build <2min, whisper → first effect 1–2min); set roll/question budgets from the observed p50/p95 and cite the session.
- [~] Rapid custom encounter generation (FR-11) — story-aware NPCs in under a minute from one sentence
  - Built offline Nov 20 — [~], live test pending. `src/session/encounter-gen.ts` (pure generation + thin live wrappers) + `src/cli/encounter-gen.ts` (`--demo` / `--generate` need no connection) + `tests/encounter-gen.test.ts` (26 checks; 30 after the BRA-201 merge). Muse authors a compact spec (names, roles, one-liners, formation); code expands it: role templates scaled to party level (house stats), gear/spells filtered by role AND theme (death-theme mage spells all from the death list), backstories built ONLY from the spec one-liner + verbatim story-context facts/people (no invented plot; empty context → explicitly generic), tokens placed by ring/line/wedge formation helpers (shared `src/session/formations.ts` since the BRA-201 merge, Nov 20 — locals deleted, demo output byte-identical, sha256 6cbf4b14…). **Two rules (Brandon, Nov 19):** (1) every NPC gets a LIVING KIT — rations, waterskin, bedroll, rope, torches, whetstone + one personal item (letter from home, etc.), price 0 (characterization, not loot); (2) every NPC gets ONE UNIQUE SIGNATURE ITEM that drops on death — named + one-line story, unique within the encounter (pool without replacement + fallback composer; Muse-authored signatures used verbatim, duplicates rejected). Live: `createCustomActors` (Actor create, then Item creates with `parentUuid: Actor.<id>`) + `createCustomEncounter` (P1 builder for tokens + combat, then glide to formation). Actor doc is a minimal house-shaped PF2e NPC using only field paths qa.ts already reads; perception is written at BOTH `attributes.perception.value` and `perception.mod` because this codebase reads both — resolve live. Backstory lives in `flags.musegm` (no biography field path verified yet — live-test item). **Still needs live testing:** a real `--build` against TestBed (actors render on sheets, tokens in formation, combat starts, signature items on the sheets).
- [~] High-level floor generation (FR-15) — the vague-brief mode: brief + chronicle → floor plan → convergence-loop preview → locked plan + build manifest
  - Built offline Nov 20 — [~], live wiring pending. `src/session/floor-plan.ts` (pure `planFloor` / `renderFloorPreview` / `validateFloorPlan` / `lockFloorPlan`) + `src/cli/floor-plan.ts` (`--demo` needs no connection; `--validate-only --file <plan.json>`) + `tests/floor-plan.test.ts` (34 checks). The planner takes a vague brief (theme, party level, puzzle kind/count, riddle on/off, minor encounters, ambush on/off, boss, intrigue count, storyline threads) + the campaign chronicle (party members, key NPCs, past events, open threads, notable deaths — plain data, passed in) and authors a floor plan: entry → plate rooms → riddle room → boss room, minor encounters branching off the chain. The pressure-plate puzzle gives each plate a distinct effect (gate opens, water drains, clue revealed quoting a chronicle fact, braziers light…) and all plates together unlock the boss door; the riddle's slots are filled from chronicle facts and its answer is always a chronicle name the party already knows (throws if the chronicle has no name to answer with). The ambush is flagged as a cutscene with a real cutscene script (place steps on a ring, validated by the cutscene engine's own `validateCutscene`); the boss is the brief's boss at party level + 2. HONESTY RULE: every element carries a `source` (brief item or chronicle entry) and validation fails any element without one; validation also proves reachability (BFS from the entry) and that the boss is unreachable when the boss-door link is removed — a shortcut link into the boss room fails validation. Deterministic for a given seed (same seed → byte-identical plan). The preview is an ASCII layout sketch + one paragraph per beat — the convergence loop: show it, erase things, show alternatives, lock only when the ideas converge. `lockFloorPlan` returns the locked plan + the ordered build manifest (uploadTilePack → buildDungeon → trap wiring per plate → riddle reveal via send → encounter-gen per encounter / cutscene for the ambush → treasure for the boss room → journal GM notes for intrigue + storyline). The manifest is DATA, not execution. **Still needs live work:** the live wiring from a locked plan to the builders (execute the manifest against TestBed) + a real convergence loop in chat (show the preview, take the creator's reactions, re-plan); then a full floor built live and walked end to end. Nov 20: the chronicle store (BRA-232) now exists — `toFloorPlannerChronicle` derives the planner's chronicle shape from the store, planner unchanged. Spec: `docs/realtime-adventure-construction.md` FR-15.
- [~] Campaign chronicle store (BRA-232) — persistent memory the generators read, so the world feels continuous
  - Built offline Nov 20 — [~], live test pending. `src/session/chronicle.ts` (append-only store, source required on every entry — same honesty rule as the quest log; kinds session/decision/npc/debt/betrayal/thread/death/loot/quest/resolution; resolution derived, not stored — `resolveThread` appends a resolution entry, re-resolving is a no-op; `toFloorPlannerChronicle` adapter — planner unchanged; `chronicleFacts` bridge for encounter-gen; `renderRecap`; `recapToChronicleEntries`) + `src/cli/chronicle.ts` (offline file-based: `--demo`/`--list`/`--add`/`--recap`/`--resolve`/`--to-floor-plan`/`--import-recap`) + `tests/chronicle.test.ts` (25 checks). Live: JournalEntry "Campaign Chronicle" (`observer`), one page per entry, entry JSON in page flags, index page with open threads/debts/deaths/names. **Still needs live testing:** append a thread + a death live (entry appears, observer, index lists them); read back returns entries in append order from page flags (page-order assumption); `importRecapLive` a real recap; `resolveThreadLive` removes the thread from the index; feed the live store to `planFloor` — the riddle answer is a chronicle name with no hand-passed data; watch entry size over a long session (one page per entry). Follow-up: encounter-gen has no chronicle input yet — wire `chronicleFacts` into its story context. Spec: `docs/realtime-adventure-construction.md` FR-11/FR-15.
- [~] BRA-233 — mode switching: one session, three modes, switch mid-build. Built offline Nov 20 — `src/session/modes.ts` (SessionMode hands-on/co-design/improvise; parseModeSwitch — the issue's phrasings + variants; parseBriefRequest — floor-brief detection; modeSwitchLine; save/loadModeState, `$FOUNDRY_MODE_STATE` or `.mode-state.json`) + `src/session/monitor.ts` (mode carried in the loop, GM-only switch in one chat message, log line + chat confirmation, persisted; briefs in co-design log as a `brief` event; MonitorSummary.mode/modeSwitches) + `src/cli/monitor.ts` (`--mode`, validated) + `tests/modes.test.ts` (26 checks). Builds execute in every mode — the mode is not a lockout; improvise changes no routing today (whispers were already first), documented in modes.ts.
  Live test (needs Dave's Foundry up):
  1. Start the monitor, say "take the brief from here" in chat — confirmation line posts, mode-switched log line, mode persists after a monitor restart.
  2. In co-design mode, send the FR-15 floor brief — a `brief` log event, no "can't do that yet", nothing built.
  3. In co-design mode, "add a door on the north wall" — the door still builds (one confirmation line).
  4. A player says "let's go hands-on" — nothing switches, no confirmation.
  5. Dave whispers "let's improvise" — the confirmation comes back as a whisper.
  6. Build a room hands-on, switch to co-design, widen it by name — the build continues, no duplicate scenes.
- [~] Interactive dressing (FR-16) — the map you can touch: torches, candles, braziers, each clickable to light/put out
  - Built offline Nov 20 — [~], live test pending. `src/session/dressing.ts` (pure `planDressing` / `toggleDressing` / `validateDressingPlan` / `dressingToRoomSpec` / `formatDressingPlan` + the composer hook: `applyDressingToSpec` / `layoutRoomWithDressing` / `resolveDressingPairing`) + `src/cli/dressing.ts` (`--demo` / `--spec` need no connection) + `tests/dressing.test.ts` (30 checks) + `tests/dressing-hook.test.ts` (12 checks) + `docs/interactive-dressing.md` (as-built wiring note). Torches every 3 cells along the walls (door cells and corners skipped), candles on tables (floor cells next to a wall when no tables — placement recorded), braziers in the corners of large (8x8+) rooms; deterministic per seed; never two items on a cell, never on a maze wall cell. Lights follow the torch language (torch #ff9a3c dim 300/bright 120 alpha 0.4; candle 120/60; brazier 400/200). Toggle is stateful (off = hidden + alpha 0; on = shown + the item's own alpha) with one chat line per kind + state ("The torch sputters to life." / "The torch gutters out."). **Build half done Nov 20 (BRA-192):** click wiring decided — Route A, passive handler, GM executes over a socket (players can't update lights, so a player's click goes over `module.meroki-dressing` to the designated GM's client — active GM with the lowest user id, exactly one executes; no GM connected → warning, not a silent no-op; the clicker being the GM runs directly; state comes from the light doc's `hidden`, not a flag, so a click after a cutscene dim reads the real state) — new `modules/meroki-dressing/` (module.json v0.1.0, Foundry 14 verified 14.370, `node --check` clean); candle + brazier tiles now real in the pack (48 tiles, 0 gaps, old 46 PNGs byte-identical — candle: brass holder, pale flame; brazier: iron tripod bowl, three fire tongues, both viewed at 100px); alpha gap closed — `LightSpec` grows an `alpha` field (`lightCreateData` honours it, default 0.5, `dressingId` stripped before sending to Foundry); the hook merges lights only (merging torch cells into `spec.torches` too would give every torch two lights — caught while building). **Live half done Nov 20 (lead):** new `buildDressedTileRoom` in `src/worldbuilding/tiles.ts` (plan + merge + lay out, build the dressed spec, pair by dressing id, write each pair's full flag record `flags.meroki = {dressingId, lightId, kind, alpha}` onto its tile — flag updates merge per scope, so the keyed build's `foundry-live` embed key survives; a pairing failure throws before the flag write, never a silently unclickable room; a separate function on purpose, so plain `buildTileRoom` — its fingerprints, keyed memo/converge, and existing callers — stays exactly as it was) + 3 tests in `tests/tile-keys.test.ts` (fake live, incl. a Tile-update branch that merges flags per scope; keyed re-run keeps one scene, same ids, flags complete). Full suite 1163/0 across 45 files, typecheck clean. **Still needs live testing:** build a room with `buildDressedTileRoom`, click a torch (light flips + chat line posts), put it out (stays out until relit), cutscene dims the room's torches then the mage's bloom brings it back; verify a player click reaches the GM client, and confirm `flags.meroki` survives the Tile round-trip. **Follow-ups (not built):** the build loop's add-dressing word map doesn't know "candle"/"brazier" yet; the theme torch palette still has no alpha, so plain `spec.torches` lights keep the 0.5 default while dressing torches get 0.4; a left-drag pan starting on a torch tile will toggle it (documented rough edge, `pointerup` fix noted in the design note). **Monitor build path closed Nov 20 (lead — the routing builder's "blocked" was a scope boundary, not a real block):** the BACKLOG note that said "(monitor.ts — …)" was wrong — the call site is the build executor, not the monitor. New `rebuildDressedTileRoom` in `src/worldbuilding/tiles.ts` (dressed spec through `rebuildTileRoom`, then the same pairing + flag write as the build path; the plan is deterministic per seed so a rebuild re-plans the same items plus any props the spec recorded since — nothing duplicates, because the rebuild deletes the old tiles first; a pairing failure throws before the flag write, same as the build path) + `syncSession` in `src/session/build-exec.ts` now routes ALL builds through `buildDressedTileRoom` and ALL rebuilds through `rebuildDressedTileRoom` — a plain rebuild would silently drop every click flag, which is why the executor routes both through the dressed variants. A pairing failure throws and the executor reports it as a chat line ("I couldn't build that — …"); there is no silent undressed fallback. The room is left built-but-unclickable in that case (a mid-sync failure — session ahead of the table, recover with undo + re-issue, the known limitation shape). 3 new tests in `tests/tile-keys.test.ts` (dressed rebuild re-pairs 14/14 with flags on the new tiles; widen re-plans and pairs; keyed dressed rebuild + later dressed build re-run converges) + the existing executeBuild crash-retry test now also asserts the built room carries meroki flags with real lights. Full suite 1284/0 across 48 files, typecheck clean. Spec: `docs/realtime-adventure-construction.md` FR-16.
- [~] Quest log (BRA-203) — running journal that ticks objectives off when the thing actually happens in game
  - Built offline Nov 20 — [~], live test pending. `src/session/questlog.ts` (pure: add/complete/fail/objectives/notes/summary, immutable; HONESTY RULE — every note requires a `source`, the summary reports only what the log contains; live: "Quest Log" journal entry, `observer` so the party can read it, one JournalEntryPage per quest with the full quest JSON in page flags — flags are the source of truth, HTML is display only; index page) + `src/cli/questlog.ts` (`--demo`, `--list`, `--show`, `--add`, `--objective`, `--note`, `--complete`, `--fail`) + `tests/questlog.test.ts` (29 checks). Completing an already-completed quest (or failing an already-failed one) is a no-op with no second chat line; completing a failed quest is an error. **Still needs live testing:** `--add` creates the entry + index + quest page visible to players; flags round-trip on 14.370 (riskiest assumption — `JournalEntryPage` create carrying `flags` through `modifyDocument` and surviving in the `getJournals()` cache; fallback is identifying pages by title); objective/complete/fail flows post exactly one chat line and repeat as no-ops; `--note` without `--source` fails; mcp-api can read/write the entry.
- [~] Downtime (BRA-204) — shopping, crafting, healing handled in chat
  - Built offline Nov 20 — [~], live test pending. `src/session/downtime.ts` (pure immutable ops — start/confirm/advance/complete/cancel, `source` required on every activity and every state change; lifecycle proposed → in-progress → ready → complete, plus cancelled; crafting/training/research track `progressDays` that accumulates across sessions and never resets; `spentGp` counts confirmed activities only — proposed costs nothing, cancelled costs nothing; healing is proposed from the rest rules as data and never applied — `REST_RULES` carries the PF2e rest text, the GM confirms and states the outcome in their own words, and completing a still-proposed activity throws; live: "Downtime Ledger" journal entry, `observer`, one page per character with that character's activities JSON in page flags — flags are the source of truth, HTML is display only; index page) + `src/cli/downtime.ts` (`--demo/--list/--show/--start/--heal/--confirm/--advance/--complete/--cancel`) + `tests/downtime.test.ts` (34 checks). Lead fix: completing an activity used to overwrite its `source` with the completion source, losing who asked for it — completion source is now recorded separately as `completedSource` (with a test). Deliberately NOT automated: no prices or item stats (costs are recorded as stated in chat), no Foundry actor/HP writes (the live layer only writes the journal), no calendar enforcement (days are counted, not dated — the GM decides how many downtime days the party has). **Still needs live testing:** `--list` on a fresh world (empty ledger, no crash); `--start` a shopping activity (journal created, page appears, chat line posts, activity proposed, `spentGp` still 0); `--confirm` flips status and gold starts counting, confirming again errors; `--complete` on a still-proposed healing activity errors (the GM gate), then `--heal --rest rest8h` → confirm → complete with the GM's stated rest result; crafting across two sessions (`--advance` 1 day, disconnect/reconnect, `--advance` again — progress adds up, page flags round-trip it; final advance → `ready` + "ready next session" chat line); fresh-connection read-back reproduces the ledger from flags, including partial progress; proposed and cancelled activities never appear in the cost section of `--list` output.
- [~] Real rule lookup (BRA-205) — `lookup_rule` in the MCP is a stub; build a real one from compendium + journal search
  - Built offline Nov 20 — [~], live test pending. `src/session/rules.ts` (pure `lookupInCorpus` + thin live `lookupRuleLive`; tokenize → pack-index candidates via compendium.ts's own `getWorldPacks`/`searchPackIndex` + journal-page search → `scorePassage` (title +10/term, all-terms-in-title +15, body +2, exact phrase +8) → snippet ≤320 chars; found threshold 12, up to 3 citations; prose comes only from `system.description.value` or journal-page content, never stat blocks or rule-element JSON; honesty in code — an unread entry (full text never read) can only ever be a closest match, never a found answer, and a failed live doc read is recorded as unread with its error, never retried silently or guessed at; no match returns "Not found in the installed books" plus the closest matches by name) + `src/cli/rules.ts` (`--demo` offline fixture corpus, `--demo "<question>"`, `--ask "<question>"` live) + `tests/rules.test.ts` (32 checks). Demo answers flat-footed correctly (-2 circumstance penalty to AC, cited). **Still needs live testing:** `--ask "What does flat-footed do?"` against TestBed (found answer citing a real pack); a journal-grounded question (house rule citation); something absent from the books (plain "Not found", not a fabricated ruling); a failed full-doc read degrades to flagged unread hits — that exercises the unconfirmed `modifyDocument "get"` action on 14.370, the riskiest assumption. **Monitor routing built offline Nov 20 (monitor routing round-up):** `parseRulesQuestion` (whisper-only): question shape (question word or "?") AND a rules term (conditions, named actions, core nouns — deliberately distinctive; bare "check"/"save" excluded so ordinary sentences aren't stolen). Checked in the loop's fall-through, **after every other branch** — roll/question/light/clock/build keep priority (tested: "what's Valeros's armor class?" goes to the data branch, not the books). Handler calls `lookupRuleLive`, posts `answer.answer` with its Source lines, records latency under the unbudgeted `"question"` kind, counts `rulesHandled`. Not-found posts "Not found in the installed books" + closest matches, never a ruling. Lookup failure whispers "I couldn't look that up right now" + an error log. **Still needs live testing:** Dave whispers "what does flat-footed do?" → answer with the −2 AC penalty and a Source line; whispers a question the books don't answer → "Not found in the installed books", no fabricated ruling. **Follow-up (not built):** rules is whisper-only by design; public-chat rules questions stay needs-agent (possible extension, not built).
- [~] Living village (BRA-227) — animated NPC daily life: rounds, ambient behavior, NPC memory (vision doc, Act Five)
  - Design + pure core built offline Nov 20 — [~], live test pending. `docs/living-village.md` (the design, with its hard questions answered) + `src/session/village.ts` (pure immutable ops: `createVillage` / `addVillager` / `addBackgroundEvent` / `positionAtHour` / `positionsAtHour` / `eventStageAt` / `advanceVillageToHour` / `engageVillager` / `disengageVillager` / `remember` / `adjustRelationship` / `respondTo` / `bandFor` / `renderVillage` / `serializeVillage` / `parseVillage`) + `tests/village.test.ts` (40 checks, fixture villagers Mara the baker + Old Fen the miller — backstories written in the test file, labeled fixtures, not campaign canon). The one decision everything follows: **position and event stage are pure functions of in-game time, not simulated state** — a week unobserved is one function call, identical whether watched or not. Tick = in-game hour (not combat round); the monitor watches the tick (not a cron — the village only changes when game time passes, and game time only passes while the table plays; the hour comes from a world calendar module or the GM stating the time, otherwise the village stands still). Engagement: a second PC joins the same conversation (participants set), responses computed per addressing PC; return when the last participant leaves or the hour hits `sinceHour + maxHours` (default 1), resuming at the schedule position for the current hour (the live layer glides the token there — stated as a deliberate simplification). `respondTo` returns grounded context, never prose: stored backstory verbatim + relevant memories verbatim + disposition (relationship + memory sentiment capped ±3 + charisma mod, clamped -5..+5) + band (hostile/wary/neutral/warm/friendly) — Muse drafts the words from that context only. Honesty in code: every memory needs a `source`, every relationship change a `reason` + `source`, backstory required and never generated, memory and backstory never merged into one "truth", history append-only. **Still needs live testing:** build a village scene with two villagers and advance the clock (tokens glide to schedule positions); engage in chat (token stops, reply grounded in the stored backstory); second PC joins, first leaves (stays engaged until the last leaves); record a memory and re-engage later (warmer reaction, cites the memory); advance past a background event's stage hour while the party is elsewhere (transition reported, GM chooses to announce or keep silent); advance a full in-game week at once (positions + event stage land exactly, no drift); JournalEntry "Village" round-trips. **Follow-ups (not built):** the live layer itself (token movement + chat routing + JournalEntry persistence — the seam is spelled out in the design doc); no reset op (a GM rewind of the game clock needs a new store or an explicit reset); no memory/relationship decay (forgetting is a deliberate act, needs a GM-chosen rule, not a silent default); no departure handling (`departed` flag + schedule suppression, not a deletion); no CLI yet (no `src/cli/village.ts` — a `--demo`/`--advance` CLI is a follow-up).
- [x] Compendium import — **research done + code built offline Nov 20, live
  test pending.** The MCP's `searchCompendium` was never broken, it was
  REST-gated (returns empty without the removed REST module). The working
  path is the plain socket: pack indexes are already in the `world`
  payload (`worldData.packs[].index` — the monitor's live count: 29 lich /
  666 dragon / 0 dracolich), and full documents come from
  `modifyDocument("Actor", "get", { query: { _id }, pack })` — verified in
  an independent implementation (Pelmog/foundry-mcp, v13-tested) and in the
  v13/v14 type definitions, NOT yet run on 14.370. See
  [docs/compendium-import.md](./docs/compendium-import.md).
  `src/session/compendium.ts` (`searchPackIndex`, `getPackDocument`,
  `importPackActor`, `mapCompendiumActorToWorld`, `applyDracolichPatch`,
  `DRACOLICH_DRAFT`) + `src/cli/compendium.ts` + `tests/compendium.test.ts`
  (18 tests green, typecheck clean). **Live checklist next session:**
  `--get` one pack doc, `--import` a Lich, verify the world Actor + items
  land, verify a `query: {_id}` miss falls back to `{_id__in: [...]}`, and
  confirm the mcp-api user can read the pack (permissions).

## Done

- [x] MIT MCP login 400 fixed (Origin header) — patched copy in `~/workspace/foundry-mcp-patched/`
- [x] Chat send proven live — ChatMessage create with `author`, message `sIyn3aBcT7CeiifP` in the log
- [x] MCP tool inventory (33 tools, no send-chat tool) — read live Nov 19

## Open issues from the Nov 19 session (monitor sign-off ~21:03)

Session closed for the night by Dave. State: Merisiel died (Xulgath 11 HP,
Zolgran 25 HP); Valeros placed in the Entry Hall with initiative 7, new
combat `1hlTZdDIHFGIXu93` round 1.

- [ ] **Dracolich — needs Dave's pick next session.** No Dracolich exists
  in the installed compendiums (searched all 101 pack indexes: 29 lich,
  666 dragon, zero dracolich). Recommended: import the Lich (import path
  now built — see Compendium import above + `docs/compendium-import.md`)
  and apply the draconic patch; fallback is the homebrew `DRACOLICH_DRAFT`
  (`--dracolich`). **Level warning:** party is level 1–2, a level 12
  Dracolich is a story device / future boss, not a fight — Dave's call.
- [ ] **Token-sync — top open issue.** MCP-originated token moves don't
  show live in browsers (reload only). Investigate what event the client
  expects that the MCP's update doesn't produce.
- [x] **Map image size.** The Entry Hall image is 3.9 MB and may be behind
  Dave's scene-switch "resources finish loading" hang. Compress map
  images on upload (resize/quality pass in `uploadImage`).
  - Built offline Nov 20 (no live test yet): `src/worldbuilding/compress_image.py`
    (PIL) + `maybeCompressImage` in `upload.ts`. Opaque images over 1 MB /
    1600 px are resized to 1600 px and saved as JPEG q82 (Entry Hall:
    3,919,796 B PNG → 448,347 B JPEG, same 1600×1600, verified offline);
    images with real alpha stay PNG (resize + optimize); small images pass
    through untouched. The pass never fails the upload — on any error
    (no python3/PIL, corrupt file) the original goes up as-is.
    `UploadResult.compressed` reports the savings. **Still needs live
    testing:** an actual upload to TestBed confirming the `.jpg` path
    lands and the scene renders from it.
- [x] **Scene create quirk.** `createSceneFromImage`'s create silently
  drops `background.src` (and `navigation` — stored `false` despite being
  sent). The background only stuck via a follow-up update. With the Level
  fix, the Level now carries the background — verify the create path sets
  everything the scene needs, or set it via update after create.
  - Fixed in code Nov 20: the post-Level update in `createSceneFromImage`
    now sets `navigation: true` alongside `initialLevel` (one update call).
    Scene-level `background` is deliberately NOT set — that update is
    accepted with no error and does nothing in v14; the Level carries the
    map. **Still needs live verification:** create a scene next session
    and read `navigation` back on a fresh connection.
- [x] **Fold in the probe lessons.** `/tmp/post-roll.mjs` (visible-roll
  helper) and the probe scripts' lessons (HP via raw `modifyDocument`,
  Token updates need `parentUuid`) belong in the library, not in /tmp.
  - Done Nov 20: `/tmp/post-roll.mjs` was **lost** (gone with /tmp) —
    reconstructed as `postVisibleRoll` in `src/session/dice.ts`, not
    claimed as found. The other two lessons were already in the library:
    HP updates go through the vendor client's `updateActorAttribute`,
    which IS `modifyDocument('Actor', 'update', …)` (`autopilot.ts`
    damage/heal use it), and every Token create/update/delete in
    `src/session/movement.ts` already passes `parentUuid: Scene.<id>`.
    The surviving /tmp probes (dump-scene, post-restart, fix-level, …)
    are one-off diagnostics with hardcoded paths — ephemeral, not library
    code; their durable lessons (Level fix, ownership, darkness, lights)
    are already in the library or BACKLOG.
