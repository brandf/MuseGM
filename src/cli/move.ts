/**
 * move CLI — glide a token, or run the demo.
 *
 *   bun run src/cli/move.ts --scene <id|name> --token <name|id> --x 500 --y 600 [--speed 250] [--step 50]
 *   bun run src/cli/move.ts demo        # place a test Kobold Warrior on Otari, glide it, delete it
 *   bun run src/cli/move.ts tokens --scene <id|name>   # list tokens on a scene (current state)
 *
 * Prints JSON. Scene and token are resolved by _id or name against CURRENT
 * scene state — never trust an id from an earlier probe.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
const { FoundryLive: LiveClient } = await import("../live.js");
const movement = await import("../session/movement.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];

async function main(): Promise<void> {
  const live = await LiveClient.connect();
  try {
    let out: unknown;
    if (cmd === "tokens") {
      const scene = arg("--scene");
      if (!scene) throw new Error("tokens needs --scene <id|name>");
      const s = movement.resolveScene(live, scene);
      out = {
        scene: { id: s._id, name: s.name },
        tokens: movement.getSceneTokens(live, s._id).map((t) => ({ id: t._id, name: t.name, x: t.x, y: t.y })),
      };
    } else if (cmd === "demo") {
      // Safe demo: the Otari scene is inactive, so nothing here touches the
      // live game on Landing. Actor resolved by name at run time.
      const found = (await live.searchActors("Kobold Warrior")) as {
        actors?: { _id: string; name: string }[];
      };
      const actor = (found.actors ?? []).find((a) => a.name === "Kobold Warrior");
      if (!actor) throw new Error('Actor "Kobold Warrior" not found.');
      const scene = movement.resolveScene(live, "Otari");
      const tokenId = await movement.placeToken(live, scene._id, actor._id, 200, 200, {
        name: "Demo Kobold (move)",
      });
      // Our own creates are invisible in this connection's cache, so the
      // move gets the create-time position as its start (see TokenRef).
      const moved = await movement.moveTokenTo(
        live,
        scene._id,
        { id: tokenId, name: "Demo Kobold (move)", x: 200, y: 200 },
        800,
        200,
        { speed: 300 },
      );
      // Verify with a FRESH connection: our own moves are invisible in our
      // own cache too. The fresh read is the proof the token actually moved.
      await live.disconnect();
      const fresh = await LiveClient.connect();
      try {
        const after = movement.resolveToken(fresh, scene._id, tokenId);
        await movement.deleteToken(fresh, scene._id, tokenId);
        out = { scene: scene._id, tokenId, moved, finalPosition: { x: after.x, y: after.y }, cleanedUp: true };
      } finally {
        await fresh.disconnect();
      }
    } else {
      const scene = arg("--scene");
      const token = arg("--token");
      const x = Number(arg("--x") ?? "NaN");
      const y = Number(arg("--y") ?? "NaN");
      if (!scene || !token || Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error("usage: move --scene <id|name> --token <name|id> --x <n> --y <n> [--speed 250] [--step 50]");
      }
      out = await movement.moveTokenTo(live, scene, token, x, y, {
        speed: Number(arg("--speed") ?? "250"),
        stepPx: Number(arg("--step") ?? "50"),
      });
    }
    console.log(JSON.stringify(out));
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`move failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
