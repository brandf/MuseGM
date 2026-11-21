# Living village: the map that lives when nobody is watching

**Status:** design + pure core built offline Nov 20 (BRA-227). Live layer is a
follow-up, not part of this item. Spec: Linear BRA-227; the vision doc, Act
Five ("A village that lives when nobody is watching").

## What it is

A village-scale living system: NPC tokens walk daily rounds, a background
event progresses whether or not the players notice, villagers step off their
scripted path when engaged, and NPCs remember what they've seen and how they
feel about individual PCs and each other — so a later reaction varies with
relationship and charisma.

The core in `src/session/village.ts` is pure: no Foundry, no I/O, no wall
clock. It answers three questions — where is everyone, what is happening,
and how does this villager feel about that PC — as deterministic functions of
in-game time plus recorded history. The live layer (tokens on a scene, chat
lines, JournalEntry persistence) is a thin wrapper that calls the core and
renders what it returns. Nothing in the core generates prose: the words a
villager speaks are Muse's job at the table, grounded in the context the core
returns.

## The one decision everything else follows

**Position and event stage are pure functions of in-game time, not
simulated state.** A villager's round is a schedule; where they are at hour
H is computed from the schedule, not from replaying every step they took to
get there. A background event's stage is computed from its stage hours, not
from a tick counter. The store keeps an hour cursor and an append-only
history, but the village never needs to be "simulated forward" hour by hour
to know where things stand.

This is what makes "the village changes while the players aren't looking"
cheap and exact: a week of unobserved in-game time is one function call, not
168 simulated hours, and the answer is the same whether the village was
watched or not. The tick (`advanceVillageToHour`) still exists, but it is a
bookkeeping pass — it moves the cursor, expires engagements, and reports what
changed (stage transitions, returns, moves) so the live layer can announce
them. It is not the source of truth for positions.

## State model

```ts
VillageStore {
  villageName: string;
  /** Last in-game hour processed, absolute (day * 24 + hourOfDay). */
  hourCursor: number;
  villagers: Villager[];
  events: BackgroundEvent[];
  /** Append-only: every change, with its source and hour. */
  history: VillageHistoryEntry[];
}

Villager {
  id: string;                    // stable, e.g. "mara-baker"
  name: string;                  // "Mara"
  role: string;                  // "baker" — what the table calls them
  /** Stored backstory text, written by the GM or Muse. Required,
   *  non-empty. The core never generates it and never paraphrases it:
   *  responses quote it verbatim. */
  backstory: string;
  schedule: ScheduleLeg[];       // >= 1 leg; legs never overlap
  relationships: Record<subjectId, number>;  // -5..+5, per PC or villager
  memories: MemoryEntry[];       // what this villager remembers
  engagement: Engagement | null;
}

ScheduleLeg {
  name: string;                  // "morning market"
  activity: string;              // "selling bread at the market stall"
  startHour: number;             // hour of day, 0..23
  endHour: number;               // hour of day, 1..24, > startHour
  waypoints: RoutePoint[];       // >= 2 integer grid cells, consecutive differ
}

MemoryEntry {
  id: string;
  /** Who or what this is about: a PC id, another villager id, an event id. */
  subject: string;
  text: string;                  // what happened, as stated
  /** How the villager feels about it, stated at record time, -2..+2. */
  sentiment: number;
  topic?: string;                // short tag, e.g. "mill-fire"
  source: string;                // required — who stated it
  hour: number;                  // absolute in-game hour it was recorded
}

Engagement {
  by: string;                    // the PC who started the conversation
  participants: string[];        // every PC in the conversation
  sinceHour: number;             // absolute in-game hour it started
  engagedAt: RoutePoint;         // the cell where the villager stopped
  maxHours: number;              // default 1 — a conversation can't hold
                                 // a villager forever (see return rule)
}

BackgroundEvent {
  id: string;
  name: string;                  // "the mill fire"
  description: string;
  /** Stages in absolute-hour order. The current stage is the last one
   *  whose hour has been reached — a pure function of the hour. */
  stages: EventStage[];
}

EventStage {
  atHour: number;                // absolute in-game hour this stage starts
  text: string;                  // what happens
  /** Chat line the live layer posts IF the GM wants the table to hear
   *  about it. Absent: the stage happens silently — the village
   *  changes whether or not the players notice. */
  announce?: string;
}
```

### Position resolution (pure)

`positionAtHour(villager, absoluteHour)`:

- If the villager is engaged, they are at `engagement.engagedAt` — they
  stepped off the path and stand where the conversation caught them.
- Otherwise the hour of day (`absoluteHour mod 24`) picks the leg whose
  `[startHour, endHour)` contains it. Inside a leg, progress is
  `(hourOfDay - startHour) / (endHour - startHour)` and the villager stands
  on waypoint `floor(progress * (waypoints.length - 1))` — one waypoint per
  equal slice of the leg. Before the first leg they wait at its first
  waypoint; after the last leg they rest at its last waypoint; in a gap
  between legs they stay at the previous leg's last waypoint (they finished
  one thing and haven't started the next).
- A leg never crosses midnight (`startHour < endHour`, both in the day).
  A night leg is two legs, or one leg ending at 24.

Positions are integer grid cells, the same `RoutePoint` shape as the vehicle
routes (`src/session/vehicles.ts`). The live layer glides the token between
reported positions; the core never animates anything.

## Tick model: in-game hours, not combat rounds

Clocks tick per combat round (BRA-228) because a deadline is measured in
rounds. A village is measured in **in-game hours**: a daily round is
thousands of 6-second rounds, and a villager's day is meaningless at that
resolution. The core takes the in-game hour as input and never reads the
wall clock.

`advanceVillageToHour(store, absoluteHour, source)`:

- Rejects going backwards — in-game time does not rewind. (If the GM rewinds
  the game clock, that is a new store or an explicit reset, not a silent
  edit. There is no reset op yet; it is a follow-up.)
- Walks the cursor forward one hour at a time, but the work per hour is
  only the transitions: background-event stage changes and engagement
  expiries. Positions are re-derived, not stepped.
- Returns `{ store, events }` where events list: each event-stage transition
  that occurred during the jump (with its hour and text), each engagement
  that expired (the villager returned to the round), and each villager whose
  position changed between the start hour and the end hour (from/to — one
  entry per villager, however many hours passed). The live layer uses the
  events to move tokens and to decide what, if anything, the table hears.

## Who watches the tick — the monitor, not a cron

The monitor owns the live watch. It already polls combat rounds for the
clocks; it also reads the in-game hour and calls `advanceVillageToHour`.
A cron is the wrong owner: the village only changes when the in-game clock
changes, and the in-game clock only changes while the table is playing. A
cron advancing the village on wall-clock time would age a village in a world
where no game time passed.

The in-game hour comes from the world's clock if one exists (a calendar
module), or from the GM stating the time ("it's the next morning") — the
monitor advances on the GM's statement, with the GM's message as the source.
If the world has no clock and the GM never states the time, the village
stands still. That is honest: the core never guesses what time it is.

## Engagement: stepping off the path

`engageVillager(store, villagerId, pcId, source, opts?)`:

- A free villager becomes engaged: `engagement = { by: pcId, participants:
  [pcId], sinceHour: current cursor hour, engagedAt: current position,
  maxHours: opts.maxHours ?? 1 }`. They stop walking — `positionAtHour`
  returns `engagedAt` until they return.
- An already-engaged villager takes a second PC as a **participant in the
  same conversation**, not a second conversation. The villager stays
  engaged; responses are computed per addressing PC, so each PC hears the
  villager as that villager feels about *them*.
- `disengageVillager(store, villagerId, pcId, source)` removes one
  participant; when the last participant leaves, the engagement ends and the
  villager resumes the round.

**Return rule.** A villager returns to the round when (a) the last
participant disengages, or (b) the in-game hour reaches
`sinceHour + maxHours` (default 1 hour) — the tick expires the engagement
and reports it. On return the villager resumes the round at the schedule
position for the current hour: the live layer glides the token there. This is
a deliberate simplification, stated plainly: the core does not track a
"caught-up" walking position, because positions are derived from the
schedule. A villager engaged for an hour resumes at most a few cells from
where they were caught, so the glide is short.

Engagement is location-agnostic in the core: it is a conversation state.
Whether the PCs can *reach* the villager (distance on the scene) is the live
layer's call, not the core's.

## Responses: grounded context, never invented prose

`respondTo(store, villagerId, pcId, opts?: { pcCharismaMod?: number,
topic?: string })` returns a `VillagerResponse` — context for the speaker,
not words:

```ts
VillagerResponse {
  villagerId, villagerName: string;
  /** Relationship score with this PC, -5..+5. */
  relationship: number;
  /** Memories about this PC (and about the topic, if one was given),
   *  newest first. Quoted verbatim. */
  memories: MemoryEntry[];
  /** The stored backstory, quoted verbatim. */
  backstory: string;
  /** The PC's charisma modifier as supplied by the caller, default 0. */
  charismaMod: number;
  /** relationship + capped memory sentiment + charisma, clamped -5..+5. */
  disposition: number;
  /** <=-4 hostile, -3..-1 wary, 0..1 neutral, 2..3 warm, >=4 friendly. */
  band: "hostile" | "wary" | "neutral" | "warm" | "friendly";
}
```

- **Disposition** = relationship + memory sentiment + charisma modifier.
  Memory sentiment is summed over the memories about this PC (and the topic,
  if given), capped at ±3, so one memory — however strong — cannot swing a
  whole relationship. The total is clamped to -5..+5.
- **Charisma** is the addressing PC's charisma modifier, supplied by the
  caller (the live layer reads it from the PC actor, or the GM states it).
  The core never reads an actor sheet.
- **The words are Muse's.** The monitor takes the response context and
  drafts the reply: backstory facts come only from the quoted backstory,
  remembered facts only from the quoted memories. A villager asked about
  something in neither says they don't know — the core never fills the gap,
  and neither should the speaker.

## Honesty rules (enforced in code, not just documented)

- **Every memory carries a `source`.** `remember` without a source throws.
  A memory's sentiment is stated at record time by whoever records it; the
  core never infers how a villager feels.
- **Every relationship change carries a `reason` and a `source`.**
  `adjustRelationship` without either throws. Scores clamp to -5..+5.
  Changes are recorded in the store history.
- **Every state change is recorded in the append-only history** with its
  kind, hour, source, and a one-line detail. History is never edited or
  deleted. A correction is a new entry.
- **A backstory is required and stored verbatim.** `addVillager` with an
  empty backstory throws. The core never generates, paraphrases, or extends
  a backstory. A villager with no backstory yet is not a villager — it is a
  missing backstory the GM still owes.
- **Memory and backstory are never merged into one "truth".** A memory is
  what the villager *remembers* — it can be wrong, and that is realistic.
  Responses quote backstory as backstory and memory as memory, labeled.
- **No wall clock, no guessing.** The core takes in-game hours as input.
  It never reads `Date.now()`, never invents a time, never advances itself.

## Validation (loud failures, never silent wrongness)

- Villager id must be unique in the store; name and backstory non-empty.
- A schedule needs at least one leg; legs must not overlap; each leg's
  `startHour < endHour`, hours in 0..24; each leg needs at least 2
  waypoints, consecutive waypoints must differ.
- An event needs at least one stage; stages must be in strictly increasing
  absolute-hour order.
- `advanceVillageToHour` rejects an hour behind the cursor.
- `engage` on an unknown villager, `remember` on an unknown villager,
  `respondTo` for an unknown villager or an unknown PC id — all throw,
  naming what is missing. ("Unknown PC id" means the PC has no
  relationship entry *and* no memories: the core treats a stranger as
  relationship 0 — see below. A PC id is never required to pre-exist.)
- A stranger is relationship 0: the first time a PC meets a villager,
  disposition is memory (none) + charisma. Meeting someone is not an
  error.

## Hard questions, answered

**Two PCs engage the same villager.** They join one conversation
(participants set). The villager stays engaged; each PC's responses are
computed against their own relationship. The first PC to leave just leaves;
the conversation ends when the last participant disengages or the hour
limit hits.

**The village is unobserved for a week of in-game time.** Nothing is lost
and nothing is simulated: positions and event stages are pure functions of
the hour, so `advanceVillageToHour` to the new hour gives the exact state.
The tick reports every stage transition that happened during the jump, so the
live layer (and the GM) can decide what the table learns about — "while you
were away, the mill burned down" is a stage transition the GM may announce
or keep. Moves are reported as start-vs-end positions only, not one event
per hour per villager.

**Who watches the tick.** The monitor (see above). Not a cron, not the
village itself.

**What the live layer is.** Two things, both follow-ups: (1) tokens on a
scene — the monitor moves villager tokens to the positions the core reports
and glides them between reported positions; (2) persistence as a JournalEntry
named "Village" (the quest-log/chronicle pattern: `observer` so the party
can read it, one page per villager with the villager JSON in page flags, one
page per background event; flags are the source of truth, HTML is display
only). A state file is the fallback if JournalEntry persistence proves
awkward, the same convention as the clocks.

**The world has no in-game clock.** The GM states the time; the monitor
advances on that statement. The village stands still otherwise.

**A villager's schedule has a gap.** They stay at the previous leg's last
waypoint — they finished one thing and haven't started the next. A villager
with no legs at all is a creation error.

**A memory contradicts the backstory.** Both are kept, labeled. The
response quotes each as what it is. The core does not resolve the
contradiction; the GM does, at the table.

**A villager is engaged far from where the schedule says they should be.**
On return they resume at the schedule position for the current hour and the
live layer glides the token there. The glide is short in practice (an hour
of schedule is a few cells). The core does not track a separate
"caught-up" position — that would turn a schedule resolver into a
simulator, which is exactly the complexity this design refuses.

**Two villagers remember the same event differently.** Fine — memories live
on the villager who holds them, with their own sentiment and source. There
is no single canonical memory of an event.

## Live layer seam (follow-up, not built here)

The live layer calls exactly these core functions, in this order per watch
cycle:

1. Read the in-game hour → `advanceVillageToHour(store, hour, source)`.
2. For each villager, `positionAtHour(villager, hour)` → move/glide the
   token if the reported cell changed. Announce event-stage transitions the
   GM wants announced (stage `announce` text); keep the rest silent.
3. On a PC engaging a villager in chat → `engageVillager(...)`, then
   `respondTo(...)` for the addressing PC, and draft the reply from the
   returned context (backstory + memories quoted, never extended).
4. On anything worth remembering → `remember(...)` with the chat message id
   as source. On a relationship shift the GM states → `adjustRelationship`
   with reason + source.
5. Persist with `serializeVillage` after every mutation (JournalEntry
   "Village"; state file as fallback).

The monitor owns chat routing for engage/disengage/respond, the same way it
owns clocks and build-loop routing. The core never posts chat, never moves a
token, never reads an actor.

## What this module deliberately does NOT do

- It does not generate villager dialogue. The core returns context; Muse
  writes the words at the table.
- It does not move tokens. Positions are data; the live layer moves them.
- It does not read actor sheets. Charisma and PC identity arrive as inputs.
- It does not decay memory or relationships with time. Forgetting is a
  deliberate act (a new memory or a stated relationship change), not
  entropy. A follow-up could add decay, but it would need a GM-chosen rule,
  not a silent default.
- It does not run background events as code. A stage's text is data; the
  consequence ("the guards arrive") is the GM's or a staged cutscene's job,
  the same rule as the clocks.
- It does not handle villagers leaving the village or new villagers
  arriving mid-day beyond `addVillager` (any hour). A villager who leaves
  is a follow-up (a `departed` flag plus schedule suppression), not a
  deletion — the history must keep them.

## Acceptance (from BRA-227)

- A village scene where NPC tokens move on rounds — core: positions resolve
  from schedules; live layer moves the tokens (follow-up).
- The background event progresses — core: stage is a pure function of the
  hour; the tick reports transitions.
- Engaging a villager produces a backstory-grounded response — core:
  `respondTo` returns the stored backstory + relevant memories + disposition;
  the words are drafted from that context only.
- NPC memory changes a later reaction — core: memories shift disposition
  through capped sentiment; tested.
