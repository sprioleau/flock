import { globalStylesSchema } from "@tandem/email-sdk";
import { ConvexError, v, type Infer } from "convex/values";
import {
  getBrandKitValidationErrors,
  type BrandKit,
} from "../apps/web/src/lib/brand-kit";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import {
  collectRowStorageIds,
  getEffectiveRevision,
  planAssetConfirmationPatch,
  planAssetRemovalPatch,
  planBrandKitSavePatch,
} from "./model/brandKitAssets";

/**
 * Brand kit persistence (brand kit panel): ONE active kit per anonymous
 * session in v1. Stage S of the brand-kit architecture proposal
 * (docs/proposals/brand-kit-architecture.md): the kit is a STABLE row —
 * `saveBrandKit` patches in place (never delete+reinsert, which churned
 * `_id` and would dangle the Stage M canvas binding) and bumps a monotonic
 * `revision`. `getActiveBrandKit` is the reactive read every open canvas/tab
 * subscribes to (via useActiveBrandKit), which is what makes "every canvas
 * uses the same kit" true live.
 *
 * Confirmable assets (§8): the extraction pipeline leaves logo/social-card
 * SUGGESTIONS (third-party URLs / inline-SVG data URIs) on the row; the
 * confirm-asset route uploads the binary to Convex storage and `confirmAsset`
 * swaps the row's URL to the durable serving URL. Owner decision 4:
 * unconfirmed suggestions render in kit UI only — nothing downstream may
 * write them into documents. Storage lifecycle (§8.2): replacing or clearing
 * a confirmed asset deletes its storage file (kit files are invisible to the
 * document GC in convex/model/cleanup.ts).
 *
 * Validation policy: the wire shape is Convex-validated below, and the
 * `globals` payloads are runtime-guarded BEFORE any write by (1) the
 * email-sdk `globalStylesSchema` (strict Zod — unknown keys/bad value types
 * rejected) and (2) the shared brand-kit contract checker
 * (`getBrandKitValidationErrors` from apps/web/src/lib/brand-kit.ts — the
 * single source of the completeness + WCAG ≥ 4.5:1 contrast rules). A kit
 * failing any guarded contrast pairing is NEVER stored.
 *
 * NOTE: the Phase 6.1 cleanup cron (convex/cleanup.ts) reaps stale DOCUMENTS
 * only; brandKits rows are session-keyed and NOT reaped yet (they're tiny).
 * See the table comment in schema.ts.
 */

/** Save-args wire shape — mirrors the frontend scrape/save `BrandKit` shape. */
export const brandKitValidator = v.object({
  name: v.string(),
  sourceUrl: v.optional(v.string()),
  fonts: v.object({ heading: v.string(), body: v.string() }),
  logoUrl: v.optional(v.string()),
  socialImageUrl: v.optional(v.string()),
  variations: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      /** Must be a COMPLETE Required<GlobalStyles> payload — guarded below. */
      globals: v.record(v.string(), v.any()),
    }),
  ),
});

/**
 * Read wire shape: the save shape plus the server-managed Stage S fields the
 * UI needs — `revision` (provenance / Stage M comparisons) and the
 * confirmedAtMs timestamps (Suggested vs Saved chips; the decision-4
 * confirmed-only gate reads them via getConfirmedBrandAssetUrl).
 */
const activeBrandKitValidator = v.object({
  name: v.string(),
  sourceUrl: v.optional(v.string()),
  fonts: v.object({ heading: v.string(), body: v.string() }),
  logoUrl: v.optional(v.string()),
  socialImageUrl: v.optional(v.string()),
  revision: v.number(),
  logoConfirmedAtMs: v.optional(v.number()),
  socialImageConfirmedAtMs: v.optional(v.number()),
  variations: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      globals: v.record(v.string(), v.any()),
    }),
  ),
});

const assetKindValidator = v.union(v.literal("logo"), v.literal("socialCard"));

type BrandKitInput = Infer<typeof brandKitValidator>;

/**
 * The server-side gate every save goes through. Throws a ConvexError with a
 * clear, user-displayable message when the kit violates the contract; the
 * ConvexError `data` survives to the client (a plain Error's message would
 * be redacted in prod).
 */
function assertBrandKitIsValid(brandKit: BrandKitInput): void {
  // 1. Strict Zod pass per variation: rejects unknown globals keys and wrong
  //    value types (the v.any() in the table validator is intentional; THIS
  //    is its runtime guard, same policy as ops/blocks).
  for (const variation of brandKit.variations) {
    const parsed = globalStylesSchema.safeParse(variation.globals);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new ConvexError(
        `Brand kit rejected — variation "${variation.id}" has invalid globals: ${details}`,
      );
    }
  }
  // 2. The shared contract checker: completeness (applyTheme replaces globals
  //    wholesale) and WCAG-AA contrast (≥ 4.5:1) on every guarded pairing.
  const errors = getBrandKitValidationErrors(brandKit as BrandKit);
  if (errors.length > 0) {
    throw new ConvexError(`Brand kit rejected: ${errors.join(" ")}`);
  }
}

/** All kit rows for a session (invariant: 0 or 1; defensive against dupes). */
async function loadSessionBrandKitRows(ctx: MutationCtx, sessionId: string) {
  return ctx.db
    .query("brandKits")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
}

/** The session's kit row, or a friendly ConvexError when none exists. */
async function requireSessionBrandKitRow(
  ctx: MutationCtx,
  sessionId: string,
): Promise<Doc<"brandKits">> {
  const rows = await loadSessionBrandKitRows(ctx, sessionId);
  if (rows.length === 0) {
    throw new ConvexError("No saved brand kit found — save a kit first.");
  }
  return rows[0];
}

/** Delete kit-owned storage files (best effort; ids may already be gone). */
async function deleteStorageFiles(ctx: MutationCtx, storageIds: string[]): Promise<void> {
  for (const storageId of storageIds) {
    await ctx.storage.delete(storageId as Id<"_storage">).catch(() => undefined);
  }
}

/**
 * The session's active brand kit, or null (frontend falls back to
 * MOCK_BRAND_KIT). Reactive: saving/clearing a kit updates every subscribed
 * tab of the session live.
 */
export const getActiveBrandKit = query({
  args: { sessionId: v.string() },
  returns: v.union(v.null(), activeBrandKitValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("brandKits")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .first();
    if (row === null) {
      return null;
    }
    return {
      name: row.name,
      ...(row.sourceUrl !== undefined ? { sourceUrl: row.sourceUrl } : {}),
      fonts: row.fonts,
      ...(row.logoUrl !== undefined ? { logoUrl: row.logoUrl } : {}),
      ...(row.socialImageUrl !== undefined ? { socialImageUrl: row.socialImageUrl } : {}),
      revision: getEffectiveRevision(row),
      ...(row.logoConfirmedAtMs !== undefined ? { logoConfirmedAtMs: row.logoConfirmedAtMs } : {}),
      ...(row.socialImageConfirmedAtMs !== undefined
        ? { socialImageConfirmedAtMs: row.socialImageConfirmedAtMs }
        : {}),
      variations: row.variations,
    };
  },
});

/**
 * Save the session's active brand kit — PATCH-IN-PLACE (Stage S): the row's
 * `_id` is stable across saves and `revision` bumps monotonically, which is
 * what the Stage M canvas binding will point at. Inserts only when the
 * session has no row yet. Asset confirmations survive a save only when the
 * incoming URL is unchanged; a new suggestion clears the confirmation and
 * deletes the orphaned storage file (§8.2). Rejects (ConvexError) without
 * writing when the kit fails the contract — see assertBrandKitIsValid.
 */
export const saveBrandKit = mutation({
  args: {
    sessionId: v.string(),
    brandKit: brandKitValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertBrandKitIsValid(args.brandKit);
    const now = Date.now();
    const existingRows = await loadSessionBrandKitRows(ctx, args.sessionId);
    if (existingRows.length === 0) {
      await ctx.db.insert("brandKits", {
        sessionId: args.sessionId,
        ...args.brandKit,
        revision: 1,
        createdAtMs: now,
        updatedAtMs: now,
      });
      return null;
    }
    // Defensive: the invariant is one row per session — fold any dupes away
    // (surrendering their storage files) and patch the primary in place.
    const [primaryRow, ...duplicateRows] = existingRows;
    for (const duplicate of duplicateRows) {
      await deleteStorageFiles(ctx, collectRowStorageIds(duplicate));
      await ctx.db.delete(duplicate._id);
    }
    const { patch, storageIdsToDelete } = planBrandKitSavePatch({
      existing: primaryRow,
      incomingLogoUrl: args.brandKit.logoUrl,
      incomingSocialImageUrl: args.brandKit.socialImageUrl,
    });
    await ctx.db.patch(primaryRow._id, {
      name: args.brandKit.name,
      sourceUrl: args.brandKit.sourceUrl,
      fonts: args.brandKit.fonts,
      variations: args.brandKit.variations,
      updatedAtMs: now,
      ...patch,
    });
    await deleteStorageFiles(ctx, storageIdsToDelete);
    return null;
  },
});

/**
 * Rename the session's kit — the extracted company name is only a suggestion
 * (proposal §8.1); the user's edit wins and persists here. Name-only changes
 * deliberately do NOT bump `revision` (risk 6: revision means meaningful
 * diffs, so Stage M staleness pills never re-arm over a rename).
 */
export const renameBrandKit = mutation({
  args: { sessionId: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const trimmedName = args.name.trim();
    if (trimmedName.length === 0) {
      throw new ConvexError("The brand kit name can't be empty.");
    }
    const row = await requireSessionBrandKitRow(ctx, args.sessionId);
    await ctx.db.patch(row._id, { name: trimmedName, updatedAtMs: Date.now() });
    return null;
  },
});

/**
 * Confirm an extracted asset. Called by the confirm-asset route AFTER it has
 * pulled the binary through the SSRF rails and uploaded it to storage: swaps
 * the row's asset URL to the durable serving URL, records provenance + the
 * confirmation timestamp, bumps revision (asset swaps are meaningful diffs —
 * Stage M re-sources logos from them), and deletes any previously confirmed
 * file for the kind. `expectedSourceUrl` must still match the row's CURRENT
 * asset URL so a concurrent re-scrape can't have a stale binary confirmed
 * over it (the orphaned upload is deleted on that rejection).
 */
export const confirmAsset = mutation({
  args: {
    sessionId: v.string(),
    kind: assetKindValidator,
    storageId: v.id("_storage"),
    expectedSourceUrl: v.string(),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    const row = await requireSessionBrandKitRow(ctx, args.sessionId);
    const currentUrl = args.kind === "logo" ? row.logoUrl : row.socialImageUrl;
    if (currentUrl !== args.expectedSourceUrl) {
      await ctx.storage.delete(args.storageId).catch(() => undefined);
      throw new ConvexError(
        "That suggestion changed while we were saving it — please try confirming again.",
      );
    }
    const servingUrl = await ctx.storage.getUrl(args.storageId);
    if (servingUrl === null) {
      throw new ConvexError("The uploaded file has no serving URL — please try again.");
    }
    const { patch, storageIdsToDelete } = planAssetConfirmationPatch({
      existing: row,
      kind: args.kind,
      storageId: args.storageId,
      servingUrl,
      sourceUrl: args.expectedSourceUrl,
      nowMs: Date.now(),
    });
    await ctx.db.patch(row._id, { ...patch, updatedAtMs: Date.now() });
    await deleteStorageFiles(ctx, storageIdsToDelete);
    return { url: servingUrl };
  },
});

/**
 * Remove one asset (suggestion or confirmed) from the session's kit — the
 * panel's [Remove] affordance. Deletes the confirmed storage file if any.
 */
export const removeBrandKitAsset = mutation({
  args: { sessionId: v.string(), kind: assetKindValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await requireSessionBrandKitRow(ctx, args.sessionId);
    const { patch, storageIdsToDelete } = planAssetRemovalPatch({ existing: row, kind: args.kind });
    await ctx.db.patch(row._id, { ...patch, updatedAtMs: Date.now() });
    await deleteStorageFiles(ctx, storageIdsToDelete);
    return null;
  },
});

/**
 * Delete the session's saved kit — every tab falls back to the mock kit
 * live. Deletes kit-owned storage files first (§8.2: kit files are invisible
 * to the document GC).
 */
export const clearBrandKit = mutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingRows = await loadSessionBrandKitRows(ctx, args.sessionId);
    for (const row of existingRows) {
      await deleteStorageFiles(ctx, collectRowStorageIds(row));
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
