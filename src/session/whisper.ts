/**
 * GM-whisper handling (BRA-185, FR-18 gap) — the pure half.
 *
 * The monitor treats a GM whisper to Meroki as an instruction, not as
 * table chatter. This module answers the two pure questions:
 * - Is this message a whisper from the GM addressed to us?
 *   (`isGmWhisper` — author is the GM user, our user id is in the
 *   message's `whisper` recipient list. Foundry only shows a whisper
 *   to its recipients, so a whisper we can see that names us is one
 *   meant for us.)
 * - What does the whisper ask for? (`classifyWhisper` — an embedded
 *   cutscene script, a named sequence, or something else entirely.)
 *
 * What the monitor can do from a whisper, and what it cannot:
 * - Embedded script: the whisper carries a cutscene script as JSON
 *   (fenced ```json or bare). The live handler validates it with the
 *   cutscene engine and plays it. This is the main path — the GM's
 *   own Muse authors the script, the monitor executes it.
 * - Named sequence: the whisper names (or describes) a sequence that
 *   already exists as a file in examples/ — the two demo scripts,
 *   "Mice and the Ogre" and "The Tentacle Twist". The live handler
 *   loads it, validates it, and plays it. This is a convenience for
 *   the sequences the table already has, not a canned response: the
 *   ack names the sequence, so a misread is visible to the GM.
 * - Anything else (a build request, a question): the live handler
 *   routes it through the monitor's existing build/question paths,
 *   with replies whispered back to the GM. A roll request is out of
 *   scope for the whisper channel — rolls live in public chat.
 * - Prose that describes a sequence the monitor has no script for:
 *   it cannot author a script (it is code, not Muse), so the handler
 *   replies asking for the script JSON or a sequence name. Never
 *   invents a sequence, never plays a guess.
 *
 * No Foundry imports here: `loadNamedSequence` reads from the
 * filesystem only, so plain `bun test` covers this module.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../types.js";

/**
 * True when the message is a whisper from the GM addressed to us.
 * All three ids must be known; a whisper to anyone else (or a public
 * message, which carries no `whisper` list) is not ours to act on.
 */
export function isGmWhisper(
  msg: ChatMessage,
  ownUserId: string | null,
  gmUserId: string | null,
): boolean {
  if (!ownUserId || !gmUserId) return false;
  if (msg.author !== gmUserId) return false;
  return (msg.whisper ?? []).includes(ownUserId);
}

/**
 * Pull a balanced JSON object out of free text: a fenced ```json block
 * first, otherwise the first `{...}` in the text. Brace matching is
 * string-aware, so braces inside quoted strings don't fool it.
 * Returns the raw JSON text and whether it came from a fence, or null
 * when no object exists. A fenced block that starts with `{` but never
 * closes is still returned (unbalanced) — the author clearly pasted a
 * script, so the caller should report the parse error rather than
 * answering "I don't understand". A bare `{door}` in prose is NOT a
 * script attempt; the classifier checks the shape before claiming it.
 */
export function extractScriptJson(text: string): { jsonText: string; fenced: boolean } | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) {
    const inner = balancedObject(fence[1]);
    if (inner) return { jsonText: inner, fenced: true };
    const trimmed = fence[1].trim();
    if (trimmed.startsWith("{")) return { jsonText: trimmed, fenced: true };
    return null;
  }
  const bare = balancedObject(text);
  return bare ? { jsonText: bare, fenced: false } : null;
}

function balancedObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // unbalanced — an unfinished paste, not a script
}

/** Sequences the table already has as files in examples/. */
export type NamedSequenceKey = "mice-ogre" | "tentacle-twist";

interface NamedSequence {
  key: NamedSequenceKey;
  file: string;
  title: string;
  /** Exact names, matched as whole phrases ("run the mice and the ogre"). */
  aliases: string[];
  /**
   * Descriptive keyword sets: every word in a set must appear.
   * A whisper that only describes the sequence ("mice rush in biting,
   * then the ogre") matches here. Less certain than an alias — the
   * handler's ack names the sequence so the GM can correct a misread.
   */
  keywords: string[][];
}

export const NAMED_SEQUENCES: NamedSequence[] = [
  {
    key: "mice-ogre",
    file: "mice-ogre.json",
    title: "Mice and the Ogre",
    aliases: ["mice-ogre", "mice and the ogre", "the mice and the ogre", "mice ogre"],
    keywords: [
      ["mice", "ogre"],
      ["mice", "rush"],
    ],
  },
  {
    key: "tentacle-twist",
    file: "tentacle-twist.json",
    title: "The Tentacle Twist",
    aliases: ["tentacle-twist", "tentacle twist", "the tentacle twist", "the tentacle"],
    keywords: [
      ["tentacle", "ogre"],
      ["tentacle", "emerge"],
      ["tentacle", "twist"],
      ["tentacle", "boss"],
      ["tentacle", "horror"],
    ],
  },
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match a whisper against the named sequences. Exact aliases win over
 * descriptive keywords; among keywords, the tentacle sets are checked
 * first ("tentacle" is the rarer word, so a whisper mentioning both
 * the mice and the tentacle is most likely the twist). First match
 * wins — the ack names the sequence, so a wrong guess is correctable.
 */
export function matchNamedSequence(text: string): NamedSequenceKey | null {
  const n = ` ${normalize(text)} `;
  for (const seq of NAMED_SEQUENCES) {
    for (const alias of seq.aliases) {
      if (n.includes(` ${normalize(alias)} `)) return seq.key;
    }
  }
  const words = new Set(n.split(" "));
  for (const seq of [...NAMED_SEQUENCES].reverse()) {
    for (const combo of seq.keywords) {
      if (combo.every((w) => words.has(w))) return seq.key;
    }
  }
  return null;
}

/** What a GM whisper asks the monitor to do. */
export type WhisperClass =
  | { kind: "script"; script: unknown }
  | { kind: "script-invalid"; error: string }
  | { kind: "named"; key: NamedSequenceKey }
  | { kind: "other" };

/** A parsed object counts as a cutscene script when it carries the shape. */
function looksLikeScript(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const rec = parsed as Record<string, unknown>;
  return Array.isArray(rec.steps) || typeof rec.version !== "undefined";
}

/**
 * Route a whisper's text. An embedded JSON block is a script (or a
 * broken one — reported as script-invalid so the handler can tell the
 * GM what failed to parse instead of answering "I don't understand").
 * A fenced block is always a script attempt; a bare `{...}` only counts
 * when it looks like a script, so `{door}` in a build request falls
 * through to the build path instead of hijacking it. Otherwise a
 * named/described sequence, otherwise "other" — the caller falls back
 * to the build/question/clarify routing.
 */
export function classifyWhisper(text: string): WhisperClass {
  const found = extractScriptJson(text);
  if (found !== null) {
    try {
      const parsed: unknown = JSON.parse(found.jsonText);
      if (found.fenced || looksLikeScript(parsed)) {
        return { kind: "script", script: parsed };
      }
      // Bare object that isn't script-shaped (e.g. "{door}" in prose):
      // not a script — fall through to the named check below.
    } catch (err) {
      // Fenced: the author clearly pasted a script — report the error.
      // Bare: only report when the block smells like a script.
      if (found.fenced || /"(version|steps|kind|name)"\s*:/.test(found.jsonText)) {
        return {
          kind: "script-invalid",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // Bare braces that aren't JSON and don't smell like a script: prose.
    }
  }
  const named = matchNamedSequence(text);
  if (named) return { kind: "named", key: named };
  return { kind: "other" };
}

/**
 * Load a named sequence's script JSON from examples/. Returns the
 * parsed JSON (unvalidated — the handler validates with the cutscene
 * engine before anything plays). Throws with a plain message when
 * the file is missing or unparseable.
 */
export function loadNamedSequence(key: NamedSequenceKey): unknown {
  const seq = NAMED_SEQUENCES.find((s) => s.key === key);
  if (!seq) throw new Error(`Unknown named sequence ${JSON.stringify(key)}.`);
  const path = join(import.meta.dir, "..", "..", "examples", seq.file);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`Named sequence "${seq.title}" is missing its file (examples/${seq.file}).`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Named sequence "${seq.title}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
