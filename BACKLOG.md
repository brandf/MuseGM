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
shared backlog.
**AgentTS hookup:** design only so far — see [docs/agentts-hookup.md](./docs/agentts-hookup.md) (recommends AgentTS as orchestrator over the CLIs for bounded jobs; live monitor stays outside AgentTS).

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
    Tile shape verified against the fvtt-types v13 TileDocument schema
    + Foundry v14 API docs: image in `texture.src` (not `img`), x/y are
    the top-left corner, elevation + sort order the layers, rotation is
    clockwise. Layers: floor (0, 0), wall (0, 10), dressing (0, 20),
    fog (elevation 1, sort 0 — overhead, above tokens).
    Tests: `tests/tiles.test.ts`, 18 checks — floor coverage,
    determinism, resize (+10 columns = +10*gridH floor tiles, every src
    still a pack file), wall rotations, door segments, layer
    elevation/sort, hidden/alpha, validation errors. `bun run typecheck`
    clean; `bun test tests/` 34 pass / 0 fail (18 tiles + 16 pre-existing
    dice). tsconfig `rootDir` removed so tests/ typechecks too.
  - **LIVE-TEST CHECKLIST (next session, Dave's Foundry on):**
    1. `uploadTilePack` — 15 files land in `worlds/testbed/`, GET back
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
- [ ] Dungeon graph: rooms + door links; walking through a door moves the
  party to the next scene at the matching door
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
- [ ] Monitor side: watch for pins, act, reply, mark done (contract is
  written; the loop is not built yet).
- [ ] Migrate the dialog from V1 `Dialog` to `DialogV2` once
  `DialogV2.wait`'s button-callback signature is verified against the
  14.370 bundle; same for programmatically switching the active tool back
  after a pin is placed.

## Session automation (P1 first, in demo order)

- [x] Encounter builder — name the monsters and the room; place tokens, set HP, roll initiative, combat ready
- [x] Combat autopilot — track initiative, advance turns, conditions with durations that expire, HP watch with a callout at 0 HP, end combat when the last enemy falls
- [x] Trap & zone triggers — watch token movement, fire a trap or a reveal when a token enters a zone
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
- [x] Ping & cursor — `ping(x, y, {style})` via the `userActivity` socket message (`{cursor, ping: {scene, pull, style, zoom}}`); cursor position rides the same message. Proven live Nov 19 (test ping sent on Landing)
  - Done Nov 19: `FoundryLive.ping()` / `moveCursor()` in `src/live.ts` + `src/cli/ping.ts`. Protocol verified in the 14.370 client bundle: `socket.volatile.emit("userActivity", userId, {cursor, ping: {scene, pull, style, zoom}})`; valid styles are pulse/alert/chevron/arrow, and the GM PULL ping is style "chevron" with `pull: true` (the library maps `style: "pull"` to that). Demo live: one pulse ping at 400,400 on the active scene (Floor 1 at the time) + one cursor-only move to 500,500 — both emitted cleanly. Caveat: volatile emit has no server ack, so the result means "emitted on a live socket", not "seen by a client". No chat spam from any of the three demos.
- [ ] Loot pipeline — generate treasure, put it in a chest token, hand it to the right character sheet on open
- [ ] Turn reminders — whisper the player whose turn starts with what they can do and what conditions they have
- [ ] Session recaps — read the chat log after a game, write the recap into a journal entry
- [ ] Player Q&A — answer AC, inventory, spells left, etc. straight from actor data
- [ ] Quest log — running journal that ticks objectives off when the thing actually happens in game
- [ ] Downtime — shopping, crafting, healing handled in chat
- [ ] Real rule lookup — `lookup_rule` in the MCP is a stub; build a real one from compendium + journal search
- [ ] Compendium import — the MCP cannot import compendium creatures at all (`searchCompendium` returns 0 results for everything, no import tool). Needed for the Dracolich: 29 lich / 666 dragon entries exist in the installed books, zero dracolich, and there is no way to pull any of them into the world as actors. Either fix/search the MCP's compendium path or build an import from pack index data.

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
  666 dragon, zero dracolich). Options: custom-build a Dracolich actor or
  use the Lich. Deeper gap: the MCP cannot import compendium creatures at
  all — `searchCompendium` returns 0 results for everything and there is
  no import tool. Needs a backlog item of its own (compendium import).
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
