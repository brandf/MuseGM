/**
 * Session modes (BRA-233) — one monitor session, three modes, switch
 * mid-build.
 *
 * The doc (Act Two): "Most real sessions will drift between all
 * three. Start a dungeon in co-design on Tuesday, tune a room
 * hands-on on Thursday, and improvise something gloriously unplanned
 * in the middle of Friday night. The tools should not make you
 * choose a mode in advance." The spec (FR-15): "the creator picks
 * per moment, and can switch mid-build."
 *
 * The three modes are the doc's own, one per FR — nothing invented:
 * - "hands-on" (FR-1): tile by tile — "add a door here".
 * - "co-design" (FR-15): the vague brief — "here's an entire floor,
 *   roughly: three pressure-plate puzzles, a riddle, two encounters,
 *   a boss" — Muse shapes it into a plan and the creator reacts.
 * - "improvise" (FR-18): mid-session, unplanned — the GM whispers an
 *   idea and a sequence plays out.
 * FR-9 director mode is v2 ("after the table has felt a few
 * cutscenes") and is deliberately NOT a fourth mode here.
 *
 * What the mode actually changes in the monitor today — honestly,
 * and only this:
 * - Builds execute in every mode. A direct tile instruction is a
 *   converged decision, not a brainstorm, whichever mode the session
 *   is in; suppressing it would make the GM rephrase a clear
 *   instruction. The mode is about what the creator is doing, not a
 *   lockout on the build loop.
 * - Briefs route by mode. In co-design, a floor-brief-shaped message
 *   is logged as a `brief` event (needs-agent with a brief marker)
 *   so the human Muse runs the convergence loop on it — instead of
 *   the build parser answering "I can't do that yet" for something
 *   that was never a tile request. In the other modes the same
 *   message is plain needs-agent. The convergence loop itself is
 *   not built yet (FR-15 status) — the monitor logs the brief, it
 *   does not claim to run the loop.
 * - Improvise changes no routing today: the GM-whisper path was
 *   already first in every mode (BRA-185), and the monitor cannot
 *   author a sequence from a public message. The mode still matters
 *   — it is the session's declared stance, it is in the log and the
 *   summary, and FR-9 (director mode) will key off it. Do not invent
 *   a routing difference to make the table look complete.
 *
 * Switching: one chat message from the GM ("let's go hands-on on
 * this room" / "take the brief from here"), or the `--mode` startup
 * option. The switch is visible (a `mode-switched` log line + a
 * confirmation in chat — a whisper back when the switch came by
 * whisper), reversible (switch back any time; switching to the
 * current mode is a no-op that says so), and persisted: the mode
 * survives a monitor restart in its own state file, same convention
 * as the build state (`$FOUNDRY_MODE_STATE` or `.mode-state.json`
 * at the repo root, best-effort, never throws). The build session
 * (rooms, plan, running sequence) is untouched by a switch — the
 * mode state and the build state are separate files on purpose.
 *
 * Everything here is pure — no Foundry, no I/O, except the state
 * file helpers (same best-effort pattern as build-loop's
 * save/loadBuildState) — so `bun test` covers it with no connection.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The three modes a monitor session can be in. */
export type SessionMode = "hands-on" | "co-design" | "improvise";

export const SESSION_MODES: readonly SessionMode[] = [
  "hands-on",
  "co-design",
  "improvise",
];

export function isSessionMode(v: unknown): v is SessionMode {
  return (
    typeof v === "string" && (SESSION_MODES as readonly string[]).includes(v)
  );
}

/** What each mode is, in the doc's own words. */
export interface ModeInfo {
  mode: SessionMode;
  /** Short label for chat and logs. */
  label: string;
  /** The FR the mode serves. */
  fr: string;
  /** One line: what the creator is doing in this mode. */
  blurb: string;
}

export const MODE_INFO: Record<SessionMode, ModeInfo> = {
  "hands-on": {
    mode: "hands-on",
    label: "Hands-on",
    fr: "FR-1",
    blurb: "tile by tile — build requests run as before.",
  },
  "co-design": {
    mode: "co-design",
    label: "Co-design",
    fr: "FR-15",
    blurb: "big-picture planning — floor briefs go to the convergence loop.",
  },
  improvise: {
    mode: "improvise",
    label: "Improvise",
    fr: "FR-18",
    blurb: "mid-session chaos, on — whisper an idea and it plays.",
  },
};

/**
 * What a mode means for routing. Builds execute in every mode (see
 * the header: a direct tile instruction is a converged decision).
 * Briefs are the one routing difference: only co-design marks them.
 */
export interface ModePolicy {
  buildsExecute: boolean;
  /** "log-brief" marks a brief-shaped message as a `brief` event;
   *  "chat" leaves it as plain needs-agent. */
  briefs: "log-brief" | "chat";
}

export const MODE_POLICIES: Record<SessionMode, ModePolicy> = {
  "hands-on": { buildsExecute: true, briefs: "chat" },
  "co-design": { buildsExecute: true, briefs: "log-brief" },
  improvise: { buildsExecute: true, briefs: "chat" },
};

// ---------------------------------------------------------------- switching

/** Normalize for matching: lowercase, collapse whitespace, trim. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Parse a chat line as a mode-switch request. Returns the target mode,
 * or null when the line is not a switch. The phrasings are the issue's
 * own ("let's go hands-on on this room" / "take the brief from
 * here") plus the obvious variants ("switch to X mode", "back to X",
 * "let's improvise", "X mode"). A switch needs a mode word AND a
 * switch cue (a verb, "mode", or the "take the brief" phrase) — a
 * bare mention ("the ogre is dead", "what's the brief?") never
 * switches. When a line names two modes ("switch from hands-on to
 * co-design"), the one after "to"/"into" wins; two modes with no
 * direction is ambiguous and returns null rather than guessing.
 */
export function parseModeSwitch(text: string): SessionMode | null {
  const s = norm(text);
  if (!s) return null;
  // The issue's co-design phrasing needs no verb: "take the brief".
  if (/\btake the brief(\s+from here)?\b/.test(s)) return "co-design";

  const modeWord =
    /(hands[\s-]?on|co[\s-]?design|improv\w*|emergent)/g;
  const mentions: { mode: SessionMode; index: number }[] = [];
  for (const m of s.matchAll(modeWord)) {
    const w = m[1];
    const mode: SessionMode = /^hands/.test(w)
      ? "hands-on"
      : /^co/.test(w)
        ? "co-design"
        : "improvise";
    mentions.push({ mode, index: m.index ?? 0 });
  }
  if (mentions.length === 0) return null;
  if (mentions.length === 1) {
    return hasSwitchCue(s, mentions[0].index) ? mentions[0].mode : null;
  }
  // Several modes named: the one after "to"/"into" is the target.
  const directed = mentions.find((m) => /(\bto|\binto)\s*$/.test(s.slice(0, m.index)));
  if (directed) return directed.mode;
  return null;
}

/**
 * A switch cue for a mode mention at `index`: a switch verb or
 * "mode" within a few words before it, or "mode" right after it.
 * ("let's go hands-on", "switch to co-design", "hands-on mode",
 * "back to improvise" all cue; "the hands-on approach" does not.)
 */
function hasSwitchCue(s: string, index: number): boolean {
  const before = s.slice(Math.max(0, index - 24), index);
  const after = s.slice(index, index + 24);
  if (/\bmode\b/.test(after)) return true;
  return /\b(let'?s|go|switch|back|use|set|enter|start)\b/.test(before);
}

/** The chat line confirming a switch (or a same-mode no-op). */
export function modeSwitchLine(from: SessionMode, to: SessionMode): string {
  if (from === to) {
    return `Already in ${MODE_INFO[to].label} mode.`;
  }
  const lines: Record<SessionMode, string> = {
    "hands-on":
      `🔨 Hands-on mode — tile by tile. Build requests run as before; say "take the brief from here" to switch to co-design, or "let's improvise" for mid-session improv.`,
    "co-design":
      `🗺️ Co-design mode — big-picture planning. Floor briefs go to the convergence loop; precise build requests ("add a door here") still run.`,
    improvise:
      `🎭 Improvise mode — mid-session chaos, on. Whisper me an idea and I'll play it; builds, rolls, and questions work as before.`,
  };
  return lines[to];
}

// ---------------------------------------------------------------- briefs

/**
 * Plan-level signal words in a message. A floor brief is a message
 * about the plan, not a tile: puzzles, a riddle, encounters, a boss,
 * intrigue, storyline threads. One signal alone is not a brief
 * ("add a boss" is a build-ish request, not a plan); two distinct
 * signals, or an explicit whole-floor phrase, is.
 */
const BRIEF_SIGNALS = [
  "puzzle",
  "riddle",
  "encounter",
  "boss",
  "intrigue",
  "storyline",
  "pressure plate",
  "unlock",
] as const;

const FLOOR_PHRASES = [
  "entire floor",
  "whole floor",
  "a floor of",
  "floor of a dungeon",
  "an entire floor",
] as const;

export interface BriefMatch {
  /** The plan-level signals found (lowercase, in signal order). */
  signals: string[];
}

/**
 * Recognize a floor-brief-shaped message, or null. Conservative on
 * purpose: a build ("build an 8x6 room with a south door") and
 * ordinary chat ("the ogre is dead") are never briefs. The caller
 * checks this only after the build/roll/question parses have all
 * said no — a direct instruction always wins over a brief reading.
 */
export function parseBriefRequest(text: string): BriefMatch | null {
  const s = norm(text);
  if (!s) return null;
  const signals = BRIEF_SIGNALS.filter((sig) => s.includes(sig));
  if (FLOOR_PHRASES.some((p) => s.includes(p))) {
    return { signals };
  }
  if (signals.length >= 2) return { signals };
  return null;
}

// ---------------------------------------------------------------- persistence

/** The mode state file's shape. Versioned like the build state. */
export interface ModeState {
  version: 1;
  mode: SessionMode;
}

export function isModeState(v: unknown): v is ModeState {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return s.version === 1 && isSessionMode(s.mode);
}

/**
 * Where the mode lives so a monitor restart keeps it. Same pattern
 * as the build state: an env override, else a dotfile at the repo
 * root. A separate file from the build state on purpose — the mode
 * and the build are independent, and a corrupt mode file must never
 * take the dungeon down with it.
 */
export function defaultModeStatePath(): string {
  return (
    process.env.FOUNDRY_MODE_STATE ??
    path.join(import.meta.dir, "..", "..", ".mode-state.json")
  );
}

/** Write the mode to the state file. Best effort, like the build
 *  state: a failed write never breaks the loop. */
export function saveModeState(
  mode: SessionMode,
  filePath: string = defaultModeStatePath(),
): void {
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, mode } satisfies ModeState),
      "utf-8",
    );
  } catch {
    // State is a convenience; a failed write must not break the loop.
  }
}

/** Read the mode back. Returns null when there is no state yet, or
 *  the file is unreadable or the wrong shape — the caller falls back
 *  to the startup option, then "hands-on". */
export function loadModeState(
  filePath: string = defaultModeStatePath(),
): SessionMode | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!isModeState(parsed)) return null;
    return parsed.mode;
  } catch {
    return null;
  }
}
