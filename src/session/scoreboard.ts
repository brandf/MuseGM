/**
 * Scoreboard (BRA-237) — visible score/points tracking for contests.
 *
 * The doc's cover promise is that the game can "build, light, score,
 * and spring the next moment" — and Act Five (dragon soccer): "The
 * rules are a clock and a score: first to three, fire is a foul —
 * sometimes." Clocks have their own module (BRA-228); this is the
 * score half: a match score, a wager tally, a race count that the
 * table can see and Muse can update in one sentence.
 *
 * HONESTY RULE (same as the quest log / chronicle): a score never
 * moves without a recorded cause. Every award and set carries a
 * `source` — who scored, or what happened ("Valeros scored", "fire
 * foul on the Red side") — and a change without a source is rejected,
 * so the board never silently gains points nobody called. The event
 * history is the record; the totals are derived from it, never
 * asserted separately.
 *
 * Two layers, kept separate on purpose (same pattern as
 * src/session/questlog.ts):
 * - Pure functions (startScoreboard / awardPoints / setPoints /
 *   endScoreboard / scoreboardToText / scoreboardToJournalHtml /
 *   parseScoreboardRequest): no Foundry, no I/O, unit tested in
 *   tests/scoreboard.test.ts. All ops are immutable — they return a
 *   new board and never mutate the input.
 * - Live functions (*Live): thin wrappers over FoundryLive. The
 *   boards are persisted as a JournalEntry named "Scoreboard"
 *   (created `observer` so the party can read it in Foundry), one
 *   JournalEntryPage per board. Each page carries the full board JSON
 *   in `flags["foundry-live"].scoreboard` — the flags are the source
 *   of truth and the HTML is only the display — so reading the boards
 *   back never has to parse HTML. A first page named "Scoreboard" is
 *   the index. Every live change also posts one chat line, so the
 *   table sees the score move.
 *
 * A board is one contest: a name, a target (first to N wins), and
 * two or more teams. A team is a side — "Red", "Blue", or in a race
 * one entry per racer. Points are an unbounded integer tally: a foul
 * subtracts a point and may take a team below zero rather than
 * silently clamping — the record says what happened. The first team
 * to reach the target wins immediately (overshoot counts); a won
 * board is terminal, like a completed quest. `endScoreboard` closes
 * an unfinished board early: the unique leader wins, a tie ends
 * with no winner.
 *
 * What this module does NOT do (follow-ups, not gaps):
 * - Monitor chat routing: `parseScoreboardRequest` is the pure half
 *   (start / award / foul / show / end phrasings); wiring it into
 *   the monitor's routing is a monitor.ts change, owned elsewhere.
 * - An open-ended tally with no target: `target` is required — the
 *   issue's acceptance is "first to N". A target-less board is a
 *   later extension, not a faked null target here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FoundryLive } from "../live.js";

/** One side of a contest. */
export interface ScoreTeam {
  id: string;
  name: string;
  points: number;
}

/** One recorded score change — the cause is part of the record. */
export interface ScoreEvent {
  teamId: string;
  /** Points change: positive for a score, negative for a foul. */
  delta: number;
  /** The team's points immediately after this event. */
  pointsAfter: number;
  /** Who scored, or what happened. Required — see the module header. */
  source: string;
  /** ISO timestamp of the event. */
  at: string;
}

export type ScoreboardStatus = "active" | "won" | "ended";

/** One contest. */
export interface Scoreboard {
  id: string;
  name: string;
  /** First to this many points wins. Positive integer. */
  target: number;
  teams: ScoreTeam[];
  events: ScoreEvent[];
  status: ScoreboardStatus;
  /** The winning team, once the board is won or ended with a leader. */
  winnerId: string | null;
  /** ISO date the board was started. */
  createdAt: string;
}

/** Every board the table has run (current and past). */
export interface ScoreboardStore {
  boards: Scoreboard[];
}

/** Validation / lookup failure. */
export class ScoreboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreboardError";
  }
}

/** An empty store. */
export function emptyScoreboardStore(): ScoreboardStore {
  return { boards: [] };
}

/** Slugify a name into a stable id ("Dragon Soccer" -> "dragon-soccer"). */
export function boardIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "scoreboard";
}

/** Slugify a team name ("Red Dragons" -> "red-dragons"). */
export function teamIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "team";
}

function cloneBoard(board: Scoreboard): Scoreboard {
  return {
    ...board,
    teams: board.teams.map((t) => ({ ...t })),
    events: board.events.map((e) => ({ ...e })),
  };
}

function cloneStore(store: ScoreboardStore): ScoreboardStore {
  return { boards: store.boards.map(cloneBoard) };
}

/** Input for starting a board. */
export interface StartScoreboardInput {
  name: string;
  /** First to this many points wins. Must be a positive integer. */
  target: number;
  /** Team names, in order. At least two, all distinct. */
  teams: string[];
  /** ISO date; defaults to today. */
  createdAt?: string;
}

/**
 * Start a board. Throws on an empty name, a non-positive or
 * non-integer target, fewer than two teams, or an empty or duplicate
 * team name (compared case-insensitively — "Red" and "red" are the
 * same team and would collide on lookup).
 */
export function startScoreboard(input: StartScoreboardInput): Scoreboard {
  const name = input.name.trim();
  if (!name) throw new ScoreboardError("A scoreboard needs a name.");
  if (!Number.isInteger(input.target) || input.target <= 0) {
    throw new ScoreboardError(
      `A scoreboard needs a target — first to how many points? Got ${JSON.stringify(input.target)}.`,
    );
  }
  if (!Array.isArray(input.teams) || input.teams.length < 2) {
    throw new ScoreboardError(
      "A scoreboard needs at least two teams — name the sides (e.g. Red and Blue).",
    );
  }
  const seen = new Set<string>();
  const teams: ScoreTeam[] = [];
  for (const raw of input.teams) {
    const teamName = raw.trim();
    if (!teamName) throw new ScoreboardError("Team names can't be blank.");
    const key = teamName.toLowerCase();
    if (seen.has(key)) {
      throw new ScoreboardError(`Duplicate team: "${teamName}" — each side needs its own name.`);
    }
    seen.add(key);
    teams.push({ id: teamIdFromName(teamName), name: teamName, points: 0 });
  }
  return {
    id: boardIdFromName(name),
    name,
    target: input.target,
    teams,
    events: [],
    status: "active",
    winnerId: null,
    createdAt: input.createdAt ?? new Date().toISOString().slice(0, 10),
  };
}

/** Find a board in the store, or undefined. */
export function getBoard(
  store: ScoreboardStore,
  boardId: string,
): Scoreboard | undefined {
  return store.boards.find((b) => b.id === boardId);
}

/** Add a board to the store. Throws on a duplicate id. */
export function addBoard(
  store: ScoreboardStore,
  board: Scoreboard,
): ScoreboardStore {
  if (getBoard(store, board.id)) {
    throw new ScoreboardError(
      `A scoreboard called "${board.name}" already exists — end it or start one with a different name.`,
    );
  }
  const next = cloneStore(store);
  next.boards.push(cloneBoard(board));
  return next;
}

/** Replace a board in the store with its new state. Throws when unknown. */
export function updateBoard(
  store: ScoreboardStore,
  board: Scoreboard,
): ScoreboardStore {
  const idx = store.boards.findIndex((b) => b.id === board.id);
  if (idx < 0) throw new ScoreboardError(`Unknown scoreboard: ${board.id}`);
  const next = cloneStore(store);
  next.boards[idx] = cloneBoard(board);
  return next;
}

/** Boards still in play, in start order. */
export function activeBoards(store: ScoreboardStore): Scoreboard[] {
  return store.boards.filter((b) => b.status === "active");
}

/** Find a team on a board, or undefined. */
export function getTeam(
  board: Scoreboard,
  teamId: string,
): ScoreTeam | undefined {
  return board.teams.find((t) => t.id === teamId);
}

/**
 * Resolve a team by id, exact name (case-insensitive), or a unique
 * substring — the same never-guess rule as the named lights: an
 * unknown team lists the teams that exist, and a name matching more
 * than one team lists the matches and asks for one exactly.
 */
export function resolveTeam(board: Scoreboard, query: string): ScoreTeam {
  const listNames = (): string =>
    board.teams.map((t) => `"${t.name}"`).join(", ");
  const key = query.trim().toLowerCase();
  if (!key) {
    throw new ScoreboardError(`Name a team — teams on this board: ${listNames()}.`);
  }
  const byId = board.teams.find((t) => t.id === key);
  if (byId) return byId;
  const exact = board.teams.find((t) => t.name.toLowerCase() === key);
  if (exact) return exact;
  const partial = board.teams.filter((t) => t.name.toLowerCase().includes(key));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new ScoreboardError(
      `"${query.trim()}" matches more than one team: ${partial.map((t) => `"${t.name}"`).join(", ")} — name one exactly.`,
    );
  }
  throw new ScoreboardError(
    `No team named "${query.trim()}" on "${board.name}" — teams here: ${listNames()}.`,
  );
}

/** The team(s) on top, and whether the lead is tied. */
export function leader(board: Scoreboard): { team: ScoreTeam; tied: boolean } {
  let top = board.teams[0];
  let tied = false;
  for (const t of board.teams.slice(1)) {
    if (t.points > top.points) {
      top = t;
      tied = false;
    } else if (t.points === top.points) {
      tied = true;
    }
  }
  return { team: top, tied };
}

function requireSource(source: string | undefined): string {
  const s = (source ?? "").trim();
  if (!s) {
    throw new ScoreboardError(
      "A score change needs a source — who scored, or what happened.",
    );
  }
  return s;
}

function requireActive(board: Scoreboard): void {
  if (board.status !== "active") {
    throw new ScoreboardError(
      `"${board.name}" is already ${board.status === "won" ? `won by ${board.teams.find((t) => t.id === board.winnerId)?.name ?? "?"}` : "ended"} — start a new board for the next contest.`,
    );
  }
}

function applyEvent(
  board: Scoreboard,
  teamId: string,
  delta: number,
  source: string,
  at: string,
): { board: Scoreboard; event: ScoreEvent; won: boolean } {
  const next = cloneBoard(board);
  const team = next.teams.find((t) => t.id === teamId)!;
  team.points += delta;
  const event: ScoreEvent = { teamId, delta, pointsAfter: team.points, source, at };
  next.events.push(event);
  let won = false;
  if (team.points >= next.target) {
    next.status = "won";
    next.winnerId = team.id;
    won = true;
  }
  return { board: next, event, won };
}

/**
 * Award points to a team: positive for a score, negative for a foul.
 * Returns the new board, the recorded event, and whether this change
 * won the contest. Throws on a finished board, a zero or non-integer
 * delta, an unknown team, or a missing source.
 */
export function awardPoints(
  board: Scoreboard,
  team: string,
  delta: number,
  source: string,
  at: string = new Date().toISOString(),
): { board: Scoreboard; event: ScoreEvent; won: boolean } {
  requireActive(board);
  if (!Number.isInteger(delta) || delta === 0) {
    throw new ScoreboardError(
      `A score change needs a whole number of points, not zero — got ${JSON.stringify(delta)}.`,
    );
  }
  const resolved = resolveTeam(board, team);
  return applyEvent(board, resolved.id, delta, requireSource(source), at);
}

/**
 * Set a team's points outright (a correction, or a starting score).
 * Same validation as awardPoints; reaching the target wins.
 */
export function setPoints(
  board: Scoreboard,
  team: string,
  points: number,
  source: string,
  at: string = new Date().toISOString(),
): { board: Scoreboard; event: ScoreEvent; won: boolean } {
  requireActive(board);
  if (!Number.isInteger(points)) {
    throw new ScoreboardError(
      `Points must be a whole number — got ${JSON.stringify(points)}.`,
    );
  }
  const resolved = resolveTeam(board, team);
  return applyEvent(board, resolved.id, points - resolved.points, requireSource(source), at);
}

/**
 * End an unfinished board early: the unique leader wins, a tie ends
 * with no winner. Ending an already-finished board is a no-op that
 * says so (same pattern as completing an already-completed quest).
 */
export function endScoreboard(
  board: Scoreboard,
): { board: Scoreboard; alreadyFinished: boolean } {
  if (board.status !== "active") return { board: cloneBoard(board), alreadyFinished: true };
  const next = cloneBoard(board);
  const { team, tied } = leader(next);
  next.status = "ended";
  next.winnerId = tied ? null : team.id;
  return { board: next, alreadyFinished: false };
}

/** "Red 2, Blue 1" — the teams in board order. */
export function scoreLine(board: Scoreboard): string {
  return board.teams.map((t) => `${t.name} ${t.points}`).join(", ");
}

/** One-line summary of a board, for chat or a log. */
export function scoreboardToText(board: Scoreboard): string {
  if (board.status === "won") {
    const winner = board.teams.find((t) => t.id === board.winnerId);
    return `🏆 ${winner?.name ?? "?"} wins ${board.name}, ${scoreLine(board)} (first to ${board.target})!`;
  }
  if (board.status === "ended") {
    const winner = board.winnerId
      ? board.teams.find((t) => t.id === board.winnerId)
      : undefined;
    return winner
      ? `${board.name} ended — ${winner.name} leads, ${scoreLine(board)} (first to ${board.target}).`
      : `${board.name} ended tied, ${scoreLine(board)} (first to ${board.target}).`;
  }
  return `⚽ ${board.name} — ${scoreLine(board)} (first to ${board.target})`;
}

/**
 * The chat line for one score change — the line the table sees. The
 * event's source is the cause ("Valeros scored", "fire foul on the
 * Red side"); the winner line replaces the score line when the change
 * wins the contest.
 */
export function scoreboardToChatLine(
  board: Scoreboard,
  event: ScoreEvent,
): string {
  const team = board.teams.find((t) => t.id === event.teamId);
  const name = team?.name ?? "?";
  if (board.status === "won" && board.winnerId === event.teamId) {
    return `🏆 ${name} wins ${board.name}, ${scoreLine(board)} (first to ${board.target})! — ${event.source}`;
  }
  if (event.delta < 0) {
    return `🔥 Foul! ${name} ${event.delta} — ${scoreLine(board)} (first to ${board.target}) — ${event.source}`;
  }
  return `⚽ ${name} scores! ${scoreLine(board)} (first to ${board.target}) — ${event.source}`;
}

/** The chat line for starting a board. */
export function scoreboardStartLine(board: Scoreboard): string {
  return `🏆 Scoreboard started: ${board.name} — ${board.teams.map((t) => t.name).join(" vs ")}, first to ${board.target}.`;
}

/** The board as a journal page (HTML). The flags carry the JSON; this is display only. */
export function scoreboardToJournalHtml(board: Scoreboard): string {
  const rows = board.teams
    .map((t) => `<tr><td>${t.name}</td><td>${t.points}</td></tr>`)
    .join("");
  const history =
    board.events.length === 0
      ? "<p>No scores yet.</p>"
      : `<ul>${board.events
          .map(
            (e) =>
              `<li>${board.teams.find((t) => t.id === e.teamId)?.name ?? "?"} ${e.delta > 0 ? "+" : ""}${e.delta} (${e.pointsAfter}) — ${e.source}</li>`,
          )
          .join("")}</ul>`;
  const status =
    board.status === "won"
      ? `<p>🏆 Winner: ${board.teams.find((t) => t.id === board.winnerId)?.name ?? "?"}.</p>`
      : board.status === "ended"
        ? `<p>Ended${board.winnerId ? ` — winner: ${board.teams.find((t) => t.id === board.winnerId)?.name ?? "?"}.` : " — tied."}</p>`
        : `<p>First to ${board.target} wins.</p>`;
  return `<h1>${board.name}</h1><table><tr><th>Team</th><th>Points</th></tr>${rows}</table>${status}${history}`;
}

/** The store index page (HTML): every board, one line each. */
export function scoreboardIndexHtml(store: ScoreboardStore): string {
  if (store.boards.length === 0) return "<h1>Scoreboard</h1><p>No contests yet.</p>";
  const lines = store.boards.map((b) => `<li>${scoreboardToText(b)}</li>`).join("");
  return `<h1>Scoreboard</h1><ul>${lines}</ul>`;
}

// ---------------------------------------------------------------- serialization

/** True when a value has the shape of a Scoreboard. */
export function isScoreboard(v: unknown): v is Scoreboard {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.name === "string" &&
    Number.isInteger(b.target) &&
    (b.target as number) > 0 &&
    Array.isArray(b.teams) &&
    (b.teams as unknown[]).length >= 2 &&
    (b.teams as Record<string, unknown>[]).every(
      (t) =>
        typeof t.id === "string" &&
        typeof t.name === "string" &&
        Number.isInteger(t.points),
    ) &&
    Array.isArray(b.events) &&
    (b.status === "active" || b.status === "won" || b.status === "ended") &&
    (b.winnerId === null || typeof b.winnerId === "string") &&
    typeof b.createdAt === "string"
  );
}

/** Parse a board from JSON. Throws on the wrong shape. */
export function parseScoreboard(json: string): Scoreboard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ScoreboardError("That is not a scoreboard (bad JSON).");
  }
  if (!isScoreboard(parsed)) {
    throw new ScoreboardError("That is not a scoreboard (wrong shape).");
  }
  return parsed;
}

/** True when a value has the shape of a ScoreboardStore. */
export function isScoreboardStore(v: unknown): v is ScoreboardStore {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return Array.isArray(s.boards) && (s.boards as unknown[]).every(isScoreboard);
}

/** Parse a store from JSON. Throws on the wrong shape. */
export function parseScoreboardStore(json: string): ScoreboardStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ScoreboardError("That is not a scoreboard store (bad JSON).");
  }
  if (!isScoreboardStore(parsed)) {
    throw new ScoreboardError("That is not a scoreboard store (wrong shape).");
  }
  return parsed;
}

// ---------------------------------------------------------------- file state

interface ScoreboardStateFile {
  version: 1;
  boards: Scoreboard[];
}

/**
 * Where the scoreboards live so a monitor restart keeps them. Same
 * pattern as the mode / build state: an env override, else a dotfile
 * at the repo root. A separate file from the build and mode state on
 * purpose — a corrupt scoreboard file must never take the dungeon or
 * the mode down with it.
 */
export function defaultScoreboardStatePath(): string {
  return (
    process.env.FOUNDRY_SCOREBOARD_STATE ??
    path.join(import.meta.dir, "..", "..", ".scoreboard-state.json")
  );
}

/** Write the store to the state file. Best effort, like the mode
 *  state: a failed write never breaks the loop. */
export function saveScoreboardState(
  store: ScoreboardStore,
  filePath: string = defaultScoreboardStatePath(),
): void {
  try {
    const file: ScoreboardStateFile = { version: 1, boards: store.boards };
    fs.writeFileSync(filePath, JSON.stringify(file), "utf-8");
  } catch {
    // State is a convenience; a failed write must not break the loop.
  }
}

/**
 * Read the store back. Returns null when there is no state yet, or
 * the file is unreadable or the wrong shape — the caller starts
 * fresh either way.
 */
export function loadScoreboardState(
  filePath: string = defaultScoreboardStatePath(),
): ScoreboardStore | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const f = parsed as Record<string, unknown>;
    if (f.version !== 1 || !Array.isArray(f.boards)) return null;
    if (!(f.boards as unknown[]).every(isScoreboard)) return null;
    return { boards: f.boards as Scoreboard[] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- chat parsing

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseTarget(text: string): number | null {
  const m = targetMatch(text);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
}

function targetMatch(text: string): RegExpExecArray | null {
  return /first to (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(text);
}

function splitTeams(segment: string): string[] {
  return segment
    .split(/\s+(?:vs\.?|versus|and)\s+|,\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type ScoreboardRequest =
  | { kind: "start"; name: string; target: number; teams: string[] }
  | { kind: "award"; boardId: string; team: string; delta: number; source: string }
  | { kind: "show"; boardId?: string }
  | { kind: "end"; boardId: string }
  | { kind: "clarify"; message: string };

/**
 * Parse one chat line into a scoreboard decision. Returns null when
 * the line isn't a scoreboard request at all (so the monitor falls
 * through to the other branches). Ambiguity is a question, never a
 * guess; out-of-scope is null, never a hallucinated board.
 *
 * Recognized:
 *   "start a dragon soccer scoreboard, first to 3, Red vs Blue"
 *   "start a scoreboard for the wager, first to five, Red and Blue"
 *   "Red scores" / "goal for Red" / "Red scores a goal"
 *   "foul on Red" / "fire foul on the Red side" (delta -1)
 *   "show the scoreboard" / "what's the score"
 *   "end the scoreboard"
 *
 * An award names its board only when more than one board is active
 * ("Red scores on the dragon soccer board"); with exactly one active
 * board it is the board; with none the parser asks to start one.
 */
export function parseScoreboardRequest(
  text: string,
  store: ScoreboardStore,
): ScoreboardRequest | null {
  const s = text.trim();
  const active = activeBoards(store);

  // Start: "start a <name> scoreboard, first to <n>, <teams>" or
  // "start a scoreboard for <name>, first to <n>, <teams>". The name
  // is the word(s) before "scoreboard", or after "for" when the board
  // is named that way ("start a scoreboard for the wager" has no
  // word before "scoreboard" — a single regex can't cover both).
  if (/^start\b/i.test(s) && /\bscoreboard\b/i.test(s)) {
    const namedM = /^start (?:a |the )?(.+?) scoreboard\b/i.exec(s);
    const forM = /^start (?:a |the )?scoreboard for (.+?)(?:,|\s+first to|$)/i.exec(s);
    // The "for" shape wins: the named shape would read the article as
    // the name ("start a scoreboard for the wager" -> name "a").
    // A bare article alone is no name at all.
    const rawName = ((forM?.[1] ?? namedM?.[1] ?? "").trim());
    const name = /^(a|the)$/i.test(rawName) ? "" : rawName;
    const tMatch = targetMatch(s);
    const target = parseTarget(s);
    // Teams come after "first to N" (the issue's order: name, target,
    // teams); when the teams come first, they sit between "scoreboard"
    // and "first to".
    let teamsSegment = "";
    if (tMatch) {
      teamsSegment = s.slice(tMatch.index + tMatch[0].length).replace(/^,?\s*/, "");
      if (!teamsSegment.trim()) {
        const between = s.slice(s.toLowerCase().indexOf("scoreboard") + "scoreboard".length, tMatch.index);
        teamsSegment = between.replace(/^,?\s*/, "").replace(/,?\s*$/, "");
      }
    }
    if (!name) return { kind: "clarify", message: "What should the scoreboard be called?" };
    if (target === null || target === undefined) {
      return {
        kind: "clarify",
        message: `First to how many points for "${name}"?`,
      };
    }
    const teams = splitTeams(teamsSegment);
    if (teams.length < 2) {
      return {
        kind: "clarify",
        message: `Which teams play "${name}"? Name at least two (e.g. Red vs Blue).`,
      };
    }
    return { kind: "start", name, target, teams };
  }

  // Show: "show the scoreboard" / "what's the score"
  if (/\bshow (?:the )?scoreboard\b/i.test(s) || /what'?s the score\b/i.test(s)) {
    if (active.length === 1) return { kind: "show", boardId: active[0].id };
    if (active.length === 0) {
      return { kind: "clarify", message: "No scoreboard is running — start one first." };
    }
    return {
      kind: "clarify",
      message: `Which scoreboard? Running now: ${active.map((b) => `"${b.name}"`).join(", ")}.`,
    };
  }

  // End: "end the scoreboard" / "end the <name> scoreboard"
  const endM = /^end (?:the )?(.+?)?\s*scoreboard$/i.exec(s);
  if (endM) {
    const named = (endM[1] ?? "").trim();
    if (named) {
      const board = active.find((b) => b.name.toLowerCase() === named.toLowerCase());
      if (!board) {
        return {
          kind: "clarify",
          message: `No running scoreboard called "${named}" — running now: ${active.map((b) => `"${b.name}"`).join(", ") || "none"}.`,
        };
      }
      return { kind: "end", boardId: board.id };
    }
    if (active.length === 1) return { kind: "end", boardId: active[0].id };
    if (active.length === 0) {
      return { kind: "clarify", message: "No scoreboard is running — nothing to end." };
    }
    return {
      kind: "clarify",
      message: `Which scoreboard should end? Running now: ${active.map((b) => `"${b.name}"`).join(", ")}.`,
    };
  }

  // Award / foul: "<team> scores" / "goal for <team>" / "foul on <team>".
  // A trailing " on the <name> board" names the board — stripped
  // first (greedy, so the LAST "on" wins: "foul on Red on the dragon
  // soccer board" is a foul on Red, on the dragon soccer board).
  const boardSuffix = /^([\s\S]*)\s+on (?:the )?(.+) board$/i.exec(s);
  const core = (boardSuffix?.[1] ?? s).trim();
  const boardName = boardSuffix?.[2].trim();
  const foulM = /\bfoul (?:on|against) (?:the )?(.+?)(?:\s+side)?$/i.exec(core);
  const goalM =
    /^(?:goal for|goal by|point for|point to) (?:the )?(.+)$/i.exec(core) ??
    /^(.+?) scores?(?: a goal)?$/i.exec(core);
  const awardM = foulM ?? goalM;
  if (awardM) {
    const teamQuery = awardM[1].trim();
    const delta = foulM ? -1 : 1;
    if (active.length === 0) {
      return { kind: "clarify", message: "No scoreboard is running — start one first." };
    }
    let board: Scoreboard | undefined;
    if (boardName) {
      board = active.find((b) => b.name.toLowerCase() === boardName.toLowerCase());
      if (!board) {
        return {
          kind: "clarify",
          message: `No running scoreboard called "${boardName}" — running now: ${active.map((b) => `"${b.name}"`).join(", ")}.`,
        };
      }
    } else if (active.length === 1) {
      board = active[0];
    } else {
      // Several boards: the team name may disambiguate.
      const matches = active.filter((b) => {
        try {
          resolveTeam(b, teamQuery);
          return true;
        } catch {
          return false;
        }
      });
      if (matches.length === 1) board = matches[0];
      else {
        return {
          kind: "clarify",
          message: `Which scoreboard? Running now: ${active.map((b) => `"${b.name}"`).join(", ")}.`,
        };
      }
    }
    return { kind: "award", boardId: board.id, team: teamQuery, delta, source: s };
  }

  // "score" mentioned but nothing above matched — not a scoreboard request.
  return null;
}

// ---------------------------------------------------------------- live layer

/** Name of the JournalEntry that holds the scoreboards. */
export const SCOREBOARD_NAME = "Scoreboard";

/** Title of the index page inside the scoreboard entry. */
export const SCOREBOARD_INDEX_PAGE = "Scoreboard";

interface RawJournalPage {
  _id: string;
  name: string;
  text?: { content?: string };
  flags?: Record<string, unknown>;
}

interface RawJournal {
  _id: string;
  name: string;
  pages?: RawJournalPage[];
  flags?: Record<string, unknown>;
}

interface RawClient {
  getJournals(): RawJournal[];
  createJournalEntry(
    name: string,
    pages: { name: string; content: string }[],
    folder?: string,
    visibility?: string,
  ): Promise<{ _id: string }>;
}

function rawClient(live: FoundryLive): RawClient {
  return live.raw() as unknown as RawClient;
}

function boardFlags(board: Scoreboard): Record<string, unknown> {
  return { "foundry-live": { boardId: board.id, scoreboard: board } };
}

function pageBoard(page: RawJournalPage): Scoreboard | null {
  const flags = page.flags?.["foundry-live"] as { scoreboard?: Scoreboard } | undefined;
  const board = flags?.scoreboard;
  if (!board || !isScoreboard(board)) return null;
  return board;
}

/** Find the scoreboard JournalEntry, if it exists. Flagged entries win over name matches. */
export function findScoreboardEntry(live: FoundryLive): RawJournal | null {
  const journals = rawClient(live).getJournals();
  const flagged = journals.find(
    (j) => (j.flags?.["foundry-live"] as { scoreboard?: boolean } | undefined)?.scoreboard === true,
  );
  if (flagged) return flagged;
  return journals.find((j) => j.name === SCOREBOARD_NAME) ?? null;
}

/**
 * Read the scoreboards from the world. Boards come from page flags
 * (the source of truth); pages without a board flag — including the
 * index page — are skipped. Returns the entry id (null when no entry
 * exists yet) and the store.
 */
export function readScoreboards(
  live: FoundryLive,
): { entryId: string | null; store: ScoreboardStore } {
  const entry = findScoreboardEntry(live);
  if (!entry) return { entryId: null, store: emptyScoreboardStore() };
  const boards: Scoreboard[] = [];
  for (const page of entry.pages ?? []) {
    const board = pageBoard(page);
    if (board) boards.push(board);
  }
  return { entryId: entry._id, store: { boards } };
}

/** Find a board's page inside an entry, by board id flag. */
function findBoardPage(entry: RawJournal, boardId: string): RawJournalPage | undefined {
  return (entry.pages ?? []).find(
    (p) => (p.flags?.["foundry-live"] as { boardId?: string } | undefined)?.boardId === boardId,
  );
}

function findIndexPage(entry: RawJournal): RawJournalPage | undefined {
  return (entry.pages ?? []).find((p) => p.name === SCOREBOARD_INDEX_PAGE);
}

/**
 * Create the scoreboard entry if it doesn't exist yet (one index page,
 * `observer` so the party can read it), and flag it. Returns the entry id.
 */
export async function ensureScoreboardEntry(live: FoundryLive): Promise<string> {
  const existing = findScoreboardEntry(live);
  if (existing) return existing._id;
  const created = await rawClient(live).createJournalEntry(
    SCOREBOARD_NAME,
    [{ name: SCOREBOARD_INDEX_PAGE, content: scoreboardIndexHtml(emptyScoreboardStore()) }],
    undefined,
    "observer",
  );
  await live.modifyDocument("JournalEntry", "update", {
    updates: [{ _id: created._id, flags: { "foundry-live": { scoreboard: true } } }],
  });
  return created._id;
}

/** Write (create or update) one board's page, then refresh the index page. */
async function writeBoardPage(
  live: FoundryLive,
  entryId: string,
  board: Scoreboard,
): Promise<string> {
  const entry = findScoreboardEntry(live);
  const existing = entry ? findBoardPage(entry, board.id) : undefined;
  const content = scoreboardToJournalHtml(board);
  if (existing) {
    await live.modifyDocument("JournalEntryPage", "update", {
      updates: [{ _id: existing._id, text: { content }, flags: boardFlags(board) }],
      parentUuid: `JournalEntry.${entryId}`,
    });
    return existing._id;
  }
  const created = await live.modifyDocument("JournalEntryPage", "create", {
    data: [
      {
        name: board.name,
        type: "text",
        text: { content, format: 1 },
        flags: boardFlags(board),
      },
    ],
    parentUuid: `JournalEntry.${entryId}`,
  });
  return String(created[0]._id);
}

/** Refresh the index page to match the current store. */
async function writeIndexPage(
  live: FoundryLive,
  entryId: string,
  store: ScoreboardStore,
): Promise<void> {
  const entry = findScoreboardEntry(live);
  const index = entry ? findIndexPage(entry) : undefined;
  if (!index) return; // The entry was created with one; a missing index is not fatal.
  await live.modifyDocument("JournalEntryPage", "update", {
    updates: [{ _id: index._id, text: { content: scoreboardIndexHtml(store) } }],
    parentUuid: `JournalEntry.${entryId}`,
  });
}

/** Read the boards, apply a change, write the page + index, post the chat line. */
async function applyBoardChangeLive(
  live: FoundryLive,
  boardId: string,
  change: (
    board: Scoreboard,
  ) => { board: Scoreboard; event: ScoreEvent; won?: boolean; chatLine: string },
): Promise<{ board: Scoreboard; event: ScoreEvent; won: boolean }> {
  const { store } = readScoreboards(live);
  const board = getBoard(store, boardId);
  if (!board) throw new ScoreboardError(`Unknown scoreboard: ${boardId}`);
  const result = change(board);
  const next = updateBoard(store, result.board);
  const entryId = await ensureScoreboardEntry(live);
  await writeBoardPage(live, entryId, result.board);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(result.chatLine);
  return { board: result.board, event: result.event, won: result.won ?? false };
}

/** List the boards on the table (entry id + store + one-line summary). */
export function listScoreboardsLive(live: FoundryLive): {
  entryId: string | null;
  store: ScoreboardStore;
  text: string;
} {
  const { entryId, store } = readScoreboards(live);
  if (store.boards.length === 0) {
    return { entryId, store, text: "No scoreboards yet — start one first." };
  }
  return {
    entryId,
    store,
    text: store.boards.map((b) => scoreboardToText(b)).join("\n"),
  };
}

/** Start a board live (journal page + index refresh + chat line). */
export async function startScoreboardLive(
  live: FoundryLive,
  input: StartScoreboardInput,
): Promise<{ board: Scoreboard; pageId: string; entryId: string }> {
  const { store } = readScoreboards(live);
  const board = startScoreboard(input);
  const next = addBoard(store, board);
  const entryId = await ensureScoreboardEntry(live);
  const pageId = await writeBoardPage(live, entryId, board);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(scoreboardStartLine(board));
  return { board, pageId, entryId };
}

/** Award points live (page + index refresh + chat line). */
export async function awardPointsLive(
  live: FoundryLive,
  boardId: string,
  team: string,
  delta: number,
  source: string,
): Promise<{ board: Scoreboard; event: ScoreEvent; won: boolean }> {
  return applyBoardChangeLive(live, boardId, (board) => {
    const result = awardPoints(board, team, delta, source);
    return {
      board: result.board,
      event: result.event,
      won: result.won,
      chatLine: scoreboardToChatLine(result.board, result.event),
    };
  });
}

/** Set a team's points live (page + index refresh + chat line). */
export async function setPointsLive(
  live: FoundryLive,
  boardId: string,
  team: string,
  points: number,
  source: string,
): Promise<{ board: Scoreboard; event: ScoreEvent; won: boolean }> {
  return applyBoardChangeLive(live, boardId, (board) => {
    const result = setPoints(board, team, points, source);
    return {
      board: result.board,
      event: result.event,
      won: result.won,
      chatLine: scoreboardToChatLine(result.board, result.event),
    };
  });
}

/** End a board live (page + index refresh + chat line). */
export async function endScoreboardLive(
  live: FoundryLive,
  boardId: string,
): Promise<{ board: Scoreboard; alreadyFinished: boolean }> {
  const { store } = readScoreboards(live);
  const board = getBoard(store, boardId);
  if (!board) throw new ScoreboardError(`Unknown scoreboard: ${boardId}`);
  const result = endScoreboard(board);
  if (result.alreadyFinished) return result;
  const next = updateBoard(store, result.board);
  const entryId = await ensureScoreboardEntry(live);
  await writeBoardPage(live, entryId, result.board);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(scoreboardToText(result.board));
  return result;
}
