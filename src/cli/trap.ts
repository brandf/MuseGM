/**
 * trap CLI — watch zones and fire traps, or run a self-contained live demo.
 *
 * Watch zones from a JSON file (see src/session/traps.ts for the format;
 * cutscene actions may name a script file — resolved and validated
 * before watching, see src/session/zone-cutscene.ts):
 *   bun run src/cli/trap.ts --zones zones.json [--seconds 120]
 *   -> {"fires": [{zone, tokenId, tokenName, actorId, at}]}
 *
 * Staircase reveals (FR-3): a zones file may carry `reveal-floor`
 * actions; the watcher needs a dungeon to reveal into — pass it as
 * JSON (see parseBuiltDungeon in src/worldbuilding/floors.ts for the
 * shape) plus an optional gate-state file:
 *   bun run src/cli/trap.ts --zones zones.json --dungeon dungeon.json [--gate-state gates.json] [--seconds 120]
 * With no --dungeon, a reveal-floor zone posts a chat line saying the
 * reveal is not wired and does nothing.
 *
 * Validate a zones file offline — no connection, prints the trigger
 * plan (one entry per cutscene-linked zone, plus the floor reveals)
 * and exits non-zero on any error:
 *   bun run src/cli/trap.ts --zones zones.json --plan
 *
 * Live demo (creates a test token, moves it into a trap zone, verifies the
 * fire, then cleans up):
 *   bun run src/cli/trap.ts --demo
 *   -> {"fired": true, "token": "<id>", "hpBefore": 16, "hpAfter": 11, "chatId": "<id>"}
 *
 * Args are parsed (and --help / --plan handled) BEFORE the library is
 * imported — importing live.js validates FOUNDRY_URL at import time,
 * so the offline paths must never import it. LOG_LEVEL is forced to
 * error before the library import so the vendored client's info logs
 * don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
import type { FoundryLive } from "../live.js";
import * as fs from "node:fs";
import * as nodePath from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

const USAGE =
  "usage: trap --zones zones.json [--seconds 120] [--plan]\n" +
  "       trap --zones zones.json --dungeon dungeon.json [--gate-state gates.json] [--seconds 120]\n" +
  "       trap --demo\n" +
  "       trap --help";

/**
 * Read + resolve + plan a zones file. Cutscene paths resolve against
 * the zones file's own directory. Throws with every error listed.
 */
async function resolveZonesFile(zonesFile: string): Promise<{
  zoneSet: import("../session/traps.js").ZoneSet;
  plan: import("../session/zone-cutscene.js").ZoneCutscenePlanSet;
  reveals: import("../worldbuilding/floors.js").FloorRevealPlan[];
}> {
  const { resolveZoneSet, planZoneCutsceneSet } = await import("../session/zone-cutscene.js");
  const { planFloorReveals } = await import("../worldbuilding/floors.js");
  const parsed: unknown = JSON.parse(fs.readFileSync(zonesFile, "utf-8"));
  const dir = nodePath.dirname(nodePath.resolve(zonesFile));
  const resolved = resolveZoneSet(parsed, (p) => fs.readFileSync(nodePath.resolve(dir, p), "utf-8"));
  if (!resolved.ok) {
    throw new Error(`invalid zones file ${zonesFile}:\n- ${resolved.errors.join("\n- ")}`);
  }
  const planned = planZoneCutsceneSet(resolved.zoneSet);
  if (!planned.ok) {
    throw new Error(`cannot plan zones file ${zonesFile}:\n- ${planned.errors.join("\n- ")}`);
  }
  return { zoneSet: resolved.zoneSet, plan: planned.plan, reveals: planFloorReveals(resolved.zoneSet).reveals };
}

async function main(): Promise<void> {
  if (has("--help")) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  const zonesFile = arg("--zones");
  if (has("--plan")) {
    if (!zonesFile) throw new Error(USAGE);
    const { plan, reveals } = await resolveZonesFile(zonesFile);
    process.stdout.write(JSON.stringify({ ok: true, ...plan, floorReveals: reveals }, null, 2) + "\n");
    return;
  }
  const { FoundryLive: LiveClient } = await import("../live.js");
  const { TrapWatcher } = await import("../session/traps.js");
  const live = await LiveClient.connect();
  try {
    if (has("--demo")) {
      const out = await demo(live as never);
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }
    if (!zonesFile) throw new Error(USAGE);
    const { zoneSet, plan, reveals } = await resolveZonesFile(zonesFile);
    const cutsceneLinks = plan.links.length;
    process.stderr.write(
      `trap: armed ${zoneSet.zones.length} zone(s) on scene ${zoneSet.sceneId}` +
        (cutsceneLinks > 0
          ? ` — ${cutsceneLinks} cutscene link(s): ${plan.links.map((l) => `${l.zone} -> ${l.cutsceneName} (${l.mode})`).join(", ")}\n`
          : "\n"),
    );
    // FR-3: wire a dungeon so reveal-floor zones fire for real.
    let floorRevealPlayer: import("../session/traps.js").FloorRevealPlayer | undefined;
    const dungeonFile = arg("--dungeon");
    if (dungeonFile) {
      const { FloorSession, parseBuiltDungeon, parseGateState } = await import("../worldbuilding/floors.js");
      const parsedDungeon = parseBuiltDungeon(JSON.parse(fs.readFileSync(dungeonFile, "utf-8")));
      if (!parsedDungeon.ok) {
        throw new Error(`invalid dungeon file ${dungeonFile}:\n- ${parsedDungeon.errors.join("\n- ")}`);
      }
      let gateState;
      const gateFile = arg("--gate-state");
      if (gateFile) {
        const parsedGates = parseGateState(JSON.parse(fs.readFileSync(gateFile, "utf-8")));
        if (!parsedGates.ok) {
          throw new Error(`invalid gate-state file ${gateFile}:\n- ${parsedGates.errors.join("\n- ")}`);
        }
        gateState = parsedGates.state;
      }
      const session = new FloorSession(parsedDungeon.dungeon, { gateState });
      floorRevealPlayer = session.revealPlayer();
      process.stderr.write(
        `trap: floor session wired — ${parsedDungeon.dungeon.rooms.length} room(s), ` +
          `${parsedDungeon.dungeon.stairs.length} staircase(s)` +
          (reveals.length > 0 ? `, ${reveals.length} reveal zone(s)\n` : "\n"),
      );
    } else if (reveals.length > 0) {
      process.stderr.write(
        `trap: ${reveals.length} reveal-floor zone(s) with no --dungeon — they will post "not wired" and do nothing\n`,
      );
    }
    const watcher = new TrapWatcher(live, zoneSet, 100, { floorRevealPlayer });
    const fires = await watcher.watch({ seconds: Number(arg("--seconds") ?? "120") });
    process.stdout.write(JSON.stringify({ fires }) + "\n");
  } finally {
    await live.disconnect();
  }
}

// The demo is typed loosely on purpose: it drives FoundryLive + the raw
// client directly and is only used by this CLI.
//
// Two connections by design: a connection never sees its OWN creates/moves
// in its cache (proven live — the sender's Token create never appears in
// its own worldData), while a second connection sees them via broadcast
// in ~1s. So the mover creates+moves the token and the watcher watches.
async function demo(live: FoundryLive): Promise<Record<string, unknown>> {
  const { TrapWatcher: Watcher } = await import("../session/traps.js");
  const { FoundryLive: Live } = await import("../live.js");
  const raw = live.raw() as unknown as {
    getScenes(): { _id: string; active?: boolean; grid?: { size?: number } }[];
    getRawActor(id: string): { system?: { attributes?: { hp?: { value?: number } } }; prototypeToken?: { texture?: { src?: string } }; img?: string } | undefined;
    moveToken(sceneId: string, tokenId: string, x: number, y: number): Promise<unknown>;
    updateActorAttribute(actorId: string, patch: Record<string, number>): Promise<unknown>;
  };
  const scene = raw.getScenes().find((s) => s.active);
  if (!scene) throw new Error("No active scene.");
  const grid = scene.grid?.size ?? 100;
  const scoutId = "PcHQDmPTztw32PhL"; // Kobold Scout, 16 HP
  const hpBefore = raw.getRawActor(scoutId)?.system?.attributes?.hp?.value ?? 0;

  // 1. Watcher connection (separate from the mover).
  const watcherLive = await Live.connect();
  try {
    const watcher = new Watcher(
      watcherLive,
      {
        sceneId: scene._id,
        zones: [{
          name: "Pit trap (demo)",
          shape: { kind: "rect", x: 1200, y: 600, w: 200, h: 200 },
          actions: [
            { type: "chat", text: "🕳️ **{token}** steps on a hidden pit trap! The floor gives way — 5 damage." },
            { type: "damage", amount: 5 },
          ],
        }],
      },
      grid,
    );
    const watchPromise = watcher.watch({ seconds: 15 });
    // 2. Mover connection: test token outside the zone, then move it in.
    const created = await live.modifyDocument("Token", "create", {
      data: [{
        name: "Kobold Scout (trap test)",
        actorId: scoutId,
        actorLink: true,
        x: 900, y: 700, width: 1, height: 1,
        texture: { src: raw.getRawActor(scoutId)?.prototypeToken?.texture?.src ?? raw.getRawActor(scoutId)?.img ?? "icons/svg/mystery-man.svg" },
        disposition: -1,
      }],
      parentUuid: `Scene.${scene._id}`,
    });
    const tokenId = String(created[0]._id);
    try {
      await new Promise((r) => setTimeout(r, 2000));
      await raw.moveToken(scene._id, tokenId, 1300, 700);
      const fires = await watchPromise;
      if (fires.length === 0) throw new Error("Trap did not fire after the token moved into the zone.");
      const hpAfter = raw.getRawActor(scoutId)?.system?.attributes?.hp?.value ?? 0;
      // 3. Verify the chat callout landed (the mover's cache gets the
      // watcher's broadcast; give it a beat).
      await new Promise((r) => setTimeout(r, 2000));
      const chat = live.getChatMessages(5);
      const callout = chat.find((m) => m.content.includes("pit trap"));
      return { fired: true, token: tokenId, hpBefore, hpAfter, chatId: callout?.id ?? null };
    } finally {
      // 4. Clean up: heal + delete the test token.
      await raw.updateActorAttribute(scoutId, { "attributes.hp.value": 16 });
      await live.modifyDocument("Token", "delete", {
        ids: [tokenId],
        parentUuid: `Scene.${scene._id}`,
      });
    }
  } finally {
    await watcherLive.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`trap failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
