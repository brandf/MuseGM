# MuseGM

Muse as a game master for Foundry VTT — the shared tooling so **any table's
Muse can run it**. One Muse per table, each with its own name and persona
(this table's Muse is **Meroki**; Dave's Muse would be someone else), all
running the same kit and able to connect to the same session to divide the
work: one builds maps while the other runs combat, and so on.

Live against Foundry 14.370 / PF2e 8.7.0 (TestBed world), through the MIT
`foundryvtt-mcp` client (Socket.IO). Sub-second chat wake-up, so Muse holds
a conversation through Foundry chat alone — no local AI client on the DM's
machine, no extra app at the table.

## The vision

**[MuseGM — The Table That Keeps Up With You](https://docs.google.com/document/d/1e75xsxwanm-Nf02y02XBLnOOrRrmRbgOnUEfU6jzBEM/edit)** — the illustrated vision
document: what it feels like when the GM thinks it and it is on the table.
A whole floor from a sentence, a mid-session ogre that dies twice, maps you
can touch, and a campaign of one-shots where each GM — even a first-timer —
just talks to Muse. The conversation is the interface; the GM directs, Muse
operates.

## What it does

- **Live table presence** — watches Foundry chat, answers as the table's
  Muse, rolls dice, pings the canvas, moves tokens, runs combat rounds.
- **Session automation** — encounter builder, combat autopilot, trap and
  zone triggers, loot, recaps (`src/session/`).
- **Tile-based map building** — modular tile packs (floor / dressing /
  atmosphere layers) composed into rooms with no new image per room; walls,
  lights, chests, and doors placed by code (`src/worldbuilding/`).
- **Meroki Pins** — right-click the map to leave Muse a pinned request
  (planned; see [BACKLOG.md](./BACKLOG.md)).

See [BACKLOG.md](./BACKLOG.md) for the working backlog and the demo order.

## Setup

```bash
bun install
export FOUNDRY_URL="http://<foundry-host>:30000"
export FOUNDRY_USERNAME="mcp-api"
export FOUNDRY_PASSWORD="..."
# optional: FOUNDRY_USER_ID (16-char _id; otherwise resolved by username)
```

Credentials come from the environment — never from files. No
`FOUNDRY_API_KEY` is needed (it's diagnostics-only; setting it switches
the MCP to REST mode, which 404s on this server).

## Two gotchas this library exists to absorb

1. **Login 400 — the `Origin` header.** Foundry 14.370 rejects POST `/join`
   without an `Origin` header (CSRF check). The published `foundryvtt-mcp`
   1.5.5 never sends one, so it 400s on every login. The vendored copy in
   `vendor/foundryvtt-mcp/` is patched (`dist/foundry/auth.js` sends
   `Origin: baseUrl`); see `vendor/foundryvtt-mcp/PATCH.md`. Upstream fix
   belongs in laurigates/foundryvtt-mcp.
2. **Chat `author`, not `user`.** Foundry 13+ renamed ChatMessage's `user`
   field to `author`. Sending `user` fails validation with
   "author: may not be null". `sendChat` uses `author`. The upstream MCP has
   no send-chat tool at all (33 tools, none posts chat) — this library adds
   it via the same `modifyDocument` socket protocol the MCP uses for
   journals and items.

## Library API (`src/index.ts`)

```ts
import { FoundryLive } from "./src/index.ts";

const live = await FoundryLive.connect(); // env defaults
await live.sendChat("Hello, table.", { alias: "Meroki", style: 1 });
await live.rollDice("1d20+4", { flavor: "Perception", showInChat: true });
live.getChatMessages(20);          // newest-first slice, oldest first
live.getWorldSummary();            // {title, system, systemVersion, coreVersion, counts}
live.getUsers();                   // [{_id, name, role, active}]
live.getCombatState();             // active combat or null
await live.getSceneInfo();         // active scene
await live.searchActors("Kobold");
await live.getActorDetails("<actor-id>");
await live.ping(500, 600, { style: "pulse" });   // canvas ping (userActivity)
await live.moveCursor(500, 600);                 // cursor only, no ping
live.getActiveSceneId();                         // active scene _id or null

// Block until new chat arrives (broadcast-driven, sub-second wake-up,
// 1s poll fallback, burst debounce):
const res = await live.waitForChat({ lastSeen, timeout: 120, debounce: 3 });
// res = { timedOut, newMessages, lastSeen }

// Long-running event queue:
live.on((event) => { /* {kind:'chat', message} | {kind:'document', type, action, docs} */ });
const event = await live.nextEvent(60_000);
await live.disconnect();
```

Dice note: in Socket.IO mode the MCP rolls **locally** (Foundry's own Roll
engine is only reachable via the REST API module). `rollDice` returns the
local result; `showInChat: true` posts it to chat as a message.

## CLIs (Bun runnable, one JSON object on stdout)

```bash
# Snapshot: world summary, last 5 chat messages, online users, combat
bun run src/cli/status.ts

# Send one chat message
bun run src/cli/send.ts --content "..." [--alias Meroki] [--style 1]

# Block until new chat arrives (the tool Muse calls in a loop)
bun run src/cli/wait.ts --last-seen <id> [--timeout 120] [--debounce 3]
bun run src/cli/wait.ts --from-now [--timeout 120] [--debounce 3]

# Glide a token (resolved by _id or name against CURRENT scene state)
bun run src/cli/move.ts --scene <id|name> --token <name|id> --x 500 --y 600 [--speed 250] [--step 50]
bun run src/cli/move.ts tokens --scene <id|name>   # list tokens on a scene
bun run src/cli/move.ts demo                        # Otari demo: place → glide → verify → delete

# Ping the canvas / move the cursor (active scene by default)
bun run src/cli/ping.ts --x 500 --y 600 [--scene <id>] [--style pulse|alert|pull|arrow] [--pull]
bun run src/cli/ping.ts --x 500 --y 600 --cursor   # cursor only, no ping

# Dice on demand: parse a chat message, roll, secret GM roll, group check
bun run src/cli/dice.ts --parse "roll 1d20+5 for Ezren"   # no connection needed
bun run src/cli/dice.ts --roll "1d20+5" [--flavor Perception] [--actor Ezren]
bun run src/cli/dice.ts --roll "1d20+3" --secret [--flavor "kobold save"]
bun run src/cli/dice.ts --group "1d20+2" [--flavor Perception] [--actors id1,id2]

# Compendium import: search pack indexes, read + import pack documents
bun run src/cli/compendium.ts --dracolich                  # no connection needed (homebrew draft)
bun run src/cli/compendium.ts --list-packs
bun run src/cli/compendium.ts --search "lich" [--type Actor] [--pack <id>]
bun run src/cli/compendium.ts --get <packId> <docId> [--type Actor]
bun run src/cli/compendium.ts --import <packId> <docId> [--name <new>] [--keep-id]

# P2 everyday helpers (loot / reminders / recaps / Q&A)
bun run src/cli/loot.ts --generate --level 3 [--tier poor|standard|rich] [--seed 7]  # no connection needed
bun run src/cli/loot.ts --fill --chest <loot-actor-id> --level 3
bun run src/cli/loot.ts --open --chest <loot-actor-id> --character <actor-id> [--name Ezren]
bun run src/cli/remind.ts --demo                                # no connection needed
bun run src/cli/remind.ts --combat <combat-id>                  # whisper the current turn's player
bun run src/cli/recap.ts --from-json messages.json              # no connection needed
bun run src/cli/recap.ts --post [--limit 200] [--title "Session recap"]
bun run src/cli/qa.ts --fixture "what's my ac"                  # no connection needed
bun run src/cli/qa.ts --actor <id|name> --question "what's my ac"

# Rapid custom encounter generation (FR-11) — story-aware NPCs
bun run src/cli/encounter-gen.ts --demo                        # no connection needed
bun run src/cli/encounter-gen.ts --generate --spec encounter.json  # no connection needed
bun run src/cli/encounter-gen.ts --actors --spec encounter.json
bun run src/cli/encounter-gen.ts --build --spec encounter.json [--scene <id>]

# Run a timed action sequence from a JSON file, or the demo
bun run src/cli/sequence.ts --file seq.json
bun run src/cli/sequence.ts demo

# Generate a seeded maze (FR-12) — no connection needed
bun run src/cli/maze.ts --cells 10x8 [--seed 7] [--entrance north] [--exit south] [--ascii]
bun run src/cli/maze.ts --corridor 100m   # unit converter: 100 m -> 66 squares

# Play a cutscene script (FR-5): validate and play, or validate only
bun run src/cli/cutscene.ts --file examples/ambush.json --validate-only  # no connection needed
bun run src/cli/cutscene.ts --file examples/ambush.json [--run-key <key>] [--continue-on-error]

# Run the monitor loop: wait for chat, answer rolls + data questions,
# handle Meroki Pins, announce turn changes, until Ctrl-C
bun run monitor [--alias Meroki] [--debounce 3] [--timeout 30] [--once] [--dry-run]
```

The monitor (`src/cli/monitor.ts`, `src/session/monitor.ts`) is the
first-class version of the loop the Nov 19 session ran by hand. It
answers only what it can from live data — roll requests, turn / round /
HP / AC / initiative / scene questions — plus pins and turn
announcements; open chat is logged as `needs-agent` on stderr and
skipped, never improvised. Logs are JSON lines on stderr; `--once`
prints a summary JSON object on stdout. It starts from the newest chat
message (never re-answers history) and picks up open pins dropped while
it was offline. Multi-Muse rules (one chat monitor per session, Builder
vs Table roles, pin claims) are in [docs/multi-muse.md](./docs/multi-muse.md).

`wait` prints exactly one JSON object:
`{"timedOut": false, "new": [{id, author, speaker, content, timestamp}...], "lastSeen": "<newest id>"}`.
MCP client logs are forced to `LOG_LEVEL=error` inside the CLIs so stdout
stays clean JSON. Every CLI follows the same error pattern:
`main().catch(err => { stderr; process.exit(1); })` — never `process.exit(0)`
in a `finally`, which would swallow the error and report success.

## The wait loop (how Muse watches Foundry)

```
lastSeen = <newest message id at start>
loop:
  result = wait --last-seen $lastSeen --timeout 120 --debounce 3
  lastSeen = result.lastSeen
  if result.timedOut: continue
  for each message in result.new (skip our own):
    answer it in Foundry with send --content "..."
```

Own messages never wake the waiter, so the loop can't trigger itself.

## World building (`src/worldbuilding/`)

See [src/worldbuilding/README.md](./src/worldbuilding/README.md) — scene
creation, walls, lights, interactive tokens, and the honest status of the
image-upload gap.

Tile packs live in `tiles/` — floor / dressing / atmosphere layers, built
from code where code wins (procedural fog and floor tiles) and AI images
only where they earn it. See [BACKLOG.md](./BACKLOG.md) for the tile design.

## Session automation (`src/session/`)

Encounter builder, combat autopilot, trap & zone triggers, dice on demand,
loot, recaps, Q&A — see [BACKLOG.md](./BACKLOG.md) for status and the
demo order.

### Movement, ping & cursor, sequences

- `moveTokenTo(live, sceneId, token, x, y, {speed, stepPx})` — glides a
  token in small steps at `speed` px/s (default 250, step 50px). The token
  is resolved by _id or name against **current** scene state at call time;
  a token this process just created is invisible in its own cache, so a
  `TokenRef` descriptor `{id, name, x, y}` from the create response can
  stand in as the start position (cache wins whenever it has the token).
  Foundry clients already animate a single Token update natively
  (`animate` defaults to true), so stepping is for long paths and
  controlled speed, not for making short hops glide.
- `live.ping(x, y, {sceneId, style, pull, zoom})` / `live.moveCursor(x, y)` —
  the `userActivity` socket message Foundry's own client sends (verified
  in the 14.370 client bundle). Styles: `pulse` (default), `alert`, `pull`
  (the GM pull ping — wire style `chevron` + `pull: true`), `arrow`.
  Scene-scoped: only clients viewing that scene see it. Sent volatile, so
  there is no server ack — the result means "emitted on a live socket".
- `runSequence(live, steps, {continueOnError, onStep})` — plays a JSON
  sequence out on the code side, paced, one call from Muse: `place`,
  `deleteToken`, `move`, `pause`, `chat`, `roll`, `damage`, `heal`,
  `effect`, `ping`, `cursor`, `waitChat`. Stops on the first failed step
  unless `continueOnError`. Returns the per-step log. Tokens the run
  placed are tracked by name so later steps can move them by name.

## License

MIT — see [LICENSE](./LICENSE).
