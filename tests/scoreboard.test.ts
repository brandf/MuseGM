import { describe, expect, it, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ScoreboardError,
  activeBoards,
  addBoard,
  awardPoints,
  boardIdFromName,
  defaultScoreboardStatePath,
  emptyScoreboardStore,
  endScoreboard,
  endScoreboardLive,
  getBoard,
  isScoreboard,
  leader,
  listScoreboardsLive,
  loadScoreboardState,
  parseScoreboard,
  parseScoreboardRequest,
  parseScoreboardStore,
  resolveTeam,
  saveScoreboardState,
  scoreboardIndexHtml,
  scoreboardStartLine,
  scoreboardToChatLine,
  scoreboardToJournalHtml,
  scoreboardToText,
  setPoints,
  startScoreboard,
  startScoreboardLive,
  awardPointsLive,
  updateBoard,
  type Scoreboard,
  type ScoreboardStore,
} from "../src/session/scoreboard.js";

const AT = "2026-11-20T12:00:00.000Z";

function dragonSoccer(): Scoreboard {
  return startScoreboard({
    name: "Dragon Soccer",
    target: 3,
    teams: ["Red", "Blue"],
    createdAt: "2026-11-20",
  });
}

describe("startScoreboard", () => {
  it("starts a board with slugged id and zeroed teams", () => {
    const b = dragonSoccer();
    expect(b.id).toBe("dragon-soccer");
    expect(b.target).toBe(3);
    expect(b.teams).toEqual([
      { id: "red", name: "Red", points: 0 },
      { id: "blue", name: "Blue", points: 0 },
    ]);
    expect(b.status).toBe("active");
    expect(b.winnerId).toBeNull();
    expect(b.events).toEqual([]);
  });

  it("rejects an empty name, a bad target, and too few teams", () => {
    expect(() => startScoreboard({ name: "  ", target: 3, teams: ["Red", "Blue"] })).toThrow(
      ScoreboardError,
    );
    expect(() => startScoreboard({ name: "X", target: 0, teams: ["Red", "Blue"] })).toThrow(
      /target/,
    );
    expect(() => startScoreboard({ name: "X", target: -2, teams: ["Red", "Blue"] })).toThrow(
      /target/,
    );
    expect(() => startScoreboard({ name: "X", target: 1.5, teams: ["Red", "Blue"] })).toThrow(
      /target/,
    );
    expect(() => startScoreboard({ name: "X", target: 3, teams: ["Red"] })).toThrow(
      /at least two teams/,
    );
  });

  it("rejects blank and duplicate team names (case-insensitive)", () => {
    expect(() =>
      startScoreboard({ name: "X", target: 3, teams: ["Red", " "] }),
    ).toThrow(/blank/);
    expect(() =>
      startScoreboard({ name: "X", target: 3, teams: ["Red", "red"] }),
    ).toThrow(/Duplicate team/);
  });

  it("slugifies names the same way quest titles do", () => {
    expect(boardIdFromName("The Big Wager!")).toBe("the-big-wager");
    expect(boardIdFromName("!!!")).toBe("scoreboard");
  });
});

describe("resolveTeam", () => {
  it("resolves by id, exact name, and unique substring", () => {
    const b = startScoreboard({
      name: "Race",
      target: 5,
      teams: ["Red Dragons", "Blue Griffins"],
    });
    expect(resolveTeam(b, "red-dragons").name).toBe("Red Dragons");
    expect(resolveTeam(b, "blue griffins").name).toBe("Blue Griffins");
    expect(resolveTeam(b, "griffin").name).toBe("Blue Griffins");
  });

  it("never guesses: unknown and ambiguous names list what exists", () => {
    const b = startScoreboard({
      name: "Race",
      target: 5,
      teams: ["Red Dragons", "Red Griffins"],
    });
    expect(() => resolveTeam(b, "Green")).toThrow(/No team named "Green".*Red Dragons.*Red Griffins/);
    expect(() => resolveTeam(b, "Red")).toThrow(/matches more than one team/);
    expect(() => resolveTeam(b, "  ")).toThrow(/Name a team/);
  });
});

describe("awardPoints", () => {
  it("awards a goal and records the event with its source", () => {
    const b = dragonSoccer();
    const { board, event, won } = awardPoints(b, "Red", 1, "Valeros scored", AT);
    expect(won).toBe(false);
    expect(board.teams[0].points).toBe(1);
    expect(event).toEqual({
      teamId: "red",
      delta: 1,
      pointsAfter: 1,
      source: "Valeros scored",
      at: AT,
    });
    // Immutable: the input board is untouched.
    expect(b.teams[0].points).toBe(0);
    expect(b.events).toEqual([]);
  });

  it("a foul subtracts a point and may take a team below zero", () => {
    const b = dragonSoccer();
    const { board, event } = awardPoints(b, "Red", -1, "fire foul on the Red side", AT);
    expect(board.teams[0].points).toBe(-1);
    expect(event.delta).toBe(-1);
    expect(scoreboardToChatLine(board, event)).toMatch(/Foul! Red -1/);
  });

  it("reaching the target wins immediately — overshoot counts", () => {
    let b = dragonSoccer();
    b = awardPoints(b, "Red", 2, "two quick goals", AT).board;
    const { board, won } = awardPoints(b, "Red", 2, "a long shot", AT);
    expect(won).toBe(true);
    expect(board.status).toBe("won");
    expect(board.winnerId).toBe("red");
    expect(board.teams[0].points).toBe(4);
  });

  it("a finished board rejects further scores", () => {
    let b = dragonSoccer();
    b = awardPoints(b, "Red", 3, "hat trick", AT).board;
    expect(() => awardPoints(b, "Blue", 1, "too late", AT)).toThrow(/already won/);
  });

  it("rejects a zero or non-integer delta, an unknown team, and a missing source", () => {
    const b = dragonSoccer();
    expect(() => awardPoints(b, "Red", 0, "nothing", AT)).toThrow(/whole number/);
    expect(() => awardPoints(b, "Red", 1.5, "half a goal", AT)).toThrow(/whole number/);
    expect(() => awardPoints(b, "Green", 1, "Valeros scored", AT)).toThrow(/No team named "Green"/);
    expect(() => awardPoints(b, "Red", 1, "   ", AT)).toThrow(/needs a source/);
  });
});

describe("setPoints", () => {
  it("sets outright and wins at the target", () => {
    const b = dragonSoccer();
    const { board, event, won } = setPoints(b, "Blue", 3, "correction: Blue had three", AT);
    expect(won).toBe(true);
    expect(board.teams[1].points).toBe(3);
    expect(event.delta).toBe(3);
    expect(board.status).toBe("won");
  });

  it("rejects a non-integer total", () => {
    const b = dragonSoccer();
    expect(() => setPoints(b, "Red", 2.5, "nope", AT)).toThrow(/whole number/);
  });
});

describe("endScoreboard", () => {
  it("ends with the unique leader as winner", () => {
    let b = dragonSoccer();
    b = awardPoints(b, "Red", 2, "two goals", AT).board;
    b = awardPoints(b, "Blue", 1, "one goal", AT).board;
    const { board, alreadyFinished } = endScoreboard(b);
    expect(alreadyFinished).toBe(false);
    expect(board.status).toBe("ended");
    expect(board.winnerId).toBe("red");
  });

  it("a tie ends with no winner", () => {
    let b = dragonSoccer();
    b = awardPoints(b, "Red", 1, "goal", AT).board;
    b = awardPoints(b, "Blue", 1, "goal", AT).board;
    const { board } = endScoreboard(b);
    expect(board.status).toBe("ended");
    expect(board.winnerId).toBeNull();
  });

  it("ending an already-finished board is a no-op that says so", () => {
    let b = dragonSoccer();
    b = awardPoints(b, "Red", 3, "hat trick", AT).board;
    const { board, alreadyFinished } = endScoreboard(b);
    expect(alreadyFinished).toBe(true);
    expect(board.status).toBe("won");
  });
});

describe("leader", () => {
  it("reports the top team and whether the lead is tied", () => {
    let b = dragonSoccer();
    expect(leader(b).tied).toBe(true);
    b = awardPoints(b, "Blue", 1, "goal", AT).board;
    expect(leader(b)).toEqual({ team: { id: "blue", name: "Blue", points: 1 }, tied: false });
  });
});

describe("store", () => {
  it("adds, updates, and lists active boards", () => {
    let store = emptyScoreboardStore();
    const b = dragonSoccer();
    store = addBoard(store, b);
    expect(getBoard(store, "dragon-soccer")?.name).toBe("Dragon Soccer");
    expect(activeBoards(store)).toHaveLength(1);
    expect(() => addBoard(store, b)).toThrow(/already exists/);
    const ended = endScoreboard(b).board;
    store = updateBoard(store, ended);
    expect(activeBoards(store)).toHaveLength(0);
    expect(() => updateBoard(store, startScoreboard({ name: "Other", target: 2, teams: ["A", "B"] }))).toThrow(
      /Unknown scoreboard/,
    );
  });
});

describe("rendering", () => {
  it("renders active, won, ended-leader, and ended-tied lines", () => {
    let b = dragonSoccer();
    expect(scoreboardToText(b)).toBe("⚽ Dragon Soccer — Red 0, Blue 0 (first to 3)");
    b = awardPoints(b, "Red", 3, "hat trick", AT).board;
    expect(scoreboardToText(b)).toBe("🏆 Red wins Dragon Soccer, Red 3, Blue 0 (first to 3)!");
    let c = dragonSoccer();
    c = awardPoints(c, "Red", 2, "two goals", AT).board;
    c = endScoreboard(c).board;
    expect(scoreboardToText(c)).toBe(
      "Dragon Soccer ended — Red leads, Red 2, Blue 0 (first to 3).",
    );
    let d = dragonSoccer();
    d = awardPoints(d, "Red", 1, "goal", AT).board;
    d = awardPoints(d, "Blue", 1, "goal", AT).board;
    d = endScoreboard(d).board;
    expect(scoreboardToText(d)).toBe("Dragon Soccer ended tied, Red 1, Blue 1 (first to 3).");
  });

  it("renders goal and winner chat lines", () => {
    let b = dragonSoccer();
    const goal = awardPoints(b, "Red", 1, "Valeros scored", AT);
    expect(scoreboardToChatLine(goal.board, goal.event)).toBe(
      "⚽ Red scores! Red 1, Blue 0 (first to 3) — Valeros scored",
    );
    const win = awardPoints(goal.board, "Red", 2, "two more", AT);
    expect(scoreboardToChatLine(win.board, win.event)).toBe(
      "🏆 Red wins Dragon Soccer, Red 3, Blue 0 (first to 3)! — two more",
    );
    expect(scoreboardStartLine(b)).toBe(
      "🏆 Scoreboard started: Dragon Soccer — Red vs Blue, first to 3.",
    );
  });

  it("renders journal HTML with teams, points, and history", () => {
    let b = dragonSoccer();
    b = awardPoints(b, "Red", 1, "Valeros scored", AT).board;
    const html = scoreboardToJournalHtml(b);
    expect(html).toContain("<td>Red</td><td>1</td>");
    expect(html).toContain("Valeros scored");
    expect(html).toContain("First to 3 wins.");
    expect(scoreboardIndexHtml({ boards: [b] })).toContain("Dragon Soccer — Red 1, Blue 0");
    expect(scoreboardIndexHtml(emptyScoreboardStore())).toContain("No contests yet.");
  });
});

describe("serialization", () => {
  it("round-trips a board and a store, and rejects bad shapes", () => {
    const b = awardPoints(dragonSoccer(), "Red", 1, "Valeros scored", AT).board;
    expect(parseScoreboard(JSON.stringify(b))).toEqual(b);
    const store: ScoreboardStore = { boards: [b] };
    expect(parseScoreboardStore(JSON.stringify(store))).toEqual(store);
    expect(() => parseScoreboard("{bad json")).toThrow(/bad JSON/);
    expect(() => parseScoreboard(JSON.stringify({ name: "X" }))).toThrow(/wrong shape/);
    expect(() => parseScoreboardStore(JSON.stringify({ boards: [{ name: "X" }] }))).toThrow(
      /wrong shape/,
    );
    expect(isScoreboard(null)).toBe(false);
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "musegm-scoreboard-"));
  tmpDirs.push(d);
  return d;
}

describe("file state", () => {
  it("round-trips through the state file, and corrupt/missing files start fresh", () => {
    const dir = tmpDir();
    const file = path.join(dir, ".scoreboard-state.json");
    const store = addBoard(emptyScoreboardStore(), dragonSoccer());
    saveScoreboardState(store, file);
    expect(loadScoreboardState(file)).toEqual(store);
    fs.writeFileSync(file, "{not json", "utf-8");
    expect(loadScoreboardState(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 2, boards: [] }), "utf-8");
    expect(loadScoreboardState(file)).toBeNull();
    expect(loadScoreboardState(path.join(dir, "missing.json"))).toBeNull();
  });

  it("defaults to the env override or the repo dotfile", () => {
    expect(defaultScoreboardStatePath()).toContain(".scoreboard-state.json");
    process.env.FOUNDRY_SCOREBOARD_STATE = "/tmp/from-env.json";
    expect(defaultScoreboardStatePath()).toBe("/tmp/from-env.json");
    delete process.env.FOUNDRY_SCOREBOARD_STATE;
  });
});

describe("parseScoreboardRequest", () => {
  function storeWith(...boards: Scoreboard[]): ScoreboardStore {
    let store = emptyScoreboardStore();
    for (const b of boards) store = addBoard(store, b);
    return store;
  }

  it("parses the issue's start phrasing, both name shapes", () => {
    expect(
      parseScoreboardRequest(
        "start a dragon soccer scoreboard, first to 3, Red vs Blue",
        emptyScoreboardStore(),
      ),
    ).toEqual({ kind: "start", name: "dragon soccer", target: 3, teams: ["Red", "Blue"] });
    expect(
      parseScoreboardRequest(
        "start a scoreboard for the wager, first to five, Red and Blue",
        emptyScoreboardStore(),
      ),
    ).toEqual({ kind: "start", name: "the wager", target: 5, teams: ["Red", "Blue"] });
  });

  it("asks for a missing target or missing teams instead of guessing", () => {
    expect(
      parseScoreboardRequest("start a scoreboard", emptyScoreboardStore()),
    ).toEqual({ kind: "clarify", message: "What should the scoreboard be called?" });
    expect(
      parseScoreboardRequest("start a dragon soccer scoreboard, Red vs Blue", emptyScoreboardStore()),
    ).toEqual({ kind: "clarify", message: 'First to how many points for "dragon soccer"?' });
    expect(
      parseScoreboardRequest("start a dragon soccer scoreboard, first to 3", emptyScoreboardStore()),
    ).toEqual({
      kind: "clarify",
      message: 'Which teams play "dragon soccer"? Name at least two (e.g. Red vs Blue).',
    });
  });

  it("parses goal, foul, and show phrasings against the one active board", () => {
    const store = storeWith(dragonSoccer());
    expect(parseScoreboardRequest("Red scores", store)).toEqual({
      kind: "award",
      boardId: "dragon-soccer",
      team: "Red",
      delta: 1,
      source: "Red scores",
    });
    expect(parseScoreboardRequest("goal for Blue", store)).toEqual({
      kind: "award",
      boardId: "dragon-soccer",
      team: "Blue",
      delta: 1,
      source: "goal for Blue",
    });
    expect(parseScoreboardRequest("fire foul on the Red side", store)).toEqual({
      kind: "award",
      boardId: "dragon-soccer",
      team: "Red",
      delta: -1,
      source: "fire foul on the Red side",
    });
    expect(parseScoreboardRequest("show the scoreboard", store)).toEqual({
      kind: "show",
      boardId: "dragon-soccer",
    });
    expect(parseScoreboardRequest("end the scoreboard", store)).toEqual({
      kind: "end",
      boardId: "dragon-soccer",
    });
  });

  it("clarifies when no board is running, or several are", () => {
    expect(parseScoreboardRequest("Red scores", emptyScoreboardStore())).toEqual({
      kind: "clarify",
      message: "No scoreboard is running — start one first.",
    });
    const two = storeWith(
      dragonSoccer(),
      startScoreboard({ name: "Wager", target: 5, teams: ["Red", "Blue"] }),
    );
    expect(parseScoreboardRequest("Red scores", two)).toEqual({
      kind: "clarify",
      message: 'Which scoreboard? Running now: "Dragon Soccer", "Wager".',
    });
    // The team name disambiguates when it only plays on one board.
    const mixed = storeWith(
      dragonSoccer(),
      startScoreboard({ name: "Wager", target: 5, teams: ["Green", "Gold"] }),
    );
    expect(parseScoreboardRequest("Green scores", mixed)).toEqual({
      kind: "award",
      boardId: "wager",
      team: "Green",
      delta: 1,
      source: "Green scores",
    });
    // A board named in the line wins.
    expect(parseScoreboardRequest("Red scores on the dragon soccer board", two)).toEqual({
      kind: "award",
      boardId: "dragon-soccer",
      team: "Red",
      delta: 1,
      source: "Red scores on the dragon soccer board",
    });
  });

  it("returns null for ordinary chat — never a hallucinated board", () => {
    const store = storeWith(dragonSoccer());
    expect(parseScoreboardRequest("the ogre is dead", store)).toBeNull();
    expect(parseScoreboardRequest("what's the brief?", store)).toBeNull();
    expect(parseScoreboardRequest("add a door on the north wall", store)).toBeNull();
  });
});

// ---------------------------------------------------------------- live layer

interface FakePage {
  _id: string;
  name: string;
  text?: { content?: string };
  flags?: Record<string, unknown>;
}

interface FakeJournal {
  _id: string;
  name: string;
  pages: FakePage[];
  flags?: Record<string, unknown>;
}

function fakeLive() {
  const journals: FakeJournal[] = [];
  const sent: string[] = [];
  const calls: { type: string; doc: string; args: Record<string, unknown> }[] = [];
  let n = 0;
  const live = {
    journals,
    sent,
    calls,
    raw: () => ({
      getJournals: () => journals,
      createJournalEntry: async (
        name: string,
        pages: { name: string; content: string }[],
        _folder?: string,
        _visibility?: string,
      ) => {
        const entry: FakeJournal = {
          _id: `entry-${++n}`,
          name,
          pages: pages.map((p) => ({
            _id: `page-${++n}`,
            name: p.name,
            text: { content: p.content },
          })),
        };
        journals.push(entry);
        return { _id: entry._id };
      },
    }),
    modifyDocument: async (
      doc: string,
      op: string,
      args: Record<string, unknown>,
    ): Promise<unknown[]> => {
      calls.push({ type: op, doc, args });
      if (doc === "JournalEntry" && op === "update") {
        const updates = args.updates as { _id: string; flags?: Record<string, unknown> }[];
        for (const u of updates) {
          const entry = journals.find((j) => j._id === u._id);
          if (entry && u.flags) entry.flags = u.flags;
        }
        return [];
      }
      if (doc === "JournalEntryPage" && op === "create") {
        const parentUuid = String(args.parentUuid ?? "");
        const entryId = parentUuid.replace("JournalEntry.", "");
        const entry = journals.find((j) => j._id === entryId);
        const data = args.data as { name: string; text?: { content?: string }; flags?: Record<string, unknown> }[];
        const created = data.map((d) => {
          const page: FakePage = { _id: `page-${++n}`, name: d.name, text: d.text, flags: d.flags };
          entry?.pages.push(page);
          return { _id: page._id };
        });
        return created;
      }
      if (doc === "JournalEntryPage" && op === "update") {
        const updates = args.updates as { _id: string; text?: { content?: string }; flags?: Record<string, unknown> }[];
        for (const u of updates) {
          for (const entry of journals) {
            const page = entry.pages.find((p) => p._id === u._id);
            if (page) {
              if (u.text) page.text = u.text;
              if (u.flags) page.flags = u.flags;
            }
          }
        }
        return [];
      }
      return [];
    },
    sendChat: async (content: string) => {
      sent.push(content);
      return `sent-${++n}`;
    },
  };
  return live;
}

describe("live layer (fake live)", () => {
  it("starts a board: journal page + index + one chat line, readable back", async () => {
    const live = fakeLive();
    const { board, entryId } = await startScoreboardLive(live as never, {
      name: "Dragon Soccer",
      target: 3,
      teams: ["Red", "Blue"],
    });
    expect(board.id).toBe("dragon-soccer");
    expect(live.sent).toEqual([
      "🏆 Scoreboard started: Dragon Soccer — Red vs Blue, first to 3.",
    ]);
    const read = listScoreboardsLive(live as never);
    expect(read.entryId).toBe(entryId);
    expect(read.store.boards).toHaveLength(1);
    expect(read.store.boards[0].teams).toEqual([
      { id: "red", name: "Red", points: 0 },
      { id: "blue", name: "Blue", points: 0 },
    ]);
    expect(read.text).toContain("Dragon Soccer — Red 0, Blue 0 (first to 3)");
  });

  it("awards live: the page flags carry the board and the chat announces the winner", async () => {
    const live = fakeLive();
    await startScoreboardLive(live as never, {
      name: "Dragon Soccer",
      target: 3,
      teams: ["Red", "Blue"],
    });
    const goal = await awardPointsLive(live as never, "dragon-soccer", "Red", 1, "Valeros scored");
    expect(goal.won).toBe(false);
    expect(live.sent.at(-1)).toBe("⚽ Red scores! Red 1, Blue 0 (first to 3) — Valeros scored");
    const win = await awardPointsLive(live as never, "dragon-soccer", "Red", 2, "two more");
    expect(win.won).toBe(true);
    expect(live.sent.at(-1)).toBe(
      "🏆 Red wins Dragon Soccer, Red 3, Blue 0 (first to 3)! — two more",
    );
    const read = listScoreboardsLive(live as never);
    expect(read.store.boards[0].status).toBe("won");
    expect(read.store.boards[0].events).toHaveLength(2);
  });

  it("ends a board live and rejects an unknown board", async () => {
    const live = fakeLive();
    await startScoreboardLive(live as never, {
      name: "Dragon Soccer",
      target: 3,
      teams: ["Red", "Blue"],
    });
    await awardPointsLive(live as never, "dragon-soccer", "Red", 2, "two goals");
    const ended = await endScoreboardLive(live as never, "dragon-soccer");
    expect(ended.board.status).toBe("ended");
    expect(ended.board.winnerId).toBe("red");
    expect(live.sent.at(-1)).toContain("ended — Red leads");
    await expect(
      awardPointsLive(live as never, "no-such-board", "Red", 1, "late"),
    ).rejects.toThrow(/Unknown scoreboard/);
  });
});
