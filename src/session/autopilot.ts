/**
 * Combat autopilot (P1.2) — run a combat once the encounter builder has
 * set it up: advance turns, track conditions with round durations, watch
 * HP with a 0 HP callout, and end combat when the last enemy falls.
 *
 * Notes:
 * - Initiative order comes from the combat tracker (set by the encounter
 *   builder). `advanceTurn` moves `turn`/`round` on the Combat document.
 * - HP is read from the world actor (encounter tokens are actor-linked, so
 *   tokens of the same actor share one HP pool — see the caveat in the
 *   encounter builder docs).
 * - The client's cache lags our own writes by seconds, so `damage()` uses
 *   the update response as the source of truth, not a re-read.
 * - Conditions are tracked in memory by this autopilot instance: if the
 *   process restarts, re-apply them. Expiry is by round number.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FoundryLive } from "../live.js";

/** Where condition / downed state lives so one-shot CLI calls compose. */
const STATE_FILE =
  process.env.FOUNDRY_AUTOPILOT_STATE ??
  path.join(import.meta.dir, "..", "..", ".autopilot-state.json");

export interface CombatantStatus {
  combatantId: string;
  tokenId: string;
  actorId: string;
  name: string;
  initiative: number | null;
  hp: number;
  hpMax: number;
  defeated: boolean;
  disposition: number;
  isEnemy: boolean;
}

export interface CombatStatus {
  combatId: string;
  sceneId: string;
  round: number;
  turn: number | null;
  active: boolean;
  combatants: CombatantStatus[];
  current: CombatantStatus | null;
}

export interface Condition {
  combatantId: string;
  statusId: string;
  effectId: string;
  /** Round on which the condition expires (start of that round). */
  expiresRound: number;
}

interface RawCombat {
  _id: string;
  scene: string;
  round: number;
  turn: number | null;
  active: boolean;
  combatants: {
    _id: string;
    tokenId: string;
    actorId: string;
    initiative: number | null;
    defeated: boolean;
  }[];
}

interface RawActor {
  _id: string;
  name: string;
  type?: string;
  system?: { attributes?: { hp?: { value?: number; max?: number } } };
}

interface RawToken {
  _id: string;
  name: string;
  disposition?: number;
}

export class CombatAutopilot {
  private live: FoundryLive;
  private combatId: string;
  private conditions: Condition[] = [];
  private downAnnounced = new Set<string>();

  constructor(live: FoundryLive, combatId: string) {
    this.live = live;
    this.combatId = combatId;
    // Conditions and downed callouts are tracked in memory, but one-shot
    // CLI runs are separate processes — persist them so the calls compose
    // into a real autopilot across invocations.
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
        combatId?: string;
        conditions?: Condition[];
        downAnnounced?: string[];
      };
      if (saved.combatId === combatId) {
        this.conditions = saved.conditions ?? [];
        this.downAnnounced = new Set(saved.downAnnounced ?? []);
      }
    } catch {
      // No state yet — start fresh.
    }
  }

  private saveState(): void {
    try {
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({
          combatId: this.combatId,
          conditions: this.conditions,
          downAnnounced: [...this.downAnnounced],
        }),
        "utf-8",
      );
    } catch {
      // State is a convenience; a failed write must not break combat.
    }
  }

  /** Current combat state, with HP filled in from the actors. */
  status(): CombatStatus {
    const raw = this.live.raw() as unknown as {
      getScenes(): { _id: string; tokens?: RawToken[] }[];
    };
    const combat = this.live.getCombatState() as unknown as RawCombat | null;
    if (!combat || combat._id !== this.combatId) {
      throw new Error(`Combat ${this.combatId} is not the active combat.`);
    }
    const scene = raw.getScenes().find((s) => s._id === combat.scene);
    const tokenById = new Map((scene?.tokens ?? []).map((t) => [t._id, t]));
    const combatants: CombatantStatus[] = combat.combatants.map((c) => {
      const actor = this.actorOf(c.actorId);
      const token = tokenById.get(c.tokenId);
      const hp = actor?.system?.attributes?.hp;
      // Enemy-ness comes from the ACTOR TYPE, not the token disposition:
      // tokens placed by builders default to disposition -1 even for PCs
      // (all seven tokens on this scene read -1). NPCs are enemies,
      // player characters are not. Disposition is only a fallback when the
      // actor type is unknown.
      const disposition = token?.disposition;
      const isEnemy =
        actor?.type !== undefined
          ? actor.type === "npc"
          : (disposition ?? 0) < 0;
      return {
        combatantId: c._id,
        tokenId: c.tokenId,
        actorId: c.actorId,
        name: token?.name ?? actor?.name ?? c.tokenId,
        initiative: c.initiative,
        hp: hp?.value ?? 0,
        hpMax: hp?.max ?? hp?.value ?? 0,
        defeated: c.defeated,
        disposition: disposition ?? 0,
        isEnemy,
      };
    });
    // Turn order is initiative order, highest first (Foundry sorts the
    // tracker this way; the document's combatants array is creation order).
    combatants.sort((a, b) => {
      if (a.initiative === null && b.initiative === null) return 0;
      if (a.initiative === null) return 1;
      if (b.initiative === null) return -1;
      return b.initiative - a.initiative || a.name.localeCompare(b.name);
    });
    const current =
      combat.turn !== null && combat.turn !== undefined
        ? (combatants[combat.turn] ?? null)
        : null;
    return {
      combatId: combat._id,
      sceneId: combat.scene,
      round: combat.round,
      turn: combat.turn,
      active: combat.active,
      combatants,
      current,
    };
  }

  private actorOf(actorId: string): RawActor | undefined {
    const raw = this.live.raw() as unknown as {
      getRawActor(id: string): RawActor | undefined;
    };
    return raw.getRawActor(actorId);
  }

  /** Advance to the next turn (wrapping to the next round), expiring due conditions. */
  async advanceTurn(): Promise<CombatStatus> {
    const before = this.status();
    const order = before.combatants;
    if (order.length === 0) throw new Error("Combat has no combatants.");
    let turn = (before.turn ?? -1) + 1;
    let round = before.round;
    if (turn >= order.length) {
      turn = 0;
      round = before.round + 1;
    }
    if (round === 0) round = 1;
    const raw = this.live.raw() as unknown as {
      updateCombat(combatId: string, patch: { turn?: number; round?: number }): Promise<unknown>;
    };
    await raw.updateCombat(this.combatId, { turn, round });
    // Expire conditions whose round has come.
    const expired = this.conditions.filter((c) => c.expiresRound <= round);
    for (const cond of expired) {
      await this.removeCondition(cond.combatantId, cond.statusId, { silent: true });
    }
    if (expired.length > 0) {
      await this.live.sendChat(
        `⌛ Conditions expired (round ${round}): ${expired
          .map((c) => c.statusId)
          .join(", ")}`,
      );
    }
    // The cache lags our own writes, so build the post-advance state from
    // the pre-advance state instead of re-reading it.
    const after: CombatStatus = {
      ...before,
      round,
      turn,
      current: order[turn] ?? null,
    };
    const current = after.current;
    if (current) {
      const conds = this.conditions
        .filter((c) => c.combatantId === current.combatantId)
        .map((c) => c.statusId);
      await this.live.sendChat(
        `➡️ Round ${after.round}, turn ${after.turn! + 1}/${after.combatants.length}: **${current.name}**` +
          (conds.length > 0 ? ` — conditions: ${conds.join(", ")}` : "") +
          ` (HP ${current.hp}/${current.hpMax})`,
      );
    }
    return after;
  }

  /** Apply a condition to a combatant for `rounds` rounds (default 1). */
  async applyCondition(
    combatantId: string,
    statusId: string,
    rounds = 1,
  ): Promise<string> {
    const st = this.status();
    const combatant = st.combatants.find((c) => c.combatantId === combatantId);
    if (!combatant) throw new Error(`Combatant ${combatantId} not in this combat.`);
    const raw = this.live.raw() as unknown as {
      createActorStatusEffect(parentActorUuid: string, statusId: string, options?: { name?: string }): Promise<{ _id: string }>;
    };
    const effect = await raw.createActorStatusEffect(`Actor.${combatant.actorId}`, statusId, {
      name: statusId,
    });
    const expiresRound = Math.max(st.round, 1) + rounds;
    this.conditions.push({
      combatantId,
      statusId,
      effectId: effect._id,
      expiresRound,
    });
    this.saveState();
    await this.live.sendChat(
      `🌀 **${combatant.name}** gains *${statusId}* (until round ${expiresRound}).`,
    );
    return effect._id;
  }

  /** Remove a condition (also drops it from the expiry tracker). */
  async removeCondition(
    combatantId: string,
    statusId: string,
    opts: { silent?: boolean } = {},
  ): Promise<void> {
    const idx = this.conditions.findIndex(
      (c) => c.combatantId === combatantId && c.statusId === statusId,
    );
    if (idx === -1) return;
    const cond = this.conditions[idx];
    this.conditions.splice(idx, 1);
    this.saveState();
    const st = this.status();
    const combatant = st.combatants.find((c) => c.combatantId === combatantId);
    if (!combatant) return;
    const raw = this.live.raw() as unknown as {
      deleteActorEffect(parentActorUuid: string, effectId: string): Promise<void>;
    };
    await raw.deleteActorEffect(`Actor.${combatant.actorId}`, cond.effectId);
    if (!opts.silent) {
      await this.live.sendChat(`✨ *${statusId}* ends on **${combatant.name}**.`);
    }
  }

  /** Deal damage to an actor (linked tokens share the actor's HP). Returns the new HP. */
  async damage(actorId: string, amount: number): Promise<{ hp: number; down: boolean }> {
    const actor = this.actorOf(actorId);
    if (!actor) throw new Error(`Actor ${actorId} not found.`);
    const hp = actor.system?.attributes?.hp;
    const current = hp?.value ?? 0;
    const next = Math.max(0, current - amount);
    const raw = this.live.raw() as unknown as {
      updateActorAttribute(actorId: string, patch: Record<string, number>): Promise<unknown>;
    };
    await raw.updateActorAttribute(actorId, { "attributes.hp.value": next });
    const down = next === 0 && current > 0;
    if (down) {
      const st = this.status();
      const combatant = st.combatants.find((c) => c.actorId === actorId);
      if (combatant) {
        await this.markDefeated(combatant.combatantId);
        await this.live.sendChat(`💀 **${combatant.name}** is down! (0 HP)`);
        this.downAnnounced.add(combatant.combatantId);
        this.saveState();
      }
    }
    return { hp: next, down };
  }

  /** Heal an actor. Returns the new HP. */
  async heal(actorId: string, amount: number): Promise<{ hp: number }> {
    const actor = this.actorOf(actorId);
    if (!actor) throw new Error(`Actor ${actorId} not found.`);
    const hp = actor.system?.attributes?.hp;
    const current = hp?.value ?? 0;
    const max = hp?.max ?? current;
    const next = Math.min(max, current + amount);
    const raw = this.live.raw() as unknown as {
      updateActorAttribute(actorId: string, patch: Record<string, number>): Promise<unknown>;
    };
    await raw.updateActorAttribute(actorId, { "attributes.hp.value": next });
    return { hp: next };
  }

  private async markDefeated(combatantId: string): Promise<void> {
    await this.live.modifyDocument("Combatant", "update", {
      updates: [{ _id: combatantId, defeated: true }],
      parentUuid: `Combat.${this.combatId}`,
    });
  }

  /**
   * One watch pass: call out newly-downed combatants, mark them defeated,
   * and end combat (with a victory message) when every enemy is down.
   * Returns whether the combat ended.
   */
  async watchOnce(): Promise<{ ended: boolean; down: string[] }> {
    const st = this.status();
    const down: string[] = [];
    for (const c of st.combatants) {
      if (c.hp === 0 && !c.defeated && !this.downAnnounced.has(c.combatantId)) {
        await this.markDefeated(c.combatantId);
        await this.live.sendChat(`💀 **${c.name}** is down! (0 HP)`);
        this.downAnnounced.add(c.combatantId);
        this.saveState();
        down.push(c.name);
      }
    }
    const enemies = st.combatants.filter((c) => c.isEnemy);
    const allDown =
      enemies.length > 0 &&
      enemies.every((c) => c.hp === 0 || c.defeated || this.downAnnounced.has(c.combatantId));
    if (allDown) {
      const raw = this.live.raw() as unknown as { endCombat(combatId: string): Promise<void> };
      await raw.endCombat(this.combatId);
      await this.live.sendChat(`🏆 **Combat over!** All enemies are down.`);
      return { ended: true, down };
    }
    return { ended: false, down };
  }

  /** Loop watchOnce until the combat ends or `maxSeconds` elapses. */
  async watchLoop(opts: { intervalSec?: number; maxSeconds?: number } = {}): Promise<boolean> {
    const intervalMs = (opts.intervalSec ?? 2) * 1000;
    const deadline = Date.now() + (opts.maxSeconds ?? 300) * 1000;
    while (Date.now() < deadline) {
      const { ended } = await this.watchOnce();
      if (ended) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }
}
