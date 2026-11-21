/**
 * Chat commands for named lights (BRA-240, FR-7 follow-up) — the pure
 * half. The monitor routes a GM chat message like "dim the braziers"
 * to `animateNamedLights` (src/session/lights.ts); this module is the
 * parser + the confirmation line, unit-tested with no connection.
 *
 * Recognized (X = a named light group):
 *   "dim X" / "darken X" / "snuff X" / "extinguish X" / "douse X" /
 *   "put out X" / "turn off X" / "switch off X" / "fade out X"
 *     → { dim: 0, bright: 0 } — the fade-out the BRA-197 checklist
 *     uses (`lights-name --dim 0 --bright 0`).
 *   "dim X to 100" → { dim: 100, bright: 50 } — the dim radius N with
 *     a bright core at half, the same proportion as the braziers and
 *     candles the dressing generator builds. Stated here, and in the
 *     confirmation line, so it is a convention, not a silent guess.
 *   "light X" / "relight X" / "ignite X" / "brighten X" /
 *   "turn on X" / "switch on X" / "fade in X" / "make X brighter" /
 *   "make X glow"
 *     → the kind's canonical radii from the dressing generator
 *     (`DRESSING_LIGHTS`): torch 300/120, candle 120/60, brazier
 *     400/200. Radii only — color and alpha are never touched, so a
 *     recolored light keeps its color. Needs a torch, candle, or
 *     brazier in the name: those are the kinds the dressing generator
 *     defines radii for. A light named "the center light" can be
 *     dimmed or set by number, but not relit by chat — the CLI
 *     (`lights-name --dim/--bright`) sets any numbers.
 *   "brighten X to 200" / "light X to 200" → { bright: 200 } — the
 *     bright radius; dim is left alone.
 *   "make X dimmer" → { dim: 0, bright: 0 }.
 *   "make X dim 100 [bright 50] [alpha 0.5]" / "set X to dim 100
 *   bright 50" → exactly the fields given.
 *   "make X red" / "set X to #ff0000" → { color } — color words
 *   (red, orange, amber, gold, yellow, green, blue, purple, violet,
 *   white, warm) map to the codebase's own hexes where one exists
 *   (amber = torch amber #ff9a3c, gold = candle gold #ffc46b,
 *   orange = brazier orange #ff8c2e).
 *
 * What this parser refuses, and why:
 * - The message must LEAD with the light verb (after "please" / "can
 *   you" / "meroki"). "add a door and dim the braziers" is a build
 *   compound — the build parser owns it; a light command never steals
 *   the first intent of a mixed line.
 * - The name must contain a light-kind word (brazier, torch, candle,
 *   lantern, chandelier, lamp, sconce, light, flame, glow, fire).
 *   That is the discriminator against build requests: "make the room
 *   darker" and "turn off the fog" have no light-kind word, so they
 *   fall through to the build parser exactly as before. "add torches"
 *   is a build (placing torch items) — "add" is not a light verb.
 * - "the lights" is NOT all lights: it resolves like any other name
 *   (a group literally named "the lights", if one exists). There is
 *   no all-lights command yet.
 * - A scene qualifier is not honored ("dim the torches in the entry
 *   hall" — the name as written won't resolve, and the resolver's
 *   error lists the lights that do exist). The monitor acts on the
 *   active scene only.
 * - Numbers out of range (alpha 2, a negative radius) are not a
 *   command — the message falls through to needs-agent rather than
 *   clamping a number the GM didn't ask for.
 * - A name containing "and" / "then" / "," is a compound, not one
 *   light command — it falls through so the build parser can have it.
 * - "make X" / "set X" with no target ("make the braziers") is not a
 *   command — the message doesn't say what to do with the light.
 */
import { DRESSING_LIGHTS, type DressingKind } from "./dressing.js";
import type { LightState } from "./lights.js";

/** What the monitor should do with a named light group. */
export interface LightCommand {
  /** The name phrase to resolve against the scene's named lights. */
  name: string;
  /** The target state — only the fields the message set. */
  target: Partial<LightState>;
  /** "dim" = fade out; "light" = relight to the kind's radii; "set" = explicit fields. */
  action: "dim" | "light" | "set";
  /** The kind the name carries, when it has one (the restore source). */
  kind?: DressingKind;
  /** The color word the GM used, when the color came from one — for the confirmation line. */
  colorWord?: string;
}

/** Color words the GM can use, with the hex each means. */
export const LIGHT_COLOR_WORDS: Record<string, string> = {
  red: "#ff0000",
  orange: "#ff8c2e", // brazier orange (dressing.ts)
  amber: "#ff9a3c", // torch amber (dressing.ts)
  gold: "#ffc46b", // candle gold (dressing.ts)
  yellow: "#ffff00",
  green: "#00ff00",
  blue: "#0000ff",
  purple: "#800080",
  violet: "#8a2be2",
  white: "#ffffff",
  warm: "#ff9a3c", // warm = torch amber
};

/** Words that mark a noun phrase as a light name. */
const LIGHT_KIND_WORDS =
  /\b(braziers?|torches?|candles?|lanterns?|chandeliers?|lamps?|sconces?|lights?|flames?|glows?|fires?)\b/i;

/** The kinds the dressing generator defines radii for. */
const RELIGHT_KINDS =
  /\b(braziers?|torches?|candles?)\b/i;

function kindOfName(name: string): DressingKind | undefined {
  const m = RELIGHT_KINDS.exec(name);
  if (!m) return undefined;
  const word = m[1].toLowerCase();
  if (word.startsWith("brazier")) return "brazier";
  if (word.startsWith("torch")) return "torch";
  return "candle";
}

const OFF_VERBS =
  /^(dim|darken|snuff|extinguish|douse|put\s+out|turn\s+off|switch\s+off|fade\s+out)\b/i;
const ON_VERBS =
  /^(light|relight|ignite|brighten|turn\s+on|switch\s+on|fade\s+in)\b/i;
const FLUFF_LEAD =
  /^(?:please[,\s]+|(?:can|could)\s+you[,\s]+|hey\s+meroki[,\s]+|meroki[,\s]+)+/i;

/**
 * Parse a chat line into a light command, or null when it isn't one.
 * The line must lead with the light verb (after "please" / "can you" /
 * "meroki") and the name must contain a light-kind word — anything
 * else falls through to the build parser / needs-agent untouched.
 */
export function parseLightCommand(text: string): LightCommand | null {
  let s = text.replace(/\s+/g, " ").replace(/[?!.]+$/, "").trim();
  if (!s) return null;
  s = s.replace(FLUFF_LEAD, "").trim();
  s = s.replace(/,\s*please\s*$/i, "").replace(/\s+please\s*$/i, "").trim();
  if (!s) return null;

  let verbKind: "off" | "on" | "make" | "set";
  let rest: string;
  let m = OFF_VERBS.exec(s);
  if (m) {
    verbKind = "off";
    rest = s.slice(m[0].length).trim();
  } else if ((m = ON_VERBS.exec(s))) {
    verbKind = "on";
    rest = s.slice(m[0].length).trim();
  } else if ((m = /^make\b/i.exec(s))) {
    verbKind = "make";
    rest = s.slice(m[0].length).trim();
  } else if ((m = /^set\b/i.exec(s))) {
    verbKind = "set";
    rest = s.slice(m[0].length).trim();
  } else {
    return null;
  }
  if (!rest) return null;

  // A compound joint in the remainder means this is two requests, not
  // one light command — let the build parser (or needs-agent) have it.
  if (/\b(and|then)\b/i.test(rest) || rest.includes(",")) return null;

  // --- trailing target spec, stripped from the end -----------------
  // Explicit fields and colors, innermost first ("dim 100 bright 50"
  // strips "bright 50", then "dim 100").
  let dim: number | undefined;
  let bright: number | undefined;
  let alpha: number | undefined;
  let color: string | undefined;
  let colorWord: string | undefined;
  for (;;) {
    let fm = /\bdim\s+(\d+)\s*$/i.exec(rest);
    if (fm) {
      dim = Number(fm[1]);
      rest = rest.slice(0, fm.index).trim();
      continue;
    }
    fm = /\bbright\s+(\d+)\s*$/i.exec(rest);
    if (fm) {
      bright = Number(fm[1]);
      rest = rest.slice(0, fm.index).trim();
      continue;
    }
    fm = /\balpha\s+(0(?:\.\d+)?|\.\d+|1(?:\.0+)?)\s*$/i.exec(rest);
    if (fm) {
      alpha = Number(fm[1]);
      rest = rest.slice(0, fm.index).trim();
      continue;
    }
    fm = /#([0-9a-f]{6})\s*$/i.exec(rest);
    if (fm) {
      color = `#${fm[1].toLowerCase()}`;
      colorWord = undefined;
      rest = rest.slice(0, fm.index).trim();
      continue;
    }
    fm = new RegExp(
      `\\b(${Object.keys(LIGHT_COLOR_WORDS).join("|")})\\s*$`,
      "i",
    ).exec(rest);
    if (fm) {
      colorWord = fm[1].toLowerCase();
      color = LIGHT_COLOR_WORDS[colorWord];
      rest = rest.slice(0, fm.index).trim();
      continue;
    }
    break;
  }
  // A bare trailing "color" ("make X color red" — the word is gone).
  rest = rest.replace(/\bcolor\s*$/i, "").trim();
  // A trailing "to" left over from "set X to ..." / "dim X to N".
  rest = rest.replace(/\bto\s*$/i, "").trim();
  // "to N" — the number after "dim" / "brighten" / "light".
  let toN: number | undefined;
  const toM = /\bto\s+(\d+)\s*$/i.exec(rest);
  if (toM) {
    toN = Number(toM[1]);
    rest = rest.slice(0, toM.index).trim();
  }
  // "glow" — "make X glow" lights the group (a color already stripped
  // rides along: "make X glow red" lights it red).
  let glow = false;
  if (/\bglow\s*$/i.test(rest)) {
    glow = true;
    rest = rest.replace(/\bglow\s*$/i, "").trim();
  }
  // "brighter" / "dimmer" — only make/set may say them; after an
  // off/on verb they contradict the verb ("dim X brighter").
  let dirWord: "brighter" | "dimmer" | undefined;
  const dirM = /\b(brighter|dimmer)\s*$/i.exec(rest);
  if (dirM) {
    if (verbKind !== "make" && verbKind !== "set") return null;
    dirWord = dirM[1].toLowerCase() as "brighter" | "dimmer";
    rest = rest.slice(0, dirM.index).trim();
  }

  // For off/on verbs, nothing but "to N" may trail: "dim X red" or
  // "dim X dim 100" is not a form we understand — don't guess.
  if (verbKind === "off" || verbKind === "on") {
    if (
      dim !== undefined ||
      bright !== undefined ||
      alpha !== undefined ||
      color !== undefined ||
      glow
    ) {
      return null;
    }
  }

  // The name is what's left. It must contain a light-kind word.
  const name = rest.trim();
  if (!name || !LIGHT_KIND_WORDS.test(name)) return null;
  const kind = kindOfName(name);

  const fields: Partial<LightState> = {};
  if (dim !== undefined) fields.dim = dim;
  if (bright !== undefined) fields.bright = bright;
  if (alpha !== undefined) fields.alpha = alpha;
  if (color !== undefined) fields.color = color;
  const hasFields = Object.keys(fields).length > 0;

  if (verbKind === "off") {
    if (toN !== undefined) {
      // "dim X to N": dim radius N, bright core at half (see header).
      return {
        name,
        target: { dim: toN, bright: Math.floor(toN / 2) },
        action: "set",
        kind,
        ...(colorWord ? { colorWord } : {}),
      };
    }
    return { name, target: { dim: 0, bright: 0 }, action: "dim", kind };
  }

  if (verbKind === "on") {
    if (toN !== undefined) {
      // "brighten X to N": the bright radius; dim is left alone.
      return { name, target: { bright: toN }, action: "set", kind };
    }
    if (!kind) return null; // relight needs a kind with canonical radii
    const preset = DRESSING_LIGHTS[kind];
    return {
      name,
      target: { dim: preset.dim, bright: preset.bright },
      action: "light",
      kind,
    };
  }

  // make / set: the trailing spec IS the target — with none, there is
  // no command ("make the braziers" doesn't say what to do).
  if (dirWord === "brighter" || glow) {
    if (!kind) return null;
    const preset = DRESSING_LIGHTS[kind];
    return {
      name,
      target: { dim: preset.dim, bright: preset.bright, ...fields },
      action: "light",
      kind,
      ...(colorWord ? { colorWord } : {}),
    };
  }
  if (dirWord === "dimmer") {
    return { name, target: { dim: 0, bright: 0 }, action: "dim", kind };
  }
  if (hasFields) {
    return {
      name,
      target: fields,
      action: "set",
      kind,
      ...(colorWord ? { colorWord } : {}),
    };
  }
  return null;
}

/**
 * The one confirmation line for a light change, against the resolved
 * display name (not the GM's query — "dim brazier" confirms as
 * "Dimmed the braziers."). States exactly what was set, so the GM
 * sees the numbers the parser chose.
 */
export function describeLightCommand(cmd: LightCommand, resolvedName: string): string {
  if (cmd.action === "dim") return `🔦 Dimmed ${resolvedName}.`;
  if (cmd.action === "light") return `🔦 Lit ${resolvedName}.`;
  const bits: string[] = [];
  if (cmd.target.dim !== undefined) bits.push(`dim ${cmd.target.dim}`);
  if (cmd.target.bright !== undefined) bits.push(`bright ${cmd.target.bright}`);
  if (cmd.target.alpha !== undefined) bits.push(`alpha ${cmd.target.alpha}`);
  if (cmd.target.color !== undefined) {
    bits.push(cmd.colorWord ?? `color ${cmd.target.color}`);
  }
  if (bits.length === 1 && cmd.target.color !== undefined) {
    return `🔦 Changed ${resolvedName} to ${bits[0]}.`;
  }
  return `🔦 Set ${resolvedName} to ${bits.join(", ")}.`;
}
