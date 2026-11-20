# Agent coordination — skills, protocols, and teaching each other

How Muse agents coordinate with each other through Foundry as the
communication channel — the skills, the protocols, how new protocols
get sorted out on the fly, how agents teach each other new tricks, and
how they collaborate on the GitHub repo. This is part of MuseGM
itself: a table's Muses should be able to pick this up and coordinate
without being taught by a human first.

Companion docs: `docs/multi-muse.md` (roles, claims, takeover,
compound requests) and `docs/realtime-adventure-construction.md`
(the build vision). No AgentTS in this design — the core stays
independent.

## Foundry as the communication channel

Foundry is the bus. Three lanes, each with a job:

| Lane | What goes there | Who sees it |
| --- | --- | --- |
| **Foundry chat** (public) | Role changes, claims, acknowledgements, "done" | The whole table |
| **Pin journal pages** (shared state) | The request, the claim, the result, the status flag | Any Muse that reads the pin |
| **The Muse-to-Muse backchannel** (private) | Splits, handoffs, negotiations, teaching | Only the two Muses |

The rule for which lane: if the table needs to know, say it in chat.
If it's coordination the table doesn't need to see (who does which
part, a protocol proposal), use the backchannel. If it's state another
Muse might need later (what was asked, what's done), write it on the
journal page or in the backlog — chat scrolls away, pages persist.

## Protocols: what they are

A protocol is a shared agreement with three parts: a message shape
(what a claim/announcement looks like), an owner rule (who does what),
and a check (how you verify before acting). The protocols already in
use:

- **Pin claim** (multi-muse.md): check open → append claim → re-read
  → proceed only if first.
- **Role announcement:** take a role only by announcing it in chat
  first; give it back the same way.
- **Compound-request split:** the receiving Muse owns the request,
  splits it, hands parts over privately, confirms once in chat when
  all parts land.

A protocol is not code — it's an agreement two Muses hold. The code
supports it (claim lines, status flags, state files), but the
agreement is what makes it work.

## Sorting out new protocols on the fly

A new situation will always show up mid-session — something two Muses
could both grab, or a handoff with no shape yet. The negotiation
pattern:

1. **Name the problem, in the backchannel.** "We both might build
   the trap-door swap — how do we not double-build it?"
2. **Propose a shape.** One Muse proposes the smallest agreement
   that solves it: "Claim it by writing the tile coords on the
   journal page, re-read before acting — same as the pin claim."
3. **Accept or amend.** The other Muse accepts, or amends ("also
   mark the tile hidden while building so the table doesn't see a
   half-built swap"). One round of amendment, then use it — don't
   bikeshed mid-session.
4. **Use it immediately, on the live case.** The protocol is proven
   by the case that needed it, not by discussion.
5. **Write it down.** The proposing Muse adds it to this doc (or
   `multi-muse.md`) and the backlog, in one paragraph: the problem,
   the shape, the case that proved it. If it isn't written down, the
   next session's Muses re-negotiate it from scratch.

The principle: **protocols are proposed, not imposed.** Neither Muse
dictates; the one that sees the problem proposes, the other accepts or
amends, and the agreement lives in the shared docs after.

## Teaching each other new tricks

When a Muse learns something — a faster build, a new tool, a Foundry
quirk, a better way to phrase a cutscene script — it teaches the
other Muse. The pattern:

1. **Tell, in the backchannel.** "I found a faster way to place
   perimeter tokens — the ring helper in cutscene.ts. Use it like
   this." Concrete, with the file and the call.
2. **Write it where it persists.** The trick goes into the backlog
   or the relevant doc, in one paragraph. The backchannel message is
   the notification; the doc is the memory.
3. **The other Muse adopts and confirms.** "Got it, used it on the
   door build." Confirmation closes the loop — an unconfirmed
   teaching might never have landed.
4. **The trick becomes a tool if it's reusable.** A one-off trick
   that works twice is a candidate for the toolbox (see the toolbox
   rule in `docs/realtime-adventure-construction.md`): build it as a
   function, test it, give it a line in the backlog.

Teaching is how the *team* gets better, not just each Muse. A trick
one Muse learns mid-session should be the other Muse's trick by the
end of the session.

## The other agent as a GitHub contributor

Dave's Muse (or any table's Muse) may become a contributor on
`brandf/MuseGM` — pushing the tools it builds, pulling the tools the
other Muse built. The coordination:

- **Own working copy each.** Never share a working directory (same
  rule as state files — clobbering).
- **Pull before building.** Before starting a build, pull the latest
  from the repo so you're building on the other Muse's tools, not
  under them.
- **Announce pushes in the backchannel.** "Pushed the maze
  generator — pull when you can." The other Muse pulls at a natural
  break, not mid-build.
- **Don't push the same file at once.** If two Muses are editing the
  same file (BACKLOG.md, package.json), say so in the backchannel
  first and take turns — the file is the shared inventory, and
  concurrent edits are the one place the snapshot-push flow can't
  save you.
- **Pushes use the snapshot-push procedure** (see the repo's sync
  record) — small, text-only, verified on main after. A Muse that
  pushes announces the commit; the other Muse verifies by reading it
  back.
- **Review each other's work.** A pushed tool gets a verification
  run by the other Muse (tests + typecheck) before the next session
  treats it as trusted. That's how the toolbox stays honest.

## Pre-session live verification — the Muses test it themselves (Brandon, Nov 19)

Whenever Foundry is upgraded or MuseGM changes in a major way, the
system needs live testing — and that testing should not need a human
spoon-feeding it or even present. The pattern:

1. **A human starts the server and tells the Muses to join.**
   That's the whole human job: "server's up, run the verification."
   Brandon or Dave doesn't need to be there for the testing itself.
2. **The Muses run through the test cases together.** The test cases
   are the live-test checklists in `BACKLOG.md` — the ones marked
   `[~]` (built, not live-tested). Each checklist is a case: upload
   the tile pack, build a room, play the ambush cutscene, run a
   generated encounter, import a creature, post a deduped message.
3. **They build what the tests need.** Little test maps, full-on
   encounters — the Muses create the fixtures themselves with the
   composer and the encounter generator, then test against them.
4. **They roleplay it out, turn by turn.** Combat isn't verified by
   reading the code — the Muses play it: move tokens, roll attacks,
   take damage, check the HP callouts land, check the turn
   announcements fire. The autopilot and the monitor get exercised
   the way the table exercises them.
5. **They divide the cases and report.** One Muse runs the map
   cases, the other runs the combat cases (compound-request split,
   same as any other work). Each case ends pass or fail with the
   evidence — what was checked, what broke, the error. Failures go
   into the backlog as open issues with the repro.
6. **The session starts clean.** The point of all of it: when the
   humans sit down for a session, they're not wasting hours fixing
   broken stuff. Verification is what makes the trial-and-error loop
   (see `docs/realtime-adventure-construction.md`) actually converge
   instead of re-breaking the same things.

This is the same collaboration as any other compound request — the
only difference is the request is "verify everything" and the test
cases are the checklist. A Muse that finds a failure fixes it if it's
small (or files it if it isn't) and re-runs the case, so the report
that comes back is the state after the fixes, not just a list of
breaks.

## What this design does NOT cover

- **More than two Muses.** Two is the tested shape. A third Muse
  would need the same lanes and would negotiate its protocols the
  same way — but three live actors on one table is untested.
- **Cross-table coordination.** Muses on different tables don't
  interact. Shared tooling, separate sessions. (A trick learned on
  one table still travels — via the repo, not via chat.)
- **AgentTS.** Deliberately out — the core stays independent. A later
  AgentTS layer sits above this design and must respect it.
