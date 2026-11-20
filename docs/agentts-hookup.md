# AgentTS hookup for MuseGM — design

**Status:** design only, Nov 19, 2026. No implementation. Written from
reading the code, not from memory — sources are cited per section, and
anything not verified is listed under Open questions.

**Context:** Brandon, Nov 19: "we should probably get this hooked up to
Agent TS at some point, but let's work on that offline between now and
next week's session." The live table is the TestBed world (Foundry
14.370 / PF2e 8.7.0); the monitor loop is running as a Muse subagent
calling MuseGM CLIs. The hookup must not make the live table worse.

**Repos involved**

- AgentTS: `~/workspace/agentts-repo` (public, MIT; r1 released Nov 19,
  2026; r2 in progress per `CHANGELOG.md`). Production state dir
  `~/workspace/agentts-state` (live — journals, blobs, queue, worker
  pool store all present).
- MuseGM: `~/workspace/foundry-live` (`package.json` name
  `foundry-live`, v0.1.0; public repo `brandf/MuseGM`). No AgentTS
  reference exists in it today (grep, Nov 19) — the hookup is a clean
  slate on the MuseGM side.

---

## (a) What AgentTS is

AgentTS is **durable execution for agent workflows, in TypeScript**
(`~/workspace/agentts-repo/README.md`). A workflow is an ordinary
TypeScript function: one JSON-capable input in, one JSON-capable
output out (`apps/agentts/workflows/library/hello.ts` is the minimal
example — `sleep({ ms: 100 })`, return a greeting). When the function
needs something from the outside world it calls a **trap**, and the
run **suspends into a snapshot blob on disk**. The trap is answered by
the host or by a worker from a pool, the run resumes from the blob
exactly where it left off. A crashed host, a killed process, or a
machine restart does not lose the run: the journal records what
already happened, the blob holds where it stopped, and the next drive
resumes from there. Every pause is a durable snapshot plus a journal
entry, not memory.

**Three layers** (`docs/ARCHITECTURE.md` §1–§4):

1. **DurableTS core (C)** — `packages/durablets/`: `trap` / `all` /
   `any` / `race`, suspend/resume blobs. Knows nothing about jobs,
   journals, or scheduling. One process spawn per run-slice; there is
   no long-lived C-host daemon in v0.
2. **AgentTS host (TypeScript)** — `apps/agentts/src/`: interprets
   traps, owns the journal (append-only JSONL per run, the source of
   truth), the run registry, the queue, workflow freezing, the clock,
   and the drive loop. Submit (`agentts run`) freezes the workflow's
   closure (entry file + transitive relative imports) into a
   content-addressed `frozen/<hash>/` copy, runs the first-run gate
   (TypeScript 5.9.3 type-check + type extraction + M2 checker), and
   enqueues. A resumed run executes against the frozen copy, never
   the live file.
3. **Environment adapter** — `apps/agentts/plugins/<name>/`: the only
   layer that knows about an environment. Four adapters exist: `mock`
   (canned answers), `direct` (real worker processes + real exec),
   `muse` (the get-job/complete-job worker pool), `briefing` (worked
   example). The adapter answers four trap types: `job`, `exec`,
   `gate`, `decide`. `sleep` / `cron` / clock are host-owned.

**The workflow-side API** (`apps/agentts/src/agentts.ts`, canonical;
`apps/agentts/src/agentts.ts` is a verbatim copy) — six wrappers over
the core's `trap(type, arg)`:

| Wrapper | Arg | Result |
| --- | --- | --- |
| `job<Input, Output>({ spec, input })` | spec name + typed input | typed output from a worker agent session |
| `exec({ cmd, args?, cwd? })` | shell command | `{ stdout, exitCode, stderr? }` |
| `gate({ question, options? })` | human question | `{ answer }` — holds until a human answers |
| `sleep({ ms })` | duration | `{ sleptMs }` |
| `cron({ at })` | one-shot ISO datetime | `{ scheduled }` — one-shot, the name does not imply recurrence |
| `decide<Output>({ question, options? })` | decision question | typed output from the narrow local decision model |
| `run<Input, Output>({ workflow, input })` | sub-workflow path + input | the child run's result (child has its own runId/journal/frozen closure) |
| `all` / `any` / `race` | thunks | fork/join with Promise-like semantics |

Types are the only source of truth: no schemas in author code. The
host extracts JSON Schema from the workflow's types at first run and
validates trap results against it. `job` and `decide` call sites must
supply both type arguments as concrete, named types or the host fails
loudly.

**The worker pool** (`docs/ARCHITECTURE.md` §5): a loopback HTTP
server (`src/worker-server.ts`, default port 18741,
`agentts worker serve`, state under `<stateDir>/worker-jobs/`).
Workers are persistent and pull jobs (`GET /get-job`, blocking
long-poll up to 60s). Two legs run the same loop: script mode (a Bun
process running a registered worker script per spec) and subagent
mode (a Muse subagent running the loop by hand per
`plugins/muse/WORKER.md`). Jobs carry a spec name + JSON input; the
server resolves the jobspec prose file when it can. Leases (default
300s, max 3 attempts), affinity (prefer the warm specialist for a
spec, 2s hold window, 30-min TTL), quotas (pool size, CPU slots,
tokens/hour). File effects return as full file contents (1 MB cap)
and are **never auto-applied** — the coordinator applies them after
review. Learnings are posted per spec (`POST /note`,
`notes/<spec>.md`) — institutional memory is keyed by spec, not by
worker.

**The tick agent** (`plugins/muse/TICK-AGENT.md`): the system's own
operator session — not a worker, not the coordinator. It watches for
system events via blocking `GET /tick` long-poll, drives the queue
(`agentts queue run`), delivers completed outputs to the outbox
(`deliveries/`), handles stuck runs, escalates to the coordinator
(Meroki) when judgment is needed. A watchdog cron (every 30 min)
restarts it if dead.

**Scheduling is two layers** (§6): admittance (which backlog tasks
run, `agentts admit`, WIP limit 3, tasks map to library workflows)
is separate from dispatch (which queued job a worker gets).

**Recurrence precedent:** the daily AI briefing is a workflow
(`workflows/dogfood/daily-ai-briefing.ts`) driven by an **external
cron** (the "live 06:15 cron" that runs `agentts run ...`). There is
no in-system recurring scheduler; a `cron` trap is a one-shot wait
inside a run.

### Constraints that shape any hookup (all verified in the code)

1. **Drive cap — 50 suspensions per drive** (`src/host.ts`,
   `MAX_DRIVE_ROUNDS = 50`). An uninterrupted `driveToCompletion`
   loop that suspends more than 50 times **fails the run loudly**
   (`DriveCapError`, blob intact). The documented remedy is to split
   the workflow into fewer traps per drive. A forever-loop workflow
   cannot survive one drive.
2. **Drive latency is tick-agent scale, not sub-second.** The queue
   is driven when the tick agent runs `queue run`; the tick agent
   learns about work via a 60s long-poll. Submit→drive latency is
   seconds to a minute in the healthy case, up to ~30 min if the
   tick agent died and the watchdog has to restart it. Nothing in
   this path meets MuseGM's <1s chat wake-up requirement.
3. **`exec` is synchronous and blocking.** Both the direct and muse
   adapters run `exec` via `spawnSync` (no shell), and the host
   drives in a synchronous loop. A long-running CLI blocks the
   driver for its whole duration. Stdout capture caps at 16 MB
   (BRA-174); larger output fails the exec. The direct adapter's
   worker timeout defaults to 120s.
4. **Trap boundary is clean JSON only** (`agentts.ts`,
   `toJsonValue`). No `undefined`, functions, Maps, class instances,
   circular refs, or binary. A Date crosses as its ISO string. Tile
   PNGs and other binaries **cannot** cross a trap boundary — they
   must travel as files (job file effects, 1 MB cap, never
   auto-applied) or be produced/consumed on the host side by `exec`.
5. **`gate` holds for real.** The direct and muse adapters always
   hold a gate; the run suspends until a human delivers an answer
   (`deliver-gate`). The mock adapter auto-answers "yes" unless run
   with `--gates hold` on both submit and drive.
6. **Workers are anonymous by design; named workers are explicitly
   undecided** (`docs/ARCHITECTURE.md` §5.4, BRA-50). There is no
   worker registry, no `targetWorker` enqueue field, no way to
   address a job to a particular worker. `workerId` is a
   self-asserted operational handle for leases, affinity, and
   debugging only. Per-spec notes are the only shared memory.
7. **The pool server is loopback** (127.0.0.1:18741 by default) and
   its state lives in this VM's `~/workspace/agentts-state`. A Muse
   running on another machine (Dave's) cannot reach it without
   network work that does not exist yet.
8. **Crash recovery is exact for jobs, not for `exec`.** A trap that
   already dispatched is re-answered from the journal, never
   re-executed — except a crash *during* an `exec` dispatch re-runs
   the command (visible in the journal as `redispatched: true`).
   MuseGM `exec` calls must therefore be idempotent or safe to run
   twice (sending the same chat message twice is the concrete
   hazard; `send` is not idempotent today).
9. **Frozen closures freeze code, not the world.** A resumed run
   executes the frozen workflow copy, but Foundry world state is
   live and moves under it. A workflow that reads "current combat"
   at step 1 and acts on it at step 5 must re-read; nothing in
   AgentTS protects against a stale Foundry snapshot.

---

## (b) Hookup options

### Option A — MuseGM jobs as native AgentTS workflows

Session and between-session jobs become workflows under
`apps/agentts/workflows/library/` (or a MuseGM plugin dir), written
against the trap API. Foundry actions go through `exec` calls to the
MuseGM CLIs, or through new `job` specs whose worker scripts are Bun
scripts wrapping the library. Example shapes:

- `build-room`: `exec` (composer: room spec → tile/wall/light
  placements) → `gate` ("GM approves this room?") → `exec` (apply
  to Foundry) → `exec` (announce in chat).
- `session-recap`: `exec` (dump chat log) → `job` (draft recap) →
  `job` (judge/fix loop over the draft, reusing `judge-fix-loop.ts`)
  → `exec` (write journal entry).
- `tile-pack`: `exec` (generate tiles) → `job` (review tiles
  against STYLE.md) → `exec` (upload once).
- The live chat monitor is **not** a workflow (see constraints 1–2).
  It stays a thin loop outside AgentTS; at most, each wake-up
  submits a short run ("answer this batch of chat") — one run per
  wake-up, resubmitted externally.

**Pros:** durability for long offline jobs (a tile-pack build that
survives a VM replacement mid-run); journal audit trail for
everything the table's Muse did; human gates where they matter
(Dave approves a room before it lands in Foundry); reuse of the
existing library workflows (judge-fix loop for map/recap review,
plan-driven-work for multi-step builds); cost model and quotas
for free; the `run()` trap composes jobs (a "session prep" parent
running build-room, loot, recap as children).

**Cons:** the monitor — the thing the table actually sees — gets
nothing from this; the drive cap forces every workflow to be
short and bounded, which is a new design discipline for MuseGM
code that currently loops freely; `exec` traps are blocking and
synchronous, so a slow CLI stalls the driver; JSON-only boundary
means tile images must be handled as files on the host side, not
as trap values; every workflow needs concrete named input/output
types and passes the first-run gate (type-check + extraction +
M2 checker) — real authoring friction vs. today's plain CLIs.

**Changes — AgentTS side:** new workflow files + jobspecs
(`plugins/muse/jobspecs/musegm-*.md`) + workers-config entries
(`--workers-config`, spec → Bun worker script); possibly a
`plugins/musegm/` plugin if MuseGM ever needs its own adapter
(not needed for v1 — direct/muse suffice). **MuseGM side:** a
thin Bun worker script per spec (or pure-`exec` workflows that
call the existing CLIs — no library change at all); `send` must
become idempotent or the exec re-dispatch hazard (constraint 8)
must be accepted; CLIs already emit exactly one JSON object on
stdout, which is the shape `exec` traps want.

### Option B — AgentTS as orchestrator over the MuseGM CLIs (thin)

Keep MuseGM exactly as it is: library + CLIs + the monitor loop
running as a Muse subagent. AgentTS workflows call the CLIs via
`exec` traps for **bounded, between-session jobs only**: tile-pack
generation, room builds with a GM gate, session recaps, quest-log
updates, downtime. The monitor loop never enters AgentTS. The
backlog (`BACKLOG.md`) becomes admittable tasks via `agentts admit`
with a `--map` from task → workflow.

**Pros:** smallest change on both sides — no new adapter, no
library changes, no risk to the live table; the monitor keeps its
sub-second loop untouched; AgentTS adds exactly what MuseGM lacks
today (durability, gates, journal, retry) for the slow jobs; the
CLIs' one-JSON-object stdout is already the right `exec` contract;
provable in an afternoon with one workflow (`build-room`).

**Cons:** two systems to reason about (the monitor loop + the
workflow queue) instead of one; `exec` is still blocking, so a
90-minute tile generation holds the driver — long jobs need to be
split or run under the muse adapter's pool (where a `job` trap's
worker can take its time under a lease); no streaming progress
from a running CLI — the workflow sees only the final stdout;
the Foundry world is still live shared state with no locking
(constraint 9).

**Changes — AgentTS side:** a handful of workflow files
(`workflows/library/musegm-*.ts`) + optionally jobspecs; a
workers-config mapping specs to CLI wrapper scripts. **MuseGM
side:** none required for v1 (a `--json` discipline on any new CLI
is the only rule). This is Option A with the scope cut to the
orchestrator layer and the native-`job` migration deferred.

### Option C — AgentTS as the multi-Muse coordination layer

AgentTS becomes the shared backbone for the multi-Muse vision in
the MuseGM README: Meroki's Muse and Dave's Muse are both workers
(subagent mode, `plugins/muse/WORKER.md`) pulling jobs from the
same pool server; the MuseGM backlog becomes admittable tasks; the
pool's affinity keeps a warm specialist per spec (map-builder vs
combat-runner); per-spec notes (`notes/<spec>.md`) are the shared
institutional memory; AgentTS journals are the audit trail of who
did what; the Foundry world is the shared state, AgentTS the shared
queue.

**Pros:** directly serves the stated goal — two Muses dividing the
work on one session, with a real queue, dedup (pool enqueue dedupes
on trapId), leases, and affinity instead of two loops that might
both answer the same chat message; the coordinator (Meroki) admits
work and closes it, workers execute, tick agent keeps it churning
— the roles already exist in the architecture.

**Cons:** blocked on decisions Brandon has not made — named
workers / routing a job to a specific Muse is **explicitly
undecided** (BRA-50, constraint 6); there is no way today to say
"this job goes to Dave's Muse" or "Meroki owns combat, Dave's Muse
owns maps"; the pool server is loopback-only (constraint 7), so
Dave's Muse on another machine cannot even connect; two Muses
writing to the same Foundry world concurrently needs a
coordination contract that does not exist (who owns the chat
monitor? what happens when both answer?); the monitor's <1s
requirement still rules out AgentTS as the live path — the
coordination layer would sit *above* the monitors, not replace
them.

**Changes — AgentTS side:** a decision on named workers (Brandon's
call), network exposure of the pool server (or a second server on
Dave's side with a shared state story), a per-Muse identity/claim
protocol for Foundry writes. **MuseGM side:** jobs must be
decomposable into specs with JSON in/out; the monitor needs a claim
or ownership rule so two Muses never double-answer; the shared
backlog needs a machine-readable form (today it is prose in
`BACKLOG.md`).

---

## (c) Recommendation

**Do Option B now; grow it into Option A for bounded jobs; treat
Option C as a later phase gated on Brandon's BRA-50 decision.**

Reasoning:

1. **The live monitor cannot live in AgentTS, and pretending
   otherwise would make the table worse.** Constraints 1 and 2 are
   decisive: a 50-suspension drive cap and tick-agent-scale drive
   latency are incompatible with a sub-second chat wake-up loop.
   Any option that moves the monitor into a workflow is wrong.
   Options B (and A, for the non-monitor jobs) respect that line.
2. **Option B buys the real value with near-zero risk.** The
   between-session work Brandon actually named — tile pack,
   composer, room builds, recaps — is exactly the bounded,
   slow, crash-sensitive work AgentTS is built for, and it is
   all `exec`-shaped already: the CLIs emit one JSON object on
   stdout. One workflow (`build-room` with a GM gate) proves the
   pattern end to end without touching the library or the monitor.
3. **Option A is the natural next step, not a separate project.**
   Once the `exec` pattern is proven, migrating a bounded job
   from `exec`-of-CLI to a native `job` spec is a small,
   reversible change per job — and it unlocks the judge-fix loop
   for map/recap review. Do it job by job, starting with the one
   where review matters most (tile-pack review against STYLE.md).
4. **Option C is the real prize but is not buildable yet.** It
   needs two things that do not exist: a named-worker/routing
   decision (BRA-50, Brandon's call) and a reachable pool server.
   Building coordination on top of anonymous pull-model workers
   would produce exactly the double-answer race it is meant to
   prevent. Defer it, and let the Option B workflows define the
   job shapes (specs with JSON in/out) that Option C will later
   dispatch to two Muses.

**Suggested first build (after Brandon answers the open questions):
`build-room` as an Option B workflow** — `exec` composer →
`gate` (Dave approves) → `exec` apply → `exec` announce — plus
the `admit` mapping so it is drivable from the backlog. It
exercises every piece of the hookup (exec, gate, journal,
freeze) and demos in Foundry the same night.

---

## (d) Open questions (only Brandon can answer)

1. **Monitor boundary — permanent?** Is the live chat monitor
   staying outside AgentTS for good, or do you want the "one run
   per wake-up" shape explored (the loop stays outside, each
   chat batch becomes a short run)? The recommendation assumes
   permanent; a per-wake-up run would add journaling to every
   table exchange at the cost of submit/drive latency on each
   answer.
2. **Named workers (BRA-50)?** Should a job be routable to a
   specific Muse — "this goes to Dave's Muse, that stays with
   Meroki" — and should a named Muse accumulate memory across
   jobs? AgentTS deliberately does not have this today, and
   adding it is a design decision, not a bug fix.
3. **Where does the pool server live for two Muses?** This VM's
   loopback server cannot be reached from Dave's machine. Is
   multi-Muse coordination on this VM only (both Muses as
   subagents here), or does the pool need to be network-reachable
   (Tailscale, a second server, something else)?
4. **Which job first, and does it need a human gate?** The
   recommendation starts with `build-room` + a Dave gate. Is
   that the right first job, or should the tile-pack generation
   (longer, no gate needed) or the session recap (needs the
   chat log as input) go first? And should room builds always
   require Dave's approval before landing in Foundry, or only
   above some size?
5. **Repo boundary — where do MuseGM workflows live?** In the
   AgentTS repo under `apps/agentts/workflows/library/`, or in
   the MuseGM repo (`brandf/MuseGM`) with AgentTS as a
   dependency/tool? The workflows import `../src/agentts` and
   are frozen with their closure at submit, so living in the
   AgentTS repo is the path of least resistance — but it splits
   MuseGM across two repos.
6. **State dir?** Use the production `~/workspace/agentts-state`
   (shared with the briefing and everything else) or a separate
   MuseGM state dir? Sharing means one tick agent, one queue,
   one watchdog; separating means a MuseGM outage cannot take
   down the briefing and vice versa.
7. **Who is the coordinator for MuseGM runs?** AgentTS has
   exactly one coordinator (Meroki). If Dave's Muse later
   admits MuseGM work, does it go through Meroki as coordinator,
   or does each table's Muse coordinate its own runs? This
   decides whether Option C is "one coordinator, two workers" or
   "two coordinators sharing a pool".

---

## Appendix: first-workflow sketch (`build-room`, Option B)

```ts
// apps/agentts/workflows/library/musegm-build-room.ts (sketch, not code)
import { exec, gate } from "../../src/agentts";

export interface BuildRoomInput {
  roomSpec: RoomSpec;        // grid w/h, doors, tile layout by layer
  sceneName: string;
}
export interface BuildRoomResult {
  sceneId: string;
  announcedChatId: string;
}

export default function buildRoom(input: BuildRoomInput): BuildRoomResult {
  // 1. Compose: room spec -> placements (no Foundry writes yet).
  const composed = exec({
    cmd: "bun", args: ["run", "src/cli/scene.ts", "--compose", "--spec", "..."],
    cwd: "<musegm-checkout>",
  });
  // 2. Human gate: Dave approves the room before it lands.
  const approval = gate({ question: `Build ${input.sceneName} in Foundry?`, options: ["yes", "no"] });
  if (approval.answer !== "yes") throw new Error("room build declined by GM");
  // 3. Apply: place tiles + walls + lights + tokens; announce in chat.
  const applied = exec({ cmd: "bun", args: ["run", "src/cli/scene.ts", "--apply", "..."], cwd: "<musegm-checkout>" });
  return JSON.parse(applied.stdout);
}
```

Notes on the sketch: the composer must be split into a `--compose`
(pure, no writes) and an `--apply` step so the gate sits between
planning and effect — today `scene.ts` does both. `send` needs
idempotency (or the re-dispatch hazard in constraint 8 must be
accepted) before a send-bearing workflow runs under the muse/direct
adapter. Room-spec JSON travels as CLI argv/file today; under
`exec` it should travel as a file (argv strings cap at 128KB
per BRA-179, and the trap boundary is JSON-only).

## Sources read

- `~/workspace/agentts-repo/README.md` (layout, quickstart, status)
- `~/workspace/agentts-repo/docs/ARCHITECTURE.md` §§1–12 (three
  layers, run path, drive cap/lock/repair, crash recovery, journal,
  worker model, tick agent, scheduling, workflow shape, CLI map,
  honest limits)
- `~/workspace/agentts-repo/apps/agentts/src/agentts.ts` (trap
  wrappers, JSON boundary rule, decision cascade, `run()` contract)
- `~/workspace/agentts-repo/apps/agentts/src/host.ts` (grep:
  `MAX_DRIVE_ROUNDS`, drive-cap failure, exec dispatch)
- `~/workspace/agentts-repo/apps/agentts/plugins/direct/src/direct-adapter.ts`
  (exec via spawnSync, 16 MB stdout cap, 120s worker timeout)
- `~/workspace/agentts-repo/apps/agentts/plugins/muse/src/muse-adapter.ts`
  (grep: exec via spawnSync, derived job timeout)
- `~/workspace/agentts-repo/apps/agentts/plugins/muse/worker-loop.ts`
  (script-mode worker loop, file-effects return, per-spec notes)
- `~/workspace/agentts-repo/apps/agentts/plugins/muse/TICK-AGENT.md`
  (grep: tick long-poll, watchdog cron)
- `~/workspace/agentts-repo/apps/agentts/workflows/dogfood/daily-ai-briefing.ts`
  (grep: exec/job structure; recurrence is an external 06:15 cron)
- `~/workspace/agentts-repo/apps/agentts/workflows/library/hello.ts`
  (minimal workflow shape)
- `~/workspace/foundry-live/README.md`, `~/workspace/foundry-live/BACKLOG.md`,
  `~/workspace/foundry-live/package.json` (library API, CLIs, backlog,
  tile design, multi-Muse vision)
- `~/workspace/agentts-repo/CHANGELOG.md` (grep: r1 Nov 19, r2 in progress)
