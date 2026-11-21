/**
 * Treasure art step (FR-14 / BRA-200) — fills each signature item's `art`
 * from its ready `artPrompt`.
 *
 * The work splits in two on purpose, and this module is only the second
 * half's wiring:
 * - GENERATION runs through the agent media step — the same path the repo
 *   already uses for other images (the vision-doc illustrations, the
 *   tile AI sources in tiles/ai-source/): `planTreasureArt` lists, per
 *   signature item, the prompt and the output path, and the media step
 *   saves one square image per item to its output path. There is no
 *   programmatic image API in this repo, so this module does not pretend
 *   to generate images itself.
 * - WIRING runs offline, here: `applyTreasureArt` looks for the expected
 *   file per signature item and writes its path into `art` when it
 *   exists; when it does not exist yet, `art` stays null and the report
 *   says "missing-file" — the media step has not run yet.
 *
 * HONESTY: an item without an `artPrompt` is skipped, `art` stays empty,
 * and the report says so. A prompt is never invented for an item that
 * does not carry one.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TreasureHoard, TreasureItem } from "./treasure.js";

/**
 * Deterministic output filename for one signature item's art, so a
 * re-run converges on the same file instead of minting duplicates.
 */
export function treasureArtFileName(item: TreasureItem): string {
  const slug = item.name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `treasure-art-${slug || "item"}.png`;
}

/** What the art step will do (or did) with one signature item. */
export type TreasureArtStatus =
  | "ready"
  | "has-art"
  | "skipped-no-prompt";

/** One entry in the art plan: prompt + output path for the media step. */
export interface TreasureArtPlanEntry {
  name: string;
  status: TreasureArtStatus;
  /** The prompt to generate from — present only when the item has one. */
  artPrompt?: string;
  /** Where the square image goes (artDir + treasureArtFileName). */
  outputPath: string;
  /** Why this item is skipped (skipped-no-prompt only). */
  reason?: string;
}

/** The art plan for a hoard: one entry per signature item. */
export interface TreasureArtPlan {
  artDir: string;
  entries: TreasureArtPlanEntry[];
}

/**
 * Build the art plan for a hoard. Pure — no disk, no network. Items
 * with art already set are "has-art"; items without an artPrompt are
 * "skipped-no-prompt" and carry no prompt (none is invented); the rest
 * are "ready" with the prompt the generator already prepared.
 */
export function planTreasureArt(
  hoard: TreasureHoard,
  artDir: string,
): TreasureArtPlan {
  return {
    artDir,
    entries: hoard.signatureItems.map((item) => {
      const outputPath = join(artDir, treasureArtFileName(item));
      if (item.art) {
        return {
          name: item.name,
          status: "has-art" as const,
          artPrompt: item.artPrompt,
          outputPath,
        };
      }
      if (!item.artPrompt) {
        return {
          name: item.name,
          status: "skipped-no-prompt" as const,
          outputPath,
          reason: "no artPrompt — art stays empty; no prompt was invented",
        };
      }
      return {
        name: item.name,
        status: "ready" as const,
        artPrompt: item.artPrompt,
        outputPath,
      };
    }),
  };
}

/** One line of the art plan, for the CLI / chat. */
export function formatTreasureArtPlan(plan: TreasureArtPlan): string {
  const lines = plan.entries.map((e) => {
    switch (e.status) {
      case "ready":
        return `  • ${e.name}: ready — generate a square image from: "${e.artPrompt}" → save to ${e.outputPath}`;
      case "has-art":
        return `  • ${e.name}: art already set`;
      case "skipped-no-prompt":
        return `  • ${e.name}: skipped — ${e.reason}`;
    }
  });
  return ["🎨 Treasure art plan:", ...lines].join("\n");
}

/** Outcome of applying art to one signature item. */
export interface TreasureArtReportEntry {
  name: string;
  status: "filled" | "already-set" | "missing-file" | "skipped-no-prompt";
  /** The art value after this run (path, or null when still empty). */
  art: string | null;
  reason?: string;
}

/** Result of applyTreasureArt: the updated hoard plus the per-item report. */
export interface TreasureArtResult {
  hoard: TreasureHoard;
  report: TreasureArtReportEntry[];
}

/**
 * Wire already-generated art files into a hoard. For each signature item
 * with a ready artPrompt and no art yet: if the expected file exists in
 * artDir, set `art` to its path; otherwise leave art null and report
 * "missing-file". Items with art already set are untouched; items
 * without an artPrompt are skipped with the reason stated. Returns a
 * new hoard — the input is not mutated. The `exists` check is
 * injectable so tests run without touching disk.
 */
export function applyTreasureArt(
  hoard: TreasureHoard,
  artDir: string,
  exists: (path: string) => boolean = existsSync,
): TreasureArtResult {
  const report: TreasureArtReportEntry[] = [];
  const updated = hoard.signatureItems.map((item) => {
    if (item.art) {
      report.push({ name: item.name, status: "already-set", art: item.art });
      return item;
    }
    if (!item.artPrompt) {
      report.push({
        name: item.name,
        status: "skipped-no-prompt",
        art: null,
        reason: "no artPrompt — art stays empty; no prompt was invented",
      });
      return item;
    }
    const path = join(artDir, treasureArtFileName(item));
    if (exists(path)) {
      report.push({ name: item.name, status: "filled", art: path });
      return { ...item, art: path };
    }
    report.push({
      name: item.name,
      status: "missing-file",
      art: null,
      reason: `no art file at ${path} yet — run the media step with the item's artPrompt`,
    });
    return item;
  });
  // Signature items appear in both hoard.items and hoard.signatureItems
  // (same objects); update both lists so they stay in agreement.
  const byName = new Map(updated.map((it) => [it.name, it]));
  const items = hoard.items.map((it) =>
    it.kind === "signature" ? (byName.get(it.name) ?? it) : it,
  );
  return { hoard: { ...hoard, items, signatureItems: updated }, report };
}

/** One line per item of the apply result, for the CLI / chat. */
export function formatTreasureArtReport(result: TreasureArtResult): string {
  const lines = result.report.map((r) => {
    switch (r.status) {
      case "filled":
        return `  • ${r.name}: art → ${r.art}`;
      case "already-set":
        return `  • ${r.name}: art already set (${r.art})`;
      case "missing-file":
        return `  • ${r.name}: no art yet — ${r.reason}`;
      case "skipped-no-prompt":
        return `  • ${r.name}: skipped — ${r.reason}`;
    }
  });
  return ["🎨 Treasure art:", ...lines].join("\n");
}
