import {
  applyOperations as applyOperationsToDocument,
  globalStylesSchema,
  ROOT_BLOCK_ID,
  type GlobalStyles,
  type Operation,
} from "@flock/email-sdk";
import { ConvexError, v, type Infer } from "convex/values";
import {
  findMatchingVariation,
  getBrandColorsValidationErrors,
  getBrandKitValidationErrors,
  getConfirmedBrandAssetUrl,
  getToneOfVoiceValidationErrors,
  type BrandKit,
  type BrandToneOfVoice,
} from "../apps/web/src/lib/brand-kit";
import {
  applyBrandFontsToVariations,
  getBrandFontsValidationErrors,
} from "../apps/web/src/lib/brand-kit-fonts";
import {
  planBrandColorsUpdate,
  reconcileBrandColors,
  reconcileToneOfVoice,
} from "../apps/web/src/lib/brand-kit-reconcile";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { resolveOwnerId, resolveOwnerIdOrNull } from "./authIdentity";
import {
  collectRowStorageIds,
  getEffectiveRevision,
  planAssetConfirmationPatch,
  planAssetRemovalPatch,
  planBrandKitSavePatch,
} from "./model/brandKitAssets";
import { commitVersions, loadDocumentState, type CommitEntry } from "./model/emailDocuments";

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
 * write them into documents. Storage lifecycle (§8.2, Stage M conversion):
 * replacing or clearing a confirmed asset deletes its storage file ONLY when
 * the file is not a registered library asset — see
 * deleteStorageFilesUnlessRegistered (kit files are invisible to the document
 * GC in convex/model/cleanup.ts).
 *
 * Stage M (canvas scoping + propagation) also lives here: the canvas brand
 * BINDING (canvases.brandKitId — shared state, restyles nothing by itself),
 * the per-draft staleness status query behind the "Updated brand available"
 * pills, and applyBrandToDocuments — the ONLY code path that restyles drafts
 * to a brand, always as explicit per-draft op batches through commitVersions
 * (the one history spine).
 *
 * Validation policy: the wire shape is Convex-validated below, and the
 * `globals` payloads are runtime-guarded BEFORE any write by (1) the
 * email-sdk `globalStylesSchema` (strict Zod — unknown keys/bad value types
 * rejected) and (2) the shared brand-kit contract checker
 * (`getBrandKitValidationErrors` from apps/web/src/lib/brand-kit.ts — the
 * single source of the completeness + WCAG ≥ 4.5:1 contrast rules). A kit
 * failing any guarded contrast pairing is NEVER stored.
 *
 * OWNERSHIP: every `sessionId` argument below is a CLAIM, not a credential —
 * the presence roster publishes it to every collaborator in the room. Each
 * public function resolves it through resolveOwnerId (convex/authIdentity.ts)
 * and keys the row off the result, so a caller with a verified identity can
 * only ever reach their own kit no matter what they send. The one exception is
 * `applyBrandToDocuments`, whose `sessionId` is the undo-stack author id for
 * the ops it commits, not an ownership key — see the note on that mutation.
 *
 * NOTE: the Phase 6.1 cleanup cron (convex/cleanup.ts) reaps stale DOCUMENTS,
 * and then — only for a session it has emptied of every canvas and document,
 * whose whole library is past the retention cutoff, and whose owner has not
 * claimed an account — the kit row and its confirmed storage files
 * (model/cleanup.ts sweepDeadSessionRows). See the table comment in schema.ts.
 */

/**
 * One AUTHORED brand color (brand-kit-user-control §3.2): the palette a human
 * curates. `origin`/`userEditedAtMs` are the re-scrape lock — see
 * reconcileBrandColors.
 */
const brandColorValidator = v.object({
  id: v.string(),
  hex: v.string(),
  name: v.string(),
  category: v.union(v.literal("primary"), v.literal("secondary"), v.literal("accent")),
  orderIndex: v.number(),
  origin: v.union(v.literal("scraped"), v.literal("agent"), v.literal("user")),
  sourceVariableName: v.optional(v.string()),
  sourceUsageCount: v.optional(v.number()),
  userEditedAtMs: v.optional(v.number()),
});

/** Tone of voice (§5.2). Prose fields reach the model only via brand-voice.ts. */
const toneOfVoiceValidator = v.object({
  descriptors: v.array(v.string()),
  formality: v.optional(v.union(v.literal("casual"), v.literal("neutral"), v.literal("formal"))),
  person: v.optional(v.union(v.literal("first-person-plural"), v.literal("third-person"))),
  guidance: v.optional(v.string()),
  avoid: v.optional(v.array(v.string())),
  origin: v.union(v.literal("scraped"), v.literal("agent"), v.literal("user")),
  userEditedAtMs: v.optional(v.number()),
});

/** Save-args wire shape — mirrors the frontend scrape/save `BrandKit` shape. */
export const brandKitValidator = v.object({
  name: v.string(),
  sourceUrl: v.optional(v.string()),
  fonts: v.object({ heading: v.string(), body: v.string() }),
  logoUrl: v.optional(v.string()),
  socialImageUrl: v.optional(v.string()),
  socialLinks: v.optional(v.array(v.object({ platform: v.string(), url: v.string() }))),
  colors: v.optional(v.array(brandColorValidator)),
  toneOfVoice: v.optional(toneOfVoiceValidator),
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
  /** The stable kit row id — what canvas bindings point at (Stage M). */
  kitId: v.id("brandKits"),
  name: v.string(),
  sourceUrl: v.optional(v.string()),
  fonts: v.object({ heading: v.string(), body: v.string() }),
  logoUrl: v.optional(v.string()),
  socialImageUrl: v.optional(v.string()),
  socialLinks: v.optional(v.array(v.object({ platform: v.string(), url: v.string() }))),
  colors: v.optional(v.array(brandColorValidator)),
  toneOfVoice: v.optional(toneOfVoiceValidator),
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

/**
 * What a save reports back so the panel can SAY what it kept (§8.2): silent
 * skipping is the failure mode provenance exists to avoid.
 */
const saveBrandKitResultValidator = v.object({
  keptUserEditedColors: v.number(),
  keptUserToneOfVoice: v.boolean(),
});

type BrandKitInput = Infer<typeof brandKitValidator>;
type ActiveBrandKitPayload = Infer<typeof activeBrandKitValidator>;

/** Project a kit row onto the read wire shape (shared by every kit read). */
function projectBrandKitRow(row: Doc<"brandKits">): ActiveBrandKitPayload {
  return {
    kitId: row._id,
    name: row.name,
    ...(row.sourceUrl !== undefined ? { sourceUrl: row.sourceUrl } : {}),
    fonts: row.fonts,
    ...(row.logoUrl !== undefined ? { logoUrl: row.logoUrl } : {}),
    ...(row.socialImageUrl !== undefined ? { socialImageUrl: row.socialImageUrl } : {}),
    ...(row.socialLinks !== undefined ? { socialLinks: row.socialLinks } : {}),
    ...(row.colors !== undefined ? { colors: row.colors } : {}),
    ...(row.toneOfVoice !== undefined ? { toneOfVoice: row.toneOfVoice } : {}),
    revision: getEffectiveRevision(row),
    ...(row.logoConfirmedAtMs !== undefined ? { logoConfirmedAtMs: row.logoConfirmedAtMs } : {}),
    ...(row.socialImageConfirmedAtMs !== undefined
      ? { socialImageConfirmedAtMs: row.socialImageConfirmedAtMs }
      : {}),
    variations: row.variations,
  };
}

/**
 * A kit row as the shared frontend BrandKit contract — safe at runtime
 * because every stored kit passed assertBrandKitIsValid (strict Zod +
 * completeness + contrast) before writing.
 */
function toBrandKitContract(row: Doc<"brandKits">): BrandKit {
  return projectBrandKitRow(row) as unknown as BrandKit;
}

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

/**
 * All kit rows for one OWNER (invariant: 0 or 1; defensive against dupes).
 *
 * `ownerId` is always the output of resolveOwnerId — never a raw `sessionId`
 * argument. The brand kit is the single most valuable thing a leaked session
 * id used to unlock, so this file has exactly one way in.
 */
async function loadOwnerBrandKitRows(ctx: MutationCtx, ownerId: string) {
  return ctx.db
    .query("brandKits")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerId))
    .collect();
}

/** The owner's kit row, or a friendly ConvexError when none exists. */
async function requireOwnerBrandKitRow(
  ctx: MutationCtx,
  ownerId: string,
): Promise<Doc<"brandKits">> {
  const rows = await loadOwnerBrandKitRows(ctx, ownerId);
  if (rows.length === 0) {
    throw new ConvexError("No saved brand kit found — save a kit first.");
  }
  return rows[0];
}

/**
 * Delete kit-owned storage files UNLESS the file is a REGISTERED asset
 * (assets table, by_storageId). Stage M conversion of the Stage S seam
 * (content-studio proposal §7.1 / confirm-asset route header): the
 * confirm-asset route registers every confirmed binary into the session's
 * asset library, so a replaced or cleared kit asset may still be referenced
 * by the Library — and by drafts that copied its URL. Registered files are
 * RETAINED (their lifecycle belongs to the registry now); unregistered files
 * keep the immediate delete. Best effort: ids may already be gone.
 */
async function deleteStorageFilesUnlessRegistered(
  ctx: MutationCtx,
  storageIds: string[],
): Promise<void> {
  for (const storageId of storageIds) {
    const registeredAsset = await ctx.db
      .query("assets")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId as Id<"_storage">))
      .first();
    if (registeredAsset !== null) {
      continue; // The Library owns this file — retain it.
    }
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
    // See savedSections.listForSession. No owner means no kit — which is
    // already this query's answer for a session that has never made one.
    const ownerId = await resolveOwnerIdOrNull(ctx, { claimedSessionId: args.sessionId });
    if (ownerId === null) {
      return null;
    }
    const row = await ctx.db
      .query("brandKits")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerId))
      .order("desc")
      .first();
    if (row === null) {
      return null;
    }
    return projectBrandKitRow(row);
  },
});

/**
 * Save the session's active brand kit — PATCH-IN-PLACE (Stage S): the row's
 * `_id` is stable across saves and `revision` bumps, which is what the Stage M
 * canvas binding points at. Inserts only when the session has no row yet.
 * Asset confirmations survive a save only when the incoming URL is unchanged;
 * a new suggestion clears the confirmation and deletes the orphaned storage
 * file (§8.2). Rejects (ConvexError) without writing when the kit fails the
 * contract — see assertBrandKitIsValid.
 *
 * TWO CHANGES from Stage S, both from brand-kit-user-control:
 *
 * 1. **Not a wholesale replace any more.** Colors and tone of voice a HUMAN
 *    authored survive an incoming scrape (§8.2 provenance + sticky edits);
 *    the return value reports what was kept so the panel can say it out loud.
 * 2. **`revision` bumps only on draft-renderable changes** (§8.3): variations
 *    or an asset URL. Renaming a color must not re-arm the "Updated brand
 *    available" pill on every draft of every bound canvas.
 */
export const saveBrandKit = mutation({
  args: {
    sessionId: v.string(),
    brandKit: brandKitValidator,
  },
  returns: saveBrandKitResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    assertBrandKitIsValid(args.brandKit);
    const now = Date.now();
    const existingRows = await loadOwnerBrandKitRows(ctx, ownerId);
    if (existingRows.length === 0) {
      await ctx.db.insert("brandKits", {
        sessionId: ownerId,
        ...args.brandKit,
        revision: 1,
        createdAtMs: now,
        updatedAtMs: now,
      });
      return { keptUserEditedColors: 0, keptUserToneOfVoice: false };
    }
    // Defensive: the invariant is one row per session — fold any dupes away
    // (surrendering their storage files) and patch the primary in place.
    const [primaryRow, ...duplicateRows] = existingRows;
    for (const duplicate of duplicateRows) {
      await deleteStorageFilesUnlessRegistered(ctx, collectRowStorageIds(duplicate));
      await ctx.db.delete(duplicate._id);
    }
    // §8: a save is no longer a wholesale replace for human-editable fields.
    // Colors and tone the user authored SURVIVE a re-scrape; everything the
    // machine produced is refreshed from the incoming payload.
    const reconciledColors = reconcileBrandColors({
      existing: primaryRow.colors,
      incoming: args.brandKit.colors,
    });
    const reconciledTone = reconcileToneOfVoice({
      existing: primaryRow.toneOfVoice,
      incoming: args.brandKit.toneOfVoice,
    });
    const { patch, storageIdsToDelete } = planBrandKitSavePatch({
      existing: primaryRow,
      incomingLogoUrl: args.brandKit.logoUrl,
      incomingSocialImageUrl: args.brandKit.socialImageUrl,
      // §8.3: only draft-renderable changes re-arm the staleness pills.
      hasRenderableChange:
        JSON.stringify(primaryRow.variations) !== JSON.stringify(args.brandKit.variations),
    });
    await ctx.db.patch(primaryRow._id, {
      name: args.brandKit.name,
      sourceUrl: args.brandKit.sourceUrl,
      fonts: args.brandKit.fonts,
      variations: args.brandKit.variations,
      // Replaced wholesale (undefined removes): social links have no human
      // edit path yet, so there is nothing of the user's to protect.
      socialLinks: args.brandKit.socialLinks,
      colors: reconciledColors.colors.length > 0 ? reconciledColors.colors : undefined,
      toneOfVoice: reconciledTone.toneOfVoice,
      updatedAtMs: now,
      ...patch,
    });
    await deleteStorageFilesUnlessRegistered(ctx, storageIdsToDelete);
    return {
      keptUserEditedColors: reconciledColors.keptUserEditedCount,
      keptUserToneOfVoice: reconciledTone.keptUserEdit,
    };
  },
});

/**
 * Replace the kit's AUTHORED palette (brand-kit-user-control §3.2) — the
 * panel's Colors section commits the whole array in one write, the same
 * wholesale stance `socialLinks` already takes.
 *
 * Does NOT bump `revision` (§8.3): the palette is a curated source for the
 * picker and the agent, not something a draft renders. Blocks store literal
 * hex values, so changing a color here repaints nothing already placed — the
 * panel says that in words rather than implying a propagation that will not
 * happen.
 *
 * Provenance is decided SERVER-SIDE (planBrandColorsUpdate): entries that
 * differ from what is stored become `origin: "user"` and pick up a
 * `userEditedAtMs`, which is what makes them survive the next re-scrape.
 */
export const updateBrandColors = mutation({
  args: { sessionId: v.string(), colors: v.array(brandColorValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    const colors = planBrandColorsUpdate({
      existing: row.colors,
      incoming: args.colors,
      nowMs: Date.now(),
    });
    const errors = getBrandColorsValidationErrors(colors);
    if (errors.length > 0) {
      throw new ConvexError(errors.join(" "));
    }
    await ctx.db.patch(row._id, {
      colors: colors.length > 0 ? colors : undefined,
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/**
 * Set the kit's heading/body fonts (brand-kit-v2 §1) — the scrape's inference
 * is only a suggestion, exactly like the kit name and the palette.
 *
 * Both stacks must be email-safe (getBrandFontsValidationErrors): the panel
 * offers the same dropdown as the block properties panel and the inline text
 * tools, and this is the server half of that rule — a free-text stack never
 * lands on the row no matter who calls.
 *
 * UNLIKE the other metadata mutations this DOES bump `revision`, because it
 * rewrites every variation's font-family globals (applyBrandFontsToVariations
 * — themes are composed from the kit's fonts, so a font edit that left them
 * alone would change nothing anyone could see). Variations are what a draft
 * renders, so the §8.3 rule says bump: bound canvases' drafts really are out
 * of date now, and their pills should say so. Nothing is restyled here —
 * applyBrandToDocuments is still the only path that touches a draft.
 */
export const updateBrandFonts = mutation({
  args: {
    sessionId: v.string(),
    fonts: v.object({ heading: v.string(), body: v.string() }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    const fontErrors = getBrandFontsValidationErrors(args.fonts);
    if (fontErrors.length > 0) {
      throw new ConvexError(fontErrors.join(" "));
    }
    if (row.fonts.heading === args.fonts.heading && row.fonts.body === args.fonts.body) {
      return null; // Nothing changed — don't re-arm every draft's pill for a no-op.
    }
    const variations = applyBrandFontsToVariations({
      variations: row.variations as BrandKit["variations"],
      fonts: args.fonts,
    });
    // Same gate every stored kit passes: completeness + WCAG contrast. Fonts
    // can't move a contrast ratio, but the kit is never written unchecked.
    assertBrandKitIsValid({ ...toBrandKitContract(row), fonts: args.fonts, variations });
    await ctx.db.patch(row._id, {
      fonts: args.fonts,
      variations,
      revision: getEffectiveRevision(row) + 1,
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/**
 * Set (or clear, with `toneOfVoice: null`) the kit's tone of voice. Always
 * lands as `origin: "user"` — this mutation only ever runs from a human
 * typing — which locks it against the next re-scrape (§8.2). Clearing hands
 * the field back to the scrape.
 *
 * Does NOT bump `revision`: nothing renders tone of voice (§8.3).
 */
export const updateBrandToneOfVoice = mutation({
  args: {
    sessionId: v.string(),
    toneOfVoice: v.union(
      v.null(),
      v.object({
        descriptors: v.array(v.string()),
        formality: v.optional(
          v.union(v.literal("casual"), v.literal("neutral"), v.literal("formal")),
        ),
        person: v.optional(v.union(v.literal("first-person-plural"), v.literal("third-person"))),
        guidance: v.optional(v.string()),
        avoid: v.optional(v.array(v.string())),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    if (args.toneOfVoice === null) {
      await ctx.db.patch(row._id, { toneOfVoice: undefined, updatedAtMs: Date.now() });
      return null;
    }
    const toneOfVoice: BrandToneOfVoice = {
      ...args.toneOfVoice,
      descriptors: args.toneOfVoice.descriptors.map((descriptor) => descriptor.trim()).filter(
        (descriptor) => descriptor.length > 0,
      ),
      ...(args.toneOfVoice.avoid === undefined
        ? {}
        : { avoid: args.toneOfVoice.avoid.map((word) => word.trim()).filter((word) => word.length > 0) }),
      origin: "user",
      userEditedAtMs: Date.now(),
    };
    const errors = getToneOfVoiceValidationErrors(toneOfVoice);
    if (errors.length > 0) {
      throw new ConvexError(errors.join(" "));
    }
    await ctx.db.patch(row._id, { toneOfVoice, updatedAtMs: Date.now() });
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
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const trimmedName = args.name.trim();
    if (trimmedName.length === 0) {
      throw new ConvexError("The brand kit name can't be empty.");
    }
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
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
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
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
    await deleteStorageFilesUnlessRegistered(ctx, storageIdsToDelete);
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
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    const { patch, storageIdsToDelete } = planAssetRemovalPatch({ existing: row, kind: args.kind });
    await ctx.db.patch(row._id, { ...patch, updatedAtMs: Date.now() });
    await deleteStorageFilesUnlessRegistered(ctx, storageIdsToDelete);
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
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const existingRows = await loadOwnerBrandKitRows(ctx, ownerId);
    for (const row of existingRows) {
      await deleteStorageFilesUnlessRegistered(ctx, collectRowStorageIds(row));
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Stage M — canvas-scoped brand binding (proposal §3), staleness (§4.3),
// and explicit propagation (§5). The binding is shared canvas state any
// capability holder may change (owner decision 1); it restyles NOTHING by
// itself. Restyling only ever happens through applyBrandToDocuments — one
// ordinary op batch per draft through the one history spine, so every
// restyle is attributable, visible, and revertable per draft.
// ---------------------------------------------------------------------------

const canvasBrandKitValidator = v.object({
  kitId: v.id("brandKits"),
  /** "binding" = canvases.brandKitId; "session" = legacy creator-session fallback. */
  source: v.union(v.literal("binding"), v.literal("session")),
  kit: activeBrandKitValidator,
});

/**
 * Resolve the brand a canvas uses (proposal §3.2 resolution chain): the
 * bound kit → the canvas creator-session's kit (legacy fallback; also covers
 * a dangling binding after clearBrandKit, risk 4) → null (frontend falls
 * back to MOCK_BRAND_KIT). Every capability holder resolves the brand
 * THROUGH the canvas — never through their own session — which is what makes
 * two collaborators' theme menus finally agree.
 */
export const getBrandKitForCanvas = query({
  args: { canvasId: v.id("canvases") },
  returns: v.union(v.null(), canvasBrandKitValidator),
  handler: async (ctx, args) => {
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      return null;
    }
    if (canvas.brandKitId !== undefined) {
      const boundKit = await ctx.db.get(canvas.brandKitId);
      if (boundKit !== null) {
        return { kitId: boundKit._id, source: "binding" as const, kit: projectBrandKitRow(boundKit) };
      }
      // Dangling binding (kit deleted while bound): fall through to legacy chain.
    }
    const sessionKit = await ctx.db
      .query("brandKits")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", canvas.sessionId))
      .order("desc")
      .first();
    if (sessionKit === null) {
      return null;
    }
    return { kitId: sessionKit._id, source: "session" as const, kit: projectBrandKitRow(sessionKit) };
  },
});

/**
 * Bind the session's saved kit as the canvas's brand. A tiny shared metadata
 * write — it RESTYLES NOTHING (proposal §3.3): drafts keep their globals and
 * their pills light up; restyling is always an explicit
 * applyBrandToDocuments confirm. Any capability holder may bind (owner
 * decision 1) — the deliberate-action prompt is the guardrail, matching
 * MERGE-NOTIFY (show, don't lock).
 */
export const bindSessionKitToCanvas = mutation({
  args: { canvasId: v.id("canvases"), sessionId: v.string() },
  returns: v.object({ kitId: v.id("brandKits"), revision: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      throw new ConvexError("That canvas no longer exists.");
    }
    const kitRow = await requireOwnerBrandKitRow(ctx, ownerId);
    const revision = getEffectiveRevision(kitRow);
    await ctx.db.patch(canvas._id, {
      brandKitId: kitRow._id,
      brandKitBoundRevision: revision,
      updatedAtMs: Date.now(),
    });
    return { kitId: kitRow._id, revision };
  },
});

/** Remove the canvas's brand binding (metadata only — drafts keep their look). */
export const unbindCanvasBrandKit = mutation({
  args: { canvasId: v.id("canvases") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      return null;
    }
    await ctx.db.patch(canvas._id, {
      brandKitId: undefined,
      brandKitBoundRevision: undefined,
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/**
 * Record the advisory brand pointer (§4.3) when a user applies one of the
 * BOUND kit's variations through the theme menu. Without this, a draft
 * switched to "Midnight" via the menu would lose its variation identity the
 * moment the kit updates (the pointer is what preserve-variation propagation
 * maps into the new revision). No-ops unless the canvas is bound and the
 * variation belongs to the bound kit's current payload set. UX metadata only
 * — never rendering truth.
 */
export const recordDocumentBrandPointer = mutation({
  args: { documentId: v.id("documents"), variationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (document === null) {
      return null;
    }
    const canvas = await ctx.db.get(document.canvasId);
    if (canvas === null || canvas.brandKitId === undefined) {
      return null;
    }
    const kitRow = await ctx.db.get(canvas.brandKitId);
    if (kitRow === null) {
      return null;
    }
    const hasVariation = kitRow.variations.some((variation) => variation.id === args.variationId);
    if (!hasVariation) {
      return null;
    }
    await ctx.db.patch(document._id, {
      brand: {
        kitId: kitRow._id,
        revision: getEffectiveRevision(kitRow),
        variationId: args.variationId,
      },
    });
    return null;
  },
});

/** Per-draft brand freshness (§4.3 pill logic — payload match composed with the pointer). */
const draftBrandStateValidator = v.union(
  /** Globals exactly match a variation of the bound kit's current revision. */
  v.literal("current"),
  /** Last brand apply was an older revision (or another kit) — show the pill. */
  v.literal("outdated"),
  /** Bound brand never applied to this draft — show the pill (§5.2 skipped drafts). */
  v.literal("never-applied"),
  /** User hand-edited away AFTER applying the current revision — deliberately detached, no pill. */
  v.literal("detached"),
);

const canvasBrandStatusValidator = v.object({
  binding: v.union(
    v.null(),
    v.object({
      kitId: v.id("brandKits"),
      revision: v.number(),
      name: v.string(),
      hasConfirmedLogo: v.boolean(),
      firstVariation: v.object({ id: v.string(), name: v.string() }),
    }),
  ),
  drafts: v.array(
    v.object({
      documentId: v.id("documents"),
      name: v.string(),
      state: draftBrandStateValidator,
      /** What propagation would apply — the preserve-variation preview (owner decision 2). */
      targetVariation: v.object({ id: v.string(), name: v.string() }),
    }),
  ),
});

/** A draft's root globals straight from its materialized root block row. */
async function readDocumentGlobals(
  ctx: QueryCtx | MutationCtx,
  documentId: Id<"documents">,
): Promise<GlobalStyles | undefined> {
  const rootRow = await ctx.db
    .query("blocks")
    .withIndex("by_documentId_and_blockId", (q) =>
      q.eq("documentId", documentId).eq("blockId", ROOT_BLOCK_ID),
    )
    .first();
  if (rootRow === null) {
    return undefined;
  }
  return rootRow.properties.globals as GlobalStyles | undefined;
}

/**
 * PRESERVE-VARIATION (owner decision 2): the variation propagation applies.
 * Precedence: the payload-matched variation (the draft's CURRENT look wins,
 * e.g. the user picked it in the menu after a propagation) → the advisory
 * pointer's variation id, when it survives in the kit ("midnight stays
 * midnight, just updated") → the kit's first variation.
 */
function pickTargetVariation({
  variations,
  matchedVariationId,
  pointerVariationId,
}: {
  variations: Doc<"brandKits">["variations"];
  matchedVariationId: string | undefined;
  pointerVariationId: string | undefined;
}): Doc<"brandKits">["variations"][number] {
  return (
    variations.find((variation) => variation.id === matchedVariationId) ??
    variations.find((variation) => variation.id === pointerVariationId) ??
    variations[0]!
  );
}

/**
 * The single reactive read behind the Figma-style UX (§5.2/§6): the canvas's
 * binding plus every draft's brand freshness. Payload-equality
 * (findMatchingVariation over the draft's live root globals) composed with
 * the advisory pointer — so undo, manual edits, and collaborator restyles
 * all converge to the right pill state without any client bookkeeping.
 * Collaborators subscribe to the same query, which is why pills appear for
 * everyone reactively and nobody ever gets a blocking modal.
 */
export const getCanvasBrandStatus = query({
  args: { canvasId: v.id("canvases") },
  returns: canvasBrandStatusValidator,
  handler: async (ctx, args) => {
    const canvas = await ctx.db.get(args.canvasId);
    const kitRow =
      canvas === null || canvas.brandKitId === undefined
        ? null
        : await ctx.db.get(canvas.brandKitId);
    if (canvas === null || kitRow === null || kitRow.variations.length === 0) {
      return { binding: null, drafts: [] };
    }
    const kitId = kitRow._id;
    const revision = getEffectiveRevision(kitRow);
    const brandKit = toBrandKitContract(kitRow);
    const firstVariation = kitRow.variations[0]!;
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .collect();
    documents.sort((a, b) => a.orderIndex - b.orderIndex);
    const drafts = [];
    for (const document of documents) {
      const globals = await readDocumentGlobals(ctx, document._id);
      const matched = findMatchingVariation({ brandKit, globals });
      const pointer = document.brand;
      const isPointerForCurrentKit = pointer !== undefined && pointer.kitId === kitId;
      let state: "current" | "outdated" | "never-applied" | "detached";
      if (matched !== null) {
        state = "current";
      } else if (pointer !== undefined && (!isPointerForCurrentKit || pointer.revision < revision)) {
        state = "outdated";
      } else if (isPointerForCurrentKit) {
        state = "detached";
      } else {
        state = "never-applied";
      }
      const target = pickTargetVariation({
        variations: kitRow.variations,
        matchedVariationId: matched?.id,
        pointerVariationId: pointer?.variationId,
      });
      drafts.push({
        documentId: document._id,
        name: document.name,
        state,
        targetVariation: { id: target.id, name: target.name },
      });
    }
    return {
      binding: {
        kitId,
        revision,
        name: kitRow.name,
        hasConfirmedLogo: getConfirmedBrandAssetUrl({ brandKit, kind: "logo" }) !== null,
        firstVariation: { id: firstVariation.id, name: firstVariation.name },
      },
      drafts,
    };
  },
});

const applyBrandResultValidator = v.object({
  results: v.array(
    v.object({
      documentId: v.id("documents"),
      outcome: v.union(
        /** Ops committed as one per-draft batch. */
        v.literal("updated"),
        /** Nothing to restyle — only the advisory pointer was refreshed. */
        v.literal("already-current"),
        v.literal("failed"),
      ),
      batchId: v.optional(v.string()),
      variationId: v.optional(v.string()),
      message: v.optional(v.string()),
    }),
  ),
});

/**
 * Propagate the canvas's BOUND brand onto the chosen drafts (§5.1) — the only
 * code path that restyles drafts to a brand, and it is always somebody's
 * explicit confirm:
 *
 * - N drafts = N per-document spine commits in one transaction; each draft
 *   gets ONE batch (`brand:<kitId>:r<revision>:<documentId>`) so
 *   history.revertBatch unwinds one draft's restyle without touching another.
 * - Ops per draft: one applyTheme with the preserve-variation target's
 *   complete globals, plus updateBlockProperties re-sourcing every
 *   role:"logo" image to the kit's CONFIRMED logo (owner decision 4 —
 *   unconfirmed suggestions never enter documents; no confirmed logo means
 *   no logo ops).
 * - `author: "user"`, `authorId` = the confirming session: a deliberate human
 *   act that belongs in that human's undo stack. The `brand:` batch prefix is
 *   the machine-readable provenance.
 * - The advisory pointer (documents.brand) is patched in the same
 *   transaction; a draft already rendering the target verbatim gets a
 *   pointer-only refresh instead of a no-op history entry.
 */
export const applyBrandToDocuments = mutation({
  args: {
    canvasId: v.id("canvases"),
    /** Explicit list — exactly the drafts the user confirmed in the prompt. */
    documentIds: v.array(v.id("documents")),
    /**
     * The confirming author; the per-draft batches land in their undo stack.
     *
     * DELIBERATELY NOT resolved through resolveOwnerId. This is not an
     * ownership key — it is `operations.authorId`, which scopes per-browser
     * undo/redo and is explicitly not migrated when an anonymous user claims
     * an account (implementation notes §3.3). Swapping it for the verified
     * identity would leave the user unable to undo their own restyle. The
     * canvas the ops land on is capability-scoped by its id, exactly like the
     * rest of documents.ts.
     */
    sessionId: v.string(),
  },
  returns: applyBrandResultValidator,
  handler: async (ctx, args) => {
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      throw new ConvexError("That canvas no longer exists.");
    }
    if (canvas.brandKitId === undefined) {
      throw new ConvexError("This canvas has no brand yet — choose one first.");
    }
    const kitRow = await ctx.db.get(canvas.brandKitId);
    if (kitRow === null || kitRow.variations.length === 0) {
      throw new ConvexError("The brand this canvas was using is gone — choose a brand again.");
    }
    const kitId = kitRow._id;
    const revision = getEffectiveRevision(kitRow);
    const brandKit = toBrandKitContract(kitRow);
    const confirmedLogoUrl = getConfirmedBrandAssetUrl({ brandKit, kind: "logo" });
    const results = [];
    for (const documentId of args.documentIds) {
      const state = await loadDocumentState(ctx, documentId);
      if (state === null || state.document.canvasId !== args.canvasId) {
        results.push({
          documentId,
          outcome: "failed" as const,
          message: "That draft is no longer on this canvas.",
        });
        continue;
      }
      const rootBlock = state.doc[ROOT_BLOCK_ID];
      const globals =
        rootBlock !== undefined && rootBlock.type === "root"
          ? rootBlock.properties.globals
          : undefined;
      const matched = findMatchingVariation({ brandKit, globals });
      const target = pickTargetVariation({
        variations: kitRow.variations,
        matchedVariationId: matched?.id,
        pointerVariationId: state.document.brand?.variationId,
      });
      const brandPointer = { kitId, revision, variationId: target.id };
      const ops: Operation[] = [];
      if (matched?.id !== target.id) {
        ops.push({ name: "applyTheme", globals: target.globals } as Operation);
      }
      if (confirmedLogoUrl !== null) {
        const desiredAlt = `${kitRow.name} logo`;
        for (const block of Object.values(state.doc)) {
          if (
            block.type === "image" &&
            block.properties.role === "logo" &&
            (block.properties.src !== confirmedLogoUrl || block.properties.alt !== desiredAlt)
          ) {
            ops.push({
              name: "updateBlockProperties",
              blockId: block.id,
              properties: { src: confirmedLogoUrl, alt: desiredAlt },
            } as Operation);
          }
        }
      }
      if (ops.length === 0) {
        // Already rendering the target verbatim: refresh the pointer (clears
        // the pill) without appending a no-op history entry.
        await ctx.db.patch(documentId, { brand: brandPointer });
        results.push({
          documentId,
          outcome: "already-current" as const,
          variationId: target.id,
        });
        continue;
      }
      const applied = applyOperationsToDocument(state.doc, ops);
      if (!applied.isOk) {
        results.push({
          documentId,
          outcome: "failed" as const,
          message: applied.errors[0]?.message ?? "Couldn't apply the brand to this draft.",
        });
        continue;
      }
      const batchId = `brand:${kitId}:r${revision}:${documentId}`;
      // `applied.inverses` is in REVERSE order: inverses[0] undoes the LAST op.
      const entries: CommitEntry[] = ops.map((op, opIndex) => ({
        op,
        inverse: applied.inverses[ops.length - 1 - opIndex]!,
        kind: "edit" as const,
      }));
      await commitVersions({
        ctx,
        state,
        newDoc: applied.doc,
        entries,
        context: { authorId: args.sessionId, author: "user", caller: "frontend", batchId },
      });
      await ctx.db.patch(documentId, { brand: brandPointer });
      results.push({
        documentId,
        outcome: "updated" as const,
        batchId,
        variationId: target.id,
      });
    }
    return { results };
  },
});
