/**
 * Trap & zone triggers (P1.3) — watch token movement and fire when a token
 * enters a zone: a trap (chat callout + damage), a reveal, a condition,
 * or a cutscene (FR-4 / BRA-196).
 *
 * How it works: the watcher polls the scene's tokens (1s; the cache updates
 * on `modifyDocument` broadcasts when tokens move) and tests each token's
 * center point against the zone shapes. Arming is per zone
 * (`LinkArming`, src/session/zone-cutscene.ts): a zone fires once per
 * token and re-arms when the token leaves — unless `fireOnce` is set,
 * in which case it fires exactly once, then stays disarmed until the
 * creator re-arms it (`arm` / `disarm`).
 *
 * Zones are plain data, so they can live in a JSON file the GM edits:
 *   { "sceneId": "<id>", "zones": [{ "name", "shape", "actions": [...] }] }
 * Shapes: { kind: "rect", x, y, w, h } or { kind: "circle", x, y, r }
 *   (pixel coordinates, same space as token x/y).
 * Actions: { type: "chat", text } (use {token} for the entering token's
 *   name), { type: "damage", amount }, { type: "condition", status, rounds },
 *   { type: "cutscene", script } — `script` is a cutscene script object
 *   (a file path is resolved to an object by `resolveZoneSet` before
 *   the watcher is built; see src/session/zone-cutscene.ts).
 * `triggerFor`: "any" (default), "pcs" (player characters), "npcs".
 * `fireOnce`: true means the zone fires exactly once, then disarms.
 */
import type { FoundryLive } from "../live.js";
import type { CutsceneScript } from "./cutscene.js";
import { playCutscene } from "./cutscene.js";
import { LinkArming } from "./zone-cutscene.js";
import type { ArmingMode } from "./zone-cutscene.js";

export type ZoneShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; x: number; y: number; r: number };

export type ZoneAction =
  | { type: "chat"; text: string }
  | { type: "damage"; amount: number }
  | { type: "condition"; status: string; rounds?: number }
  | {
      type: "cutscene";
      /** A validated cutscene script (paths are resolved before watch time). */
      script: CutsceneScript;
      /** Idempotency key for the run (passed through to playCutscene). */
      runKey?: string;
      /** Set by resolveZoneSet when the script inherited the zone's sceneId. */
      sceneIdInherited?: boolean;
    };

export interface Zone {
  name: string;
  shape: ZoneShape;
  actions: ZoneAction[];
  triggerFor?: "any" | "pcs" | "npcs";
  /** Fire exactly once, then disarm until the creator re-arms it. */
  fireOnce?: boolean;
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

/**
 * Plays a cutscene script. Injectable so tests can record the call
 * instead of playing against a live world; defaults to the real
 * `playCutscene`.
 */
export type CutscenePlayer = (
  live: FoundryLive,
  script: CutsceneScript,
  opts?: { runKey?: string },
) => Promise<unknown>;

export class TrapWatcher {
  private live: FoundryLive;
  private zoneSet: ZoneSet;
  private gridSize: number;
  private arming = new LinkArming();
  private cutscenePlayer: CutscenePlayer;
  private onFire: ((fire: TrapFire) => void) | null = null;

  constructor(
    live: FoundryLive,
    zoneSet: ZoneSet,
    gridSize = 100,
    opts: { cutscenePlayer?: CutscenePlayer } = {},
  ) {
    this.live = live;
    this.zoneSet = zoneSet;
    this.gridSize = gridSize;
    this.cutscenePlayer =
      opts.cutscenePlayer ??
      ((liveClient, script, playerOpts) => playCutscene(liveClient, script, playerOpts));
  }

  /** Called with every firing (in addition to the zone's own actions). */
  onTrap(cb: (fire: TrapFire) => void): void {
    this.onFire = cb;
  }

  /** Creator control: re-arm a zone (a spent `fireOnce` zone fires again). */
  arm(zoneName: string): void {
    this.arming.arm(zoneName);
  }

  /** Creator control: disarm a zone until it is armed again. */
  disarm(zoneName: string): void {
    this.arming.disarm(zoneName);
  }

  /** Whether a zone would fire on entry right now. */
  isArmed(zoneName: string): boolean {
    const zone = this.zoneSet.zones.find((z) => z.name === zoneName);
    const mode: ArmingMode = zone?.fireOnce ? "once" : "per-token";
    return this.arming.isArmed(zoneName, mode);
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
        const mode: ArmingMode = zone.fireOnce ? "once" : "per-token";
        const inside = pointInShape(cx, cy, zone.shape);
        if (!inside) {
          this.arming.leave(zone.name, token._id);
          continue;
        }
        const type = this.actorType(token.actorId);
        if (zone.triggerFor === "pcs" && type !== "character") continue;
        if (zone.triggerFor === "npcs" && type !== "npc") continue;
        if (!this.arming.shouldFire(zone.name, token._id, mode)) continue;
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
      } else if (action.type === "cutscene") {
        await this.cutscenePlayer(this.live, action.script, { runKey: action.runKey });
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
