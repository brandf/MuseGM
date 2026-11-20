/**
 * Encounter builder (P1.1) — name the monsters and the room, get a
 * combat-ready encounter in seconds: tokens placed on the scene, combat
 * started, initiative rolled (PF2e: 1d20 + Perception modifier), announced
 * in chat.
 *
 * Uses the vendored MCP client's startCombat / setCombatantInitiative and
 * raw `modifyDocument` Token creates. Tokens are linked to their world
 * actors (actorLink: true), hostile disposition.
 *
 * Retry-safety (`opts.encounterKey`): the key is stored in the combat's
 * flags and in each token's flags, so a crash re-dispatch resumes the
 * encounter instead of duplicating it — existing tokens and combatants
 * are reused, missing initiative is rolled with a seed derived from the
 * key and the token id (same key = same initiative). The resume path
 * reads the fresh world payload, so it assumes a fresh connection (the
 * one-shot CLI case); a same-process re-call is not protected, because
 * this connection's cache lags its own creates.
 */
import type { FoundryLive } from "../live.js";
import { deleteToken, getSceneTokens } from "./movement.js";
import { FLAG_FIELDS, docHasFlag, flagValue } from "../idempotency.js";

interface RawCombat {
  _id: string;
  scene: string;
  active: boolean;
  combatants: {
    _id: string;
    tokenId: string;
    actorId: string;
    initiative: number | null;
    defeated: boolean;
  }[];
  flags?: Record<string, Record<string, unknown> | undefined> | null;
}

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
  /**
   * Idempotency key for this encounter. When set, the combat carries it
   * in its flags and every token carries `<key>:token:<n>`; a re-run
   * finds the existing combat and tokens and resumes (missing combatants
   * created, missing initiative rolled with a seed) instead of building
   * a second encounter. Without it, behavior is unchanged.
   */
  encounterKey?: string;
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

  // Place tokens in a row starting at the origin. Placements are
  // deterministic (same monsters + origin + spacing = same positions),
  // so a keyed re-run can find the tokens it already placed.
  const placements: { actor: RawActor; x: number; y: number }[] = [];
  let i = 0;
  for (const { actor, count } of specs) {
    for (let n = 0; n < count; n++) {
      placements.push({ actor, x: origin.x + i * spacing, y: origin.y });
      i++;
    }
  }
  const tokenDocFor = (placement: { actor: RawActor; x: number; y: number }, idx: number) => {
    const doc: Record<string, unknown> = {
      name: placement.actor.name,
      actorId: placement.actor._id,
      actorLink: true,
      x: placement.x,
      y: placement.y,
      width: 1,
      height: 1,
      texture: { src: placement.actor.prototypeToken?.texture?.src ?? placement.actor.img ?? "icons/svg/mystery-man.svg" },
      disposition: -1,
    };
    if (opts.encounterKey) {
      doc.flags = flagValue(FLAG_FIELDS.tokenPlace, `${opts.encounterKey}:token:${idx}`);
    }
    return doc;
  };
  const key = opts.encounterKey;
  const tokenIds: string[] = new Array(placements.length).fill("");
  if (key) {
    // Resume: reuse tokens already placed under this key, create the rest.
    const existingTokens = getSceneTokens(live, scene._id);
    const missing: { idx: number; doc: Record<string, unknown> }[] = [];
    placements.forEach((p, idx) => {
      const found = existingTokens.find((t) =>
        docHasFlag(t, FLAG_FIELDS.tokenPlace, `${key}:token:${idx}`),
      );
      if (found) tokenIds[idx] = found._id;
      else missing.push({ idx, doc: tokenDocFor(p, idx) });
    });
    if (missing.length > 0) {
      const created = await live.modifyDocument("Token", "create", {
        data: missing.map((m) => m.doc),
        parentUuid: `Scene.${scene._id}`,
      });
      created.forEach((d, n) => {
        tokenIds[missing[n].idx] = String(d._id);
      });
    }
  } else {
    const created = await live.modifyDocument("Token", "create", {
      data: placements.map((p, idx) => tokenDocFor(p, idx)),
      parentUuid: `Scene.${scene._id}`,
    });
    created.forEach((d, idx) => {
      tokenIds[idx] = String(d._id);
    });
  }

  // Start combat with the tokens.
  //
  // Done inline (not via the client's startCombat) so we keep the created
  // Combatant _ids from the modifyDocument responses: the client's cache
  // lags our own writes by seconds (broadcasts), and the upstream
  // refreshWorldData() never resolves ('world' only answers at connect),
  // so the cache cannot be trusted right after a write.
  //
  // Keyed resume: when the active combat already carries the key, reuse
  // it (and its combatants/initiative) instead of starting a second one.
  let combatId: string;
  const combatantByToken = new Map<string, { combatantId: string; initiative: number | null }>();
  const activeCombat = live.getCombatState() as unknown as RawCombat | null;
  if (key && activeCombat && docHasFlag(activeCombat, FLAG_FIELDS.combatEncounter, key)) {
    combatId = activeCombat._id;
    for (const c of activeCombat.combatants ?? []) {
      combatantByToken.set(c.tokenId, { combatantId: c._id, initiative: c.initiative });
    }
  } else {
    const combatData: Record<string, unknown> = { scene: scene._id, active: true };
    if (key) combatData.flags = flagValue(FLAG_FIELDS.combatEncounter, key);
    const combatCreated = await live.modifyDocument("Combat", "create", {
      data: [combatData],
    });
    combatId = String(combatCreated[0]?._id ?? "");
    if (!combatId) throw new Error("Combat create returned no _id.");
  }
  const missingCombatants = tokenIds
    .map((tokenId, idx) => ({ tokenId, actorId: placements[idx].actor._id }))
    .filter((c) => !combatantByToken.has(c.tokenId));
  if (missingCombatants.length > 0) {
    const combatantsCreated = await live.modifyDocument("Combatant", "create", {
      data: missingCombatants.map((c) => ({
        tokenId: c.tokenId,
        sceneId: scene._id,
        actorId: c.actorId,
      })),
      parentUuid: `Combat.${combatId}`,
    });
    for (const doc of combatantsCreated) {
      combatantByToken.set(String(doc.tokenId), {
        combatantId: String(doc._id),
        initiative: null,
      });
    }
  }

  // Roll initiative (PF2e: 1d20 + Perception) and set it on each combatant.
  // Keyed runs seed by token id, so a resumed roll reproduces the
  // initiative the first run set; a combatant that already has initiative
  // keeps it (no re-roll at all).
  const combatRaw = live.raw() as unknown as {
    setCombatantInitiative(combatId: string, combatantId: string, initiative: number): Promise<unknown>;
  };
  const placed: PlacedToken[] = [];
  for (let idx = 0; idx < tokenIds.length; idx++) {
    const placement = placements[idx];
    const mod = perceptionMod(placement.actor);
    const combatantId = combatantByToken.get(tokenIds[idx])?.combatantId ?? "";
    const existingInitiative = combatantByToken.get(tokenIds[idx])?.initiative;
    let initiative: number;
    if (existingInitiative !== null && existingInitiative !== undefined) {
      initiative = existingInitiative;
    } else {
      const roll = await live.rollDice(mod >= 0 ? `1d20+${mod}` : `1d20${mod}`, {
        flavor: `${placement.actor.name} initiative`,
        seed: key ? `${key}:init:${tokenIds[idx]}` : undefined,
      });
      initiative = roll.total;
      if (combatantId) {
        await combatRaw.setCombatantInitiative(combatId, combatantId, initiative);
      }
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
      initiative,
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
    const text =
      `⚔️ **Encounter!** ${placed.length} ${placed.length === 1 ? "foe" : "foes"} in *${scene.name}*:\n${lines.join("\n")}\nInitiative order: ${order.join(" → ")}`;
    if (key) {
      await live.sendChatIdempotent(text, { dedupeKey: `${key}:announce` });
    } else {
      await live.sendChat(text);
    }
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
  // Tolerant per-token deletes: a token already gone is a success, so a
  // crash re-dispatch of cleanup does not fail on the second run.
  for (const tokenId of opts.tokenIds) {
    await deleteToken(live, opts.sceneId, tokenId);
  }
}
