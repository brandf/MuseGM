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
- [ ] Tile pack, in layers: floor tiles (full squares, floor included);
  wall pieces (straight, corner, door); dressing (bone pile, skeleton,
  chest, pillar, rubble — solid bg, cut out in code to transparent PNGs);
  atmosphere (fog wisp, smoke — black bg, luminance-as-alpha in code).
  Upload once; manifest under `src/worldbuilding/tiles/`
- [ ] Composer: room spec (grid width/height, door walls/positions, tile
  layout by layer) → place Tile documents (sort order = layer) + walls +
  lights + tokens on the scene; resize = change grid dims, no new images
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

## Session automation (P1 first, in demo order)

- [x] Encounter builder — name the monsters and the room; place tokens, set HP, roll initiative, combat ready
- [x] Combat autopilot — track initiative, advance turns, conditions with durations that expire, HP watch with a callout at 0 HP, end combat when the last enemy falls
- [x] Trap & zone triggers — watch token movement, fire a trap or a reveal when a token enters a zone
- [x] Scene builder — map image to walls, lights, tokens; auto-post the room description into chat when players enter
  - Done Nov 19: `src/worldbuilding/` + `src/cli/scene.ts` demo. Upload verified live (400×300 PNG → `worlds/testbed/test-map.png`, byte-identical on GET). Demo scene rebuilt after the `background.src` fix: 4 walls, 2 lights, chest (50gp + 2× Healing Potion) verified in a fresh snapshot, then cleaned up (world back to 4 scenes / 31 actors). Caveat: the background is set per the v14 schema and accepted by the server, but the worldData snapshot never exposes `background` for any scene — the GM needs to open the scene once to visually confirm the map. See `src/worldbuilding/README.md`.
  - BUG found Nov 19: scenes created via the MCP get ownership `{default: 0, mcp-api: 3}` only — the GM (Dave) is not an owner and could not edit "Lich's Lair — Entry Hall". Fixed live by adding Dave as owner (level 3). TODO: `createSceneFromImage` (and any scene create) must add the GM user(s) as owners — look up users, find role GM, include them in `ownership` at level 3.
  - BUG found Nov 19 (the real load failure): in Foundry 14 the map lives on a **Level**, not on the scene — the scene MUST have at least one Level or the canvas has nothing to render and the scene will not load. My scenes were created with scene-level `background: {src}` only, so Lich's Lair had `levels: []` and `initialLevel: null` while every working scene has a `defaultLevel0000` with `background.src` on it. The earlier "background.src fix" was wrong — that update was accepted with no error and did nothing. Fixed live: created a Level on Lich's Lair with `background.src: worlds/testbed/test-map.png` and set `initialLevel` to the level's real _id (the server assigns its own _id — a requested `defaultLevel0000` was ignored). Verified on a fresh connection. `createSceneFromImage` in `src/worldbuilding/index.ts` now creates the Level + sets `initialLevel` for every new scene.
- [ ] Dice on demand — rolls requested in chat, secret GM rolls, group checks for the whole party
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
- [ ] **Map image size.** The Entry Hall image is 3.9 MB and may be behind
  Dave's scene-switch "resources finish loading" hang. Compress map
  images on upload (resize/quality pass in `uploadImage`).
- [ ] **Scene create quirk.** `createSceneFromImage`'s create silently
  drops `background.src` (and `navigation` — stored `false` despite being
  sent). The background only stuck via a follow-up update. With the Level
  fix, the Level now carries the background — verify the create path sets
  everything the scene needs, or set it via update after create.
- [ ] **Fold in the probe lessons.** `/tmp/post-roll.mjs` (visible-roll
  helper) and the probe scripts' lessons (HP via raw `modifyDocument`,
  Token updates need `parentUuid`) belong in the library, not in /tmp.
