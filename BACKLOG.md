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
  - **FR-13 note:** the overlay half is built; real wet-variant tiles
    (floor-wet) are a later pack addition — the variant set today is the
    existing floor tiles (e.g. plain -> dark reads as waterlogged). The
    scripted trap-door swap half of FR-13 is the cutscene builder's job
    (a `swapTile` step in the timeline player), not this one.
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
  - Built offline Nov 20 — [~], live test pending. `src/worldbuilding/tiles-layout.ts` (`listPropTiles` — the 9 dressing-layer tiles, sorted; `listProps` / `placeProp` / `moveProp` / `removeProp` — pure, immutable spec ops, stable `prop-N` ids never reused, targets by id / synthesized id / bare tile name when unique / `{tile, gx, gy}`, ambiguous or missing targets throw naming what the room has; `validateRoomSpec` now exported as the single source of truth — rejects unknown dressing tiles, non-dressing tiles on the dressing layer, duplicate prop ids) + `src/worldbuilding/tile-keys.ts` (converge now matches tiles by position + look — sort, elevation, x, y, texture src, rotation — never by flat layout index; fixes the widen ghost-prop bug where a crash-retry after a widen left a bones tile on a wall cell; walls/lights still index-matched, documented follow-up) + `src/worldbuilding/tiles.ts` (converge passes layout tile descriptors) + `tests/props.test.ts` (27 checks) + `tests/tile-keys.test.ts` (26 checks, incl. the widen ghost-prop regression and re-skin tests). Re-skin keeps or swaps props via the existing theme dressing remap (proven by test). Acceptance 4 is partial: place works through chat today (pre-existing add-dressing op); move/remove chat ops and cutscene-prop recording are follow-ups.
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
  - Built offline Nov 20 — [~], live test pending. `src/session/cutscene.ts` (versioned script schema, strict validation — every error listed, never a silent skip; formation expansion; `playCutscene` via runSequence) + `src/session/formations.ts` (ring/line/wedge + facing angles, pure) + `src/session/lights.ts` (timed light transitions — dim/bright/color lerp, `animateLight`) + `src/session/tile-ops.ts` (FR-13 `swapTile`: texture swap in place by Tile _id or by cell when the cache carries tiles) + `src/cli/cutscene.ts` (`--file`, `--validate-only` needs no connection) + `examples/ambush.json` (the ambush: 9 soldiers glide in, spears, mage, center light blooms — validates, expands to 51 steps) + `tests/cutscene.test.ts` (22 checks). Spear prop tile added to the pack procedurally (pack now 19 tiles, 0 gaps). **Still needs live testing:** play the ambush against TestBed (Soldier/Mage actors must exist; spear tile uploaded to `worlds/testbed/`); verify the token-rotation convention (0 = north, clockwise), the dot-notation light/tile updates (`config.dim`, `texture.src`), the light-bloom timing, and a `swapTile` by _id (cell addressing needs a tile cache the client may not carry — the _id path is the reliable one). Spec: `docs/realtime-adventure-construction.md` FR-5 + FR-13.
  - [~] BRA-231 — stage-then-fire gate. Built offline Nov 20 — `src/session/staging.ts` (`stageCutscene` validates the whole script + resolves every reference against a world snapshot, returning every error in step order; beat store — stage/fire/drop/edit/list, serialize/parse, deterministic `staged-<slug>-<hash8>` ids; `snapshotWorld` + `playStagedCutscene`, which hash-checks the beat before playing and refuses a script edited after staging) + `src/cli/cutscene.ts` (`--stage` / `--fire` / `--snapshot-world` / `--help`) + `tests/staging.test.ts` (20 checks, incl. mice-ogre staging against a fixture world — 38 expanded steps, 0 warnings). A staging failure leaves the table untouched; staging is a pre-flight check, not a lock — the world can change between stage and fire.
  Live test (needs Dave's Foundry up): `--snapshot-world` against TestBed, `--stage` mice-ogre — clean stage; `--fire` on the GM's nod — nothing visible to the table until fired, then plays fully; fire/edit/drop each in one message; stage a script with a bad reference — error names the real missing thing, nothing posted.
- [~] Theme re-skin (FR-2, BRA-194) — one word ("western") rebuilds the same room spec with a different look
  - Built offline Nov 20 — [~], live test pending. `src/worldbuilding/themes.ts` (ThemeSpec: floor/wall tile names, atmosphere + dressing remaps, torch palette, Level background colour; DUNGEON_THEME = the pre-theme look made explicit, proven identical by test; WESTERN_THEME = sandstone floors, wood-plank walls, dust instead of fog, lantern-gold torch #ffb347 dim 280/bright 110, background #0d0a07; `resolveTheme` case-insensitive, unknown names throw listing known themes; `themeTileGaps` fails loudly naming theme + tile, never fakes one) + `src/worldbuilding/tiles-layout.ts` (`RoomSpec.theme`, `layoutRoom`/`layoutDungeon` theme param, default dungeon) + `src/worldbuilding/tiles.ts` (`buildTileRoom`/`rebuildTileRoom`/`buildDungeon` theme param; Level background from theme) + `tiles/procedural/generate_tiles.py` (WESTERN_PACK, 10 tiles) + `tests/themes.test.ts` (20 checks). Pack now 29 tiles, 0 gaps; old 19 PNGs byte-identical; western preview verified visually. **Still needs live testing:** `uploadTilePack` lands the 10 new western tiles (GET byte-identical for floor-sand, wall-wood-door, dust-wisp-large); build an 8×6 western room on TestBed (scene loads, sandstone + wood ring + door visible on a fresh connection); re-skin live (same room built dungeon, then `rebuildTileRoom` with theme "western" — same scene/walls/doors, new look); fog remap live (western room with fog "fog-wisp-large" shows dust, not green fog; toggles via `hidden`); torch palette live (western torch reads lantern gold vs dungeon amber); Level background (western scene's Level is warm dark brown #0d0a07); `buildDungeon` with theme "western" (all rooms western, links resolve, `walkThroughDoor` works). Follow-ups (not gaps): western dressing tiles (cactus/wagon/barrel), sci-fi/dragon/Care Bears themes (one ThemeSpec + generator variant each), build-loop "make it western" chat op, floor-plan theme param. Spec: `docs/realtime-adventure-construction.md` FR-2.
- [~] Emergent sequences (FR-18) — the GM whispers an idea mid-session and a whole sequence plays out, unplanned
  - Built offline Nov 20 — [~], live test pending. New cutscene steps, all validated the same strict way (every error listed, never a silent skip): `waitRound` (round clock — the sequence advances on combat rounds, polls combat state every 2s, relative or absolute, 30-min default timeout; already-past rounds return at once), `rush` (pure expansion: one token per actor, placed at the door, gliding through each waypoint in order to the far door, staggered; a bite after each `through` waypoint is one visible roll in chat — the roll IS the damage roll, targets round-robin from the author's ordered list; applying the rolled damage to HP is the GM's call, the runner has no variable passing so a rolled amount cannot feed a `damage` step in the same expansion), `lightsOut` (pure `lightsOutPlan` in lights.ts — every light to dim 0 / bright 0 / alpha 0, color kept, fast 800ms fade in parallel, not a snap), `breakWall` (by Wall _id or nearest wall to a point via pins.ts `nearestWall` — `sceneWalls` now exported for it; deletes the Wall doc, drops a rubble tile at the break by default), `emerge` (pure expansion: new token placed at a corpse token's position — `at` when given so --validate-only works, else the live player resolves the corpse token; the corpse is recorded in the place key, which the step log carries), and the `reveal` image shape (`src/session/reveal.ts`: `buildRevealPrompt` grounds the prompt in the room + corpse + creature, no generic gore; `revealImageChatHtml` posts the image inline in chat; `validateReveal`; popout mode is accepted but falls back to the chat post with a note in the step result — no client-side popout is reachable from the MCP path). `examples/mice-ogre.json` (Brandon's proving case: 6 mice rush + bite, 5 rounds, ogre enters, roars, smashes the south wall, lights out — validates, 10 → 38 steps) + `examples/tentacle-twist.json` (phase three: looting → tentacle rips through the ogre's stomach → reveal image → the Tentacled Horror emerges at the corpse — validates, 7 → 7 steps) + `tests/emergent.test.ts` (26 checks). **Live test is a real mid-session moment, not a lab case:** Dave (or Brandon) whispers the idea privately mid-session, Muse builds the script on the fly and it plays — the checklist is: the mice rush + bite rolls land in chat, the ogre arrives on the round clock after five rounds, the wall smash drops rubble, the lights go out as a fade, and the twist's reveal image lands in chat at the moment of the emergence (inline rendering + the uploaded image URL resolving for every client). Monitor GM-whisper handling is built — see the BRA-185 sub-entry below. Spec: `docs/realtime-adventure-construction.md` FR-18.
  - [~] BRA-185 — monitor GM-whisper handling (FR-18 gap). A GM whisper to Meroki is an instruction, not chatter. `src/session/whisper.ts` classifies (embedded script / named sequence / other); `src/session/monitor.ts` routes whispers to the cutscene engine (ack whisper, background play, runKey `whisper:<msgId>`), the build loop, or live-data answers — all handler replies whispered to the GM, script chat steps stay public. Unit-tested (34 checks in `tests/whisper.test.ts`).
  - [~] BRA-228 — Clocks: visible countdown/progress clocks on the table. Built offline Nov 20 — `src/session/clocks.ts` (Clock + ClockStore, immutable ops: create/tick/fill/resolve/reset/drop; `advanceClocksToRound` — one tick per new combat round, re-poll is a no-op, new combat resets tracking; `parseClockStart` — one-sentence start; `renderClock`/`renderClockStore`; serialize/parseClockStore; save/loadClockState, `$FOUNDRY_CLOCK_STATE` or `.clock-state.json`; `readCombatRound` + `announceClockLive`) + `src/cli/clocks.ts` (`--demo/--list/--show/--start/--tick/--fill/--resolve/--reset/--drop/--watch`) + `tests/clocks.test.ts` (25 checks). A fired clock fires exactly once; the consequence is data the caller delivers, not code.
  Live test (needs Dave's Foundry up): `--start` announces in chat; `--watch` ticks once per combat round; fire at zero posts once; two same-name clocks addressed by id; watch restart restores from the state file; new combat ticks round 1 again.
  Follow-ups NOT filed in Linear (Nov 20 — the workspace hit its free issue limit at BRA-275; see the note at the top of this file): monitor routing for clocks is BRA-275 (filed); JournalEntry persistence for the clock store; pause/resume for clocks; consequence execution — map a fired clock to a staged cutscene. File these in Linear once the limit is lifted.
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
  - Built offline Nov 20 — [~], live test pending. `src/session/treasure.ts` (pure `generateTreasure` / `treasureValueGp` / `formatTreasure` — seeded deterministic RNG, reuses loot's `rngFromSeed` + `splitCoins`) + `src/cli/treasure.ts` (`--budget <gp> --level <n> [--seed] [--theme]` needs no connection) + `tests/treasure.test.ts` (17 checks). Budget fitting: 1–2 signature items (20–35% of budget each, capped 45%, topped up instead of dumping into coins when the pool is thin) + greedy unique-item selection + stack growth on gems/consumables + coins as the small remainder, so the total lands exactly on the budget; pool is the union of all level bands at or below the level (a small budget at a high level still has cheap items to spend on — caught by a failing test, fixed). Every item gets a unique story line (owner/place/quirk, themed: dungeon/gothic/underwater/crypt); signature items have a named homebrew ability (labeled homebrew in data + text) and the artwork hook (`art: null` + `artPrompt` per signature item — one square image each, filled in later by the art generator; artwork never blocks the drop). House table, clearly labeled NOT the PF2e rulebook table. **Still needs live testing:** no live layer exists yet — filling a chest from a treasure hoard (map to `fillChest`) and the art-generator step that fills `art` are follow-ups.
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
  - Built offline Nov 20 — [~], click wiring + composer hook pending. `src/session/dressing.ts` (pure `planDressing` / `toggleDressing` / `validateDressingPlan` / `dressingToRoomSpec` / `formatDressingPlan`) + `src/cli/dressing.ts` (`--demo` / `--spec` need no connection) + `tests/dressing.test.ts` (28 checks) + `docs/interactive-dressing.md` (click-wiring design note). Torches every 3 cells along the walls (door cells and corners skipped), candles on tables (floor cells next to a wall when no tables — placement recorded), braziers in the corners of large (8x8+) rooms; deterministic per seed; never two items on a cell, never on a maze wall cell. Lights follow the torch language (torch #ff9a3c dim 300/bright 120 alpha 0.4; candle 120/60; brazier 400/200). Toggle is stateful (off = hidden + alpha 0; on = shown + the item's own alpha) with one chat line per kind + state ("The torch sputters to life." / "The torch gutters out."). TILE HONESTY: the pack has a torch tile (`sconce`) but NO candle or brazier tile — those items carry `tile: null` + `tileNeeded`, listed in the plan's `tileGaps`, never faked. **Still needs live work:** the click wiring (module vs generated macro vs monitor chat command — decide live; recommendation is a small module following the Meroki Pins pattern, see the design note), the composer hook (run the dressing pass per room, write light `_id`s + `flags.meroki.dressingId` back onto the tiles), the candle/brazier pack tiles, and the alpha gap (`LightSpec` has no alpha; `addLights` hardcodes 0.5 — the hook must set alpha post-create or `LightSpec` grows an `alpha` field). Live checklist: build a room with the hook, click a torch (light flips + chat line posts), put it out (stays out until relit), cutscene dims the room's torches then the mage's bloom brings it back. Spec: `docs/realtime-adventure-construction.md` FR-16.
- [~] Quest log (BRA-203) — running journal that ticks objectives off when the thing actually happens in game
  - Built offline Nov 20 — [~], live test pending. `src/session/questlog.ts` (pure: add/complete/fail/objectives/notes/summary, immutable; HONESTY RULE — every note requires a `source`, the summary reports only what the log contains; live: "Quest Log" journal entry, `observer` so the party can read it, one JournalEntryPage per quest with the full quest JSON in page flags — flags are the source of truth, HTML is display only; index page) + `src/cli/questlog.ts` (`--demo`, `--list`, `--show`, `--add`, `--objective`, `--note`, `--complete`, `--fail`) + `tests/questlog.test.ts` (29 checks). Completing an already-completed quest (or failing an already-failed one) is a no-op with no second chat line; completing a failed quest is an error. **Still needs live testing:** `--add` creates the entry + index + quest page visible to players; flags round-trip on 14.370 (riskiest assumption — `JournalEntryPage` create carrying `flags` through `modifyDocument` and surviving in the `getJournals()` cache; fallback is identifying pages by title); objective/complete/fail flows post exactly one chat line and repeat as no-ops; `--note` without `--source` fails; mcp-api can read/write the entry.
- [ ] Downtime — shopping, crafting, healing handled in chat
- [ ] Real rule lookup — `lookup_rule` in the MCP is a stub; build a real one from compendium + journal search
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
