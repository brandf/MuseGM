/**
 * Real rule lookup (BRA-205) — answers plain-language rules questions
 * from the installed books (compendium packs) and the world's journals,
 * with a citation for every answer. The MCP `lookup_rule` is a stub and
 * returns nothing; this is the real path.
 *
 * Access paths reused, not invented:
 * - Pack indexes: `getWorldPacks` / `searchPackIndex` from compendium.ts
 *   — the `world` payload already carries every pack's index
 *   (`worldData.packs[].index`), so name search needs no round trip.
 * - Full pack documents: `getPackDocument(live, type, packId, docId)` —
 *   `modifyDocument(type, "get", { query: { _id }, pack })`. NEEDS LIVE
 *   CONFIRMATION on 14.370 (same caveat as the compendium import); the
 *   live lookup degrades honestly when a read fails (see `lookupRuleLive`).
 * - Journals: `live.raw().getJournals()` — the same raw-client shape
 *   questlog.ts / chronicle.ts / scoreboard.ts read (entries with pages
 *   whose `text.content` is HTML).
 *
 * Honesty rules, enforced in code:
 * - Every answer carries its citations (pack label + entry name, or
 *   journal title + page name). An answer with no source says so.
 * - Nothing is invented: if no passage matches, the result is
 *   "not found in the installed books" plus the closest matches, never
 *   a made-up ruling.
 * - A document whose full text was not read is never presented as a
 *   found answer: it can only appear as a closest match, flagged
 *   `textUnread`, with the reason why its text was not read.
 *
 * Layout follows the compendium module: pure functions (tokenize /
 * score / search / rank / answer) are unit-tested with fixtures; the
 * thin live wrapper does the socket calls. Anything that needs a live
 * Foundry is marked as such.
 */
import type { FoundryLive } from "../live.js";
import {
  getPackDocument,
  getWorldPacks,
  searchPackIndex,
  type PackInfo,
} from "./compendium.js";

// ---------------------------------------------------------------- types

/** Where an answer came from. Rendered verbatim in the answer text. */
export interface RuleCitation {
  kind: "compendium" | "journal";
  /** Compendium only. */
  packId?: string;
  /** Compendium only. */
  packLabel?: string;
  /** Compendium: entry name. Journal: page name. */
  entryName: string;
  /** Journal only. */
  journalTitle?: string;
  /** Compendium only. */
  docId?: string;
}

export function formatCitation(c: RuleCitation): string {
  if (c.kind === "compendium") {
    return `${c.packLabel ?? c.packId ?? "unknown pack"} — "${c.entryName}"`;
  }
  return `Journal "${c.journalTitle ?? "untitled"}" — page "${c.entryName}"`;
}

export interface RuleHit {
  citation: RuleCitation;
  /** Plain-text passage the answer is drawn from ("" when unread). */
  text: string;
  /** Best passage for display, drawn from `text`. */
  snippet: string;
  score: number;
  matchedTerms: string[];
  /** True when only the index entry was seen — full text never read. */
  textUnread?: boolean;
  /** Why the full text was not read (fetch failed, not fetched, ...). */
  unreadReason?: string;
}

/** A journal entry as read from the world, for the pure search. */
export interface JournalPageDoc {
  _id: string;
  name: string;
  text?: { content?: string };
}

export interface JournalDoc {
  _id: string;
  name: string;
  pages?: JournalPageDoc[];
}

/** Everything the pure lookup searches. */
export interface RulesCorpus {
  packs: PackInfo[];
  /** Full pack documents, keyed `${packId}:${docId}`. */
  docs: Map<string, Record<string, unknown>>;
  journals: JournalDoc[];
  /** Index candidates whose full text was not read: key → reason. */
  unread?: Map<string, string>;
}

export interface RuleAnswer {
  question: string;
  terms: string[];
  found: boolean;
  /** The answer text. When found, drawn from the top hit's passage. */
  answer: string;
  /** Citations for the answer, best first. Empty when not found. */
  citations: RuleCitation[];
  /** Ranked hits, best first (empty when nothing matched at all). */
  hits: RuleHit[];
  /** Closest matches by name when no passage matched — not-found path. */
  closest: RuleHit[];
  /** Provenance: which packs and journals were actually searched. */
  searched: { packs: string[]; journals: string[] };
}

// ---------------------------------------------------------------- tokenize

/** Words that carry no rules meaning. Short rules terms (ac, dc) survive. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for",
  "with", "at", "by", "from", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "can", "could", "would", "should", "how", "what",
  "when", "where", "why", "which", "who", "whom", "whose", "i", "me",
  "my", "we", "our", "you", "your", "he", "she", "it", "its", "they",
  "them", "their", "this", "that", "these", "those", "there", "here",
  "if", "then", "than", "so", "such", "as", "not", "no", "yes", "get",
  "take", "takes", "make", "makes", "use", "using", "used", "work",
  "works", "happen", "happens", "mean", "means", "say", "tell", "about",
  "against", "into", "over", "under", "up", "down", "out", "off", "again", "just",
  "only", "very", "much", "many", "more", "most", "some", "any", "all",
  "each", "every", "both", "either", "neither", "one", "two", "first",
]);

/** Split a plain-language question into searchable terms. */
export function tokenizeQuestion(question: string): string[] {
  const terms: string[] = [];
  for (const raw of question.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    if (!terms.includes(raw)) terms.push(raw);
  }
  return terms;
}

// ---------------------------------------------------------------- text

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

/** Strip HTML tags and entities down to plain readable text. */
export function stripHtml(html: string): string {
  let text = html.replace(/<[^>]*>/g, " ");
  for (const [entity, ch] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(ch);
  }
  text = text.replace(/&#\d+;/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pull the readable rules text out of a full pack document. PF2e
 * documents carry prose in `system.description.value`; JournalEntry
 * documents carry it in their pages' `text.content`. Anything else
 * (rule elements, numbers, ids) is not prose and is ignored — the
 * answer is built from words, never from a stat block.
 */
export function extractPackDocText(doc: Record<string, unknown>): string {
  const parts: string[] = [];
  // The name is NOT included: scoring already sees it as the title, and
  // including it here glues it onto the first sentence for the snippet
  // picker. Only prose goes into the passage.
  const system = doc.system;
  if (isRecord(system)) {
    const desc = system.description;
    if (isRecord(desc) && typeof desc.value === "string") {
      parts.push(stripHtml(desc.value));
    }
  }
  if (Array.isArray(doc.pages)) {
    for (const page of doc.pages as unknown[]) {
      if (!isRecord(page)) continue;
      const text = page.text;
      if (isRecord(text) && typeof text.content === "string") {
        parts.push(stripHtml(text.content));
      }
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- scoring

/**
 * Score a title + passage against the question terms. Title matches
 * count most (a matching entry name is the strongest signal the book
 * has the rule); body terms count less; the exact phrase counts extra.
 * Deterministic and explainable: the score is the sum of the parts.
 */
export function scorePassage(
  terms: string[],
  title: string,
  text: string,
): { score: number; matchedTerms: string[] } {
  const titleLower = title.toLowerCase();
  const textLower = text.toLowerCase();
  const matched: string[] = [];
  let score = 0;
  let titleTerms = 0;
  for (const term of terms) {
    const inTitle = titleLower.includes(term);
    const inText = textLower.includes(term);
    if (inTitle) {
      titleTerms += 1;
      score += 10;
      matched.push(term);
    } else if (inText) {
      score += 2;
      matched.push(term);
      // Extra occurrences add a little, capped — a long entry that
      // mentions a word ten times is not ten times more relevant.
      const occurrences = textLower.split(term).length - 1;
      score += Math.min(3, occurrences - 1) * 0.5;
    }
  }
  if (terms.length > 0 && titleTerms === terms.length) score += 15;
  if (terms.length > 1) {
    const phrase = terms.join(" ");
    if (textLower.includes(phrase) || titleLower.includes(phrase)) score += 8;
  }
  return { score, matchedTerms: matched };
}

/**
 * The best passage for display: the sentence containing the most
 * question terms, falling back to the start of the text. Capped so an
 * answer stays quotable, never a wall of book text.
 */
export function snippetFor(text: string, terms: string[], maxLen = 320): string {
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?])\s+/);
  let best = "";
  let bestCount = -1;
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const count = terms.filter((t) => lower.includes(t)).length;
    if (count > bestCount) {
      bestCount = count;
      best = sentence;
    }
  }
  const chosen = bestCount > 0 ? best : sentences[0] ?? text;
  if (chosen.length <= maxLen) return chosen.trim();
  const cut = chosen.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen / 2 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

// ---------------------------------------------------------------- pure: search

export interface PackIndexCandidate {
  packId: string;
  packLabel: string;
  packType: string;
  entryId: string;
  entryName: string;
  /** How many question terms the entry name covers (0..terms.length). */
  nameCoverage: number;
}

/**
 * Candidates from the pack indexes: for each question term, the
 * compendium name search, deduped by pack + document, with name
 * coverage counted. Pure — the index is already in memory.
 */
export function searchPackIndexTerms(
  packs: PackInfo[],
  terms: string[],
  opts: { limit?: number } = {},
): PackIndexCandidate[] {
  const byKey = new Map<string, PackIndexCandidate>();
  const limit = opts.limit ?? 20;
  for (const term of terms) {
    for (const hit of searchPackIndex(packs, term, { limit })) {
      const key = `${hit.packId}:${hit.entry._id}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.nameCoverage += 1;
      } else {
        byKey.set(key, {
          packId: hit.packId,
          packLabel: hit.packLabel,
          packType: hit.packType,
          entryId: hit.entry._id,
          entryName: hit.entry.name,
          nameCoverage: 1,
        });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.nameCoverage - a.nameCoverage || a.entryName.localeCompare(b.entryName),
  );
}

/** Search every journal page's text. Pure — journals are passed in. */
export function searchJournalCorpus(
  journals: JournalDoc[],
  terms: string[],
  opts: { limit?: number } = {},
): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const journal of journals) {
    for (const page of journal.pages ?? []) {
      const text = stripHtml(page.text?.content ?? "");
      if (!text && !page.name) continue;
      const { score, matchedTerms } = scorePassage(terms, page.name, text);
      if (score <= 0) continue;
      hits.push({
        citation: {
          kind: "journal",
          journalTitle: journal.name,
          entryName: page.name,
        },
        text,
        snippet: snippetFor(text, terms),
        score,
        matchedTerms,
      });
    }
  }
  return rankRuleHits(hits).slice(0, opts.limit ?? 20);
}

/** Best score first; ties break on the citation string (deterministic). */
export function rankRuleHits(hits: RuleHit[]): RuleHit[] {
  return [...hits].sort(
    (a, b) =>
      b.score - a.score ||
      formatCitation(a.citation).localeCompare(formatCitation(b.citation)),
  );
}

// ---------------------------------------------------------------- pure: answer

/** A readable passage must score at least this to count as an answer. */
export const FOUND_MIN_SCORE = 12;

/** How many top hits are cited on a found answer. */
export const MAX_CITATIONS = 3;

function docKey(packId: string, docId: string): string {
  return `${packId}:${docId}`;
}

/**
 * The full pure lookup: index candidates (with full text when the
 * corpus carries the document, flagged unread when it does not) plus
 * journal pages, ranked, then answered — or honestly not found.
 *
 * `corpus.docs` holds only documents that were actually read. A
 * candidate with no document in the map is scored on its name alone
 * and marked `textUnread`; it can never be the basis of a found
 * answer, only a closest match.
 */
export function lookupInCorpus(question: string, corpus: RulesCorpus): RuleAnswer {
  const terms = tokenizeQuestion(question);
  const searched = {
    packs: corpus.packs.map((p) => p.label),
    journals: corpus.journals.map((j) => j.name),
  };
  if (terms.length === 0) {
    return {
      question,
      terms,
      found: false,
      answer:
        "No searchable terms in the question — ask about a rule by name (for example, \"what does flat-footed do?\").",
      citations: [],
      hits: [],
      closest: [],
      searched,
    };
  }

  const hits: RuleHit[] = [];
  for (const candidate of searchPackIndexTerms(corpus.packs, terms)) {
    const key = docKey(candidate.packId, candidate.entryId);
    const doc = corpus.docs.get(key);
    const citation: RuleCitation = {
      kind: "compendium",
      packId: candidate.packId,
      packLabel: candidate.packLabel,
      entryName: candidate.entryName,
      docId: candidate.entryId,
    };
    if (doc) {
      const text = extractPackDocText(doc);
      const { score, matchedTerms } = scorePassage(terms, candidate.entryName, text);
      if (score <= 0) continue;
      hits.push({
        citation,
        text,
        snippet: snippetFor(text, terms),
        score,
        matchedTerms,
      });
    } else {
      // Name only — the book has an entry by this name, but its text
      // was never read, so this hit can only ever be a closest match.
      const { score, matchedTerms } = scorePassage(terms, candidate.entryName, "");
      if (score <= 0) continue;
      const reason =
        corpus.unread?.get(key) ?? "full text was not read in this lookup";
      hits.push({
        citation,
        text: "",
        snippet: "",
        score,
        matchedTerms,
        textUnread: true,
        unreadReason: reason,
      });
    }
  }
  hits.push(...searchJournalCorpus(corpus.journals, terms));
  const ranked = rankRuleHits(hits);

  const readable = ranked.filter((h) => !h.textUnread && h.text !== "");
  const best = readable[0];
  if (best && best.score >= FOUND_MIN_SCORE) {
    const cited = readable
      .filter((h) => h.score >= FOUND_MIN_SCORE)
      .slice(0, MAX_CITATIONS);
    const answerLines = [
      best.snippet,
      "",
      `Source: ${formatCitation(best.citation)}`,
    ];
    if (cited.length > 1) {
      answerLines.push(
        `Also: ${cited
          .slice(1)
          .map((h) => formatCitation(h.citation))
          .join("; ")}`,
      );
    }
    return {
      question,
      terms,
      found: true,
      answer: answerLines.join("\n"),
      citations: cited.map((h) => h.citation),
      hits: ranked,
      closest: [],
      searched,
    };
  }

  // Not found — say so plainly, with the closest matches by name.
  const closest = ranked.slice(0, 3);
  const closestLines = closest.map((h) => {
    const unread = h.textUnread
      ? ` (entry exists but its text was not read: ${h.unreadReason ?? "unknown reason"})`
      : "";
    return `- ${formatCitation(h.citation)}${unread}`;
  });
  const answerLines = [
    `Not found in the installed books: no passage in ${searched.packs.length > 0 ? searched.packs.join(", ") : "any installed pack"}${searched.journals.length > 0 ? ` or in the journals (${searched.journals.join(", ")})` : " or in any journal"} answers "${question}".`,
  ];
  if (closestLines.length > 0) {
    answerLines.push("", "Closest matches by name:", ...closestLines);
  } else {
    answerLines.push("", "Nothing by a similar name exists in the installed books either.");
  }
  return {
    question,
    terms,
    found: false,
    answer: answerLines.join("\n"),
    citations: [],
    hits: ranked,
    closest,
    searched,
  };
}

// ---------------------------------------------------------------- demo corpus

/**
 * Demo fixture corpus for the offline `--demo` and the tests. The pack
 * labels say FIXTURE: this is illustrative text, not book data. Live
 * lookups cite the real installed packs, never this fixture.
 */
export function demoRulesCorpus(): RulesCorpus {
  const packs: PackInfo[] = [
    {
      id: "demo.conditions",
      label: "Demo Conditions Pack (fixture — not a real book)",
      type: "Item",
      system: "pf2e",
      index: [
        { _id: "flat-footed", name: "Flat-Footed", type: "condition" },
        { _id: "frightened", name: "Frightened", type: "condition" },
        { _id: "grabbed", name: "Grabbed", type: "condition" },
      ],
    },
    {
      id: "demo.actions",
      label: "Demo Actions Pack (fixture — not a real book)",
      type: "Item",
      system: "pf2e",
      index: [
        { _id: "reload", name: "Reload", type: "action" },
        { _id: "strike", name: "Strike", type: "action" },
        { _id: "stride", name: "Stride", type: "action" },
      ],
    },
  ];
  const docs = new Map<string, Record<string, unknown>>([
    [
      "demo.conditions:flat-footed",
      {
        _id: "flat-footed",
        name: "Flat-Footed",
        type: "condition",
        system: {
          description: {
            value:
              "<p>While flat-footed, you take a –2 circumstance penalty to AC. You are flat-footed while you are unable to move or you are unaware of an attack.</p>",
          },
        },
      },
    ],
    [
      "demo.conditions:frightened",
      {
        _id: "frightened",
        name: "Frightened",
        type: "condition",
        system: {
          description: {
            value:
              "<p>You take a status penalty equal to the condition value to all checks and DCs.</p>",
          },
        },
      },
    ],
    [
      "demo.actions:reload",
      {
        _id: "reload",
        name: "Reload",
        type: "action",
        system: {
          description: {
            value:
              "<p>Reloading a ranged weapon takes 1 action. Some weapons, like a crossbow, take 2 actions to reload unless you have a feat that changes it.</p>",
          },
        },
      },
    ],
    [
      "demo.actions:strike",
      {
        _id: "strike",
        name: "Strike",
        type: "action",
        system: {
          description: {
            value:
              "<p>You attack with a weapon you are wielding. A Strike costs 1 action and uses your attack bonus against the target's AC.</p>",
          },
        },
      },
    ],
  ]);
  const journals: JournalDoc[] = [
    {
      _id: "house-rules",
      name: "House Rules",
      pages: [
        {
          _id: "house-reload",
          name: "Reloading in our game",
          text: {
            content:
              "<p>House rule: reloading a crossbow still takes 2 actions, but a character with Rapid Reload does it in 1. Dave's call, session 3.</p>",
          },
        },
      ],
    },
    {
      _id: "session-notes",
      name: "Session Notes",
      pages: [
        {
          _id: "notes-flat",
          name: "Why Merisiel went down",
          text: {
            content:
              "<p>Merisiel was flat-footed against the Xulgath because she had not acted yet in the encounter.</p>",
          },
        },
      ],
    },
  ];
  return { packs, docs, journals };
}

/** Offline demo lookup over the fixture corpus — no connection. */
export function demoLookup(question: string): RuleAnswer {
  return lookupInCorpus(question, demoRulesCorpus());
}

// ---------------------------------------------------------------- live layer

interface RawClient {
  getJournals(): JournalDoc[];
}

/**
 * Read the world's journals over the raw client (same shape questlog /
 * chronicle read). Journals are in the world payload, so this is a
 * cache read, not a round trip.
 */
export function getWorldJournals(live: FoundryLive): JournalDoc[] {
  const raw = live.raw() as unknown as RawClient;
  return raw.getJournals() ?? [];
}

export interface LookupRuleLiveOptions {
  /** Max index hits per term. Default 20. */
  limit?: number;
  /** How many top index candidates get their full document read. Default 5. */
  fetchDocs?: number;
}

/**
 * Live rule lookup. Packs come from the `world` payload (no round
 * trip); full pack documents are read over the socket with
 * `getPackDocument` — NEEDS LIVE CONFIRMATION on 14.370, so a failed
 * read is recorded as an unread hit with its error, never retried
 * silently and never guessed at. Journals are read from the world
 * cache. Returns the same `RuleAnswer` shape as the pure lookup.
 */
export async function lookupRuleLive(
  live: FoundryLive,
  question: string,
  opts: LookupRuleLiveOptions = {},
): Promise<RuleAnswer> {
  const terms = tokenizeQuestion(question);
  const packs = getWorldPacks(live);
  const candidates = searchPackIndexTerms(packs, terms, { limit: opts.limit ?? 20 });
  const docs = new Map<string, Record<string, unknown>>();
  const unread = new Map<string, string>();
  const toFetch = candidates.slice(0, opts.fetchDocs ?? 5);
  for (const candidate of toFetch) {
    const key = docKey(candidate.packId, candidate.entryId);
    try {
      const doc = await getPackDocument(
        live,
        candidate.packType,
        candidate.packId,
        candidate.entryId,
      );
      docs.set(key, doc);
    } catch (err) {
      unread.set(
        key,
        `could not be read live: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const candidate of candidates.slice(toFetch.length)) {
    unread.set(
      docKey(candidate.packId, candidate.entryId),
      "full text was not read in this lookup (outside the top candidates)",
    );
  }
  const journals = getWorldJournals(live);
  return lookupInCorpus(question, { packs, docs, journals, unread });
}
