import {
  applyOperations as applyOperationsToDocument,
  globalStylesSchema,
  ROOT_BLOCK_ID,
  type ApplyThemeOperation,
  type EmailDocument,
  type GlobalStyles,
  type Operation,
} from "@flock/email-sdk";
import { ConvexError, v, type Infer } from "convex/values";
import {
  areGlobalsEqual,
  findMatchingVariation,
  getBrandColorsValidationErrors,
  getBrandKitValidationErrors,
  getConfirmedBrandAssetUrl,
  getLiveThemeVariations,
  getToneOfVoiceValidationErrors,
  MAX_BRAND_KIT_VARIATIONS,
  type BrandKit,
  type BrandToneOfVoice,
} from "../apps/web/src/lib/brand-kit";
import { buildDefaultBrandKit } from "../apps/web/src/lib/brand-kit-default";
import { planThemeVariationDeletion } from "../apps/web/src/lib/brand-theme-lifecycle";
import { validateBrandAssetUrl } from "../apps/web/src/lib/brand-asset-url";
import {
  composeThemeGlobals,
  resolveDraftThemeLink,
} from "../apps/web/src/lib/brand-theme-link";
import {
  applyBrandFontsToVariations,
  getBrandFontsValidationErrors,
} from "../apps/web/src/lib/brand-kit-fonts";
import { planSocialLinksUpdate } from "../apps/web/src/lib/brand-social-links";
import {
  planBrandColorsUpdate,
  reconcileBrandColors,
  reconcileSocialLinks,
  reconcileToneOfVoice,
  stampUserEditedSocialLinks,
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

/*
  Brand kit persistence (brand kit panel): ONE active kit per anonymous
  session in v1. Stage S of the brand-kit architecture proposal
  (docs/proposals/brand-kit-architecture.md): the kit is a STABLE row —
  `saveBrandKit` patches in place (never delete+reinsert, which churned
  `_id` and would dangle the Stage M canvas binding) and bumps a monotonic
  `revision`. `getActiveBrandKit` is the reactive read every open canvas/tab
  subscribes to (via useActiveBrandKit), which is what makes "every canvas
  uses the same kit" true live.

  Confirmable assets (§8): the extraction pipeline leaves logo/social-card
  SUGGESTIONS (third-party URLs / inline-SVG data URIs) on the row; the
  confirm-asset route uploads the binary to Convex storage and `confirmAsset`
  swaps the row's URL to the durable serving URL. Owner decision 4:
  unconfirmed suggestions render in kit UI only — nothing downstream may
  write them into documents. Storage lifecycle (§8.2, Stage M conversion):
  replacing or clearing a confirmed asset deletes its storage file ONLY when
  the file is not a registered library asset — see
  deleteStorageFilesUnlessRegistered (kit files are invisible to the document
  GC in convex/model/cleanup.ts).

  Stage M (canvas scoping + propagation) also lives here: the canvas brand
  BINDING (canvases.brandKitId — shared state, restyles nothing by itself),
  the per-draft staleness status query behind the "Updated brand available"
  pills, and applyBrandToDocuments — the ONLY code path that restyles drafts
  to a brand, always as explicit per-draft op batches through commitVersions
  (the one history spine).

  Validation policy: the wire shape is Convex-validated below, and the
  `globals` payloads are runtime-guarded BEFORE any write by (1) the
  email-sdk `globalStylesSchema` (strict Zod — unknown keys/bad value types
  rejected) and (2) the shared brand-kit contract checker
  (`getBrandKitValidationErrors` from apps/web/src/lib/brand-kit.ts — the
  single source of the completeness + WCAG ≥ 4.5:1 contrast rules). A kit
  failing any guarded contrast pairing is NEVER stored.

  OWNERSHIP: every `sessionId` argument below is a CLAIM, not a credential —
  the presence roster publishes it to every collaborator in the room. Each
  public function resolves it through resolveOwnerId (convex/authIdentity.ts)
  and keys the row off the result, so a caller with a verified identity can
  only ever reach their own kit no matter what they send. The one exception is
  `applyBrandToDocuments`, whose `sessionId` is the undo-stack author id for
  the ops it commits, not an ownership key — see the note on that mutation.

  NOTE: the Phase 6.1 cleanup cron (convex/cleanup.ts) reaps stale DOCUMENTS,
  and then — only for a session it has emptied of every canvas and document,
  whose whole library is past the retention cutoff, and whose owner has not
  claimed an account — the kit row and its confirmed storage files
  (model/cleanup.ts sweepDeadSessionRows). See the table comment in schema.ts.
*/

/*
  One AUTHORED brand color (brand-kit-user-control §3.2): the palette a human
  curates. `origin`/`userEditedAtMs` are the re-scrape lock — see
  reconcileBrandColors.
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

/*
  Tone of voice (§5.2). Prose fields reach the model only via brand-voice.ts.
*/
const toneOfVoiceValidator = v.object({
  descriptors: v.array(v.string()),
  formality: v.optional(v.union(v.literal("casual"), v.literal("neutral"), v.literal("formal"))),
  person: v.optional(v.union(v.literal("first-person-plural"), v.literal("third-person"))),
  guidance: v.optional(v.string()),
  avoid: v.optional(v.array(v.string())),
  origin: v.union(v.literal("scraped"), v.literal("agent"), v.literal("user")),
  userEditedAtMs: v.optional(v.number()),
});

/*
  One STORED social profile link. `origin` is the re-scrape lock — optional,
  and absent means machine-owned, so every row saved before it existed is swept
  and refreshed by a scrape exactly as it always was (see reconcileSocialLinks
  and the schema comment).

  READ shape only. The save/scrape wire below deliberately does NOT accept
  `origin`: a scrape has no business declaring a link the human's, and keeping
  it off the input means `"user"` can only be minted server-side by
  `updateSocialLinks`, where a human demonstrably typed something.
*/
const storedSocialLinkValidator = v.object({
  platform: v.string(),
  url: v.string(),
  origin: v.optional(v.union(v.literal("scraped"), v.literal("agent"), v.literal("user"))),
});

/*
  Save-args wire shape — mirrors the frontend scrape/save `BrandKit` shape.
*/
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
      /*
        Must be a COMPLETE Required<GlobalStyles> payload — guarded below.
      */
      globals: v.record(v.string(), v.any()),
    }),
  ),
});

/*
  Read wire shape: the save shape plus the server-managed Stage S fields the
  UI needs — `revision` (provenance / Stage M comparisons) and the
  confirmedAtMs timestamps (Suggested vs Saved chips; the decision-4
  confirmed-only gate reads them via getConfirmedBrandAssetUrl).
*/
const activeBrandKitValidator = v.object({
  /*
    The stable kit row id — what canvas bindings point at (Stage M).
  */
  kitId: v.id("brandKits"),
  name: v.string(),
  sourceUrl: v.optional(v.string()),
  fonts: v.object({ heading: v.string(), body: v.string() }),
  logoUrl: v.optional(v.string()),
  socialImageUrl: v.optional(v.string()),
  socialLinks: v.optional(v.array(storedSocialLinkValidator)),
  colors: v.optional(v.array(brandColorValidator)),
  toneOfVoice: v.optional(toneOfVoiceValidator),
  revision: v.number(),
  logoConfirmedAtMs: v.optional(v.number()),
  socialImageConfirmedAtMs: v.optional(v.number()),
  /*
    True while this is the untouched Flock STARTER kit — drives the badge only.
  */
  isStarterKit: v.optional(v.boolean()),
  /*
    LIVE variations only. Soft-deleted rows are filtered out by
    `projectBrandKitRow` and never cross this boundary, which is what makes
    "a deleted theme is not in the dropdown" true for every reader at once
    rather than a rule each component has to remember (§14.5b).
  */
  variations: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      globals: v.record(v.string(), v.any()),
    }),
  ),
  /*
    The soft-deleted ones, so the panel can offer Restore and the add form can
    treat their ids as taken. Omitted entirely when there are none, which keeps
    the payload byte-identical for every kit nobody has deleted from.
  */
  deletedVariations: v.optional(
    v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        globals: v.record(v.string(), v.any()),
      }),
    ),
  ),
});

const assetKindValidator = v.union(v.literal("logo"), v.literal("socialCard"));

/*
  What a save reports back so the panel can SAY what it kept (§8.2): silent
  skipping is the failure mode provenance exists to avoid.
*/
const saveBrandKitResultValidator = v.object({
  keptUserEditedColors: v.number(),
  keptUserToneOfVoice: v.boolean(),
  keptUserEditedSocialLinks: v.number(),
});

type BrandKitInput = Infer<typeof brandKitValidator>;
type ActiveBrandKitPayload = Infer<typeof activeBrandKitValidator>;

/*
  Project a kit row onto the read wire shape (shared by every kit read).
*/
function projectBrandKitRow(row: Doc<"brandKits">): ActiveBrandKitPayload {
  const deletedVariations = row.variations
    .filter((variation) => variation.deletedAtMs !== undefined)
    .sort((a, b) => (a.deletedAtMs ?? 0) - (b.deletedAtMs ?? 0))
    .map((variation) => ({ id: variation.id, name: variation.name, globals: variation.globals }));
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
    ...(row.isStarterKit === true ? { isStarterKit: true } : {}),
    /*
      THE one place soft deletion becomes invisible (§14.5b). Every kit read in
      the app — the theme dropdown, the panel, the palette derivation, the
      identity resolver, propagation — comes through here, so filtering once
      covers all of them; and the fields are re-listed rather than spread so
      `deletedAtMs` cannot leak into a return validator that does not declare
      it.
    */
    variations: getLiveThemeVariations(row.variations).map((variation) => ({
      id: variation.id,
      name: variation.name,
      globals: variation.globals,
    })),
    ...(deletedVariations.length > 0 ? { deletedVariations } : {}),
  };
}

/*
  A kit row as the shared frontend BrandKit contract — safe at runtime
  because every stored kit passed assertBrandKitIsValid (strict Zod +
  completeness + contrast) before writing.
*/
function toBrandKitContract(row: Doc<"brandKits">): BrandKit {
  return projectBrandKitRow(row) as unknown as BrandKit;
}

/*
  The server-side gate every save goes through. Throws a ConvexError with a
  clear, user-displayable message when the kit violates the contract; the
  ConvexError `data` survives to the client (a plain Error's message would
  be redacted in prod).
*/
function assertBrandKitIsValid(brandKit: BrandKitInput): void {
  /*
    1. Strict Zod pass per variation: rejects unknown globals keys and wrong
       value types (the v.any() in the table validator is intentional; THIS
       is its runtime guard, same policy as ops/blocks).
  */
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
  /*
    2. The shared contract checker: completeness (applyTheme replaces globals
       wholesale) and WCAG-AA contrast (≥ 4.5:1) on every guarded pairing.
  */
  const errors = getBrandKitValidationErrors(brandKit as BrandKit);
  if (errors.length > 0) {
    throw new ConvexError(`Brand kit rejected: ${errors.join(" ")}`);
  }
}

/*
  All kit rows for one OWNER (invariant: 0 or 1; defensive against dupes).

  `ownerId` is always the output of resolveOwnerId — never a raw `sessionId`
  argument. The brand kit is the single most valuable thing a leaked session
  id used to unlock, so this file has exactly one way in.
*/
async function loadOwnerBrandKitRows(ctx: MutationCtx, ownerId: string) {
  return ctx.db
    .query("brandKits")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerId))
    .collect();
}

/*
  The owner's kit row, or a friendly ConvexError when none exists.
*/
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

/*
  Delete kit-owned storage files UNLESS the file is a REGISTERED asset
  (assets table, by_storageId). Stage M conversion of the Stage S seam
  (content-studio proposal §7.1 / confirm-asset route header): the
  confirm-asset route registers every confirmed binary into the session's
  asset library, so a replaced or cleared kit asset may still be referenced
  by the Library — and by drafts that copied its URL. Registered files are
  RETAINED (their lifecycle belongs to the registry now); unregistered files
  keep the immediate delete. Best effort: ids may already be gone.
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
      continue; /* The Library owns this file — retain it. */
    }
    await ctx.storage.delete(storageId as Id<"_storage">).catch(() => undefined);
  }
}

/*
  The session's active brand kit, or null (frontend falls back to
  MOCK_BRAND_KIT). Reactive: saving/clearing a kit updates every subscribed
  tab of the session live.
*/
export const getActiveBrandKit = query({
  args: { sessionId: v.string() },
  returns: v.union(v.null(), activeBrandKitValidator),
  handler: async (ctx, args) => {
    /*
      See savedSections.listForSession. No owner means no kit — which is
      already this query's answer for a session that has never made one.
    */
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

/*
  Save the session's active brand kit — PATCH-IN-PLACE (Stage S): the row's
  `_id` is stable across saves and `revision` bumps, which is what the Stage M
  canvas binding points at. Inserts only when the session has no row yet.
  Asset confirmations survive a save only when the incoming URL is unchanged;
  a new suggestion clears the confirmation and deletes the orphaned storage
  file (§8.2). Rejects (ConvexError) without writing when the kit fails the
  contract — see assertBrandKitIsValid.

  TWO CHANGES from Stage S, both from brand-kit-user-control:

  1. **Not a wholesale replace any more.** Colors and tone of voice a HUMAN
     authored survive an incoming scrape (§8.2 provenance + sticky edits);
     the return value reports what was kept so the panel can say it out loud.
  2. **`revision` bumps only on draft-renderable changes** (§8.3): variations
     or an asset URL. Renaming a color must not re-arm the "Updated brand
     available" pill on every draft of every bound canvas.
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
      return { keptUserEditedColors: 0, keptUserToneOfVoice: false, keptUserEditedSocialLinks: 0 };
    }
    /*
      Defensive: the invariant is one row per session — fold any dupes away
      (surrendering their storage files) and patch the primary in place.
    */
    const [primaryRow, ...duplicateRows] = existingRows;
    for (const duplicate of duplicateRows) {
      await deleteStorageFilesUnlessRegistered(ctx, collectRowStorageIds(duplicate));
      await ctx.db.delete(duplicate._id);
    }
    /*
      §8: a save is no longer a wholesale replace for human-editable fields.
      Colors, tone and social links the user authored SURVIVE a re-scrape;
      everything the machine produced is refreshed from the incoming payload.
    */
    const reconciledColors = reconcileBrandColors({
      existing: primaryRow.colors,
      incoming: args.brandKit.colors,
    });
    const reconciledTone = reconcileToneOfVoice({
      existing: primaryRow.toneOfVoice,
      incoming: args.brandKit.toneOfVoice,
    });
    const reconciledSocialLinks = reconcileSocialLinks({
      existing: primaryRow.socialLinks,
      incoming: args.brandKit.socialLinks,
    });
    const { patch, storageIdsToDelete } = planBrandKitSavePatch({
      existing: primaryRow,
      incomingLogoUrl: args.brandKit.logoUrl,
      incomingSocialImageUrl: args.brandKit.socialImageUrl,
      /*
        §8.3: only draft-renderable changes re-arm the staleness pills.
      */
      hasRenderableChange:
        JSON.stringify(primaryRow.variations) !== JSON.stringify(args.brandKit.variations),
    });
    await ctx.db.patch(primaryRow._id, {
      name: args.brandKit.name,
      sourceUrl: args.brandKit.sourceUrl,
      fonts: args.brandKit.fonts,
      variations: args.brandKit.variations,
      /*
        Reconciled, not replaced (§8.2). Links a human typed in the panel are
        stamped `origin: "user"` and survive this scrape; the ones the previous
        scrape guessed are swept and re-proposed from the incoming payload,
        including when the payload has none at all. `undefined` still removes
        the field, so a kit left with no links reads exactly as one that never
        had any.
      */
      socialLinks:
        reconciledSocialLinks.socialLinks.length > 0
          ? reconciledSocialLinks.socialLinks
          : undefined,
      colors: reconciledColors.colors.length > 0 ? reconciledColors.colors : undefined,
      toneOfVoice: reconciledTone.toneOfVoice,
      /*
        A scrape REPLACES the starter kit outright — that is the frictionless
        overwrite §14.5c promises. The starter's colors and tone carry
        `origin: "agent"` precisely so `reconcileBrandColors` and
        `reconcileToneOfVoice` sweep them instead of protecting them, and the
        badge goes with them. (The starter kit ships no social links, so
        `reconcileSocialLinks` has nothing of its to sweep.)
      */
      isStarterKit: undefined,
      updatedAtMs: now,
      ...patch,
    });
    await deleteStorageFilesUnlessRegistered(ctx, storageIdsToDelete);
    return {
      keptUserEditedColors: reconciledColors.keptUserEditedCount,
      keptUserToneOfVoice: reconciledTone.keptUserEdit,
      keptUserEditedSocialLinks: reconciledSocialLinks.keptUserEditedCount,
    };
  },
});

/*
  SEED the starter kit — Flock's own brand — for an owner who has none
  (brand-kit-user-control §14.5c, lib/brand-kit-default.ts).

  THE PROBLEM IT SOLVES: every manual editor in the panel is gated behind
  `hasSavedKit`, and the only way to earn one was a successful website scrape.
  A user whose site is bot-protected, or who has no site, had no path at all —
  not to colors, not to fonts, not to a tone of voice, not even to binding a
  brand to their canvas. This gives them a real, editable row in one click.

  IDEMPOTENT AND NEVER DESTRUCTIVE. An owner who already has a kit gets that
  kit's id back, untouched. There is no path here that overwrites a saved kit,
  which is what lets the panel offer this without a confirmation step.

  RESTYLES NOTHING. It inserts one row. It binds no canvas, writes no document
  and commits no op, so a person with existing drafts sees them exactly as they
  were — the canvas is not even using this kit until they choose it, and even
  then applyBrandToDocuments is still somebody's explicit confirm.

  The kit passes the same gate a scraped one does (strict Zod, completeness,
  WCAG-AA) because it is built from the app's own contract-passing theme
  payloads — the assertion below is not a formality, it is what keeps that
  true if anyone edits the constant.
*/
export const startDefaultBrandKit = mutation({
  args: { sessionId: v.string() },
  returns: v.object({ kitId: v.id("brandKits"), wasAlreadyPresent: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const existingRows = await loadOwnerBrandKitRows(ctx, ownerId);
    const existingRow = existingRows[0];
    if (existingRow !== undefined) {
      return { kitId: existingRow._id, wasAlreadyPresent: true };
    }
    const brandKit = buildDefaultBrandKit();
    assertBrandKitIsValid(brandKit as BrandKitInput);
    const now = Date.now();
    const kitId = await ctx.db.insert("brandKits", {
      sessionId: ownerId,
      name: brandKit.name,
      fonts: brandKit.fonts,
      /*
        UNCONFIRMED, deliberately. The logo is an inline `data:image/svg+xml`
        suggestion exactly like a scraped masthead SVG, so the shipped confirm
        flow — same safety gate, same upload, same Suggested → Saved chip — is
        what makes it durable and earns it the right to enter a document.
        `logoConfirmedAtMs` is absent, so getConfirmedBrandAssetUrl answers
        null and propagation writes no logo op until the user confirms.
      */
      logoUrl: brandKit.logoUrl,
      colors: brandKit.colors,
      toneOfVoice: brandKit.toneOfVoice,
      variations: brandKit.variations,
      /*
        The badge's whole basis — cleared by a rename or a scrape.
      */
      isStarterKit: true,
      revision: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    return { kitId, wasAlreadyPresent: false };
  },
});

/*
  Replace the kit's AUTHORED palette (brand-kit-user-control §3.2) — the
  panel's Colors section commits the whole array in one write, the same
  wholesale stance `socialLinks` already takes.

  Does NOT bump `revision` (§8.3): the palette is a curated source for the
  picker and the agent, not something a draft renders. Blocks store literal
  hex values, so changing a color here repaints nothing already placed — the
  panel says that in words rather than implying a propagation that will not
  happen.

  Provenance is decided SERVER-SIDE (planBrandColorsUpdate): entries that
  differ from what is stored become `origin: "user"` and pick up a
  `userEditedAtMs`, which is what makes them survive the next re-scrape.
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

/*
  Set the kit's heading/body fonts (brand-kit-v2 §1) — the scrape's inference
  is only a suggestion, exactly like the kit name and the palette.

  Both stacks must be email-safe (getBrandFontsValidationErrors): the panel
  offers the same dropdown as the block properties panel and the inline text
  tools, and this is the server half of that rule — a free-text stack never
  lands on the row no matter who calls.

  UNLIKE the other metadata mutations this DOES bump `revision`, because it
  rewrites every variation's font-family globals (applyBrandFontsToVariations
  — themes are composed from the kit's fonts, so a font edit that left them
  alone would change nothing anyone could see). Variations are what a draft
  renders, so the §8.3 rule says bump: bound canvases' drafts really are out
  of date now, and their pills should say so. Nothing is restyled here —
  applyBrandToDocuments is still the only path that touches a draft.
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
      return null; /* Nothing changed — don't re-arm every draft's pill for a no-op. */
    }
    const variations = applyBrandFontsToVariations({
      variations: row.variations as BrandKit["variations"],
      fonts: args.fonts,
    });
    /*
      Same gate every stored kit passes: completeness + WCAG contrast. Fonts
      can't move a contrast ratio, but the kit is never written unchecked.
      Soft-deleted variations ARE re-fonted above (a restored theme must not
      come back with two-revisions-old fonts) but are not what the gate counts
      against the cap — see getBrandKitValidationErrors.
    */
    assertBrandKitIsValid({
      ...toBrandKitContract(row),
      fonts: args.fonts,
      variations: getLiveThemeVariations(variations),
    });
    await ctx.db.patch(row._id, {
      fonts: args.fonts,
      variations,
      revision: getEffectiveRevision(row) + 1,
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/*
  Append a USER-AUTHORED theme to the kit (brand-kit-v2 §2.1 — "I want the
  user to be able to add custom themes").

  ~~APPEND ONLY... there must not be an edit path until the
  identity-vs-equality question in brand-kit-user-control §14.5 has an
  answer.~~ ANSWERED (§14.5a): identity resolves `matched payload → surviving
  pointer → none`, a per-property override diff is measured against the
  baseline snapshot on `documents.brand`, and the edit path is
  `updateBrandThemeVariation` below. This mutation stays append-only because
  appending is what it means — not because editing is unsafe.

  What DOES still separate the two is the revision policy.

  Appending DOES NOT BUMP `revision`, which is a deliberate exception to the §8.3 rule
  of thumb ("variations changed ⇒ bump"). The rule exists because a bump
  re-arms the "Updated brand available" pill on every draft of every bound
  canvas, and it is only honest when the drafts have something new to adopt.
  A newly appended theme gives them nothing: `pickTargetVariation` resolves
  to the draft's matched variation, then its advisory pointer, then the kit's
  FIRST variation — an appended one is never any of those — so propagation
  after an add would apply exactly nothing to every draft it prompted about.
  The existing themes are untouched and still render identically; nothing a
  draft renders got newer, so nothing should claim it did.

  The server-side contract gate still runs (`assertBrandKitIsValid`): the
  client filters combinations BEFORE offering them (lib/brand-theme-builder.ts)
  so a person never meets a refusal, but the guarantee that no failing kit is
  ever stored belongs here, where it holds regardless of caller.
*/
export const addBrandThemeVariation = mutation({
  args: {
    sessionId: v.string(),
    variation: v.object({
      id: v.string(),
      name: v.string(),
      /*
        Must be a COMPLETE Required<GlobalStyles> payload — guarded below.
      */
      globals: v.record(v.string(), v.any()),
    }),
  },
  returns: v.object({ variationId: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    const name = args.variation.name.trim();
    if (name.length === 0) {
      throw new ConvexError("Give the theme a name.");
    }
    /*
      Id collisions are checked against EVERY row, live or soft-deleted: a
      deleted variation still occupies its id (that is what makes restoring it
      re-link the drafts pointing there), so reusing the id would fuse two
      different themes into one as far as every pointer is concerned. The panel
      feeds `buildUniqueVariationId` the deleted ids too, so a person never
      meets this — it is the backstop, like the contrast gate below.
    */
    if (row.variations.some((variation) => variation.id === args.variation.id)) {
      throw new ConvexError("A theme with that name already exists in this kit.");
    }
    /*
      The cap counts THEMES, and a deleted one is not a theme this kit has.
    */
    if (getLiveThemeVariations(row.variations).length >= MAX_BRAND_KIT_VARIATIONS) {
      throw new ConvexError(
        `This kit already holds ${MAX_BRAND_KIT_VARIATIONS} themes — the most it can carry.`,
      );
    }
    const variations = [...row.variations, { ...args.variation, name }];
    assertBrandKitIsValid({
      ...toBrandKitContract(row),
      variations: getLiveThemeVariations(variations),
    });
    await ctx.db.patch(row._id, { variations, updatedAtMs: Date.now() });
    return { variationId: args.variation.id };
  },
});

/*
  EDIT an existing theme — the payoff of §14.5a and the thing v2 §2 was blocked
  on. Renames, recolors, refonts one variation in place.

  This mutation RESTYLES NOTHING. It writes the kit row and stops;
  `applyBrandToDocuments` is still the only path that touches a draft, still
  behind a human confirm. What changes for referencing drafts is what they are
  TOLD: their pointer's revision falls behind, so they read "outdated" and grow
  the non-blocking "Updated brand available" pill. Confirming it applies the new
  payload with each draft's own overridden properties re-applied on top — the
  Webflow behaviour the owner asked for, and the reason the edit is finally
  safe. A draft that overrode the button color keeps its button color; every
  property it did not touch adopts the edit.

  IT BUMPS `revision`, and that is the opposite call from the append above.
  Every clause of the append exception inverts here. `pickTargetVariation`
  resolves to a draft's matched-or-pointed variation, and an EDITED variation is
  exactly that for every draft referencing it — so propagation after an edit
  really does have something to apply, which is the condition §8.3's rule is
  about. The bump is also what re-arms the per-(kit, revision) dismissal token
  in brand-pill-dismissals: without it, anyone who dismissed a previous pill
  would never be told their theme changed. `updateBrandFonts` is the standing
  precedent — it rewrites every variation's font globals and bumps for the same
  reason.

  The kit's own baselines are NOT rewritten. A draft's baseline is a snapshot of
  what it last adopted; moving it here would erase the evidence of which
  properties are the person's and which are the theme's, which is precisely what
  the snapshot exists to preserve.
*/
export const updateBrandThemeVariation = mutation({
  args: {
    sessionId: v.string(),
    variationId: v.string(),
    name: v.string(),
    /*
      Must be a COMPLETE Required<GlobalStyles> payload — guarded below.
    */
    globals: v.record(v.string(), v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError("Give the theme a name.");
    }
    /*
      LIVE ONLY. Editing a theme the user deleted would silently resurrect it
      as far as the panel is concerned while leaving `deletedAtMs` in place —
      an edit is not the restore gesture, and `setBrandThemeVariationDeleted`
      is (§14.5b).
    */
    const existing = getLiveThemeVariations(row.variations).find(
      (variation) => variation.id === args.variationId,
    );
    if (existing === undefined) {
      throw new ConvexError("That theme is no longer in this kit.");
    }
    const variations = row.variations.map((variation) =>
      variation.id === args.variationId
        ? { id: variation.id, name, globals: args.globals }
        : variation,
    );
    /*
      Same gate every stored kit passes — strict Zod, completeness, WCAG-AA.
    */
    assertBrandKitIsValid({
      ...toBrandKitContract(row),
      variations: getLiveThemeVariations(variations),
    });
    const hasSameName = existing.name === name;
    const hasSameGlobals = areGlobalsEqual({ a: existing.globals, b: args.globals });
    if (hasSameName && hasSameGlobals) {
      /*
        A no-op edit must not re-arm every draft's pill (same rule as updateBrandFonts).
      */
      return null;
    }
    await ctx.db.patch(row._id, {
      variations,
      /*
        A pure RENAME changes nothing any draft renders, so it must not claim
        otherwise — same reasoning as renameBrandKit (risk 6). Only a payload
        edit gives referencing drafts something to adopt.
      */
      ...(hasSameGlobals ? {} : { revision: getEffectiveRevision(row) + 1 }),
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/*
  DELETE a theme — softly — or undo that (brand-kit-user-control §14.5b).
  The owner's decision, verbatim: "I think we should allow theme deletion, but
  it's a soft deletion (and unlinks existing drafts from using that theme)."

  THIS MUTATION RESTYLES NOTHING, and the proof is that it cannot: it patches
  `variations` on the kit row and returns. It reads no document, writes no
  document, commits no operation. `applyBrandToDocuments` is still the only
  code path that touches a draft, and it is still behind a human confirm. A
  draft that was rendering the deleted theme goes on rendering the identical
  bytes; what changes is what it is CALLED — `resolveDraftThemeLink` finds no
  parent for its pointer and reports `never-applied`. That IS the unlink the
  owner asked for: the draft reads as parentless, not as "overridden against a
  theme that no longer exists".

  WHY NOT CLEAR THE DRAFTS' POINTERS INSTEAD. It is the other way to unlink,
  and it is worse on three counts. It would make a kit mutation write across
  into `documents` — every draft of every canvas bound to this kit, with no
  index to reach them by — which breaks the property the whole §14.5a design
  rests on (no kit mutation touches a document). It is unbounded work in one
  transaction. And it destroys the thing that makes soft deletion worth
  anything: the pointer, with its `baselineGlobals` snapshot, is the memory of
  which theme a draft was an instance of, so clearing it would make the restore
  below a restore of the theme but not of the link.

  IT DOES NOT BUMP `revision`, and that is the same call as the append
  exception. A bump re-arms the "Updated brand available" pill on every draft
  of every bound canvas, and it is only honest when those drafts have something
  to adopt. After a deletion the surviving themes are untouched, so every draft
  using one has nothing new — and the drafts that DID use the deleted theme get
  their signal from the state change (`never-applied` shows the pill) rather
  than from a kit-wide claim that everything changed.

  RESTORE IS THE SAME WRITE IN REVERSE, which is why it is the same mutation:
  clearing `deletedAtMs` makes every draft whose pointer still names this theme
  an instance of it again — `current` if it never diverged, `overridden` with
  its own properties intact if it did — again without a single document write.
*/
export const setBrandThemeVariationDeleted = mutation({
  args: {
    sessionId: v.string(),
    variationId: v.string(),
    /*
      true = delete, false = restore. One argument, one symmetric write.
    */
    isDeleted: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    const plan = planThemeVariationDeletion({
      variations: row.variations,
      variationId: args.variationId,
      isDeleted: args.isDeleted,
      nowMs: Date.now(),
    });
    if (!plan.isOk) {
      throw new ConvexError(plan.message);
    }
    /*
      The same gate every stored kit passes. It matters most on the DELETE
      side: `getBrandKitValidationErrors` counts the live set, so a kit that
      somehow reached zero live themes is refused here rather than becoming a
      row whose `variations[0]` fallback has nothing to return.
    */
    assertBrandKitIsValid({
      ...toBrandKitContract(row),
      variations: getLiveThemeVariations(plan.variations),
    });
    await ctx.db.patch(row._id, { variations: plan.variations, updatedAtMs: Date.now() });
    return null;
  },
});

/*
  Set (or clear, with `toneOfVoice: null`) the kit's tone of voice. Always
  lands as `origin: "user"` — this mutation only ever runs from a human
  typing — which locks it against the next re-scrape (§8.2). Clearing hands
  the field back to the scrape.

  Does NOT bump `revision`: nothing renders tone of voice (§8.3).
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

/*
  Rename the session's kit — the extracted company name is only a suggestion
  (proposal §8.1); the user's edit wins and persists here. Name-only changes
  deliberately do NOT bump `revision` (risk 6: revision means meaningful
  diffs, so Stage M staleness pills never re-arm over a rename).
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
    await ctx.db.patch(row._id, {
      name: trimmedName,
      /*
        Naming the kit is one of the two gestures that mean it is about the
        user's own brand now, so the Starter badge goes (§14.5c). The other is
        a scrape — see saveBrandKit. Recoloring or re-theming does NOT clear
        it: a kit still called "Flock" is still Flock's, and saying otherwise
        on the badge would be the implication the framing forbids.
      */
      isStarterKit: undefined,
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/*
  Set the kit's logo or social card from a URL the USER typed
  (brand-kit-user-control §6.2).

  THE SAFETY PROPERTY THIS PRESERVES. The confirm-asset route's core guarantee
  is that it never trusts a client-supplied URL: it re-reads the URL from the
  row, which is trusted because the extraction guards vetted it. Handing that
  route a typed URL directly would break the guarantee. So the typed URL lands
  HERE instead, as an ordinary UNCONFIRMED suggestion on the row — exactly the
  state a scraped suggestion is in — and the shipped confirm flow then runs
  unchanged and unweakened: same SSRF rails, same size and content-type caps,
  same upload, same library registration, same Suggested → Saved chip the user
  already knows. The owner's requirement that a typed URL still go through the
  confirm step is satisfied literally rather than by a parallel path.

  Nothing is fetched here. Validation is deliberately the SYNTAX half only
  (lib/brand-asset-url.ts — node-free so it runs in this runtime); the
  DNS-resolving guard stays in the fetch, where it has to be anyway because DNS
  can change between the two moments.

  Bumps `revision` because the asset URL changed, matching planBrandKitSavePatch
  — and replacing a CONFIRMED asset with a fresh suggestion genuinely changes
  what propagation would apply, since getConfirmedBrandAssetUrl now answers null.
*/
export const setBrandAssetSuggestion = mutation({
  args: {
    sessionId: v.string(),
    kind: assetKindValidator,
    url: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    const validated = validateBrandAssetUrl(args.url);
    if (!validated.isValid) {
      throw new ConvexError(validated.message);
    }
    const currentUrl = args.kind === "logo" ? row.logoUrl : row.socialImageUrl;
    if (currentUrl === validated.url) {
      /*
        Re-typing the address already on the row must not un-confirm a saved
        asset and delete its file — that would turn a no-op into data loss.
      */
      return null;
    }
    /*
      A removal plan is exactly the right shape here: it clears the storage id,
      the provenance and the confirmation timestamp, bumps the revision and
      surrenders the replaced file. The only difference is that a new URL lands
      where the removal would have left the field empty.
    */
    const { patch, storageIdsToDelete } = planAssetRemovalPatch({ existing: row, kind: args.kind });
    const urlField = args.kind === "logo" ? "logoUrl" : "socialImageUrl";
    await ctx.db.patch(row._id, {
      ...patch,
      [urlField]: validated.url,
      updatedAtMs: Date.now(),
    });
    await deleteStorageFilesUnlessRegistered(ctx, storageIdsToDelete);
    return null;
  },
});

/*
  Replace the kit's social profile links with the ones a human curated
  (brand-kit-user-control §7.2) — until now the only human-facing kit field
  with no edit path at all.

  Validation runs through planSocialLinksUpdate, which reuses `classifySocialUrl`
  — the same classifier the extraction ladder uses — so a typed link and a
  scraped one are the same kind of value: canonicalized, one per platform, and
  with share/intent chrome refused rather than stored as the brand's profile.

  Does NOT bump `revision` (§8.3): social links are kit metadata that no draft
  renders. The footer "Fill from brand kit" affordance reads them on demand and
  is always an explicit user gesture, so nothing needs a staleness pill.

  SURVIVES A RE-SCRAPE, which is the whole reason this is not just a patch.
  `stampUserEditedSocialLinks` marks the rows whose URL actually CHANGED (and
  any new platform) `origin: "user"` before they are written, and
  `reconcileSocialLinks` in saveBrandKit then refuses to let an incoming scrape
  touch a platform a user-owned link claims. Rows that came back unchanged keep
  the provenance they had, so blurring a field you did not edit does not
  quietly lock the whole list against every future scrape.

  Provenance is decided HERE, server-side, exactly as it is for the palette:
  the client sends the array it is showing and nothing it claims about origin
  is read — the save wire shape carries no `origin` at all.
*/
export const updateSocialLinks = mutation({
  args: {
    sessionId: v.string(),
    socialLinks: v.array(
      v.object({
        platform: v.union(
          v.literal("x"),
          v.literal("facebook"),
          v.literal("instagram"),
          v.literal("linkedin"),
          v.literal("youtube"),
          v.literal("github"),
          v.literal("tiktok"),
        ),
        url: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await requireOwnerBrandKitRow(ctx, ownerId);
    const plan = planSocialLinksUpdate(args.socialLinks);
    if (!plan.isValid) {
      throw new ConvexError(plan.message);
    }
    const socialLinks = stampUserEditedSocialLinks({
      existing: row.socialLinks,
      incoming: plan.links,
    });
    await ctx.db.patch(row._id, {
      /*
        Empty removes the field, matching how `colors` stores "none".
      */
      socialLinks: socialLinks.length > 0 ? socialLinks : undefined,
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/*
  Confirm an extracted asset. Called by the confirm-asset route AFTER it has
  pulled the binary through the SSRF rails and uploaded it to storage: swaps
  the row's asset URL to the durable serving URL, records provenance + the
  confirmation timestamp, bumps revision (asset swaps are meaningful diffs —
  Stage M re-sources logos from them), and deletes any previously confirmed
  file for the kind. `expectedSourceUrl` must still match the row's CURRENT
  asset URL so a concurrent re-scrape can't have a stale binary confirmed
  over it (the orphaned upload is deleted on that rejection).
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

/*
  Remove one asset (suggestion or confirmed) from the session's kit — the
  panel's [Remove] affordance. Deletes the confirmed storage file if any.
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

/*
  Delete the session's saved kit — every tab falls back to the mock kit
  live. Deletes kit-owned storage files first (§8.2: kit files are invisible
  to the document GC).
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

/*
  ---------------------------------------------------------------------------
  Stage M — canvas-scoped brand binding (proposal §3), staleness (§4.3),
  and explicit propagation (§5). The binding is shared canvas state any
  capability holder may change (owner decision 1); it restyles NOTHING by
  itself. Restyling only ever happens through applyBrandToDocuments — one
  ordinary op batch per draft through the one history spine, so every
  restyle is attributable, visible, and revertable per draft.
  ---------------------------------------------------------------------------
*/

const canvasBrandKitValidator = v.object({
  kitId: v.id("brandKits"),
  /*
    "binding" = canvases.brandKitId; "session" = legacy creator-session fallback.
  */
  source: v.union(v.literal("binding"), v.literal("session")),
  kit: activeBrandKitValidator,
});

/*
  Resolve the brand a canvas uses (proposal §3.2 resolution chain): the
  bound kit → the canvas creator-session's kit (legacy fallback; also covers
  a dangling binding after clearBrandKit, risk 4) → null (frontend falls
  back to MOCK_BRAND_KIT). Every capability holder resolves the brand
  THROUGH the canvas — never through their own session — which is what makes
  two collaborators' theme menus finally agree.
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
      /*
        Dangling binding (kit deleted while bound): fall through to legacy chain.
      */
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

/*
  Bind the session's saved kit as the canvas's brand. A tiny shared metadata
  write — it RESTYLES NOTHING (proposal §3.3): drafts keep their globals and
  their pills light up; restyling is always an explicit
  applyBrandToDocuments confirm. Any capability holder may bind (owner
  decision 1) — the deliberate-action prompt is the guardrail, matching
  MERGE-NOTIFY (show, don't lock).
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

/*
  Remove the canvas's brand binding (metadata only — drafts keep their look).
*/
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

/*
  Record the draft's theme link (§4.3, §14.5a) when a user applies one of the
  BOUND kit's variations through the theme menu. Without this, a draft switched
  to "Midnight" via the menu would lose its variation identity the moment the
  kit updates (the pointer is what preserve-variation propagation maps into the
  new revision). No-ops unless the canvas is bound and the variation belongs to
  the bound kit's current payload set. Never rendering truth — the theme menu's
  own `applyTheme` op is what restyled the draft; this only records what it now
  is an instance OF.

  This is also the RESET path for overrides. The menu dispatches a wholesale
  `applyTheme`, so the draft's globals become the variation's payload verbatim;
  writing the same payload as the baseline means the override diff is empty by
  construction, and the indicator goes dark. "Pick the theme again to reset" is
  the affordance the indicator's tooltip promises, and this is the half of it
  that clears the override set.
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
    /*
      Live only: a deleted theme is not one the menu can have applied.
    */
    const variation = getLiveKitVariations(kitRow).find((entry) => entry.id === args.variationId);
    if (variation === undefined) {
      return null;
    }
    await ctx.db.patch(document._id, {
      brand: {
        kitId: kitRow._id,
        revision: getEffectiveRevision(kitRow),
        variationId: args.variationId,
        baselineGlobals: variation.globals,
      },
    });
    return null;
  },
});

/*
  Per-draft theme link state (§4.3 pill logic, §14.5a vocabulary). Resolved by
  the shared pure `resolveDraftThemeLink` so this query and the toolbar can
  never label the same draft two different ways.
*/
const draftBrandStateValidator = v.union(
  /*
    Connected to a theme of the bound kit, rendering it verbatim.
  */
  v.literal("current"),
  /*
    Connected to a theme of the bound kit with local per-property changes.
    RENAMES the old "detached" (§14.5a): the link was never severed, so the
    word was wrong. No pill — an override is a decision, not staleness.
  */
  v.literal("overridden"),
  /*
    Something to adopt: an older revision, another kit, or the parent theme moved — show the pill.
  */
  v.literal("outdated"),
  /*
    No parent theme at all — show the pill (§5.2 skipped drafts).
  */
  v.literal("never-applied"),
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
      /*
        What propagation would apply — the preserve-variation preview (owner decision 2).
      */
      targetVariation: v.object({ id: v.string(), name: v.string() }),
      /*
        The theme this draft is an INSTANCE OF (§14.5a), or null when it has
        none. Distinct from `targetVariation`, which is what propagation would
        apply next — for a never-applied draft there is no parent but there is
        always a target.
      */
      parentVariation: v.union(v.null(), v.object({ id: v.string(), name: v.string() })),
      /*
        The global style properties whose resolved value differs from the
        parent theme's — the Webflow "this instance is overridden" set, sorted.
        Empty whenever `parentVariation` is null.

        GLOBALS LAYER ONLY. Per-section background overrides are block
        properties, and folding them in would make this reactive query depend
        on every block row of every draft on the canvas (see
        getThemeOverrideIndicator).
      */
      overriddenGlobalKeys: v.array(v.string()),
    }),
  ),
});

/*
  A draft's root globals straight from its materialized root block row.
*/
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

/*
  Every section's theme-scoped background overrides, in `applyTheme`'s
  `sectionOverrides` shape — the BLOCK-layer half of the override model
  (§14.5a). `applyTheme` strips these before writing the new globals, so
  handing them back on the same op is what makes "this one section is dark"
  survive a brand update. Returns an empty array when no section carries one,
  in which case the op omits the field entirely and behaves exactly as before.
*/
function collectSectionThemeOverrides(
  doc: EmailDocument,
): NonNullable<ApplyThemeOperation["sectionOverrides"]> {
  const overrides: NonNullable<ApplyThemeOperation["sectionOverrides"]> = [];
  for (const block of Object.values(doc)) {
    if (block.type !== "section") {
      continue;
    }
    const { innerBackgroundColor, outerBackgroundColor } = block.properties;
    if (innerBackgroundColor === undefined && outerBackgroundColor === undefined) {
      continue;
    }
    overrides.push({
      blockId: block.id,
      ...(innerBackgroundColor !== undefined ? { innerBackgroundColor } : {}),
      ...(outerBackgroundColor !== undefined ? { outerBackgroundColor } : {}),
    });
  }
  return overrides;
}

/*
  PRESERVE-VARIATION (owner decision 2): the variation propagation applies.
  Precedence: the payload-matched variation (the draft's CURRENT look wins,
  e.g. the user picked it in the menu after a propagation) → the advisory
  pointer's variation id, when it survives in the kit ("midnight stays
  midnight, just updated") → the kit's first variation.
*/
/*
  LIVE VARIATIONS ONLY — the guarantee `pickTargetVariation` below depends on.
  Both Stage-M handlers resolve their variation list through here rather than
  reading `kitRow.variations`, so a soft-deleted theme can never become a
  propagation target, never become the "first variation" a never-applied draft
  falls back to, and never be counted when deciding a kit is empty (§14.5b).
*/
function getLiveKitVariations(kitRow: Doc<"brandKits">): Doc<"brandKits">["variations"] {
  return kitRow.variations.filter((variation) => variation.deletedAtMs === undefined);
}

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

/*
  The single reactive read behind the Figma-style UX (§5.2/§6): the canvas's
  binding, plus every draft's theme link — which theme it is an instance of,
  which of its properties are locally overridden, and whether it has anything
  to adopt.

  Every per-draft answer comes from ONE pure function (`resolveDraftThemeLink`,
  §14.5a) that the toolbar's override indicator also calls, so the query and
  the UI cannot disagree. It is derived from live data on every read — the
  draft's root globals plus its pointer — which is why undo, manual edits,
  batch reverts and collaborator restyles all converge without any client
  bookkeeping. Collaborators subscribe to the same query, which is why pills
  appear for everyone reactively and nobody ever gets a blocking modal.
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
    const liveVariations = kitRow === null ? [] : getLiveKitVariations(kitRow);
    if (canvas === null || kitRow === null || liveVariations.length === 0) {
      return { binding: null, drafts: [] };
    }
    const kitId = kitRow._id;
    const revision = getEffectiveRevision(kitRow);
    const brandKit = toBrandKitContract(kitRow);
    const firstVariation = liveVariations[0]!;
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .collect();
    documents.sort((a, b) => a.orderIndex - b.orderIndex);
    const drafts = [];
    for (const document of documents) {
      const globals = await readDocumentGlobals(ctx, document._id);
      const pointer = document.brand;
      const link = resolveDraftThemeLink({
        variations: brandKit.variations,
        kitId,
        revision,
        globals,
        pointer,
      });
      /*
        The TARGET is computed by the pre-§14.5a rule, unchanged and
        deliberately independent of the link above: matched payload → the
        pointer's variation if it survives → the kit's first. Keeping these two
        separate is half the "no wrong restyle" argument — the richer resolver
        only ever changes what a draft is CALLED, never what propagation would
        write to it.
      */
      const matched = findMatchingVariation({ brandKit, globals });
      const target = pickTargetVariation({
        variations: liveVariations,
        matchedVariationId: matched?.id,
        pointerVariationId: pointer?.variationId,
      });
      const parent =
        link.parentVariationId === null
          ? null
          : (liveVariations.find((variation) => variation.id === link.parentVariationId) ?? null);
      drafts.push({
        documentId: document._id,
        name: document.name,
        state: link.state,
        targetVariation: { id: target.id, name: target.name },
        parentVariation: parent === null ? null : { id: parent.id, name: parent.name },
        overriddenGlobalKeys: link.overriddenGlobalKeys,
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
        /*
          Ops committed as one per-draft batch.
        */
        v.literal("updated"),
        /*
          Nothing to restyle — only the advisory pointer was refreshed.
        */
        v.literal("already-current"),
        v.literal("failed"),
      ),
      batchId: v.optional(v.string()),
      variationId: v.optional(v.string()),
      message: v.optional(v.string()),
    }),
  ),
});

/*
  Propagate the canvas's BOUND brand onto the chosen drafts (§5.1) — the only
  code path that restyles drafts to a brand, and it is always somebody's
  explicit confirm:

  - N drafts = N per-document spine commits in one transaction; each draft
    gets ONE batch (`brand:<kitId>:r<revision>:<documentId>`) so
    history.revertBatch unwinds one draft's restyle without touching another.
  - Ops per draft: one applyTheme with the preserve-variation target's
    complete globals, plus updateBlockProperties re-sourcing every
    role:"logo" image to the kit's CONFIRMED logo (owner decision 4 —
    unconfirmed suggestions never enter documents; no confirmed logo means
    no logo ops).
  - `author: "user"`, `authorId` = the confirming session: a deliberate human
    act that belongs in that human's undo stack. The `brand:` batch prefix is
    the machine-readable provenance.
  - The advisory pointer (documents.brand) is patched in the same
    transaction; a draft already rendering the target verbatim gets a
    pointer-only refresh instead of a no-op history entry.
*/
export const applyBrandToDocuments = mutation({
  args: {
    canvasId: v.id("canvases"),
    /*
      Explicit list — exactly the drafts the user confirmed in the prompt.
    */
    documentIds: v.array(v.id("documents")),
    /*
      The confirming author; the per-draft batches land in their undo stack.

      DELIBERATELY NOT resolved through resolveOwnerId. This is not an
      ownership key — it is `operations.authorId`, which scopes per-browser
      undo/redo and is explicitly not migrated when an anonymous user claims
      an account (implementation notes §3.3). Swapping it for the verified
      identity would leave the user unable to undo their own restyle. The
      canvas the ops land on is capability-scoped by its id, exactly like the
      rest of documents.ts.
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
    const liveVariations = kitRow === null ? [] : getLiveKitVariations(kitRow);
    if (kitRow === null || liveVariations.length === 0) {
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
        variations: liveVariations,
        matchedVariationId: matched?.id,
        pointerVariationId: state.document.brand?.variationId,
      });
      /*
        THE WEBFLOW MERGE (§14.5a). The target theme supplies every global;
        the draft's OVERRIDDEN properties are re-applied on top, so a person
        who set their own button color keeps it across a brand update instead
        of having it silently reverted.

        With zero overrides — every draft that exists before a theme is ever
        edited — `composed` is the target's payload verbatim, byte-identical
        to the wholesale replace this used to write. That is the migration's
        "renders identically" guarantee, in the one place that writes.
      */
      const link = resolveDraftThemeLink({
        variations: brandKit.variations,
        kitId,
        revision,
        globals,
        pointer: state.document.brand,
      });
      const composedGlobals = composeThemeGlobals({
        themeGlobals: target.globals,
        draftGlobals: globals,
        overriddenGlobalKeys: link.overriddenGlobalKeys,
      });
      const brandPointer = {
        kitId,
        revision,
        variationId: target.id,
        /*
          The baseline moves to the theme we just applied: from here on, the
          draft's overrides are measured against THIS payload. Without the
          move, the next edit of the same theme would re-diff against a payload
          two revisions old and read the previous adoption as an override.
        */
        baselineGlobals: target.globals,
      };
      const ops: Operation[] = [];
      if (!areGlobalsEqual({ a: composedGlobals, b: globals })) {
        /*
          Per-SECTION background overrides (innerBackgroundColor /
          outerBackgroundColor) are the BLOCK-layer half of the same idea, and
          `applyTheme` deliberately strips them. Carrying them on the op's
          `sectionOverrides` — the field the inverse already uses — re-sets them
          in the same operation, so one section painted a custom color survives
          a brand update exactly like an overridden global does.

          The theme MENU still strips them, on purpose: picking a theme is the
          explicit "make this draft this theme" gesture and is the reset path.
          Propagation is "keep this draft's decisions, take the brand's update".
        */
        const sectionOverrides = collectSectionThemeOverrides(state.doc);
        ops.push({
          name: "applyTheme",
          globals: composedGlobals,
          ...(sectionOverrides.length > 0 ? { sectionOverrides } : {}),
        } as Operation);
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
        /*
          Already rendering the target verbatim: refresh the pointer (clears
          the pill) without appending a no-op history entry.
        */
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
      /*
        `applied.inverses` is in REVERSE order: inverses[0] undoes the LAST op.
      */
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
