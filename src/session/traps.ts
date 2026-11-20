/**
 * Trap & zone triggers (P1.3) — watch token movement and fire when a token
 * enters a zone: a trap (chat callout + damage), a reveal, a condition.
 *
 * How it works: the watcher polls the scene's tokens (1s; the cache updates
 * on `modifyDocument` broadcasts when tokens move) and tests each token's
 * center point against the zone shapes. A zone fires once per token; it
 * re-arms when the token leaves the zone.
 *
 * Zones are plain data, so they can live in a JSON file the GM edits:
 *   { "sceneId": "<id>", "zones": [{ "name", "shape", "actions": [...] }] }
 * Shapes: { kind: "rect", x, y, w, h } or { kind: "circle", x, y, r }
 *   (pixel coordinates, same space as token x/y).
 * Actions: { type: "chat", text } (use {token} for the entering token's
 *   name), { type: "damage", amount }, { type: "condition", status, rounds }.
 * `triggerFor`: "any" (default), "pcs" (player characters), "npcs".
 */
import type { FoundryLive } from "../live.js";

export type ZoneShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; x: number; y: number; r: number };

export type ZoneAction =
  | { type: "chat"; text: string }
  | { type: "damage"; amount: number }
  | { type: "condition"; status: string; rounds?: number };

export interface Zone {
  name: string;
  shape: ZoneShape;
  actions: ZoneAction[];
  triggerFor?: "any" | "pcs" | "npcs";
}

export interface ZoneSet {
  sceneId: string;
  zones: Zone[];
}

export interface TrapFire {
  zone: string;
  tokenId: string;
  tokenName: string;
  actorId: string;
  at: number;
}

interface RawToken {
  _id: string;
  name: string;
  actorId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

function pointInShape(x: number, y: number, shape: ZoneShape): boolean {
  if (shape.kind === "rect") {
    return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
  }
  const dx = x - shape.x;
  const dy = y - shape.y;
  return dx * dx + dy * dy <= shape.r * shape.r;
}

export class TrapWatcher {
  private live: FoundryLive;
  private zoneSet: ZoneSet;
  private gridSize: number;
  private fired = new Set<string>(); // `${zone}:${tokenId}`
  private onFire: ((fire: TrapFire) => void) | null = null;

  constructor(live: FoundryLive, zoneSet: ZoneSet, gridSize = 100) {
    this.live = live;
    this.zoneSet = zoneSet;
    this.gridSize = gridSize;
  }

  /** Called with every firing (in addition to the zone's own actions). */
  onTrap(cb: (fire: TrapFire) => void): void {
    this.onFire = cb;
  }

  private actorType(actorId: string): string | undefined {
    const raw = this.live.raw() as unknown as {
      getRawActor(id: string): { type?: string } | undefined;
    };
    return raw.getRawActor(actorId)?.type;
  }

  private tokensOnScene(): RawToken[] {
    const raw = this.live.raw() as unknown as {
      getScenes(): { _id: string; tokens?: RawToken[]; grid?: { size?: number } }[];
    };
    const scene = raw.getScenes().find((s) => s._id === this.zoneSet.sceneId);
    if (scene?.grid?.size) this.gridSize = scene.grid.size;
    return scene?.tokens ?? [];
  }

  /** One poll pass. Returns the firings that happened. */
  async checkOnce(): Promise<TrapFire[]> {
    const fires: TrapFire[] = [];
    for (const token of this.tokensOnScene()) {
      const cx = token.x + ((token.width ?? 1) * this.gridSize) / 2;
      const cy = token.y + ((token.height ?? 1) * this.gridSize) / 2;
      for (const zone of this.zoneSet.zones) {
        const key = `${zone.name}:${token._id}`;
        const inside = pointInShape(cx, cy, zone.shape);
        if (!inside) {
          this.fired.delete(key); // re-arm when the token leaves
          continue;
        }
        if (this.fired.has(key)) continue;
        const type = this.actorType(token.actorId);
        if (zone.triggerFor === "pcs" && type !== "character") continue;
        if (zone.triggerFor === "npcs" && type !== "npc") continue;
        this.fired.add(key);
        const fire: TrapFire = {
          zone: zone.name,
          tokenId: token._id,
          tokenName: token.name,
          actorId: token.actorId,
          at: Date.now(),
        };
        fires.push(fire);
        this.onFire?.(fire);
        await this.runActions(zone, token);
      }
    }
    return fires;
  }

  private async runActions(zone: Zone, token: RawToken): Promise<void> {
    for (const action of zone.actions) {
      if (action.type === "chat") {
        await this.live.sendChat(action.text.replaceAll("{token}", token.name));
      } else if (action.type === "damage") {
        const raw = this.live.raw() as unknown as {
          getRawActor(id: string): { system?: { attributes?: { hp?: { value?: number } } } } | undefined;
          updateActorAttribute(actorId: string, patch: Record<string, number>): Promise<unknown>;
        };
        const actor = raw.getRawActor(token.actorId);
        const current = actor?.system?.attributes?.hp?.value ?? 0;
        const next = Math.max(0, current - action.amount);
        await raw.updateActorAttribute(token.actorId, { "attributes.hp.value": next });
        if (next === 0 && current > 0) {
          await this.live.sendChat(`💀 **${token.name}** is down! (0 HP)`);
        }
      } else if (action.type === "condition") {
        const raw = this.live.raw() as unknown as {
          createActorStatusEffect(parentActorUuid: string, statusId: string, options?: { name?: string }): Promise<{ _id: string }>;
        };
        await raw.createActorStatusEffect(`Actor.${token.actorId}`, action.status, {
          name: action.status,
        });
        await this.live.sendChat(
          `🌀 **${token.name}** gains *${action.status}* (from ${zone.name}).`,
        );
      }
    }
  }

  /** Poll until `seconds` elapse. Returns all firings. */
  async watch(opts: { seconds?: number; pollMs?: number } = {}): Promise<TrapFire[]> {
    const all: TrapFire[] = [];
    const deadline = Date.now() + (opts.seconds ?? 120) * 1000;
    const pollMs = opts.pollMs ?? 1000;
    while (Date.now() < deadline) {
      const fires = await this.checkOnce();
      all.push(...fires);
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return all;
  }
}
