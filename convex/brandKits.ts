import { globalStylesSchema } from "@tandem/email-sdk";
import { ConvexError, v, type Infer } from "convex/values";
import {
  getBrandKitValidationErrors,
  type BrandKit,
} from "../apps/web/src/lib/brand-kit";
import { mutation, query, type MutationCtx } from "./_generated/server";

/**
 * Brand kit persistence (brand kit panel): ONE active kit per anonymous
 * session in v1 — `saveBrandKit` replaces whatever was there, `clearBrandKit`
 * drops back to the frontend mock fallback. `getActiveBrandKit` is the
 * reactive read every open canvas/tab subscribes to (via useActiveBrandKit),
 * which is what makes "every canvas uses the same kit" true live.
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

/** Wire shape of a brand kit — mirrors the frontend `BrandKit` type exactly. */
export const brandKitValidator = v.object({
  name: v.string(),
  sourceUrl: v.optional(v.string()),
  fonts: v.object({ heading: v.string(), body: v.string() }),
  logoUrl: v.optional(v.string()),
  variations: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      /** Must be a COMPLETE Required<GlobalStyles> payload — guarded below. */
      globals: v.record(v.string(), v.any()),
    }),
  ),
});

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

/**
 * The session's active brand kit, or null (frontend falls back to
 * MOCK_BRAND_KIT). Reactive: saving/clearing a kit updates every subscribed
 * tab of the session live.
 */
export const getActiveBrandKit = query({
  args: { sessionId: v.string() },
  returns: v.union(v.null(), brandKitValidator),
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
      variations: row.variations,
    };
  },
});

/**
 * Save (replace) the session's active brand kit. v1 has no multi-kit library:
 * any existing rows for the session are deleted first, so the by_sessionId
 * invariant stays "at most one row". Rejects (ConvexError) without writing
 * when the kit fails the contract — see assertBrandKitIsValid.
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
    for (const row of existingRows) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.insert("brandKits", {
      sessionId: args.sessionId,
      ...args.brandKit,
      createdAtMs: now,
      updatedAtMs: now,
    });
    return null;
  },
});

/** Delete the session's saved kit — every tab falls back to the mock kit live. */
export const clearBrandKit = mutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingRows = await loadSessionBrandKitRows(ctx, args.sessionId);
    for (const row of existingRows) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
