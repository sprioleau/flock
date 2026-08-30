import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/*
  Content Studio Stage S — shared (non-registered) helpers for the assets
  registry (docs/proposals/content-studio.md §4). The registry is the system
  of record for storage-file ownership; every upload path calls
  assets.register at the moment it resolves a serving URL.
*/

/*
  Provenance kinds (the library's filter axis). Widens later ("scraped").
*/
export const assetKindValidator = v.union(
  v.literal("uploaded"),
  v.literal("generated"),
  v.literal("logo"),
  v.literal("social-card"),
);

export type AssetKind = Doc<"assets">["kind"];

/*
  Bound on one session's library listing. Registration is per human gesture
  (upload / generate / confirm), so demo-scale sessions sit far below this;
  over the bound the NEWEST rows win, which is what the grid shows anyway.
*/
export const MAX_ASSETS_LISTED_PER_SESSION = 100;

/*
  Cap a generated-image name at a word boundary so cards stay readable.
*/
const MAX_SEEDED_NAME_LENGTH = 60;

const DEFAULT_NAME_BY_KIND: Record<AssetKind, string> = {
  uploaded: "Uploaded image",
  generated: "Generated image",
  logo: "Logo",
  "social-card": "Social card",
};

/*
  The display name a new asset row is seeded with when the caller didn't
  provide one: the trimmed caller name (filename / kit name) when present,
  else the prompt stem for generated images, else a per-kind label. Pure —
  unit-tested directly.
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

/*
  Whether a serving URL belongs to a registered asset — the cleanup cascade's
  retain check (proposal §6.1): registered files are owned by the library,
  not by documents, so the document-deletion cascade must never delete them.
  One indexed point lookup per candidate URL.
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

/*
  Bound on the whole-table `blocks` read behind the delete-time in-use check
  (Stage M, proposal §6.2). Block `properties` is a v.record, which Convex
  cannot index by nested path, so "which drafts show this image" is a scan —
  the exact same constraint and the exact same number the cleanup cascade
  already lives with (MAX_BLOCK_ROWS_SCANNED in model/cleanup.ts). The scan
  runs at most once per delete CLICK, which is a human gesture, not a loop.

  Over the bound the answer is IN USE, not "not in use": an unanswerable
  reference question must never resolve to "go ahead and delete the file".
  Same retain-on-doubt posture as the cascade, which retains every candidate
  when its own bound is blown.
*/
export const MAX_BLOCK_ROWS_SCANNED_FOR_USAGE = 4000;

/*
  How many of the caller's own referencing drafts the refusal names before it
  falls back to counting. Three names fit one readable sentence; past that the
  list stops being a list and becomes a wall.
*/
export const MAX_USAGE_DRAFT_NAMES = 3;

/*
  Where an asset's URL is still rendered — the input to the delete refusal.
*/
export interface AssetUsage {
  /*
    True when at least one head block row still points at the URL.
  */
  isInUse: boolean;
  /*
    Names of the CALLER'S OWN referencing drafts, capped (see the constant).
  */
  draftNames: string[];
  /*
    Referencing drafts that cannot or should not be named (see below).
  */
  otherDraftCount: number;
}

/*
  Find the drafts whose HEAD blocks still render `url`.

  Two deliberate choices here:

  1. THE SCAN COVERS EVERY DOCUMENT, not just the owner's. Canvases are
     shared by link and forks copy block rows verbatim (`src` strings
     included), so a collaborator's draft can legitimately render an image
     that lives in MY library. Scoping the scan to my own documents would
     make "not in use" a lie and break someone else's draft on my click.
  2. ONLY MY OWN DRAFTS ARE NAMED. A draft belonging to another owner is
     counted, never named — the refusal must not become a way to read
     strangers' draft titles by uploading an image and asking who uses it.

  Head rows only, matching the cascade: a reference living solely in history
  (an op inverse / a version snapshot) is invisible here. That gap is
  inherited and documented, not widened — see the `remove` comment in
  convex/assets.ts.
*/
export async function findAssetUsage(
  ctx: QueryCtx | MutationCtx,
  args: { url: string; ownerId: string },
): Promise<AssetUsage> {
  const blockRows = await ctx.db.query("blocks").take(MAX_BLOCK_ROWS_SCANNED_FOR_USAGE + 1);
  if (blockRows.length > MAX_BLOCK_ROWS_SCANNED_FOR_USAGE) {
    console.warn(
      `assets: blocks table exceeds ${MAX_BLOCK_ROWS_SCANNED_FOR_USAGE} rows; ` +
        "in-use check could not run — treating the asset as in use and refusing the delete.",
    );
    return { isInUse: true, draftNames: [], otherDraftCount: 0 };
  }

  const referencingDocumentIds = new Set<Id<"documents">>();
  for (const row of blockRows) {
    if (row.type === "image" && row.properties.src === args.url) {
      referencingDocumentIds.add(row.documentId);
    }
  }
  if (referencingDocumentIds.size === 0) {
    return { isInUse: false, draftNames: [], otherDraftCount: 0 };
  }

  const draftNames: string[] = [];
  let otherDraftCount = 0;
  for (const documentId of referencingDocumentIds) {
    const document = await ctx.db.get(documentId);
    /*
      A null document means block rows outliving their draft — the cascade
      deletes both together, so that is a torn state, not a normal one. It
      still counts: the honest answer to "is anything pointing at this file"
      is yes, and a delete that cannot be fully reasoned about is declined.
    */
    if (
      document !== null &&
      document.sessionId === args.ownerId &&
      draftNames.length < MAX_USAGE_DRAFT_NAMES
    ) {
      draftNames.push(document.name);
      continue;
    }
    otherDraftCount += 1;
  }
  return { isInUse: true, draftNames, otherDraftCount };
}
