import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Content Studio Stage S — shared (non-registered) helpers for the assets
 * registry (docs/proposals/content-studio.md §4). The registry is the system
 * of record for storage-file ownership; every upload path calls
 * assets.register at the moment it resolves a serving URL.
 */

/** Provenance kinds (the library's filter axis). Widens later ("scraped"). */
export const assetKindValidator = v.union(
  v.literal("uploaded"),
  v.literal("generated"),
  v.literal("logo"),
  v.literal("social-card"),
);

export type AssetKind = Doc<"assets">["kind"];

/**
 * Bound on one session's library listing. Registration is per human gesture
 * (upload / generate / confirm), so demo-scale sessions sit far below this;
 * over the bound the NEWEST rows win, which is what the grid shows anyway.
 */
export const MAX_ASSETS_LISTED_PER_SESSION = 100;

/** Cap a generated-image name at a word boundary so cards stay readable. */
const MAX_SEEDED_NAME_LENGTH = 60;

const DEFAULT_NAME_BY_KIND: Record<AssetKind, string> = {
  uploaded: "Uploaded image",
  generated: "Generated image",
  logo: "Logo",
  "social-card": "Social card",
};

/**
 * The display name a new asset row is seeded with when the caller didn't
 * provide one: the trimmed caller name (filename / kit name) when present,
 * else the prompt stem for generated images, else a per-kind label. Pure —
 * unit-tested directly.
 */
export function seedAssetName(args: {
  kind: AssetKind;
  name?: string | undefined;
  prompt?: string | undefined;
}): string {
  const { kind, name, prompt } = args;
  const trimmedName = name?.trim() ?? "";
  if (trimmedName.length > 0) {
    return truncateAtWordBoundary(trimmedName);
  }
  const collapsedPrompt = prompt?.replace(/\s+/g, " ").trim() ?? "";
  if (kind === "generated" && collapsedPrompt.length > 0) {
    return truncateAtWordBoundary(collapsedPrompt);
  }
  return DEFAULT_NAME_BY_KIND[kind];
}

function truncateAtWordBoundary(text: string): string {
  if (text.length <= MAX_SEEDED_NAME_LENGTH) {
    return text;
  }
  const truncated = text.slice(0, MAX_SEEDED_NAME_LENGTH);
  const lastSpaceIndex = truncated.lastIndexOf(" ");
  const stem = lastSpaceIndex > 0 ? truncated.slice(0, lastSpaceIndex) : truncated;
  return `${stem.trimEnd()}…`;
}

/**
 * Whether a serving URL belongs to a registered asset — the cleanup cascade's
 * retain check (proposal §6.1): registered files are owned by the library,
 * not by documents, so the document-deletion cascade must never delete them.
 * One indexed point lookup per candidate URL.
 */
export async function isUrlRegisteredAsset(
  ctx: QueryCtx | MutationCtx,
  url: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("assets")
    .withIndex("by_url", (q) => q.eq("url", url))
    .first();
  return row !== null;
}
