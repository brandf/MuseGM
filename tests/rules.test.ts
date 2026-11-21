/**
 * Real rule lookup tests (BRA-205) — tokenize / strip / score / search /
 * rank / answer over the demo fixture corpus. No Foundry connection: the
 * live layer (pack documents over the socket, world journals) is
 * live-tested next session.
 */
import { describe, it, expect } from "bun:test";
import {
  FOUND_MIN_SCORE,
  demoLookup,
  demoRulesCorpus,
  extractPackDocText,
  formatCitation,
  lookupInCorpus,
  rankRuleHits,
  scorePassage,
  searchJournalCorpus,
  searchPackIndexTerms,
  snippetFor,
  stripHtml,
  tokenizeQuestion,
  type RulesCorpus,
  type RuleHit,
} from "../src/session/rules.js";

function hit(score: number, citation: string): RuleHit {
  return {
    citation: { kind: "journal", journalTitle: "J", entryName: citation },
    text: "",
    snippet: "",
    score,
    matchedTerms: [],
  };
}

describe("tokenizeQuestion", () => {
  it("drops stopwords and keeps rules terms", () => {
    expect(tokenizeQuestion("What does flat-footed do?")).toEqual(["flat", "footed"]);
  });
  it("keeps short rules terms like ac and dc", () => {
    expect(tokenizeQuestion("what is my AC against a DC 15 check")).toEqual([
      "ac",
      "dc",
      "15",
      "check",
    ]);
  });
  it("splits hyphens and dedupes", () => {
    expect(tokenizeQuestion("reload reload the crossbow")).toEqual(["reload", "crossbow"]);
  });
  it("returns [] for an all-stopword question", () => {
    expect(tokenizeQuestion("what is it?")).toEqual([]);
  });
  it("returns [] for an empty question", () => {
    expect(tokenizeQuestion("")).toEqual([]);
  });
});

describe("stripHtml", () => {
  it("removes tags and decodes entities", () => {
    expect(stripHtml("<p>You take a &ndash;2 penalty &amp; fall.</p>")).toBe(
      "You take a –2 penalty & fall.",
    );
  });
  it("collapses whitespace and handles empty input", () => {
    expect(stripHtml("<p>  a   b\n c </p>")).toBe("a b c");
    expect(stripHtml("")).toBe("");
  });
});

describe("extractPackDocText", () => {
  it("pulls the description out of a PF2e document", () => {
    const text = extractPackDocText({
      name: "Flat-Footed",
      system: { description: { value: "<p>You take a –2 penalty to AC.</p>" } },
    });
    expect(text).toContain("You take a –2 penalty to AC.");
    expect(text).not.toContain("<p>");
    // The name is the title, not the passage — it is scored separately.
    expect(text).not.toContain("Flat-Footed");
  });
  it("joins journal-entry pages", () => {
    const text = extractPackDocText({
      name: "Rulebook",
      pages: [
        { name: "Actions", text: { content: "<p>Three actions per turn.</p>" } },
        { name: "Reactions", text: { content: "<p>One reaction per round.</p>" } },
      ],
    });
    expect(text).toContain("Three actions per turn.");
    expect(text).toContain("One reaction per round.");
  });
  it("returns empty when there is no prose (the name is the title, not the passage)", () => {
    expect(extractPackDocText({ name: "Strike", system: {} })).toBe("");
  });
});

describe("scorePassage", () => {
  it("title matches beat body-only matches", () => {
    const title = scorePassage(["flat", "footed"], "Flat-Footed", "unrelated body");
    const body = scorePassage(["flat", "footed"], "Something Else", "flat footed in the body");
    expect(title.score).toBeGreaterThan(body.score);
  });
  it("all terms in the title earn the bonus", () => {
    const all = scorePassage(["flat", "footed"], "Flat-Footed", "");
    const one = scorePassage(["flat", "footed"], "Flat", "");
    expect(all.score).toBe(one.score + 10 + 15);
  });
  it("no match scores zero with no matched terms", () => {
    const { score, matchedTerms } = scorePassage(["dragon"], "Strike", "attack with a weapon");
    expect(score).toBe(0);
    expect(matchedTerms).toEqual([]);
  });
  it("the exact phrase earns a bonus", () => {
    const phrase = scorePassage(["flat", "footed"], "Other", "you are flat footed now");
    const scattered = scorePassage(["flat", "footed"], "Other", "flat here. footed there.");
    expect(phrase.score).toBeGreaterThan(scattered.score);
  });
});

describe("snippetFor", () => {
  it("picks the sentence with the most terms", () => {
    const text = "Unrelated sentence here. Reloading a crossbow takes 2 actions. Another line.";
    expect(snippetFor(text, ["reload", "crossbow"])).toBe(
      "Reloading a crossbow takes 2 actions.",
    );
  });
  it("falls back to the start when nothing matches", () => {
    expect(snippetFor("First sentence. Second.", ["dragon"])).toBe("First sentence.");
  });
  it("truncates long passages at a word boundary", () => {
    const text = "word ".repeat(100).trim() + ".";
    const snippet = snippetFor(text, ["word"], 40);
    expect(snippet.length).toBeLessThanOrEqual(41);
    expect(snippet.endsWith("…")).toBe(true);
  });
  it("returns empty for empty text", () => {
    expect(snippetFor("", ["flat"])).toBe("");
  });
});

describe("searchPackIndexTerms", () => {
  it("dedupes across terms and counts name coverage", () => {
    const corpus = demoRulesCorpus();
    const candidates = searchPackIndexTerms(corpus.packs, ["flat", "footed"]);
    const flatFooted = candidates.find((c) => c.entryName === "Flat-Footed");
    expect(flatFooted).toBeDefined();
    expect(flatFooted?.nameCoverage).toBe(2);
    expect(candidates.filter((c) => c.entryName === "Flat-Footed")).toHaveLength(1);
  });
  it("finds nothing for an unknown term", () => {
    expect(searchPackIndexTerms(demoRulesCorpus().packs, ["moon"])).toEqual([]);
  });
});

describe("searchJournalCorpus", () => {
  it("finds a page by its content and cites journal + page", () => {
    const corpus = demoRulesCorpus();
    const hits = searchJournalCorpus(corpus.journals, ["crossbow", "reload"]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].citation).toEqual({
      kind: "journal",
      journalTitle: "House Rules",
      entryName: "Reloading in our game",
    });
    expect(hits[0].snippet).toContain("crossbow");
    expect(hits[0].snippet).not.toContain("<p>");
  });
  it("finds nothing when no page mentions the terms", () => {
    expect(searchJournalCorpus(demoRulesCorpus().journals, ["dragon", "moon"])).toEqual([]);
  });
});

describe("rankRuleHits", () => {
  it("sorts best score first with a deterministic tiebreak", () => {
    const ranked = rankRuleHits([hit(5, "B page"), hit(9, "A page"), hit(5, "A page")]);
    expect(ranked.map((h) => h.score)).toEqual([9, 5, 5]);
    expect(ranked[1].citation.entryName).toBe("A page");
  });
});

describe("formatCitation", () => {
  it("renders compendium and journal citations", () => {
    expect(
      formatCitation({ kind: "compendium", packLabel: "Conditions", entryName: "Flat-Footed" }),
    ).toBe('Conditions — "Flat-Footed"');
    expect(
      formatCitation({ kind: "journal", journalTitle: "House Rules", entryName: "Reloading" }),
    ).toBe('Journal "House Rules" — page "Reloading"');
  });
});

describe("lookupInCorpus", () => {
  it("answers flat-footed from the conditions pack, with a citation", () => {
    const answer = demoLookup("What does flat-footed do?");
    expect(answer.found).toBe(true);
    expect(answer.answer).toContain("–2 circumstance penalty to AC");
    expect(answer.answer).toContain('Demo Conditions Pack (fixture — not a real book)');
    expect(answer.citations[0]).toEqual({
      kind: "compendium",
      packId: "demo.conditions",
      packLabel: "Demo Conditions Pack (fixture — not a real book)",
      entryName: "Flat-Footed",
      docId: "flat-footed",
    });
  });
  it("answers the reload question and ranks the house-rule journal hit too", () => {
    const answer = demoLookup("How many actions does it take to reload a crossbow?");
    expect(answer.found).toBe(true);
    // The best sentence for a crossbow question is the crossbow one.
    expect(answer.answer).toContain("take 2 actions to reload");
    const kinds = answer.hits.map((h) => h.citation.kind);
    expect(kinds).toContain("compendium");
    expect(kinds).toContain("journal");
  });
  it("says plainly when nothing matches — no invented ruling", () => {
    const answer = demoLookup("How do I ride a dragon to the moon?");
    expect(answer.found).toBe(false);
    expect(answer.answer).toContain("Not found in the installed books");
    expect(answer.answer).not.toContain("You can ride");
    expect(answer.citations).toEqual([]);
  });
  it("lists closest matches by name on the not-found path", () => {
    // "frightened" matches a condition entry by name only (score 10,
    // below the found threshold) and "dragon" matches nothing — so the
    // combined question is not found, but Frightened is listed.
    const answer = demoLookup("What does frightened do to my dragon?");
    expect(answer.found).toBe(false);
    expect(answer.closest.length).toBeGreaterThan(0);
    expect(answer.closest[0].citation.entryName).toBe("Frightened");
    expect(answer.answer).toContain("Closest matches by name");
  });
  it("never presents an unread entry as a found answer", () => {
    const corpus = demoRulesCorpus();
    // The document exists in the index but was never read: title-only hit.
    const unreadCorpus: RulesCorpus = {
      packs: corpus.packs,
      docs: new Map(),
      journals: [],
      unread: new Map([
        ["demo.conditions:flat-footed", "could not be read live: connection refused"],
      ]),
    };
    const answer = lookupInCorpus("What does flat-footed do?", unreadCorpus);
    expect(answer.found).toBe(false);
    expect(answer.answer).toContain("Not found in the installed books");
    expect(answer.closest[0].textUnread).toBe(true);
    expect(answer.closest[0].unreadReason).toContain("connection refused");
    expect(answer.answer).toContain("entry exists but its text was not read");
  });
  it("handles an empty question without crashing", () => {
    const answer = demoLookup("");
    expect(answer.found).toBe(false);
    expect(answer.answer).toContain("No searchable terms");
  });
  it("records which packs and journals were searched", () => {
    const answer = demoLookup("What does flat-footed do?");
    expect(answer.searched.packs).toHaveLength(2);
    expect(answer.searched.journals).toEqual(["House Rules", "Session Notes"]);
  });
  it("the found threshold is reachable by a two-term title match", () => {
    const { score } = scorePassage(["flat", "footed"], "Flat-Footed", "");
    expect(score).toBeGreaterThanOrEqual(FOUND_MIN_SCORE);
  });
});
