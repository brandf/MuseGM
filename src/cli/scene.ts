/**
 * scene CLI — build scenes, walls, lights, chests; or run the full demo.
 *
 *   bun run src/cli/scene.ts upload --file <local-image> --target worlds/testbed/maps
 *   bun run src/cli/scene.ts create --name "Cathedral" --image <local-file-or-server-path> --width 400 --height 300 [--grid 50]
 *   bun run src/cli/scene.ts walls --scene <id> --walls '[{"x1":0,"y1":0,"x2":400,"y2":0}]'
 *   bun run src/cli/scene.ts lights --scene <id> --lights '[{"x":200,"y":150,"dim":300,"bright":100}]'
 *   bun run src/cli/scene.ts chest --scene <id> --x 200 --y 150 [--name "Old Chest"] [--loot '[{"name":"Gold","price":50}]']
 *   bun run src/cli/scene.ts delete --scene <id> [--actor <loot-actor-id>]
 *   bun run src/cli/scene.ts demo            # full room build, prints ids
 *   bun run src/cli/scene.ts demo-cleanup --scene <id> [--actor <id>]
 *
 * Prints JSON. The demo builds a room and posts its description to chat;
 * it does NOT activate the scene (the GM's call).
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
import type { FoundryLive } from "../live.js";
const { FoundryLive: LiveClient } = await import("../live.js");
const wb = await import("../worldbuilding/index.js");
const { uploadImage } = await import("../worldbuilding/upload.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];

async function main(): Promise<void> {
  const live = await LiveClient.connect();
  try {
    let out: unknown;
    switch (cmd) {
      case "upload": {
        const file = arg("--file");
        const target = arg("--target") ?? "worlds/testbed/maps";
        if (!file) throw new Error("upload needs --file <local-image>");
        out = await uploadImage(file, target);
        break;
      }
      case "create": {
        const name = arg("--name");
        const image = arg("--image");
        const width = Number(arg("--width") ?? "0");
        const height = Number(arg("--height") ?? "0");
        if (!name || !image || !width || !height) {
          throw new Error('create needs --name --image --width --height');
        }
        const sceneId = await wb.createSceneFromImage(live, {
          name,
          imagePath: image,
          width,
          height,
          gridSize: Number(arg("--grid") ?? "100"),
        });
        out = { sceneId };
        break;
      }
      case "walls": {
        const sceneId = arg("--scene");
        const walls = JSON.parse(arg("--walls") ?? "[]");
        if (!sceneId) throw new Error("walls needs --scene <id> --walls '[...]'");
        out = { wallIds: await wb.addWalls(live, sceneId, walls) };
        break;
      }
      case "lights": {
        const sceneId = arg("--scene");
        const lights = JSON.parse(arg("--lights") ?? "[]");
        if (!sceneId) throw new Error("lights needs --scene <id> --lights '[...]'");
        out = { lightIds: await wb.addLights(live, sceneId, lights) };
        break;
      }
      case "chest": {
        const sceneId = arg("--scene");
        const x = Number(arg("--x") ?? "0");
        const y = Number(arg("--y") ?? "0");
        if (!sceneId) throw new Error("chest needs --scene <id> --x <n> --y <n>");
        const loot = JSON.parse(arg("--loot") ?? "[]");
        out = await wb.addChest(live, sceneId, {
          x,
          y,
          name: arg("--name") ?? "Old Chest",
          loot,
        });
        break;
      }
      case "delete": {
        const sceneId = arg("--scene");
        if (!sceneId) throw new Error("delete needs --scene <id>");
        await wb.deleteScene(live, sceneId);
        const actorId = arg("--actor");
        if (actorId) await wb.deleteActor(live, actorId);
        out = { deleted: true, sceneId };
        break;
      }
      case "demo": {
        out = await demo(live);
        break;
      }
      case "demo-cleanup": {
        const sceneId = arg("--scene");
        if (!sceneId) throw new Error("demo-cleanup needs --scene <id>");
        await wb.deleteScene(live, sceneId);
        const actorId = arg("--actor");
        if (actorId) await wb.deleteActor(live, actorId);
        out = { cleaned: true, sceneId };
        break;
      }
      default:
        throw new Error(`unknown command: ${cmd ?? "(none)"}`);
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } finally {
    await live.disconnect();
  }
}

async function demo(live: FoundryLive): Promise<Record<string, unknown>> {
  const built = await wb.buildRoom(live, {
    name: "Meroki Test Cathedral (demo)",
    imagePath: "/tmp/test-map.png",
    width: 400,
    height: 300,
    gridSize: 50,
    description:
      "A small candle-lit cathedral. Dust hangs in the torchlight, and a stone chest sits beneath the altar.",
    lights: [
      { x: 100, y: 75, dim: 250, bright: 100, color: "#ff9a3c" },
      { x: 300, y: 225, dim: 250, bright: 100, color: "#7ec8ff" },
    ],
    chest: {
      x: 200,
      y: 150,
      name: "Altar Chest (demo)",
      loot: [
        { name: "Gold Pieces", type: "treasure", price: 50, quantity: 1 },
        { name: "Healing Potion", type: "consumable", price: 12, quantity: 2 },
      ],
    },
  });
  return {
    sceneId: built.sceneId,
    wallIds: built.wallIds,
    lightIds: built.lightIds,
    chest: built.chest,
  };
}

main().catch((err) => {
  process.stderr.write(`scene failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
