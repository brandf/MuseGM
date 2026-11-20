/**
 * Turn reminders (P2) — when a combat turn starts, tell the player whose
 * turn it is what they can do, what conditions they have, and how hurt
 * they are.
 *
 * Two layers, kept separate on purpose (same pattern as src/session/dice.ts):
 * - Pure functions (buildTurnReminder / formatConditions / hpStatus):
 *   no Foundry, no I/O, unit tested in tests/reminders.test.ts on fixture
 *   combat/actor data.
 * - Live function (remindTurn): reads the autopilot's combat status and
 *   whispers the reminder to the current combatant's owning player
 *   (falling back to a public chat post when no owner can be found).
 *
 * The action list is the generic PF2e 3-action economy (Strike, Stride,
 * Step, Raise a Shield, Cast a Spell, Interact, ...). It is NOT tailored
 * to the character's actual feats or spells — the reminder says what any
 * character can do, and the conditions/HP parts are the per-character
 * facts. Do not present the generic list as the character's own options.
 */
import type { FoundryLive } from "../live.js";
import { CombatAutopilot } from "./autopilot.js";
import type { CombatantStatus } from "./autopilot.js";
import { resolveGamemasterId } from "./dice.js";

/** One condition on the current combatant, as the autopilot tracks it. */
export interface ReminderCondition {
  statusId: string;
  /** Round on which it expires (start of that round). */
  expiresRound: number;
}

/** Everything the reminder needs about the current turn. */
export interface TurnReminderInput {
  name: string;
  round: number;
  /** 1-based turn number within the round. */
  turn: number;
  /** Total combatants in the tracker. */
  total: number;
  hp: number;
  hpMax: number;
  /** Is this combatant an enemy (NPC)? */
  isEnemy: boolean;
  conditions: ReminderCondition[];
}

/** HP band wording — never invents a number, only describes the ratio. */
export function hpStatus(hp: number, hpMax: number): string {
  if (hpMax <= 0) return "HP unknown";
  if (hp <= 0) return "down (0 HP)";
  const ratio = hp / hpMax;
  if (ratio >= 1) return "unhurt";
  if (ratio >= 0.75) return "lightly hurt";
  if (ratio >= 0.5) return "hurt";
  if (ratio >= 0.25) return "badly hurt";
  return "barely standing";
}

/** "Frightened 1 (until round 3)" — one line per condition. */
export function formatConditions(conditions: ReminderCondition[]): string {
  if (conditions.length === 0) return "";
  return conditions
    .map((c) => `*${c.statusId}* (until round ${c.expiresRound})`)
    .join(", ");
}

/** The generic PF2e 3-action economy, as a one-line hint. */
export const ACTION_HINT =
  "You have 3 actions: Strike, Stride, Step, Raise a Shield, Cast a Spell, Interact, or Ready.";

/**
 * Chat text for the start of a turn. Enemies get a short GM-facing line;
 * players get the full reminder. A downed combatant gets a "you're down"
 * line instead of actions — they can't act.
 */
export function buildTurnReminder(input: TurnReminderInput): string {
  const { name, round, turn, total, hp, hpMax, isEnemy, conditions } = input;
  const conds = formatConditions(conditions);
  const status = hpStatus(hp, hpMax);
  if (hp <= 0) {
    return (
      `💀 **${name}** is down (0 HP) — round ${round}, turn ${turn}/${total}. ` +
      `Someone needs to get them back up.`
    );
  }
  if (isEnemy) {
    return (
      `➡️ Round ${round}, turn ${turn}/${total}: **${name}** (HP ${hp}/${hpMax}, ${status})` +
      (conds ? ` — conditions: ${conds}` : "")
    );
  }
  let text =
    `➡️ Round ${round}, turn ${turn}/${total}: **${name}**, your turn! ` +
    `(HP ${hp}/${hpMax} — ${status})`;
  if (conds) text += `\nConditions: ${conds}`;
  text += `\n${ACTION_HINT}`;
  return text;
}

// ---------------------------------------------------------------- live layer

/**
 * Post (whisper when possible) the reminder for the current turn of a
 * combat. The owning player is found from the current combatant's actor
 * ownership: the non-GM user with OWNER (3) access. When no owner is
 * found — NPCs, or actors nobody owns — the reminder goes to public chat.
 */
export async function remindTurn(
  live: FoundryLive,
  autopilot: CombatAutopilot,
): Promise<{ messageId: string; whisperedTo: string | null }> {
  const st = autopilot.status();
  const current = st.current;
  if (!current) throw new Error("No current combatant in this combat.");
  const conds = autopilot.listConditions(current.combatantId);
  const text = buildTurnReminder({
    name: current.name,
    round: st.round,
    turn: (st.turn ?? 0) + 1,
    total: st.combatants.length,
    hp: current.hp,
    hpMax: current.hpMax,
    isEnemy: current.isEnemy,
    conditions: conds,
  });
  const whisperTo = resolveTurnOwner(live, current);
  const messageId = await live.sendChat(text, whisperTo ? { whisperTo: [whisperTo] } : {});
  return { messageId, whisperedTo: whisperTo };
}

/** The non-GM OWNER of an actor's sheet, or null when there isn't one. */
export function resolveTurnOwner(
  live: FoundryLive,
  combatant: CombatantStatus,
): string | null {
  let gmId: string | null = null;
  try {
    gmId = resolveGamemasterId(live);
  } catch {
    gmId = null;
  }
  const raw = live.raw() as unknown as {
    getRawActor(id: string): { ownership?: Record<string, number> } | undefined;
  };
  const actor = raw.getRawActor(combatant.actorId);
  const ownership = actor?.ownership ?? {};
  for (const [userId, level] of Object.entries(ownership)) {
    if (level === 3 && userId !== gmId) return userId;
  }
  return null;
}
