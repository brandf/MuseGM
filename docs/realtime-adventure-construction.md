# Real-time adventure construction — feature requests

**Status:** spec, Nov 19, 2026. Written from Brandon's live-session vision
(real-time adventure construction in Foundry) and the speed principle he
stated the same night. No implementation yet except where noted as built.

## The governing principle: Muse authors a small script, the engine plays it

This is NOT canned responses to things Brandon says. The shape is:

1. Brandon says what should happen, in intent ("nine soldiers rush in
   and surround them").
2. Muse authors a **small declarative script (JSON)** — the decisions
   only: which tokens, where roughly, in what order, what it should feel
   like. The script is compact; Muse's tokens go to the creative calls,
   never to enumerating placements.
3. The engine executes the script on a **timed timeline** — hundreds of
   placements, movements, facings, light changes, prop drops — with no
   further tokens and no round-trip per step.

The sequence runner (`src/session/sequence.ts`) is already this shape:
a JSON step list played out on the code side, paced, one call from Muse.
The cutscene engine is that idea grown up: a richer step vocabulary, a
real timeline, and a script-authoring surface for Muse.

**The speed budget (the constraint every feature below carries):**
Muse's decision is a short script, seconds of tokens at most. Code
execution is seconds. Time from Brandon's sentence to the change visible
on the table should be measured in seconds, not in a long token stream.
If a feature needs Muse to enumerate placements one by one, the feature
is shaped wrong — push the enumeration into code.

## First principles: what a content creator needs mid-session

The creator's loop is: **say what should happen → see it happen →
react to the players → say the next thing.** Everything below serves
that loop. The failure mode is dead air: every second the table waits
while the creator describes coordinates or watches a build is lost
energy. So:

- **The creator speaks in intent, not coordinates.** "Add a door here"
  (pointing), "make it gothic", "soldiers rush in" — the system resolves
  intent to concrete placements. Code does the geometry.
- **Everything is a small, reversible edit.** Add → look → adjust →
  undo. "A bit wider", "darker", "more fog" are one short message each.
  The dungeon is data (room specs + a graph); edits are spec diffs.
- **The table never sees the scaffolding.** Changes land live and
  smoothly — tokens glide, lights fade, fog drifts in. No jarring pops,
  no "hold on while I build" pauses.
- **Surprise is preserved.** Hidden rooms, secret doors, unrevealed
  floors — players see only what they should, when they should. Reveal
  is a first-class action, gated on the fiction (climbing the stairs),
  not on the build.
- **The creator stays in the fiction.** They talk to the table and to
  Muse in the same channel (Foundry chat). No dashboard to switch to.

## Feature requests

### FR-1 — Conversational room building (iterative)

**Creator says:** "Start with a small entry room." Then: "Add a door
here." Then: "Add a hidden room over here that takes you into a long
hallway over to here."

**Muse authors:** a room spec per step (dimensions, door wall/position,
link to the next room). "Here" resolves from the creator's ping/cursor
or the named wall — never from coordinates in chat.

**Engine executes:** the composer places the tiles, walls, lights
(`buildTileRoom`); the dungeon graph links the rooms (`layoutDungeon`,
`walkThroughDoor`).

**Acceptance:** a 3-room dungeon built in under 2 minutes of chat, no
coordinate talk, each step visible within seconds of the message.

**Status:** [~] built + unit-tested offline Nov 20 — `src/session/build-loop.ts` (pure parser: chat line -> one `BuildOp` — create-room, widen, door add/move, dressing, torches, fog, overlay, corridor — or a clarifying question, or "can't do that yet"; `BuildSession` history of specs; `planSync`) + `src/session/build-exec.ts` (live executor: peek -> validate -> commit -> sync via `buildTileRoom`/`rebuildTileRoom`) + the monitor hook (new routing kinds `build` / `clarify` / `unsupported`, after roll/question) + `src/cli/build-loop.ts` (`--demo`, `--say`, no connection) + `tests/build-loop.test.ts` (89 checks). One confirmation line per build in chat. Live test pending: the full BACKLOG checklist (3-room dungeon in under 2 minutes of chat, widen/secret-door/corridor live, clarification + unsupported lines). "Here" now resolves from the GM's last ping/cursor (BRA-225, Nov 20) — the pinged scene identifies the room, the point the wall/cell; without a ping it still asks. Rooms are targetable by name, and compound requests run their ops in order. Composer + dungeon graph built and unit-tested (18-tile pack, 0 gaps); the chat-driven iterative loop (monitor → composer) is now wired.

### FR-2 — Theme re-skin

**Creator says:** "Skin this to be more of a gothic theme."

**Muse authors:** one word — the theme name. Maybe a note ("colder,
taller windows").

**Engine executes:** the same room spec rebuilt with a different tile
pack (floor/wall/dressing swapped) + light palette change, in code, in
seconds. A room spec references a theme; re-skin is a pack swap.

**Acceptance:** a built room re-skinned in under 10 seconds of
execution; the layout (walls, doors, links) is unchanged, only the look.

**Status:** [~] built + unit-tested offline Nov 20 — `src/worldbuilding/themes.ts` (ThemeSpec + DUNGEON_THEME + WESTERN_THEME) with a `theme` parameter threaded through the room spec, the composer, and the builders; pack now 29 tiles (10 western: sandstone floors, wood-plank walls, dust). Live test pending: upload the western tiles, build a western room, re-skin a dungeon room live. More themes (gothic, crypt, tavern, forest…) are one ThemeSpec + a generator variant each.

### FR-3 — Multi-floor + gated reveal

**Creator says:** "A staircase goes up here to a second floor that is
only revealed when the characters actually go up here."

**Muse authors:** a staircase zone + a second-floor room spec linked
as "up" from the first room.

**Engine executes:** the second floor exists (built) but is hidden /
inactive — its scene is not activated and its contents are not visible
until a token enters the staircase zone, at which point the reveal
fires: scene activates, tokens move up, the floor is shown.

**Acceptance:** the players cannot see the second floor before climbing;
the climb itself triggers the reveal with no creator action in the
moment.

**Status:** not built. Needs: a staircase zone type, scene
visibility/reveal control, and the zone→reveal wiring (extends the
trigger-zone system, FR-4).

### FR-4 — Trigger zones

**Creator says:** "A trigger zone over here — the first player that
steps into this area…"

**Muse authors:** a zone (rectangle on the map) + a trigger (first token
enters) + the script it fires (see FR-5).

**Engine executes:** the zone watches token movement (the trap/zone
trigger system) and fires the linked script once, on entry.

**Acceptance:** a zone defined in one message; fires exactly once on
first entry; the creator can arm/disarm it.

**Status:** trap & zone triggers built (step on it and it fires live). [~] The zone→cutscene-script link is built + unit-tested offline Nov 20 — `src/session/zone-cutscene.ts` (strict zone-set validation, sceneId inheritance, `LinkArming` dedupe) + `TrapWatcher` plays the cutscene on entry + `bun run trap --zones <file> --plan` prints the trigger plan with no connection. Live test pending (trapdoor demo on TestBed). Deliberately NOT wired into the monitor — the trap CLI's watch is the live executor, and a second watcher would double-fire.

### FR-5 — Cutscene scripting + playback (the ambush)

**Creator says:** "Nine soldiers rush in the door and surround them
around the perimeter of the walls and point spears towards the center,
and then a mage enters and starts casting a spell that lights up the
room in the center and it glows brightly."

**Muse authors:** one cutscene script (JSON) — the decisions: 9 soldier
tokens, perimeter positions, spears pointed at the center, mage enters
last, light blooms in the center. Muse does NOT enumerate the 9
positions one by one in tokens; it writes the intent ("ring of 9 around
center, radius R") and code expands it.

**Engine executes:** the timeline — door opens, soldiers glide in one
by one (or in waves), take perimeter positions, face the center, spear
props appear in their hands / pointed inward, mage glides in, casting
effect, the center light blooms (timed intensity/color transition),
narration in chat. All on the code side, paced, no round-trip per step.

**Acceptance:** the ambush plays in under 30 seconds from the creator's
sentence; tokens animate smoothly; the table watches a scene, not a
build.

**Status:** built offline Nov 20, unit-tested, live test pending.
`src/session/cutscene.ts` (versioned script schema, strict validation —
every error listed, never a silent skip; formation expansion;
`playCutscene` via the sequence runner) + `src/session/formations.ts`
(ring/line/wedge + facing angles) + `src/session/lights.ts` (timed
light transitions) + `src/cli/cutscene.ts` (`--file`, `--validate-only`
needs no connection) + `examples/ambush.json` (the ambush: 9 soldiers,
spears, mage, light bloom — validates and expands to 51 steps) +
`tests/cutscene.test.ts` (22 checks). The sequence runner gained
`face`, `light`, `prop`, `reveal`, `wait` steps. **Still needs live
testing:** play the ambush against TestBed (Soldier/Mage actors must
exist; spear tile uploaded); verify the token-rotation convention
(0 = north, clockwise), the dot-notation light updates, and the
light-bloom timing.

### FR-6 — Props as first-class objects

**Creator says:** "Put spears in their hands", "a brazier in the
corner", "rubble everywhere".

**Muse authors:** prop placements (what, where roughly).

**Engine executes:** props are tiles/tokens placed, movable, removable
— the dressing layer generalized. Spears in the ambush are props, not
part of the soldier tokens.

**Acceptance:** a prop placed, moved, or removed in one short message;
props persist with the room spec (so a re-skin keeps them, or swaps
them per theme).

**Status:** partially built — dressing tiles exist (bones, chest, altar,
pillar, rubble, spear) and sit on their own layer, and prop *placement
by the cutscene engine* is built (`prop` step + formation props, Nov 20).
Prop persistence in the room spec is not built.

### FR-7 — Lighting as a language

**Creator says:** "Light up the room in the center and make it glow
brightly."

**Muse authors:** a light change (which light, to what, over how long).

**Engine executes:** named lights with timed intensity/color
transitions — a bloom is a fade over seconds, not an instant swap. The
mage's casting light is a light animation, not a new static light.

**Acceptance:** a light bloom reads as a spell being cast, not as a
light switch; the creator can name a light ("the center light") and
change it in one message.

**Status:** not built. Lights today are static (dim/bright/color set at
build). Needs timed light transitions + named lights in the room spec.

### FR-8 — Undo / tweak

**Creator says:** "A bit wider", "move that door left", "darker",
"actually undo that room".

**Muse authors:** a spec diff (one field changed) or an undo.

**Engine executes:** rebuild the affected room from the edited spec
(fast — tiles are data, no new images), or restore the previous spec.

**Acceptance:** any build action reversible in one message; a tweak
lands in seconds.

**Status:** [~] built + unit-tested offline Nov 20, with FR-1 — the
layout ops were already pure and non-mutating, so edit history is a
list of specs and undo is the previous one: `BuildSession` (`peek` /
`commit` / `apply` / `undo` / `redo`, history entries carry the GM's
exact words + the summary) in `src/session/build-loop.ts`, "undo
that" / "redo" parse as ops and post what was undone/redone in chat,
`tests/build-loop.test.ts` (57 checks, incl. undo-to-start, redo-tail
dropped by a new edit, frozen-input immutability). Live test pending:
undo/redo in chat against a live room (see the BACKLOG checklist).
Known limitation: the session lives in memory only — a monitor
restart loses the history (a state file is the follow-up).

### FR-9 — Pacing / director mode (v2)

**Creator says:** nothing — the system paces itself.

**Idea:** cutscenes pause for the table's reaction (wait for a player
message or a beat) instead of running wall-to-wall; the director
(monitor) notices when the table is engaged and holds the next beat.
Explicitly v2 — FR-5 first, pacing after the table has felt a few
cutscenes.

**Status:** not scoped beyond this paragraph.

### FR-10 — The speed budget (governs all of the above)

Every feature carries a latency budget: Muse's script is seconds of
tokens; code execution is seconds. Measure it: time from the creator's
message to the change visible on the table. If a feature needs Muse to
enumerate placements one by one, the feature is shaped wrong — push the
enumeration into code. This is the same principle as the monitor (code
watches, Muse only wakes when needed) and the sequence runner (code
plays, no round-trip per step).

**Status:** [~] built + unit-tested offline Nov 20 — `src/session/perf.ts` (LatencyLog on an injectable clock; SPEED_BUDGETS with a cited source per budget, `ms: null` where no sourced budget exists; p50/p95 session report) + monitor wiring (detect per message from msg.timestamp; one action record per handled message — roll/question/room-build/whisper-first-effect; per-step cutscene durations; one latency line per action, one latency-over-budget warning per over-budget stage). Live validation against TestBed pending.

### FR-11 — Rapid custom encounter generation (story-aware NPCs)

**Creator says:** "Set up a custom encounter — a patrol of the lich's
honor guard, ambushing the party in the hallway. Give them backstories,
interesting gear, spells that fit who they are."

**The human cost this replaces:** building that by hand is hours — stat
blocks, gear and spell selection that actually fits the fiction,
backstories that tie each NPC to the plot, tokens placed with the right
look and positions. The system should do it in seconds to a minute.

**Muse authors:** a compact encounter spec — who they are (names,
roles, one-line backstories tied to the storyline), what makes each one
distinct (one signature item or spell each), and the formation. Muse
does NOT write out full stat blocks or item lists in tokens; it writes
the creative calls.

**Engine executes:** from the spec + the story context (the campaign's
running record — session recaps, journal entries, the dungeon theme,
the current scene), code expands each NPC into a full actor: stats
scaled to the party's level from templates, gear and spells picked from
the library filtered by role and theme (a lich's honor guard gets
necrotic-touched gear and death-flavored spells, not random loot),
backstory text attached to the actor, tokens created and placed in
formation with the right look. The story context is what makes the gear
and backstories *specific* instead of generic — the generator reads the
recaps and journals first.

**Acceptance:** a 4–6 NPC custom encounter, backstoried and equipped to
the storyline, on the table in under a minute from the creator's
sentence; every NPC has a reason to be there that a player could
discover by asking.

**Two rules that make it feel real (Brandon, Nov 19):**

- **Every character is fleshed out, even the mooks.** Not just the
  boss — every enemy gets a backstory, a personality hook, and gear
  that fits a living person. A guard isn't "a dagger and a rapier and
  nothing else" — a living person carries the stuff that keeps them
  alive: rations, a waterskin, a bedroll, rope, torches, a whetstone, a
  letter from home. The **living kit** is part of every NPC's gear, and
  it is how the players learn who this person was after the fight.
- **Unique loot, not generic loot.** When you kill a creature you get
  something interesting and specific — a signature item with a story
  (the guard captain's notched blade with the oath etched in it, the
  mage's cracked focus that still hums), not a generic dagger. The loot
  IS characterization: what a creature carried tells you who they were.
  Every NPC gets one unique signature item that drops on death, and the
  generator must never emit the same generic weapon list twice.

**Status:** not built. The encounter builder (P1) places monsters and
starts combat, but it uses existing actors. This is the *custom* half:
story-aware NPC generation (templates + level scaling + gear/spell
selection + backstories from the story context) and token setup from the
generated actors. Depends on the recap/journal record being the story
context (FR: recaps are built; the generator reads them).

### FR-12 — Mutable maps + procedural layout generation

**Creator says:** "Along this wall, let's make a corridor that goes
north for like 100 meters and then turn it into a small maze."

**The point:** maps are data, so they should be *mutable*. The creator
never redraws anything — they describe a change and the map changes.
A corridor is a layout operation on the room spec; a maze is a small
script run locally that generates a layout, which the composer turns
into tiles.

**Muse authors:** a layout operation — "corridor, north, from this
wall, length 100m" — then "maze region, seeded, at the end of it".
Units are the creator's (meters, feet, squares — code converts; in
PF2e a square is 5 ft ≈ 1.5 m, so 100 m is about 66 squares).

**Engine executes:** a maze generator (recursive backtracker or Prim's,
seeded so the same seed gives the same maze) produces a tile layout;
the composer rebuilds the affected rooms from the edited spec — no new
images, tiles only. The whole change lands in about 30 seconds.

**Acceptance:** corridor + maze on the table ~30 seconds after the
message; the maze is a real maze (connected, one solution path, dead
ends), the corridor links to the existing room's door, and the creator
can say "different maze" to re-roll the seed.

**Status:** built offline Nov 20 — [~], live test pending.
`src/worldbuilding/maze.ts` (seeded recursive backtracker, `toSquares`,
ASCII + analysis helpers) + layout ops in `tiles-layout.ts`
(`addCorridor`, `linkRooms`, `carveMazeRegion`, `widenRoom`) and the
composer wiring (maze wall tiles, merged collision walls, `openings` for
corridor ends). The composer rebuilds rooms from specs (the mechanism
exists) and the ops are pure, non-mutating edits on the spec. CLI:
`bun run maze --cells 10x8 [--seed 7] [--ascii]`. Tests:
`tests/maze.test.ts`, 35 checks. Live test next session: corridor +
maze on the table, walk-through, re-roll the seed.

### FR-13 — Iterative refinement: hash on it (regional overlays + scripted tile swaps)

**Creator says:** "No — let's actually make this part of the maze
partially underwater." Then: "There's going to be a trap door here.
When the players step on this, I want you to swap this tile for that
tile."

**The point:** the build is a conversation, not a single order. Brandon
hashes on it with Muse — each turn is a small edit, fast, and Muse
drives the change from the request. Two new mechanics make that work:

- **Regional theme overlays.** A theme isn't whole-map-or-nothing: a
  *region* of the maze goes underwater. The engine adds water tiles on
  top, or swaps tiles for wet variations (floor-plain → floor-wet) in
  that region only. The rest of the map is untouched. Same mechanism as
  the re-skin (FR-2), scoped to a region.
- **Scripted tile swaps.** A trigger (step on this tile) → swap this
  tile for that tile — the trap door opens, the floor becomes a pit, the
  wall becomes a passage. Scripted so the code does it: the swap is a
  step in a cutscene/trigger script (FR-4 + FR-5), not a manual edit in
  the moment.

**Muse authors:** the overlay ("water, this region") and the swap
script ("on step, tile A → tile B").

**Engine executes:** region-scoped tile swaps at build time (overlay)
and at trigger time (scripted swap, executed by the timeline player).

**Acceptance:** "make it underwater" lands in seconds on that region
only; the trap-door swap fires exactly when stepped on and the table
sees the tile change live.

**Status:** both halves built offline Nov 20 — [~], live test pending.
The `swapTile` step is built: schema + validation (exactly one of tile
_id / cell, non-empty target) + timeline-player execution (updates
`texture.src` in place, retry-safe by nature) + unit tests
(`tests/cutscene.test.ts`, `tile-ops.ts`). The overlay half is built
too: `applyOverlay` in `tiles-layout.ts` (pure spec edit; the composer
remaps floor tiles inside the region only, later overlays win) +
`tests/maze.test.ts` (region-only, 1:1 variants, later-wins). The
variant set today is the existing floor tiles (plain -> dark reads as
waterlogged); real wet-variant tiles (floor-wet) are a later pack
addition. Note: a cell address only resolves when the connection's tile
cache carries tiles — the vendored client does not track Tile documents,
so the _id path is the reliable one (buildTileRoom returns the tile ids).

### FR-14 — Value-budgeted treasure with stories (not generic loot)

**Creator says:** "I want this amount of value of treasure" — a number,
say 500 gp worth — "and make it interesting."

**Muse authors:** the budget and the theme; the rest is generation.

**Engine executes:** from the value budget, the generator assembles a
hoard that actually totals (approximately) the requested value — a
budget-fitting selection from a valued item pool, not a random table
roll. Every item is distinct and comes with a story and details:
provenance, a previous owner, a quirk, a reason it exists. Signature
items get unique magic abilities (homebrew, labeled as homebrew — never
presented as rulebook items) and custom artwork (generated per
signature item, offline/async — artwork never blocks the treasure
drop). The result is a hoard a player would remember, not "3 daggers
and 47 gp".

**Acceptance:** the hoard's total value lands within ~10% of the
requested budget; every item has a story line; no two items in one
hoard are the same generic weapon; signature items have a named magic
ability and art.

**Status:** [~] built + unit-tested offline Nov 20 — `src/session/treasure.ts` + `src/cli/treasure.ts` + `tests/treasure.test.ts` (17 checks). Budget fitting lands exactly on target; stories unique per hoard; 1–2 signature items with named homebrew abilities and the `art`/`artPrompt` hook. Live test pending: no live layer yet — filling a chest from a hoard and the art-generator step are follow-ups. The loot pipeline (P2) does level-banded tables of real PF2e item names + coins, but it is not value-budgeted, has no stories, no magic abilities, and no artwork. This is the treasure half of FR-11's unique-loot rule, generalized to whole hoards.

### FR-15 — High-level floor generation (the vague-brief mode)

**Creator says:** "Here's an entire floor of a dungeon, roughly: I
want three kind of puzzles here — pressure plates, they need to do
something interesting with pressure plates in three different rooms to
unlock a door. A riddle type thing over here. Two minor encounters,
one of which is an ambush. Then the big boss battle. Some intrigue.
And further the main storyline in a few different ways."

**Two modes, not one.** Some people want the hands-on, nitty-gritty
mode (FR-1: "add a door here") — specific, direct, tile by tile.
Other people want this mode: vague, high-level, throw out ideas and
let Muse do the creative work. Both modes live in the same system; the
creator picks per moment, and can switch mid-build.

**Muse authors:** a floor plan — the rooms and their links, the three
pressure-plate puzzles (each plate does something interesting, all
three together unlock the door), the riddle, the two minor encounters
(one an ambush cutscene), the boss battle, the intrigue beats, and the
storyline threads it advances. All of it woven from the campaign
history Muse has been chronicling — the recaps, the journals, the
dungeon theme. The chronicle is the input: the puzzles reference what
the party has done, the intrigue plays on relationships the chronicle
recorded, the boss is someone the story has been building toward.

**The convergence loop (before anything is built):** Muse shows the
plan — a summary plus a sketch of the layout — and the creator reacts.
Show a few things, erase them, show alternatives. Ask clarifying
questions when a fork is real; suggest things to gauge what the creator
might be interested in *before* building a bunch of stuff they don't
like. Only when the ideas converge does anything get built — and the
build itself is the cheap part, because the engine already knows how
(the composer, the encounter generator, the cutscene player, the
treasure generator, the trap system). The loop is iterative, but the
iteration happens at the idea level, not the tile level.

**Acceptance:** a vague brief turns into a floor plan the creator
recognizes as theirs, after at most a few rounds of show-and-erase;
the locked plan builds with the existing engine pieces (no new
one-off code per floor); every puzzle, encounter, and intrigue beat
traces to something in the chronicle or the brief — nothing generic.

**Status:** planner built + unit-tested Nov 20 (`src/session/floor-plan.ts`, `src/cli/floor-plan.ts`, `tests/floor-plan.test.ts` — 34 checks; `bun run floor-plan --demo` prints the lich's lair floor preview + the locked plan and manifest). Live wiring still pending: executing a locked plan's manifest against a real Foundry, and the chat convergence loop (show the preview, take reactions, re-plan).

### FR-16 — Interactive dressing: the map you can touch

**Creator says:** "The maps should feel a lot more interactive than
they normally would, sometimes in cosmetic ways. If the players go
around clicking on torches they should be able to light them up and
put them out. Click a little candle on a table and it lights up."

**Muse authors:** nothing by hand. The composer generates it: given a
room spec, a dressing pass sprinkles torches along the walls, candles
on tables, braziers in corners — each one a tile *plus* its light
*plus* the click wiring that toggles it. A human placing all of that
would take forever; a script generates it in one pass. The same
pass can dress a whole dungeon: every room gets its torches and
candles, each one clickable, each one with a warm light that turns on
and off.

**Engine executes:** a torch is a dressing tile with a paired
AmbientLight (dim, warm, flickering — the light language from FR-7)
and a click handler (a small module, following the Meroki Pins
pattern, or a generated macro) that toggles the light and posts a
one-line flavor note in chat ("The torch sputters to life."). A
candle is the same shape, smaller radius. The toggle is stateful
(light on/off persists in the light document), and the cutscene
engine can also drive it (a `light` step with a named light, or a
torch-off step in an ambush: the room goes dark, then the mage's
spell lights the center).

**Acceptance:** a room built by the composer has its torches and
candles placed, lit, and clickable without any hand work; clicking
toggles the light and the chat line; the same dressing pass works on
any room spec (not just the demo room); a torch the players put out
stays out until someone relights it.

**Status:** [~] generator built + unit-tested offline Nov 20 —
`src/session/dressing.ts` (pure `planDressing` / `toggleDressing` /
`validateDressingPlan` / `dressingToRoomSpec` / `formatDressingPlan`)
+ `src/cli/dressing.ts` (`--demo` and `--spec <room-spec.json>` need
no connection) + `tests/dressing.test.ts` (28 checks) +
`docs/interactive-dressing.md` (the click-wiring design note). The
generator places torches along the walls (every 3 cells, skipping
door cells and corners), candles on tables (or floor cells next to a
wall when there are no tables — placement recorded), braziers in the
corners of large (8x8+) rooms; deterministic per seed; never two
items on a cell, never on a maze wall cell. Lights follow the torch
language from the lighting fix (torch #ff9a3c dim 300/bright 120
alpha 0.4; candle dim 120/bright 60; brazier dim 400/bright 200).
The toggle is stateful (off = hidden + alpha 0, on = shown + the
item's own alpha — a relight restores the same light) with one chat
line per kind + state. Tile honesty: the pack has a torch tile
(`sconce`) but NO candle or brazier tile yet — those items carry
`tile: null` + `tileNeeded` and the plan lists them in `tileGaps`.
**Still pending:** the click wiring (module vs generated macro vs
monitor chat command — decide live; recommendation is a small module
following the Meroki Pins pattern, see the design note), the composer
hook that runs the dressing pass on every room it builds (and writes
the light `_id`s + `flags.meroki.dressingId` back onto the tiles),
the candle/brazier pack tiles, and the alpha gap (`LightSpec` has no
alpha; `addLights` hardcodes 0.5 — the hook must set alpha in a
post-create update or `LightSpec` grows an `alpha` field).

### FR-17 — Sound: effects and background music

**Creator says:** "We'll probably want to get into sound effects and
background music and stuff like that eventually too."

**Muse authors:** a soundscape per room and per moment — ambient
music for the dungeon theme (cold, echoing, low), and sound effects
tied to events: a door creak when the secret door opens, a snap when
a trap fires, a whoosh when a torch ignites, a swell when the boss
enters. The cutscene engine gets a `sound` step (play a named effect,
start/stop a playlist, fade a track over N seconds — the same timed
transition shape as the light step).

**Engine executes:** Foundry playlists (ambient music per scene,
fading between rooms) and one-shot effects (a `sound` step in a
cutscene script, a trap's fire sound, a torch's ignite). The pieces
are the same as lighting: a named asset, a timed transition, a
trigger.

**Acceptance:** a room has an ambient track that starts when the
party enters and fades when they leave; a cutscene can play an
effect at a timed step; a trap's sound fires with the trap.

**Status:** not built — design only. Open questions before building:
where do the tracks come from (Foundry's built-in sounds, uploaded
files, a generated set), and does the table want music at all in the
first sessions (ask Dave — it's a taste question, not a technical
one). The `sound` step schema can be built with the cutscene engine
once the asset question is answered.

### FR-18 — Mid-session emergent sequences (the GM whispers an idea)

**GM says, privately, mid-session:** "The players just started
screaming, so let's have a whole bunch of mice rush in the room.
They're going to think it's some minor encounter with mice, but
really the mice are just running by them, biting, trying to get down
the hall — because they've alerted a huge ogre. Five rounds later,
after five rounds of mice biting them as they run by and they're
trying to work their way down the hall, this ogre shows up and roars
and smashes on the wall and all the lights go out."

**The mode:** not map building, not design — a mid-session workflow.
The GM isn't moving things around much; an idea pops into their head
and they give it to Muse on the side, as a private message. Muse goes
off and sets the whole thing up real quick while the players are
sitting there screwing around looking for loot and hidden traps and
hidden doors — and the next thing they know the sequence just plays
out. None of it was planned ahead of time. It's emergent behavior,
driven by an idea in the moment.

**The side channel:** the GM's idea arrives privately, not in the
public chat — a whisper to Meroki in Foundry (visible only to the GM
and to us), or a message to the GM's own Muse. The players never see
the setup. The monitor treats a GM whisper as an instruction, not as
table chatter — and it acts on it without announcing itself.

**Muse authors:** a multi-phase script, on the fly. Phase one: the
mice — a swarm of tokens placed at the door, gliding through the room
and down the hall, biting as they pass (a little damage, a little
chaos, and the players thinking it's a minor encounter). Phase two,
five rounds later: the ogre — a big token at the door, a roar in
chat, a wall smash (a wall segment comes down, rubble dressing
appears), and all the lights go out (every light dimmed to nothing,
the room in darkness). The clock is combat rounds, not wall-clock
seconds — the sequence advances on the round, so it stays in sync
with the fight the players are already in.

**Engine executes:** the cutscene player, extended with a round clock
(`waitRound` steps), a rush-through movement pattern (tokens that
pass through a room and out the far door, biting as they go), a
lights-out step (all lights off at once), and a wall-break step
(remove a wall segment, drop rubble). The encounter is generated on
the fly (the encounter generator: a mouse swarm + an ogre, both
fleshed out with the FR-11 rules) — nothing is pre-built, nothing is
canned. From whisper to the first mouse in the room is seconds.

**Acceptance:** a GM whisper turns into a playing sequence in under
a minute, with no public announcement of the setup; the mice move
and bite for five rounds and then the ogre arrives on the round
clock; the wall smash and the lights-out land as part of the same
script; the players experience it as one continuous event, not as
Muse doing setup in front of them.

**The trigger can be a player's own line.** The idea pops into the
GM's head off something a player says while finishing off the ogre —
"well, at least we have time to rest before the boss!" — and the GM
decides to answer that assumption. The table's own words are an input
to the emergent mode, not just noise: the GM hears the line, whispers
the twist, and within a minute or two the crazy next thing is
happening and the players are saying "what is going on? This is
nuts." The latency budget is the point: whisper to first visible
effect in one to two minutes, or the moment is gone. And the feel
matters as much as the speed — delighted chaos, not confusion: the
sequence is surprising but legible (they can see the mice, the ogre,
the tentacle), so the table reads it as one continuous event, not as
noise.

**The twist (phase three):** after the ogre battle, the GM gets
another idea — the players are celebrating, looking through the
ogre's meager possessions for treasure, and a tentacle rips through
the ogre's stomach and a tentacle creature emerges: the true boss of
the level. The ogre was a fake-out. Muse generates, on the fly, a
gory image — the ogre lying on the ground with a tentacle ripped
through its stomach — and shows it to the players at the moment it
happens. The image *is* the reveal: the players see it before they
see the stat block, and then the real battle starts. The same
pattern chains: a second whisper arrives mid-celebration, Muse
appends a new phase to the running sequence (the corpse token becomes
the emergence point), generates the image, shows it, and the new
encounter begins. The reveal image is a first-class mechanic — a
`reveal` step in the cutscene engine (upload the image, post it to
chat with the image inline, or pop it up on screen), with the prompt
grounded in the fiction (the room they're in, the corpse on the
floor, the tentacle). This is also the answer to the open question
from the Nov 19 session about attaching images to chat or popping
them up when something big happens.

**Status:** [~] built + unit-tested offline Nov 20 — the round clock
(`waitRound`), `rush`, `lightsOut`, and `breakWall` steps in the
cutscene engine (`src/session/cutscene.ts` + `src/session/sequence.ts`
+ `src/session/lights.ts` `lightsOutPlan`/`lightsOut` + `src/session/pins.ts`
`sceneWalls` now exported for the wall lookup), the `emerge` step,
and the `reveal` image step (`src/session/reveal.ts` — prompt
builder grounded in the room + corpse + creature, chat HTML with the
image inline; popout falls back to chat, honestly). `examples/mice-ogre.json`
(10 → 38 steps) and `examples/tentacle-twist.json` (7 → 7 steps) both
validate with `--validate-only`; `tests/emergent.test.ts` (26 checks).
Still pending: the monitor's GM-whisper handling (a whisper to us is
an instruction, not chatter), and the live test — which is a real
mid-session moment, not a lab case, now with the twist: the reveal
image landing in chat at the moment of the emergence.

## What exists vs what is next

| Piece | Status |
|---|---|
| Sequence runner (JSON steps, code-side, paced) | Built |
| Tile composer + dungeon graph (rooms + door links) | Built, unit-tested |
| 19-tile pack (0 gaps, incl. spear prop) | Built |
| Trap & zone triggers | Built |
| Chat-driven iterative building loop | Built, unit-tested (Nov 20); live test pending |
| Theme packs + re-skin | Not built |
| Multi-floor + gated reveal | Not built |
| Zone → cutscene link | Not built |
| Cutscene script schema + timeline player | Built, unit-tested (Nov 20) |
| Formation helpers (ring, line, wedge) | Built, unit-tested (Nov 20) |
| Timed light transitions + named lights | Transitions built (light step); named lights still use id/proximity |
| Scripted tile swaps (FR-13 swapTile) | Built, unit-tested (Nov 20) |
| Edit history / undo | Built, unit-tested (Nov 20); live test pending |
| Props in the room spec | Not built |
| High-level floor generation (FR-15) | Planner + preview + manifest built, unit-tested; live wiring pending |
| Interactive dressing: clickable torches/candles (FR-16) | Generator built, unit-tested (Nov 20); click wiring + composer hook pending |
| Sound: effects + background music (FR-17) | Not built — design only, asset question open |
| Mid-session emergent sequences (FR-18) | Built, unit-tested (Nov 20) — round clock + rush + lights-out + wall-break + emerge + reveal image; monitor whisper handling + live test pending |

## Build order

1. **Cutscene script + player** (FR-5 core: schema, timeline player,
   `face`/`light`/`prop`/`reveal` steps, formation helpers) — it is the
   engine everything else plays through.
2. **Chat-driven building loop** (FR-1 wiring: monitor → composer) +
   **undo** (FR-8) — the iterative loop, since it is the daily use.
3. **Rapid custom encounter generation** (FR-11) — story-aware NPCs
   with backstories, gear, and spells from the story context. High
   creator value; builds on the encounter builder and the formation
   helpers.
4. **Value-budgeted treasure** (FR-14) — hoards that hit a requested
   value with storied, unique, magical items + art. The treasure half
   of FR-11.
5. **Mutable maps: layout ops + maze generator** (FR-12) — corridor
   carving, maze regions, seed re-rolls. The map itself becomes as
   editable as the rooms.
6. **Iterative refinement: regional overlays + scripted tile swaps**
   (FR-13) — water (or any theme) on a region, trap-door tile swaps
   fired by triggers. The hash-on-it loop.
7. **Theme packs + re-skin** (FR-2) — one new themed pack (gothic)
   proves the swap.
8. **Trigger zones → cutscene** (FR-4 link) + **multi-floor reveal**
   (FR-3) — the reveal mechanics.
9. **Lighting as a language** (FR-7) — timed transitions, named lights.
10. **Director mode** (FR-9) — v2, after the table has felt cutscenes.
11. **High-level floor generation** (FR-15) — the vague-brief mode:
    the floor planner + convergence loop + orchestration of the
    existing builders. The capstone: it only works once the pieces
    above exist, and it is the mode that makes the whole thing feel
    magical.
12. **Interactive dressing** (FR-16) — the dressing generator +
    click wiring: torches and candles the players can light and put
    out. Builds on the lighting language (FR-7) and the Pins module
    pattern.
13. **Sound** (FR-17) — effects + background music, once the asset
    question (where tracks come from, does the table want it) is
    answered.
14. **Mid-session emergent sequences** (FR-18) — the GM whispers an
    idea, Muse sets it up in seconds, it plays out in rounds: the
    round clock, rush-through movement, lights-out, wall-break.
    Builds on the cutscene engine, the encounter generator, and the
    lighting language — and it's the mode the table will feel most
    directly, so it goes right after the pieces it needs.

## How the system gets better (Brandon, Nov 19)

Two rules, every session:

1. **Reflect on the toolbox you have.** After each session, look at
   what was asked and what the toolbox could do today — what worked,
   what was missing, what was slow. The reflection is the work: it is
   how the next session gets better than this one.
2. **No tool is never a stop.** If a request has no tool in the
   toolbox, that doesn't stop anything — build the tool. If Brandon
   wants a one-off maze, write a little maze generator for it. If it
   turns out reusable, it joins the toolbox permanently ("add it to the
   toolbox, baby"). The toolbox grows by doing the work, not by
   planning it.

This is already how the project has gone tonight: the maze generator
started as a one-off answer to "a corridor and a small maze" and is now
a tool in the composer. The backlog is the toolbox's inventory — when a
one-off becomes a tool, it gets a line there.

**That is how MuseGM develops: trial and error and constant
improvement.** Build it, try it live at the table, see what breaks or
what's slow, fix it, build the next thing. The live session is the test
— the walkthrough demo each session is where the trial happens.

**The ideas are illustrations, not a build list (Brandon, Nov 19).**
The mice, the ogre, the tentacle — those are off-the-cuff ideas,
given to show the direction, not specific things to go build. The
deliverable is the toolkit: whatever tools Muse thinks it needs, so
that when the creator comes up with this kind of stuff in the future —
or anything else they might imagine — the tools are already there to
make it happen on the fly, as fast as possible, as reliable as
possible, as high quality as possible. The players are used to this
stuff having to be planned out weeks in advance; the experience MuseGM
is aiming for is the opposite — the GM thinks it, and it happens.
Every feature request in this document should be read that way: a
scenario is a test case for the toolbox, and the toolbox is the
product.

## Why this exists: the one-shot campaign (Brandon, Nov 19)

The group is stepping back after two multi-year, back-to-back
campaigns wrapping up. The next campaign is different: a series of
one-shots, where each person in the group GMs a one- or two-session
mini quest, under an overarching frame like Sliders or an isekai —
the party hops between worlds. The sessions have wildly different
themes: one session they're all dragons, fighting a big dragon battle
or playing dragon soccer; the next they're isekai'd into a western,
robbing banks and trains; the next it's a sci-fi battle with laser
guns.

That is what the toolkit is for. The creation tools have to be
flexible across genres, not just dungeon fantasy — themes are a
parameter everywhere (rooms, tiles, encounters, music), and a new
theme should be a pack, not a rebuild. And they have to be easy
enough for people who have never created a map or a campaign or run
a game as a GM. The bar is Scott: a first-time GM should be able to
run a session without reading the whole Game Master manual. The
vague-brief mode (FR-15) is the answer to that — he describes the
mini quest in plain language, Muse asks the real questions, shows
him the plan, and builds it. Heavy AI assistance is the point: the
GM brings the idea, the toolkit brings everything else.

**The GM never touches Foundry.** Scott shouldn't have to figure out
how to do things in Foundry at all. He talks to Muse, says what he
wants, and Muse helps him make it — the conversation *is* the
interface. And during the session it's the same: Muse does the
nitty-gritty assistance during combat and everything else, and Scott
just tells Muse what to do. The GM directs; Muse operates. That is
the bar for every tool in the kit: if it requires the GM to learn
Foundry's UI, it's the wrong shape — the tool should take a sentence
and do the Foundry work itself.
