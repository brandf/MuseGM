# Compendium import — research note

**Status:** research + code built offline Nov 20, 2026. **No live test yet** —
Dave's Foundry was off. The read path below is verified in code and in an
independent implementation, but has not been run against TestBed (14.370).

## The problem

The monitor searched all 101 pack indexes on Nov 19 (via
`worldData.packs[].index`): **29 lich, 666 dragon, 0 dracolich**. There is
no Dracolich in the installed books, and no way to pull *any* of them into
the world — the MCP's `searchCompendium` returns 0 results for everything
and there is no import tool.

## What was verified

Each claim is labeled by how it was verified. "VERIFIED IN CODE" means read
in the vendored MCP client or this library. "VERIFIED IN AN INDEPENDENT
IMPLEMENTATION" means read in another project's source (Pelmog/foundry-mcp,
MIT, v13-tested; TheStranjer FoundryMCP documents the same pattern).
"VERIFIED LIVE" means observed against TestBed on Nov 19. Everything else
is labeled NEEDS LIVE.

### VERIFIED IN CODE — why `searchCompendium` returns nothing

`vendor/foundryvtt-mcp/dist/foundry/client.js:675` (`searchCompendium`):
without `FOUNDRY_API_KEY` it returns
`{ results: [], total: 0, restAvailable: false }` — a graceful empty, not
an error. With a key it GETs `/api/compendium/search` on the REST API
module, which Dave removed from his Foundry on Nov 19. The handler
(`dist/tools/handlers/compendium.js`) says so itself. **The search was
never broken — it was REST-gated, and the REST module is gone.** There is
no way to make it work without reinstalling that module.

### VERIFIED IN CODE — the client only speaks three socket events

Grep of `dist/foundry/client.js`: the client emits only `world`,
`modifyDocument`, and `userActivity`. There is no compendium-read event in
the client. The upstream authors concluded from this that a compendium
read is impossible over Socket.IO — `createActorItem` (client.js:767)
says: *"Compendium sources are NOT yet supported over Socket.IO — copying
a pack entry needs a compendium read that `modifyDocument` does not
provide (tracked in issue #159)."* **That conclusion is wrong.** See below.

### VERIFIED IN CODE — `modifyDocument` takes a `pack`

`modifyDocument` (client.js:748) builds
`{ type, action, operation: { broadcast: true, pack: null, modifiedTime:
Date.now(), ...operation } }`. The `pack: null` default is overridden by
any `pack` in the operation, and the action is only *typed* as
`"create" | "update" | "delete"` — at runtime any action string passes
through to the socket. The server-side dispatch (`SocketInterface`,
verified in the fvtt-types v13 definitions) accepts
`DocumentSocketRequest | ManageCompendiumRequest`; the manage request is
create/delete *packs* only, so a document read is a `DocumentSocketRequest`
action — the same family as the writes this library already does.

### VERIFIED IN AN INDEPENDENT IMPLEMENTATION — `modifyDocument` "get" reads packs

Pelmog/foundry-mcp (`foundry-mcp-server/lib/tools/compendiums.mjs`,
`lib/foundry-socket.mjs`) documents the operation shapes:

```
get:    { query, pack }
create: { data: [...], pack }
update: { updates: [...], diff, pack }
delete: { ids: [...], pack }
```

and reads a pack with:

```js
socket.modifyDocument('get', type, { query: {}, pack, ...(full ? {} : { index: true }) });
```

`response.result` is the array of documents (or index entries with
`index: true`). TheStranjer's FoundryMCP documents the same `pack` read
pattern (`get_actors` etc. take an optional `pack` parameter). Both
projects read pack contents over the plain socket with no REST module and
no browser client.

### VERIFIED LIVE — the pack indexes are already in the `world` payload

The monitor's `/tmp/draco-index.mjs` (Nov 19) read
`client.worldData.packs` — 101 packs, each with an `index` array
(`_id`, `name`, `type`, `img`, ...). The `WorldDataSchema`
(client.js:130) validates only the listed world arrays; `packs` is extra
data that survives because the client keeps the raw payload. Pelmog's
comment agrees: "getJoinData carries every pack (world, system and
modules) at the top level as `packs`". **Searching by name needs no round
trip at all** — the index is already in memory from connect.

## The recommended import path

1. **Search** — `searchPackIndex` over `worldData.packs[].index` (pure
   function, no I/O). Find the entry by name, optionally scoped to a pack
   or document type.
2. **Read the full document** — `modifyDocument("Actor", "get",
   { query: { _id: "<docId>" }, pack: "<packId>" })`. This is the step
   that needs live confirmation (L1 below).
3. **Map** — `mapCompendiumActorToWorld`: drop the pack `_id` (fresh world
   id; `keepId: true` preserves it), drop the pack `folder` (pack folder
   ids don't exist in the world), keep `name/type/img/system/
   prototypeToken/flags`, split embedded `items` out.
4. **Create** — Actor create, then one Item create per embedded item with
   `parentUuid: Actor.<newId>` — the same two-step pattern the chest
   builder (`src/worldbuilding/index.ts`, `addChest`) already proves.
5. **Place** (optional) — the existing `placeToken` from
   `src/session/movement.ts`.

Implemented in `src/session/compendium.ts` (`getPackDocument`,
`importPackActor`, `searchPackIndex`, `mapCompendiumActorToWorld`) with
CLI `src/cli/compendium.ts` and unit tests `tests/compendium.test.ts`.

## What still needs a live Foundry (14.370) to confirm

- **L1 — the "get" action works on 14.370.** Pelmog tested v13; the
  protocol is core Foundry and the v13/v14 type definitions agree, but it
  has not been run against this server. First live test:
  `bun run src/cli/compendium.ts --get <packId> <docId>`.
- **L2 — the result envelope.** Expect `response.result` to be the array
  of documents (Pelmog resolves `response?.result ?? response`). If the
  shape differs on v14, the wrapper needs adjusting — the raw response is
  printed by `--get` for diagnosis.
- **L3 — the query shape for one document.** `query: { _id: "<id>" }`
  follows the compendium `Query` type (`_id`, `_id__in`, `name`, ...). If
  a bare `_id` query returns nothing, try `{ _id__in: ["<id>"] }`.
- **L4 — permissions.** The read runs as the `mcp-api` user. PF2e SRD
  packs are normally OBSERVER-visible to all players, but if a pack is
  GM-only the get will fail — the error will say so; that pack then needs
  Dave to open its permissions (or the GM user to do the import).
- **L5 — index completeness.** The monitor counted entries in the join
  payload's indexes, but whether that index is the *complete* pack index
  (vs a capped/default-fields subset) is unproven. If a search misses an
  entry Dave can see in the compendium sidebar, fall back to
  `--get` with `index: true` via a fresh `get` call, which asks the server
  for the index directly.
- **L6 — Actor create with embedded items in one call is untested.**
  The implementation uses the proven two-step path (Actor, then Items),
  so this doesn't block anything.

## What this does NOT do

- No REST module, no API key, no new module on Dave's Foundry, no
  browser client. The whole path is the socket the library already holds.
- No bulk pack dump by default: `query: {}` returns the whole pack, which
  for a 1000-entry SRD pack is tens of MB. Always scope by `_id` (or a
  narrow query) unless Dave explicitly asks for a whole pack.

## The Dracolich case

**What exists in the books:** nothing named Dracolich (0 hits across all
101 indexes, live count Nov 19). What exists: 29 lich entries and 666
dragon entries. The PF2e Lich is a 12th-level creature; adult dragons are
in the same tier.

**Recommended: import the Lich, then customize.** Import the Lich actor
from its pack, then apply the draconic patch
(`applyDracolichPatch` in `src/session/compendium.ts`): rename to
Dracolich, creature type Dragon, size Large, flight 60, and a necrotic
breath strike. The base stats come from the book; only the dragon parts
are homebrew, and they are labeled as such in the code.

**Fallback if import stays blocked:** `DRACOLICH_DRAFT` in
`src/session/compendium.ts` is a full minimal PF2e NPC actor JSON
(level 12, Large, HP 210, AC 32, jaws/claws/necrotic breath) — **every
number in it is homebrew, chosen as a draft, not book data**. Print it
with `bun run src/cli/compendium.ts --dracolich` (no connection needed).

**Level warning — read this before using it in a fight:** the party is
level 1–2 (Menace Under Otari / Beginner Box). A level 12 Dracolich is
not an encounter for them, it's a cutscene or a future boss — it would
one-shot the whole table. If Dave wants a dracolich the party can
actually fight *now*, scale the draft down (level 5, HP ~70, AC ~22) via
the same patch mechanism, or use it as a looming threat the party sees
but doesn't fight. This is Dave's call, not Muse's — don't drop a
level 12 into a level 1 fight unannounced.

## Sources

- Vendored MCP: `vendor/foundryvtt-mcp/dist/foundry/client.js`
  (`searchCompendium` ~L675, `modifyDocument` ~L748,
  `createActorItem` ~L767, `WorldDataSchema` ~L130),
  `dist/tools/handlers/compendium.js`
- Monitor probes (surviving in /tmp): `draco-index.mjs`,
  `draco-search.mjs`, `draco-search2.mjs`, `lich-list.mjs`
- Pelmog/foundry-mcp (MIT): `foundry-mcp-server/lib/tools/compendiums.mjs`,
  `lib/foundry-socket.mjs` — the "get" action and the pack read
- fvtt-types v13 (`@league-of-foundry-developers/foundry-vtt-types`
  13.346.0-beta): `SocketInterface.dispatch`,
  `CompendiumCollection.ManageCompendiumRequest`, compendium `Query` type
- Foundry v14 API docs (`foundryvtt.com/api/.../foundry.documents.html`):
  `fromUuid`, `pack.getDocument`, `game.actors.importFromCompendium`
