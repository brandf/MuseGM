# World building — `src/worldbuilding/`

Build a scene from a map image — walls, lights, an openable chest — through
the same `modifyDocument` socket protocol the rest of `foundry-live` uses.
Nothing here activates a scene on its own: activation switches the whole
table's view, so that stays the GM's call (`activateScene` exists for when
the GM says go).

## What it does

| Function | What it builds |
|---|---|
| `createSceneFromImage(live, {name, imagePath, width, height, gridSize?})` | A Scene. A local `imagePath` is uploaded first; a server-relative path is used as-is. Returns the scene `_id`. |
| `addWalls(live, sceneId, walls[])` | Wall embeds: `{x1, y1, x2, y2, door?}` — `door` 0 = wall, 1 = door, 2 = secret door. Returns wall `_id`s. |
| `addLights(live, sceneId, lights[])` | AmbientLight embeds: `{x, y, dim, bright, angle?, color?}`. Returns light `_id`s. |
| `addChest(live, sceneId, {x, y, name?, loot?})` | A `loot`-type Actor holding the loot Items + a linked Token on the scene. Returns `{actorId, tokenId, itemIds}`. |
| `buildRoom(live, opts)` | The whole room in one call: scene + rectangle walls + lights + chest + a room-description post to chat. Returns `{sceneId, wallIds, lightIds, chest}`. |
| `activateScene(live, sceneId)` | Switches the table to the scene. GM's call only. |
| `deleteScene(live, sceneId)` / `deleteActor(live, actorId)` | Cleanup (deleting a scene takes its walls/lights/tokens with it). |

## The image-upload gap — closed

The MCP has no upload tool, but Foundry itself does: the FilePicker posts a
multipart form to `POST <base>/upload` with `source=data`, `target=<folder>`,
`upload=<file>`, authenticated with the session cookie from the login flow
plus an `Origin` header (the same CSRF check that broke `POST /join` on
14.370). `src/worldbuilding/upload.ts` (`uploadImage`) does exactly that.

Verified live Nov 19 against TestBed: a 400×300 PNG uploaded to
`worlds/testbed/` GETs back byte-identical at the returned path.

One constraint, found live: **the target folder must already exist** — the
server will not create nested folders (`worlds/testbed/meroki-test` failed
with "Target directory … does not exist"). Uploads go to the world folder
itself, which always exists. A new subfolder has to be created once in the
FilePicker by the GM.

## The scene background — the honest version

Foundry 14 stores the map under `background.src`, not `img`. `img` is
legacy and is **silently dropped on create** — the first demo scene was
created with `img` only and came back with no background at all. The fix
(Nov 19): send `background: {src}` (plus `img` for older clients).

Verification caveat: the `worldData` snapshot the MCP keeps **never exposes
`img`/`background` for any scene** — not even Floor 1, which definitely has
a map. So the background cannot be verified by reading the scene back.
What was verified live Nov 19:

- Scene updates flow: an update carrying `background: {src}` **and** a name
  change came back echoing the new name, and the new name was visible on a
  fresh snapshot — same update, no error, so the `background.src` write was
  accepted by the server.
- The rebuilt demo scene (walls/lights/chest) was verified in the fresh
  snapshot; the background itself needs the GM to open the scene once and
  confirm the map is showing. Until then it is "set per the v14 schema",
  not "seen on screen".

## Chest interactivity — the PF2e route that works

A chest is a Token linked to a `loot`-type Actor holding Item documents.
Players open the token, the loot sheet opens, and they take items onto
their own sheets. That is the native PF2e loot flow. The alternatives were
evaluated and rejected: a journal entry is text-only (nothing to open),
and a loot-table roll is a one-off, not an openable chest. The chest image
is the core icon `icons/containers/chest/chest-wooden-tied-white.webp`.

## CLI

```bash
# Demo: builds a 400x300 cathedral room (walls, 2 lights, chest with
# 50gp + 2x Healing Potion), posts the room description to chat.
bun run src/cli/scene.ts demo

# Clean up a demo scene and its chest actor afterwards.
bun run src/cli/scene.ts demo-cleanup --scene <sceneId> --actor <actorId>
```

The demo scene is **not** activated — the GM activates it when ready.

## Live test (Nov 19)

- Upload: `/tmp/test-map.png` (400×300) → `worlds/testbed/test-map.png`,
  GET back 200, bytes identical.
- Demo (after the `background.src` fix): scene `jVdOQQadiQMeqP5V`
  ("Meroki Test Cathedral (demo)"), 4 walls, 2 lights, chest loot actor
  `rj4RJ4Gb3ZWspxGr` with Gold Pieces 50gp + Healing Potion ×2, token
  `eDRR1pnaOscq20Jd` at 200,150 — all confirmed in a fresh snapshot
  (embedded `walls: 4, lights: 2, tokens: 1`). Room description posted to
  chat. Demo scene + chest actor then deleted; world back to 4 scenes /
  31 actors.
- Background: set via `background.src`, accepted by the server (see the
  caveat above); needs a one-time visual confirmation by the GM.
