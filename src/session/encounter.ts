/**
 * Encounter builder (P1.1) — name the monsters and the room, get a
 * combat-ready encounter in seconds: tokens placed on the scene, combat
 * started, initiative rolled (PF2e: 1d20 + Perception modifier), announced
 * in chat.
 *
 * Uses the vendored MCP client's startCombat / setCombatantInitiative and
 * raw `modifyDocument` Token creates. Tokens are linked to their world
 * actors (actorLink: true), hostile disposition.
 */
import type { FoundryLive } from "../live.js";

export interface EncounterMonster {
  name: string;
  count?: number;
}

export interface EncounterOptions {
  /** Scene _id. Default: the currently active scene. */
  sceneId?: string;
  /** Pixel origin for the monster line-up. Default: scene center. */
  origin?: { x: number; y: number };
  /** Pixels between tokens. Default: the scene grid size. */
  spacing?: number;
  /** Post the encounter announcement to Foundry chat. Default: true. */
  announce?: boolean;
}

export interface PlacedToken {
  tokenId: string;
  combatantId: string;
  actorId: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  hpMax: number;
  initiative: number;
  initiativeMod: number;
}

export interface EncounterResult {
  sceneId: string;
  sceneName: string;
  combatId: string;
  tokens: PlacedToken[];
  /** Names in initiative order, highest first. */
  order: string[];
}

interface RawScene {
  _id: string;
  name: string;
  width: number;
  height: number;
  grid?: { size?: number };
  active?: boolean;
}

interface RawActor {
  _id: string;
  name: string;
  type: string;
  img?: string;
  prototypeToken?: { texture?: { src?: string } };
  system?: {
    attributes?: { hp?: { value?: number; max?: number } };
    perception?: { mod?: number };
  };
}

function perceptionMod(actor: RawActor): number {
  const mod = actor.system?.perception?.mod;
  return typeof mod === "number" ? mod : 0;
}

function hpOf(actor: RawActor): { value: number; max: number } {
  const hp = actor.system?.attributes?.hp;
  return { value: hp?.value ?? 0, max: hp?.max ?? hp?.value ?? 0 };
}

export async function buildEncounter(
  live: FoundryLive,
  monsters: EncounterMonster[],
  opts: EncounterOptions = {},
): Promise<EncounterResult> {
  const raw = live.raw() as unknown as {
    getScenes(): RawScene[];
    getRawActor(id: string): RawActor | undefined;
    startCombat(
      sceneId: string,
      combatants: { tokenId: string; sceneId: string; actorId?: string }[],
    ): Promise<{ combatId: string; combatantCount: number }>;
    setCombatantInitiative(combatId: string, combatantId: string, initiative: number): Promise<unknown>;
  };

  // Resolve the scene.
  const scenes = raw.getScenes();
  const scene =
    (opts.sceneId ? scenes.find((s) => s._id === opts.sceneId) : undefined) ??
    scenes.find((s) => s.active) ??
    scenes[0];
  if (!scene) throw new Error("No scene found to place the encounter on.");
  const gridSize = scene.grid?.size ?? 100;
  const spacing = opts.spacing ?? gridSize;
  const origin = opts.origin ?? {
    x: Math.floor(scene.width / 2),
    y: Math.floor(scene.height / 2),
  };

  // Resolve every monster name to a world actor.
  const specs: { actor: RawActor; count: number }[] = [];
  for (const m of monsters) {
    const count = m.count ?? 1;
    const found = (await live.searchActors(m.name)) as {
      actors?: { _id: string; name: string }[];
    };
    const exact = (found.actors ?? []).find(
      (a) => a.name.toLowerCase() === m.name.toLowerCase(),
    );
    const pick = exact ?? (found.actors ?? [])[0];
    if (!pick) throw new Error(`Monster not found: "${m.name}".`);
    const actor = raw.getRawActor(pick._id);
    if (!actor) throw new Error(`Actor ${pick._id} (${m.name}) not in world cache.`);
    specs.push({ actor, count });
  }

  // Place tokens in a row starting at the origin.
  const tokenDocs: Record<string, unknown>[] = [];
  const placements: { actor: RawActor; x: number; y: number }[] = [];
  let i = 0;
  for (const { actor, count } of specs) {
    for (let n = 0; n < count; n++) {
      const x = origin.x + i * spacing;
      const y = origin.y;
      placements.push({ actor, x, y });
      tokenDocs.push({
        name: actor.name,
        actorId: actor._id,
        actorLink: true,
        x,
        y,
        width: 1,
        height: 1,
        texture: { src: actor.prototypeToken?.texture?.src ?? actor.img ?? "icons/svg/mystery-man.svg" },
        disposition: -1,
      });
      i++;
    }
  }
  const created = await live.modifyDocument("Token", "create", {
    data: tokenDocs,
    parentUuid: `Scene.${scene._id}`,
  });
  const tokenIds = created.map((d) => String(d._id));

  // Start combat with the new tokens.
  //
  // Done inline (not via the client's startCombat) so we keep the created
  // Combatant _ids from the modifyDocument responses: the client's cache
  // lags our own writes by seconds (broadcasts), and the upstream
  // refreshWorldData() never resolves ('world' only answers at connect),
  // so the cache cannot be trusted right after a write.
  const combatCreated = await live.modifyDocument("Combat", "create", {
    data: [{ scene: scene._id, active: true }],
  });
  const combatId = String(combatCreated[0]?._id ?? "");
  if (!combatId) throw new Error("Combat create returned no _id.");
  const combatantsCreated = await live.modifyDocument("Combatant", "create", {
    data: tokenIds.map((tokenId, idx) => ({
      tokenId,
      sceneId: scene._id,
      actorId: placements[idx].actor._id,
    })),
    parentUuid: `Combat.${combatId}`,
  });
  const combatantIdByToken = new Map<string, string>();
  for (const doc of combatantsCreated) {
    combatantIdByToken.set(String(doc.tokenId), String(doc._id));
  }

  // Roll initiative (PF2e: 1d20 + Perception) and set it on each combatant.
  const combatRaw = live.raw() as unknown as {
    setCombatantInitiative(combatId: string, combatantId: string, initiative: number): Promise<unknown>;
  };
  const placed: PlacedToken[] = [];
  for (let idx = 0; idx < tokenIds.length; idx++) {
    const placement = placements[idx];
    const mod = perceptionMod(placement.actor);
    const roll = await live.rollDice(mod >= 0 ? `1d20+${mod}` : `1d20${mod}`, {
      flavor: `${placement.actor.name} initiative`,
    });
    const combatantId = combatantIdByToken.get(tokenIds[idx]) ?? "";
    if (combatantId) {
      await combatRaw.setCombatantInitiative(combatId, combatantId, roll.total);
    }
    const hp = hpOf(placement.actor);
    placed.push({
      tokenId: tokenIds[idx],
      combatantId,
      actorId: placement.actor._id,
      name: placement.actor.name,
      x: placement.x,
      y: placement.y,
      hp: hp.value,
      hpMax: hp.max,
      initiative: roll.total,
      initiativeMod: mod,
    });
  }

  const order = [...placed]
    .sort((a, b) => b.initiative - a.initiative)
    .map((t) => `${t.name} (${t.initiative})`);

  if (opts.announce !== false) {
    const lines = placed.map(
      (t) => `• ${t.name} — HP ${t.hp}/${t.hpMax}, initiative ${t.initiative}`,
    );
    await live.sendChat(
      `⚔️ **Encounter!** ${placed.length} ${placed.length === 1 ? "foe" : "foes"} in *${scene.name}*:\n${lines.join("\n")}\nInitiative order: ${order.join(" → ")}`,
    );
  }

  return { sceneId: scene._id, sceneName: scene.name, combatId, tokens: placed, order };
}

/** End the combat and delete the encounter tokens (demo cleanup). */
export async function clearEncounter(
  live: FoundryLive,
  opts: { combatId?: string; tokenIds: string[]; sceneId: string },
): Promise<void> {
  const raw = live.raw() as unknown as {
    endCombat(combatId: string): Promise<void>;
  };
  if (opts.combatId) {
    try {
      await raw.endCombat(opts.combatId);
    } catch {
      // Combat may already be gone; tokens still need deleting.
    }
  }
  if (opts.tokenIds.length > 0) {
    await live.modifyDocument("Token", "delete", {
      ids: opts.tokenIds,
      parentUuid: `Scene.${opts.sceneId}`,
    });
  }
}
