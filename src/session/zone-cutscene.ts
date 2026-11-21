/**
 * Zone → cutscene links (FR-4 / BRA-196) — the pure planning layer.
 *
 * A trigger zone (see src/session/traps.ts) can carry a `cutscene`
 * action: when a token enters the zone, the linked cutscene script
 * plays. This module is the offline half:
 *
 *   - `resolveZoneSet` — strict validation of a zones JSON file, with
 *     cutscene actions given either inline (a script object) or by
 *     file path (resolved through an injected loader, so tests never
 *     touch disk). A script with no sceneId inherits the zone set's
 *     sceneId; a script whose sceneId disagrees with the set's is an
 *     error — a zone on scene A triggering a script that defaults to
 *     scene B is an authoring mistake (a cross-scene reveal still
 *     works: `reveal` steps carry their own sceneId).
 *   - `planZoneCutsceneSet` — the trigger plan: one entry per
 *     cutscene-linked zone (cutscene name, script/expanded step
 *     counts, arming mode), plus the zones with no cutscene.
 *   - `LinkArming` — the dedupe state machine the watcher uses:
 *     `once` zones fire exactly once, then stay disarmed until the
 *     creator re-arms them; `per-token` zones fire once per token
 *     and re-arm when that token leaves. Manual arm/disarm works in
 *     both modes.
 *
 * Pure: no FoundryLive, no MCP client, no fs — the file loader is
 * injected by the caller (the CLI passes an fs reader).
 */
import type { Zone, ZoneAction, ZoneSet } from "./traps.js";
import type { CutsceneScript } from "./cutscene.js";
import { validateCutscene, expandCutscene } from "./cutscene.js";
import { validateGate } from "../worldbuilding/floors.js";

/** How a linked zone re-arms. `once` is the FR-4 default. */
export type ArmingMode = "once" | "per-token";

/**
 * Dedupe + arming state for trigger zones. Pure: feed it
 * (zone, tokenId, inside) observations and it says whether to fire.
 */
export class LinkArming {
  private fired = new Set<string>(); // `${zone}:${tokenId}`, per-token mode
  private spent = new Set<string>(); // zone names, once mode
  private disarmed = new Set<string>(); // zones the creator disarmed

  /**
   * Call when a token is inside the zone and passes the trigger
   * filter. Returns true exactly when the zone should fire now.
   */
  shouldFire(zone: string, tokenId: string, mode: ArmingMode): boolean {
    if (this.disarmed.has(zone)) return false;
    if (mode === "once") {
      if (this.spent.has(zone)) return false;
      this.spent.add(zone);
      return true;
    }
    const key = `${zone}:${tokenId}`;
    if (this.fired.has(key)) return false;
    this.fired.add(key);
    return true;
  }

  /** Call when a token leaves the zone (per-token zones re-arm). */
  leave(zone: string, tokenId: string): void {
    this.fired.delete(`${zone}:${tokenId}`);
  }

  /** Creator control: re-arm a zone (clears spent + manual disarm). */
  arm(zone: string): void {
    this.spent.delete(zone);
    this.disarmed.delete(zone);
  }

  /** Creator control: disarm a zone until it is armed again. */
  disarm(zone: string): void {
    this.disarmed.add(zone);
  }

  isArmed(zone: string, mode: ArmingMode): boolean {
    if (this.disarmed.has(zone)) return false;
    if (mode === "once") return !this.spent.has(zone);
    return true;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numField(
  errors: string[],
  where: string,
  obj: Record<string, unknown>,
  field: string,
  opts: { min?: number; integer?: boolean; required?: boolean } = {},
): void {
  const v = obj[field];
  if (v === undefined) {
    if (opts.required) errors.push(`${where}: "${field}" is required.`);
    return;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${where}: "${field}" must be a finite number, got ${JSON.stringify(v)}.`);
    return;
  }
  if (opts.integer && !Number.isInteger(v)) {
    errors.push(`${where}: "${field}" must be an integer, got ${v}.`);
  }
  if (opts.min !== undefined && v < opts.min) {
    errors.push(`${where}: "${field}" must be >= ${opts.min}, got ${v}.`);
  }
}

function strField(
  errors: string[],
  where: string,
  obj: Record<string, unknown>,
  field: string,
  required = false,
): void {
  const v = obj[field];
  if (v === undefined) {
    if (required) errors.push(`${where}: "${field}" is required.`);
    return;
  }
  if (typeof v !== "string" || v.length === 0) {
    errors.push(`${where}: "${field}" must be a non-empty string.`);
  }
}

const ACTION_FIELDS: Record<string, Set<string>> = {
  chat: new Set(["type", "text"]),
  damage: new Set(["type", "amount"]),
  condition: new Set(["type", "status", "rounds"]),
  cutscene: new Set(["type", "script", "runKey"]),
  "reveal-floor": new Set(["type", "stair", "gate"]),
};

/**
 * Validate + resolve a zones JSON document. Cutscene actions given
 * as a file path are read through `loadFile` (which receives the path
 * exactly as written in the JSON — the caller resolves it against the
 * zones file's directory) and validated as cutscene scripts.
 *
 * Unknown top-level fields are ignored (notes, _comment) — the same
 * rule as cutscene scripts. Unknown zone / shape / action fields are
 * errors: a typo'd field name should fail loudly, not silently do
 * nothing.
 */
export function resolveZoneSet(
  input: unknown,
  loadFile: (path: string) => string,
): { ok: true; zoneSet: ZoneSet } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["Zone set must be a JSON object."] };
  }
  if (typeof input.sceneId !== "string" || input.sceneId.length === 0) {
    errors.push(`"sceneId" must be a non-empty string.`);
  }
  if (!Array.isArray(input.zones) || input.zones.length === 0) {
    errors.push(`"zones" must be a non-empty array.`);
    return { ok: false, errors };
  }
  const sceneId = typeof input.sceneId === "string" ? input.sceneId : "";
  const seenNames = new Set<string>();
  const zones: Zone[] = [];
  for (let zi = 0; zi < input.zones.length; zi++) {
    const where = `Zone ${zi}`;
    const raw = input.zones[zi];
    if (!isRecord(raw)) {
      errors.push(`${where}: must be an object.`);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!["name", "shape", "actions", "triggerFor", "fireOnce"].includes(key)) {
        errors.push(`${where}: unknown field "${key}".`);
      }
    }
    const name = raw.name;
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`${where}: "name" must be a non-empty string.`);
      continue;
    }
    const zwhere = `Zone "${name}"`;
    if (seenNames.has(name)) {
      errors.push(`${zwhere}: duplicate zone name (zone names must be unique — the watcher keys arming state by name).`);
      continue;
    }
    seenNames.add(name);
    // Shape.
    let shape: Zone["shape"] | undefined;
    if (!isRecord(raw.shape)) {
      errors.push(`${zwhere}: "shape" must be an object.`);
    } else {
      for (const key of Object.keys(raw.shape)) {
        if (!["kind", "x", "y", "w", "h", "r"].includes(key)) {
          errors.push(`${zwhere} shape: unknown field "${key}".`);
        }
      }
      if (raw.shape.kind === "rect") {
        numField(errors, `${zwhere} shape`, raw.shape, "x", { required: true });
        numField(errors, `${zwhere} shape`, raw.shape, "y", { required: true });
        numField(errors, `${zwhere} shape`, raw.shape, "w", { required: true, min: 1 });
        numField(errors, `${zwhere} shape`, raw.shape, "h", { required: true, min: 1 });
        // Built even when invalid — the whole set is rejected below on
        // any error, so a malformed shape never escapes resolveZoneSet.
        shape = {
          kind: "rect",
          x: raw.shape.x as number,
          y: raw.shape.y as number,
          w: raw.shape.w as number,
          h: raw.shape.h as number,
        };
      } else if (raw.shape.kind === "circle") {
        numField(errors, `${zwhere} shape`, raw.shape, "x", { required: true });
        numField(errors, `${zwhere} shape`, raw.shape, "y", { required: true });
        numField(errors, `${zwhere} shape`, raw.shape, "r", { required: true, min: 1 });
        shape = {
          kind: "circle",
          x: raw.shape.x as number,
          y: raw.shape.y as number,
          r: raw.shape.r as number,
        };
      } else {
        errors.push(`${zwhere} shape: "kind" must be rect|circle, got ${JSON.stringify(raw.shape.kind)}.`);
      }
    }
    // triggerFor / fireOnce.
    let triggerFor: Zone["triggerFor"];
    if (raw.triggerFor !== undefined) {
      if (raw.triggerFor !== "any" && raw.triggerFor !== "pcs" && raw.triggerFor !== "npcs") {
        errors.push(`${zwhere}: "triggerFor" must be any|pcs|npcs, got ${JSON.stringify(raw.triggerFor)}.`);
      } else {
        triggerFor = raw.triggerFor;
      }
    }
    let fireOnce: boolean | undefined;
    if (raw.fireOnce !== undefined) {
      if (typeof raw.fireOnce !== "boolean") {
        errors.push(`${zwhere}: "fireOnce" must be a boolean, got ${JSON.stringify(raw.fireOnce)}.`);
      } else {
        fireOnce = raw.fireOnce;
      }
    }
    // Actions.
    const actions: ZoneAction[] = [];
    if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
      errors.push(`${zwhere}: "actions" must be a non-empty array (a zone with nothing to fire is an authoring mistake).`);
    } else {
      for (let ai = 0; ai < raw.actions.length; ai++) {
        const awhere = `${zwhere} action ${ai}`;
        const a = raw.actions[ai];
        if (!isRecord(a)) {
          errors.push(`${awhere}: must be an object.`);
          continue;
        }
        const fields = typeof a.type === "string" ? ACTION_FIELDS[a.type] : undefined;
        if (!fields) {
          errors.push(`${awhere}: unknown type ${JSON.stringify(a.type)} (known: chat, damage, condition, cutscene, reveal-floor).`);
          continue;
        }
        for (const key of Object.keys(a)) {
          if (!fields.has(key)) errors.push(`${awhere} (${a.type}): unknown field "${key}".`);
        }
        if (a.type === "chat") {
          strField(errors, awhere, a, "text", true);
          if (typeof a.text === "string") actions.push({ type: "chat", text: a.text });
        } else if (a.type === "damage") {
          numField(errors, awhere, a, "amount", { required: true, min: 0 });
          if (typeof a.amount === "number") actions.push({ type: "damage", amount: a.amount });
        } else if (a.type === "condition") {
          strField(errors, awhere, a, "status", true);
          numField(errors, awhere, a, "rounds", { min: 1, integer: true });
          if (typeof a.status === "string") {
            actions.push({
              type: "condition",
              status: a.status,
              rounds: typeof a.rounds === "number" ? a.rounds : undefined,
            });
          }
        } else if (a.type === "cutscene") {
          strField(errors, awhere, a, "runKey");
          const script = resolveCutsceneAction(errors, awhere, a.script, loadFile);
          if (script) {
            if (script.sceneId !== undefined && script.sceneId !== sceneId) {
              errors.push(
                `${awhere}: cutscene "${script.name}" has sceneId ${JSON.stringify(script.sceneId)} but the zone set is on ${JSON.stringify(sceneId)} — omit sceneId to inherit the zone's scene.`,
              );
            } else {
              // Inherit the zone's scene as the script default, and
              // record that it was inherited (the plan reports it).
              const inherited = script.sceneId === undefined;
              actions.push({
                type: "cutscene",
                script: { ...script, sceneId: script.sceneId ?? sceneId },
                runKey: typeof a.runKey === "string" ? a.runKey : undefined,
                sceneIdInherited: inherited,
              });
            }
          }
        } else if (a.type === "reveal-floor") {
          // Stair: { room, wall, at } — the staircase's source-scene end.
          let stair: { room: string; wall: "north" | "south" | "east" | "west"; at: number } | null = null;
          const rawStair = a.stair;
          if (!isRecord(rawStair)) {
            errors.push(`${awhere}: "stair" must be an object {room, wall, at}.`);
          } else {
            let bad = false;
            if (typeof rawStair.room !== "string" || rawStair.room.length === 0) {
              errors.push(`${awhere}: "stair.room" must be a non-empty string.`);
              bad = true;
            }
            if (
              typeof rawStair.wall !== "string" ||
              !["north", "south", "east", "west"].includes(rawStair.wall)
            ) {
              errors.push(`${awhere}: "stair.wall" must be north|south|east|west.`);
              bad = true;
            }
            if (typeof rawStair.at !== "number" || !Number.isInteger(rawStair.at) || rawStair.at < 0) {
              errors.push(`${awhere}: "stair.at" must be a non-negative integer.`);
              bad = true;
            }
            if (!bad) {
              stair = {
                room: rawStair.room as string,
                wall: rawStair.wall as "north" | "south" | "east" | "west",
                at: rawStair.at as number,
              };
            }
          }
          let gate: import("../worldbuilding/tiles-layout.js").GateCondition | undefined;
          if (a.gate !== undefined) {
            const g = validateGate(a.gate);
            if (!g.ok) {
              for (const e of g.errors) errors.push(`${awhere} gate: ${e}`);
            } else {
              gate = g.gate;
            }
          }
          if (stair) {
            actions.push({
              type: "reveal-floor",
              stair,
              ...(gate ? { gate } : {}),
            });
          }
        }
      }
    }
    if (shape) {
      zones.push({
        name,
        shape,
        actions,
        triggerFor,
        fireOnce,
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, zoneSet: { sceneId, zones } };
}

/** Resolve one cutscene action's `script`: inline object or file path. */
function resolveCutsceneAction(
  errors: string[],
  where: string,
  script: unknown,
  loadFile: (path: string) => string,
): CutsceneScript | undefined {
  let parsed: unknown;
  if (typeof script === "string") {
    if (script.length === 0) {
      errors.push(`${where}: "script" must be a cutscene object or a non-empty file path.`);
      return undefined;
    }
    let text: string;
    try {
      text = loadFile(script);
    } catch (e) {
      errors.push(`${where}: could not read cutscene file ${JSON.stringify(script)}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      errors.push(`${where}: cutscene file ${JSON.stringify(script)} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  } else if (isRecord(script)) {
    parsed = script;
  } else {
    errors.push(`${where}: "script" must be a cutscene object or a file path, got ${typeof script}.`);
    return undefined;
  }
  const checked = validateCutscene(parsed);
  if (!checked.ok) {
    for (const e of checked.errors) errors.push(`${where}: ${e}`);
    return undefined;
  }
  return checked.script;
}

export interface ZoneCutsceneLinkPlan {
  /** The zone the cutscene is linked to. */
  zone: string;
  triggerFor: "any" | "pcs" | "npcs";
  /** Arming mode: "once" (fireOnce) or "per-token". */
  mode: ArmingMode;
  cutsceneName: string;
  /** Steps as authored. */
  scriptSteps: number;
  /** Steps after expansion (formations/rushes become concrete steps). */
  expandedSteps: number;
  /** Expanded step kinds, in order. */
  kinds: string[];
  /** True when the script inherited the zone set's sceneId. */
  sceneIdInherited: boolean;
}

export interface ZoneCutscenePlanSet {
  sceneId: string;
  links: ZoneCutsceneLinkPlan[];
  /** Zones with no cutscene action (plain trap/chat/condition zones). */
  plainZones: string[];
}

/**
 * Build the trigger plan for a resolved zone set: one entry per
 * cutscene-linked zone. Pure — but a formation centered on a token
 * needs live scene state to expand, so that is a plan error here
 * (play it live, or give the center as coordinates).
 */
export function planZoneCutsceneSet(
  zoneSet: ZoneSet,
): { ok: true; plan: ZoneCutscenePlanSet } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const links: ZoneCutsceneLinkPlan[] = [];
  const plainZones: string[] = [];
  for (const zone of zoneSet.zones) {
    const cutscenes = zone.actions.filter(
      (a): a is Extract<ZoneAction, { type: "cutscene" }> => a.type === "cutscene",
    );
    if (cutscenes.length === 0) {
      plainZones.push(zone.name);
      continue;
    }
    for (const action of cutscenes) {
      const script = action.script;
      let expanded;
      try {
        expanded = expandCutscene(script);
      } catch (e) {
        errors.push(
          `Zone "${zone.name}" cutscene "${script.name}": cannot expand offline: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      links.push({
        zone: zone.name,
        triggerFor: zone.triggerFor ?? "any",
        mode: zone.fireOnce ? "once" : "per-token",
        cutsceneName: script.name,
        scriptSteps: script.steps.length,
        expandedSteps: expanded.length,
        kinds: expanded.map((s) => s.kind),
        sceneIdInherited: action.sceneIdInherited ?? false,
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { sceneId: zoneSet.sceneId, links, plainZones } };
}
