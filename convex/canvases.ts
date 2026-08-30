import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { resolveOwnerIdOrNull } from "./authIdentity";
import {
  createEmptyCleanupStats,
  deleteDocumentCascade,
  MAX_ROW_DELETIONS_PER_RUN,
} from "./model/cleanup";

/**
 * The dashboard's server half: what a signed-in person owns, and the two
 * organizing actions they can take on it (rename, delete).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE INVARIANT THIS FILE EXISTS TO HOLD
 *
 *   Ownership is for LISTING. It is never for ACCESS.
 *
 * `canvases` and `documents` are deliberately exempt from the identity checks
 * that guard every other session-scoped table (convex/authIdentity.ts, closing
 * paragraph). The id in the URL is the capability, and share-by-link — opening
 * a `?doc=` / `?canvas=` link with no account at all — is the product. So:
 *
 *   - Nothing in this file is on the read path for a canvas or a draft.
 *     `documents.getDocument`, `documents.getCanvasEntryDocument`,
 *     `documents.applyOperations` and friends are untouched and still ask
 *     nobody who they are. A stranger with a link keeps full read/write.
 *   - `listMyCanvases` is additive: it answers "which canvases go in MY list",
 *     which is a question only the dashboard asks.
 *   - `renameCanvas` / `deleteCanvas` DO check ownership, because they are
 *     library management, not editing. Renaming the container someone else
 *     owns, or deleting it out from under them, is not something a link should
 *     confer. Everything a link-holder could already do to the CONTENT — edit
 *     every block, rename drafts, add drafts, delete drafts — is unchanged.
 *
 * If a future change makes a canvas READ consult `canvasOwners`, that is the
 * bug: it breaks every shared link in existence, silently, for everyone who is
 * not signed in.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHERE `ownerId` COMES FROM
 *
 * Always `resolveOwnerIdOrNull` — the verified Better Auth subject when the
 * caller has an identity, the pre-auth localStorage fallback when they do not
 * and the deployment is not in strict mode. The client's `sessionId` argument
 * is a FALLBACK KEY, never an assertion: with identity present it is ignored
 * entirely, which is what makes the presence-roster replay attack
 * (apps/web/src/lib/auth/owner-identity.test.ts) inert here too. Someone who
 * quotes your session id gets their own empty list, not yours.
 *
 * The same resolution runs at record time and at read time, so the dashboard
 * works identically with auth on (rows keyed to the durable user id, list
 * follows you across devices) and with auth off (rows keyed to the browser's
 * localStorage UUID, list is that browser's). No branch, no second code path.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT COVERED, STATED PLAINLY
 *
 * Canvases created BEFORE this table existed have no ownership row and so do
 * not appear in any dashboard. Their links still work — nothing was lost, and
 * the drafts bar still reaches every draft on them. Backfilling them is an
 * operator action (`adoptCanvasesBySessionId` below) and NOT a client-callable
 * one, for exactly the reason `authMigration.adoptLegacySessionData` is not:
 * the legacy session id is published to every collaborator through presence,
 * so a public "adopt everything keyed to this id" mutation would let anyone
 * who once shared a canvas with you sweep your work into their account.
 */

// ---------------------------------------------------------------------------
// Ownership recording (called from documents.ts at canvas-creation time)
// ---------------------------------------------------------------------------

/**
 * Record `ownerId` as an owner of `canvasId`, idempotently.
 *
 * Not a Convex function — an internal helper the canvas-creating mutations in
 * documents.ts call inside their own transaction, so a canvas and its
 * ownership row are never separately observable.
 */
export async function recordCanvasOwner(
  ctx: MutationCtx,
  args: { canvasId: Id<"canvases">; ownerId: string },
): Promise<void> {
  // An empty owner key is what `resolveOwnerIdOrNull` returns for a caller
  // with no identity and no mirrored session cookie. Storing it would pool
  // every such caller into one shared "list", which is worse than no list.
  if (args.ownerId.length === 0) {
    return;
  }
  const existing = await ctx.db
    .query("canvasOwners")
    .withIndex("by_ownerId_and_canvasId", (q) =>
      q.eq("ownerId", args.ownerId).eq("canvasId", args.canvasId),
    )
    .first();
  if (existing !== null) {
    return;
  }
  await ctx.db.insert("canvasOwners", {
    canvasId: args.canvasId,
    ownerId: args.ownerId,
    createdAtMs: Date.now(),
  });
}

/**
 * Record the CALLING identity as an owner of a freshly created canvas.
 *
 * The resolution is deliberately the null-tolerant one: a caller with no
 * identity in a strict deployment simply gets no ownership row, and the canvas
 * still works perfectly over its link. Creating a canvas must never fail
 * because we could not decide whose list it belongs in.
 */
export async function recordCanvasOwnerFromCaller(
  ctx: MutationCtx,
  args: { canvasId: Id<"canvases">; claimedSessionId: string },
): Promise<void> {
  const ownerId = await resolveOwnerIdOrNull(ctx, {
    claimedSessionId: args.claimedSessionId,
  });
  if (ownerId === null) {
    return;
  }
  await recordCanvasOwner(ctx, { canvasId: args.canvasId, ownerId });
}

/**
 * Carry a canvas's owners onto a canvas derived from it (draft promotion).
 *
 * Inheriting rather than re-resolving is what stops a promotion from making a
 * draft vanish out of its owner's dashboard: the drafts moved, so the list
 * entry has to move with them. It also means a link-holder who promotes a
 * draft does not quietly take the result into their own library — they get the
 * same editing capability they already had, and no ownership they did not.
 *
 * A source canvas with no owner rows (created before this table existed) falls
 * back to the caller, so promoting is one way an unowned legacy canvas's
 * offspring re-enters a real dashboard.
 */
export async function inheritCanvasOwners(
  ctx: MutationCtx,
  args: {
    fromCanvasId: Id<"canvases">;
    toCanvasId: Id<"canvases">;
    claimedSessionId: string;
  },
): Promise<void> {
  const sourceOwners = await ctx.db
    .query("canvasOwners")
    .withIndex("by_canvasId", (q) => q.eq("canvasId", args.fromCanvasId))
    .collect();
  if (sourceOwners.length === 0) {
    await recordCanvasOwnerFromCaller(ctx, {
      canvasId: args.toCanvasId,
      claimedSessionId: args.claimedSessionId,
    });
    return;
  }
  for (const owner of sourceOwners) {
    await recordCanvasOwner(ctx, {
      canvasId: args.toCanvasId,
      ownerId: owner.ownerId,
    });
  }
}

/** Drop every ownership row for a canvas (its cascade step; see deleteCanvas). */
export async function deleteCanvasOwnerRows(
  ctx: MutationCtx,
  args: { canvasId: Id<"canvases"> },
): Promise<number> {
  const rows = await ctx.db
    .query("canvasOwners")
    .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
    .collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Ownership assertion
// ---------------------------------------------------------------------------

/**
 * The resolved owner, or null when the caller cannot name one. Shared by the
 * listing read and the management mutations so they can never disagree about
 * who is calling.
 */
async function resolveCallerOwnerId(
  ctx: QueryCtx | MutationCtx,
  args: { claimedSessionId: string },
): Promise<string | null> {
  const ownerId = await resolveOwnerIdOrNull(ctx, {
    claimedSessionId: args.claimedSessionId,
  });
  return ownerId === null || ownerId.length === 0 ? null : ownerId;
}

/**
 * Throw unless the caller owns this canvas.
 *
 * The refusal message is deliberately the same for "you do not own it" and
 * "it does not exist": a distinct not-found would turn this into an oracle for
 * probing which canvas ids are real. It costs nothing — the only person who
 * reaches this path in normal use is looking at their own dashboard.
 */
async function assertCanvasOwner(
  ctx: MutationCtx,
  args: { canvasId: Id<"canvases">; claimedSessionId: string },
): Promise<void> {
  const ownerId = await resolveCallerOwnerId(ctx, {
    claimedSessionId: args.claimedSessionId,
  });
  if (ownerId === null) {
    throw new ConvexError(
      "You're signed out, so we can't tell which emails are yours. Reload the page and try again.",
    );
  }
  const ownership = await ctx.db
    .query("canvasOwners")
    .withIndex("by_ownerId_and_canvasId", (q) =>
      q.eq("ownerId", ownerId).eq("canvasId", args.canvasId),
    )
    .first();
  if (ownership === null) {
    throw new ConvexError("That email isn't in your list, so it can't be changed from here.");
  }
}

// ---------------------------------------------------------------------------
// listMyCanvases — the dashboard read
// ---------------------------------------------------------------------------

/**
 * Ceiling on canvases returned to the dashboard in one read. Well beyond what
 * a person accumulates by hand; a paging cursor is the honest fix if a real
 * user ever passes it, not a bigger number.
 */
const MAX_CANVASES_LISTED = 200;

/** Draft names shown on a card before it collapses to "+N more". */
const MAX_DRAFT_PREVIEWS_PER_CANVAS = 4;

const canvasListEntryValidator = v.object({
  canvasId: v.id("canvases"),
  /**
   * Always a non-empty display string — the stored title, or one derived from
   * the canvas's first draft. Naming is resolved for the UI here rather than
   * in three components that would each drift.
   */
  title: v.string(),
  /** True when `title` was derived rather than chosen, so the UI can say so. */
  isTitleDerived: v.boolean(),
  /**
   * Canvas-level email subject / inbox preview, shared by every draft on the
   * canvas (only one draft is ever sent — see the schema comments). Absent when
   * never set; the dashboard card shows them so a user can tell canvases apart
   * by what will actually land in the inbox.
   */
  subject: v.optional(v.string()),
  previewText: v.optional(v.string()),
  draftCount: v.number(),
  /** The draft a click should open: the most recently touched one. */
  entryDocumentId: v.union(v.null(), v.id("documents")),
  /** First few draft names, for the card's preview strip. */
  draftPreviews: v.array(
    v.object({
      documentId: v.id("documents"),
      name: v.string(),
      /** Agent-authored summary (§10.2 dual naming) — shown, never edited here. */
      agentName: v.optional(v.string()),
    }),
  ),
  createdAtMs: v.number(),
  /** Latest activity across the canvas and every draft on it. */
  updatedAtMs: v.number(),
});

/**
 * Every canvas the calling identity owns, most recently touched first.
 *
 * Returns an EMPTY LIST rather than throwing when the caller has no resolvable
 * identity. A dashboard that explodes for a signed-out visitor is a worse
 * answer than one that says "nothing here yet" — and the page already has to
 * render that state well for a brand-new account.
 */
export const listMyCanvases = query({
  args: {
    /** Pre-auth fallback key only; a verified identity always wins. */
    sessionId: v.optional(v.string()),
  },
  returns: v.array(canvasListEntryValidator),
  handler: async (ctx, args) => {
    const ownerId = await resolveCallerOwnerId(ctx, {
      claimedSessionId: args.sessionId ?? "",
    });
    if (ownerId === null) {
      return [];
    }
    const ownerships = await ctx.db
      .query("canvasOwners")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(MAX_CANVASES_LISTED);

    const entries: Array<{
      canvasId: Id<"canvases">;
      title: string;
      isTitleDerived: boolean;
      subject?: string;
      previewText?: string;
      draftCount: number;
      entryDocumentId: Id<"documents"> | null;
      draftPreviews: Array<{
        documentId: Id<"documents">;
        name: string;
        agentName?: string;
      }>;
      createdAtMs: number;
      updatedAtMs: number;
    }> = [];

    for (const ownership of ownerships) {
      const canvas = await ctx.db.get(ownership.canvasId);
      if (canvas === null) {
        // The canvas was reaped (cleanup cron) while its ownership row
        // survived. Skip rather than surface a card that opens onto nothing;
        // the row is swept by the next delete or backfill pass.
        continue;
      }
      // Drafts per canvas stay small (a handful of frames); bounded, and the
      // same `collect()` the rest of documents.ts uses for this index.
      const drafts = await ctx.db
        .query("documents")
        .withIndex("by_canvasId", (q) => q.eq("canvasId", canvas._id))
        .collect();
      entries.push(buildCanvasListEntry({ canvas, drafts }));
    }

    return entries.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  },
});

/**
 * Assemble one card's worth of data from a canvas and its drafts.
 *
 * Exported for the unit tests that pin the naming and freshness rules without
 * standing up a backend.
 */
export function buildCanvasListEntry({
  canvas,
  drafts,
}: {
  canvas: Doc<"canvases">;
  drafts: Doc<"documents">[];
}) {
  const orderedDrafts = [...drafts].sort((a, b) => a.orderIndex - b.orderIndex);
  const storedTitle = canvas.title?.trim() ?? "";
  const hasStoredTitle = storedTitle.length > 0;

  // A canvas card with no name is useless to scan, and `canvases.title` is
  // optional and usually unset (nothing in the studio ever asked for one). Fall
  // back to the first draft's name, which the user DID choose or accept, and
  // only then to a generic. `isTitleDerived` lets the card show the difference
  // instead of pretending the user named this.
  const derivedTitle = orderedDrafts[0]?.name.trim() ?? "";
  const title = hasStoredTitle
    ? storedTitle
    : derivedTitle.length > 0
      ? derivedTitle
      : "Untitled email";

  // Freshness is the MAX across the canvas row and every draft on it. The
  // canvas row is only patched by structural changes (draft added, renamed,
  // deleted, promoted); ordinary editing bumps the draft. Reading only the
  // canvas would show a card as untouched for weeks of daily work.
  const updatedAtMs = orderedDrafts.reduce(
    (latest, draft) => Math.max(latest, draft.updatedAtMs),
    canvas.updatedAtMs,
  );

  const mostRecentDraft =
    orderedDrafts.length === 0
      ? null
      : orderedDrafts.reduce((latest, draft) =>
          draft.updatedAtMs > latest.updatedAtMs ? draft : latest,
        );

  return {
    canvasId: canvas._id,
    title,
    isTitleDerived: !hasStoredTitle,
    // Canvas-level and independent of the derived/stored title above; forwarded
    // only when present so an unset field stays absent rather than "".
    ...(canvas.subject !== undefined ? { subject: canvas.subject } : {}),
    ...(canvas.previewText !== undefined ? { previewText: canvas.previewText } : {}),
    draftCount: orderedDrafts.length,
    entryDocumentId: mostRecentDraft === null ? null : mostRecentDraft._id,
    draftPreviews: orderedDrafts.slice(0, MAX_DRAFT_PREVIEWS_PER_CANVAS).map((draft) => ({
      documentId: draft._id,
      name: draft.name,
      ...(draft.agentName !== undefined ? { agentName: draft.agentName } : {}),
    })),
    createdAtMs: canvas.createdAtMs,
    updatedAtMs,
  };
}

// ---------------------------------------------------------------------------
// renameCanvas / deleteCanvas — the dashboard's organizing actions
// ---------------------------------------------------------------------------

/**
 * Give a canvas a name of the user's choosing.
 *
 * This is the first writer of `canvases.title` in the app — the studio never
 * asked for one — which is why `buildCanvasListEntry` has a derivation
 * fallback for every canvas that predates the dashboard.
 */
export const renameCanvas = mutation({
  args: {
    canvasId: v.id("canvases"),
    title: v.string(),
    /** Pre-auth fallback key only; a verified identity always wins. */
    sessionId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertCanvasOwner(ctx, {
      canvasId: args.canvasId,
      claimedSessionId: args.sessionId ?? "",
    });
    const title = args.title.trim();
    if (title.length === 0) {
      // Same posture as documents.renameDocument: the UI trims and guards, and
      // a blank name is a no-op rather than a thrown error.
      return false;
    }
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      return false;
    }
    if (canvas.title === title) {
      return true;
    }
    await ctx.db.patch(args.canvasId, { title, updatedAtMs: Date.now() });
    return true;
  },
});

/**
 * Ceilings on the canvas-level email subject / preview text. A subject much
 * over this never survives an inbox's own truncation, and the preview is a
 * short preheader, so 200 is generous for both. Over-length input is TRUNCATED
 * rather than rejected: like `renameCanvas`, this mutation never throws for a
 * merely-too-long value — the dialog enforces the limit at the input, and a
 * server that silently clamps a stray long paste is friendlier than one that
 * fails the save. The client-facing UI owns the hard cap; this is the backstop.
 */
const MAX_SUBJECT_LENGTH = 200;
const MAX_PREVIEW_LENGTH = 200;

/**
 * Set the canvas-level email subject and/or preview text.
 *
 * CANVAS-LEVEL, not per draft: only one draft is ever sent, so the subject and
 * preview the recipient sees belong to the canvas (schema comments carry the
 * full reasoning). Modelled on `renameCanvas` — same ownership guard, same
 * pre-auth `sessionId` fallback-key posture — because this is library
 * management of the container, not editing of a draft's content.
 *
 * PARTIAL PATCH: each of `subject` / `previewText` is written ONLY when the
 * caller passed it. A dialog that saves just the subject must not wipe the
 * preview text, so an omitted arg is left exactly as it was.
 *
 * EMPTY CLEARS: a provided value is trimmed; if nothing survives the trim the
 * field is CLEARED to a clean absent state (`patch({ field: undefined })`)
 * rather than stored as `""`. This mirrors `brandKits.unbindCanvasBrandKit`,
 * which clears `brandKitId` the same way — Convex's `db.patch` treats an
 * explicit `undefined` as "remove this optional field", so a later read sees
 * the field genuinely absent, not an empty string the UI would have to special
 * case (verified empirically by the "empty clears" test for this mutation).
 *
 * Returns true when the canvas was found and (any) update applied, false when
 * it no longer exists. A non-owner is REFUSED by `assertCanvasOwner` before any
 * of this runs.
 */
export const setCanvasEmailMeta = mutation({
  args: {
    canvasId: v.id("canvases"),
    subject: v.optional(v.string()),
    previewText: v.optional(v.string()),
    /** Pre-auth fallback key only; a verified identity always wins. */
    sessionId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertCanvasOwner(ctx, {
      canvasId: args.canvasId,
      claimedSessionId: args.sessionId ?? "",
    });
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      return false;
    }

    // Build the patch from ONLY the fields the caller sent. `undefined` in the
    // patch means "clear this optional field"; a field never added to `patch`
    // is left untouched. A trimmed-to-empty value maps to the clear.
    const patch: {
      subject?: string | undefined;
      previewText?: string | undefined;
      updatedAtMs: number;
    } = { updatedAtMs: Date.now() };

    if (args.subject !== undefined) {
      const subject = args.subject.trim().slice(0, MAX_SUBJECT_LENGTH);
      patch.subject = subject.length === 0 ? undefined : subject;
    }
    if (args.previewText !== undefined) {
      const previewText = args.previewText.trim().slice(0, MAX_PREVIEW_LENGTH);
      patch.previewText = previewText.length === 0 ? undefined : previewText;
    }

    await ctx.db.patch(args.canvasId, patch);
    return true;
  },
});

/**
 * The canvas-level email subject / preview for a single canvas, or null when
 * the canvas is gone.
 *
 * The send dialog lives in the studio, whose other canvas-level reads are
 * already keyed by `canvasId` (brandKits.getBrandKitForCanvas /
 * getCanvasBrandStatus). This follows that convention rather than bolting
 * canvas-level fields onto the per-draft document payload. Absent fields are
 * omitted, so the shape is `{}` for a canvas that has neither set — the
 * frontend reads `subject` / `previewText` as optional.
 *
 * NOT an access gate (see this file's header): the id in the URL is the
 * capability, so — like every other canvas READ — this asks the caller nobody
 * who they are. Only the WRITE (`setCanvasEmailMeta`) checks ownership.
 */
export const getCanvasEmailMeta = query({
  args: { canvasId: v.id("canvases") },
  returns: v.union(
    v.null(),
    v.object({
      subject: v.optional(v.string()),
      previewText: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      return null;
    }
    return {
      ...(canvas.subject !== undefined ? { subject: canvas.subject } : {}),
      ...(canvas.previewText !== undefined ? { previewText: canvas.previewText } : {}),
    };
  },
});

/**
 * Delete a canvas and every draft on it.
 *
 * Runs the SAME per-document cascade as the cleanup cron and the single-draft
 * delete (model/cleanup.ts) — one deletion path, no drift, and the blocks /
 * operations / snapshots / sync docs / storage files / findings / comments of
 * every draft go with it.
 *
 * Unlike `documents.deleteDocument` there is no last-draft guard: deleting the
 * container is exactly the operation that is allowed to take the final draft
 * with it. The cascade's own step 8 removes the canvas row once its last
 * document is gone; when a budget-exhausted run leaves documents behind, the
 * canvas survives this call and the scheduled continuation finishes it.
 */
export const deleteCanvas = mutation({
  args: {
    canvasId: v.id("canvases"),
    /** Pre-auth fallback key only; a verified identity always wins. */
    sessionId: v.optional(v.string()),
  },
  returns: v.object({
    isOk: v.boolean(),
    /** Drafts actually removed by this call (a partial run finishes out of band). */
    deletedDraftCount: v.number(),
    /** False when the budget ran out and a continuation was scheduled. */
    isComplete: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await assertCanvasOwner(ctx, {
      canvasId: args.canvasId,
      claimedSessionId: args.sessionId ?? "",
    });
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      // Ownership row outlived the canvas (reaped by the cron). Sweep the
      // stale row so the dashboard stops carrying a dead entry.
      await deleteCanvasOwnerRows(ctx, { canvasId: args.canvasId });
      return { isOk: true, deletedDraftCount: 0, isComplete: true };
    }

    const drafts = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .collect();

    const budget = { remaining: MAX_ROW_DELETIONS_PER_RUN };
    const stats = createEmptyCleanupStats();
    let isComplete = true;
    for (const draft of drafts) {
      const result = await deleteDocumentCascade({ ctx, document: draft, budget, stats });
      if (!result.isComplete) {
        isComplete = false;
        break;
      }
    }

    if (isComplete) {
      // The cascade deletes the canvas row itself on its last document (step
      // 8), but a canvas that held NO drafts never reaches that step — patch
      // over both cases explicitly rather than depending on which ran.
      const survivingCanvas = await ctx.db.get(args.canvasId);
      if (survivingCanvas !== null) {
        await ctx.db.delete(args.canvasId);
      }
      await deleteCanvasOwnerRows(ctx, { canvasId: args.canvasId });
    }

    return {
      isOk: true,
      deletedDraftCount: stats.deletedDocuments,
      isComplete,
    };
  },
});

// ---------------------------------------------------------------------------
// Operator backfill
// ---------------------------------------------------------------------------

/** Per-run ceiling, mirroring authMigration's MAX_ROWS_PER_TABLE posture. */
const MAX_BACKFILL_CANVASES = 512;

/**
 * Give an owner ownership rows for every canvas keyed to a legacy session id.
 *
 * DELIBERATELY `internalMutation`, for the same reason
 * `authMigration.adoptLegacySessionData` is: `legacySessionId` is published to
 * every collaborator through the presence roster, so a public version would
 * let anyone who once shared a canvas with you pull your whole library into
 * their dashboard. Run it from the Convex dashboard for a specific browser.
 *
 * Usage:
 *   npx convex run --component-free canvases:adoptCanvasesBySessionId \
 *     '{"legacySessionId":"<localStorage flock_session_id>","ownerId":"<better auth user id>"}'
 */
export const adoptCanvasesBySessionId = internalMutation({
  args: { legacySessionId: v.string(), ownerId: v.string() },
  returns: v.object({ adoptedCanvases: v.number() }),
  handler: async (ctx, args) => {
    if (args.legacySessionId.length === 0 || args.ownerId.length === 0) {
      return { adoptedCanvases: 0 };
    }
    const canvases = await ctx.db
      .query("canvases")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.legacySessionId))
      .take(MAX_BACKFILL_CANVASES);
    let adoptedCanvases = 0;
    for (const canvas of canvases) {
      const before = await ctx.db
        .query("canvasOwners")
        .withIndex("by_ownerId_and_canvasId", (q) =>
          q.eq("ownerId", args.ownerId).eq("canvasId", canvas._id),
        )
        .first();
      if (before !== null) {
        continue;
      }
      await recordCanvasOwner(ctx, { canvasId: canvas._id, ownerId: args.ownerId });
      adoptedCanvases += 1;
    }
    console.log(
      `[dashboard] adopted ${adoptedCanvases} canvases from session ${args.legacySessionId} → ${args.ownerId}`,
    );
    return { adoptedCanvases };
  },
});
