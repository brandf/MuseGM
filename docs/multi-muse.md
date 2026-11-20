# Multi-Muse coordination — two Muses, one Foundry session

How two Muses (e.g. Meroki + Dave's Muse, each with their own name and
persona) share one Foundry session and divide the work without stepping
on each other. Grounded in the actual library — `waitForChat`, `sendChat`,
the pins contract, the combat autopilot — and in the Nov 19 session, when
one Muse ran the table alone. No AgentTS in this design: the core stays
independent (Brandon, Nov 19 — the AgentTS layer is phase two, possibly
a separate repo).

## Identity: one Foundry user per Muse

Each Muse needs **its own Foundry user account** — its own login, its own
user `_id`, its own speaker alias — plus its own connection and its own
working copy of the repo:

- Meroki runs as `mcp-api` (user `_id` `74bQ3Z3siKIJsXF2`, alias `Meroki`).
- Dave's Muse needs its own user (e.g. a user named for that Muse, with
  its own password) and its own `FOUNDRY_USER_ID` / alias in env.
- Own messages are filtered by author `_id` AND speaker alias
  (`waitForChat` / `classifyMessage`), so a Muse never wakes on its own
  posts — but that only works if the two Muses have **different** author
  ids and aliases. Two Muses sharing one account would each answer the
  other's messages as if they were the table's.
- State files are per-Muse and per-working-copy: `.autopilot-state.json`
  (conditions, down callouts) and `.pins-state.json` (handled pins).
  Never share one working directory between two Muses — they would
  clobber each other's state and re-answer (or skip) each other's work.

## Roles: exactly one chat monitor per session

The division that makes double-answering impossible **by construction**:

| Role | Owns | Runs |
| --- | --- | --- |
| **Table Muse** | Foundry chat, dice, data questions, turn announcements | `bun run monitor` |
| **Builder Muse** | Meroki Pins, rooms, tiles, chests, lights | pin handler + builders, on demand |
| **Scribe Muse** (optional) | Recaps, loot, quest log (post-session) | after the session, from the chat log |

- **Only the Table Muse watches chat.** A roll request answered twice
  is two different rolls posted to the table; a question answered twice
  is two answers. There is no safe way for two monitors to split chat
  after the fact, so don't run two. The Builder Muse ignores chat
  entirely — it watches document events (pins) and builds.
- **One owner per announcement type.** The monitor announces *turn*
  changes (the GM advancing the tracker). The autopilot announces *HP /
  down / combat end* (the code path that changes HP owns the callout).
  If two Muses ran an autopilot each, both would post the same down
  message — so combat automation also has exactly one owner per combat.
- **Pins belong to the Builder.** Only the Builder handles pins; the
  Table Muse never touches a pin. The pin's journal page is the shared
  record of what was asked and what was built.

Suggested split for this table: Meroki stays the Table Muse (it's the
name the table already knows), Dave's Muse is the Builder. Either can
be the Scribe after the session — it reads the log, it doesn't act live.

## Coordination channels (in priority order)

1. **Foundry chat — the shared channel the table sees.** Role changes,
   claims, and handoffs are announced here, in the open. If a Muse
   takes over a role, it says so in chat first (see Takeover below).
2. **The shared backlog — `BACKLOG.md` in `brandf/MuseGM`.** Offline
   coordination: what each Muse built, what's untested, what's blocked
   on Dave/Brandon. Both Muses read it; both update it with what they
   did. It is the only shared file — state files are per-Muse, the
   backlog is shared.
3. **The pin's journal page — the claim record.** A pin's page holds
   the request, the builder's reply, and the `flags.meroki.status`.
   It is the only place two Muses can coordinate about the *same* pin
   without talking in chat.

## The pin claim protocol (two Builders on one pin)

Two Builders watching the same pin could both build it. The protocol:

1. Check `flags.meroki.status === "open"` immediately before acting.
2. Append a claim line to the pin's journal page first:
   `<p><b>Meroki:</b> Building this now…</p>`.
3. Re-read the page. Proceed **only if your claim is the first/only**
   claim line on it. If another Muse's claim is already there, stop —
   the pin is theirs.
4. Build, reply in chat, append the result, mark `status: "done"` on
   both docs (the entry and the Note).

The race window is the seconds between the status check and the claim
append — small, and the cost of losing the race is one duplicate build
that the table can see and delete, not corrupted state. If the table
ever runs three or more Builders, this protocol needs a real lock; for
two, claim-then-verify is enough, and the failure mode is visible.

The same claim-then-verify shape applies to anything else two Muses
might both grab (a combat to autopilot, a room to rebuild): claim in
the open, re-read, proceed only if you're first.

## Compound requests: divide and conquer (Brandon, Nov 19)

The pattern for next session, when multiple Muses are connected. Dave
gives **one** Muse a multi-part request — e.g. "add a door here and
have it locked, and I want the key for it over here in this chest with
this kind of trap on it." The table should see it just get done, with
no spoon-feeding. The workflow:

1. **The receiving Muse takes it and acknowledges in chat.** One
   answer, in the open: "We're on it." The table sees one Muse owning
   the request, not two Muses debating it.
2. **It splits the request into parts, itself.** Door + lock. Chest +
   key. Trap. The split is the receiving Muse's call — it decides the
   division from the role split and from what each Muse is already
   doing, not from a human telling it who does what.
3. **It privately messages the other Muse** — on the connection's
   private backchannel (the Muse-to-Muse conversation), **not** in
   Foundry chat — with the parts it's handing over plus the shared
   context the other Muse needs: the scene, the positions, the exact
   spec for each part, and what "done" looks like.
4. **Each Muse executes its parts.** Where two Muses might touch the
   same thing (the same scene, the same chest), the claim protocol
   above applies — claim in the open, re-read, proceed only if first.
5. **The other Muse reports back privately** when its parts are done
   (or blocked, with why). The receiving Muse confirms completion in
   Foundry chat once **all** parts have landed — the table hears one
   "done", not a play-by-play of the handoff.
6. **No spoon-feeding.** Dave and Brandon say what they want once.
   The Muses decide the split, the order, and who does what. If a part
   turns out to need a tool nobody has, the Muse that owns that part
   builds it (see the toolbox rule in
   `docs/realtime-adventure-construction.md`).

**Failure modes:** if the other Muse doesn't answer, the receiving
Muse does the whole request itself rather than leaving Dave hanging —
and says so in chat. If a part is blocked (needs Dave's call, needs a
live test), the receiving Muse reports the block in chat with exactly
what's missing, and the finished parts still land. A compound request
never silently half-finishes.

## When one Muse goes offline

- **Its work queues, it doesn't vanish.** Pins it was building stay
  `status: "open"`; chat it would have answered goes unanswered. The
  other Muse does NOT silently pick it up.
- **Takeover is explicit and announced.** If the Table Muse goes down,
  the Builder may take over chat — but only by announcing it in chat
  first: "Meroki's down, I'll cover chat until they're back." Then it
  starts `bun run monitor` with its own alias (the table sees a
  different name answering — that is correct, not a bug). When the
  Table Muse returns, it announces and takes the role back; the
  stand-in stops its monitor.
- **Returning Muse re-syncs from the world, not from memory.** On
  start, the monitor reads chat from now (never re-answers history)
  and scans for open pins (`findOpenPins`) — so pins dropped while it
  was offline get handled, and pins the other Muse already marked done
  are skipped via the state file.
- **A Muse that crashes mid-build leaves a claim, not a lock.** A
  claim line with no result and a still-open pin is visible on the
  journal page; the other Muse may take it over after announcing it in
  chat. There is no lock to clear and no stuck state to unwind.

## What this design does NOT cover

- **AgentTS.** Deliberately out — the core stays independent. If a
  later AgentTS layer orchestrates bounded jobs (see
  `docs/agentts-hookup.md`), it sits above this design and must respect
  it: one chat monitor, one owner per announcement type, claims in the
  open.
- **More than two Muses.** The roles above cover two; a third Muse
  would take the Scribe role (post-session only) or a second Builder
  with the pin claim protocol. Three live actors on one table is
  untested — say so before trying it.
- **Cross-table coordination.** Muses on different tables (different
  Foundry worlds) don't interact at all. Shared tooling, separate
  sessions.

## Setup checklist — Dave's Muse

1. Create its Foundry user (own login + password), note the user `_id`.
2. Check out `brandf/MuseGM` into its own working copy.
3. Set its env: `FOUNDRY_URL`, `FOUNDRY_USERNAME`, `FOUNDRY_PASSWORD`,
   `FOUNDRY_USER_ID` (its own `_id`), and its alias (its own name).
4. Agree the role split in chat + in `BACKLOG.md` before the session:
   who is Table, who is Builder.
5. The Builder installs the Meroki Pins module (Dave's call — his
   Foundry, his world) and confirms the Table Muse sees the broadcasts.
