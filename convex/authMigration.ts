import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

/*
  Carrying a user's work across an identity change.

  Two callers, one engine:

  1. `reKeyOwnedRows` — the `onLinkAccount` seam (convex/auth.ts). An
     anonymous user taps a magic link; Better Auth mints a durable user and
     then DELETES the anonymous row. Everything that pointed at the old id has
     to move first, or the promotion silently costs the user their brand kit.
     This is the whole reason the eval recommended the pair over the anonymous
     plugin alone (better-auth-evaluation.md §1.2, §4.3).

  2. `adoptLegacySessionData` — the manual escape hatch for a browser that
     still owns rows under its pre-auth localStorage UUID.

     DELIBERATELY `internalMutation`, i.e. NOT callable from the client. A
     public version would take the legacy session id as an argument — and that
     id is published to every collaborator through presence and comments
     (see convex/authIdentity.ts). Exposing adoption would let anyone who
     shared a document with you permanently capture your library into their
     own account: a strictly worse hole than the one this work closes. Run it
     from the Convex dashboard when a specific browser's data matters. The
     default posture is the eval's own §6.3 recommendation — let the cleanup
     cron eat orphaned demo data.

  SCOPE, stated honestly:
  - Moved: canvasOwners (the dashboard key), brandKits, assets, savedSections,
    agents (persona copies, slug included), comments on the owner's own drafts,
    and — for the adoption caller ONLY — canvases and documents. See
    `migrateOwnedRows` for why those last two cannot fire on a link.
  - NOT moved: `operations.authorId`. Per-user undo history resets at the
    link moment. Op rows are a provenance record of what actually happened;
    rewriting history to flatter a UX detail muddies the one history spine
    (eval §6.2, recommended and taken).
  - NOT moved: comments the user wrote on documents they do not own. Reaching
    those needs a table scan — `comments` is indexed by canvas/document, never
    by author. Their attribution reverts to the derived display identity.
*/

/*
  Per-table ceiling for one migration pass. A link is interactive (the user is
  staring at a redirect), and Convex mutations are transactional — an
  unbounded scan would be both slow and a conflict magnet. Demo-scale
  libraries are one to two orders of magnitude below this.

  WHAT HAPPENS AT THE CEILING, since `canvasOwners` now rides on it too: the
  overflow rows stay keyed to the anonymous id that Better Auth deletes moments
  later, so those canvases are missing from the dashboard until an operator
  re-runs the migration. They are NOT lost. Their links keep working (canvases
  are exempt from identity checks), and the cleanup cron reads a dangling
  identity-backed owner key as a CLAIMED account and retains it — check 3 of
  `classifyDocumentOwner`, convex/model/cleanup.ts. Failing in the retaining
  direction is deliberate; raising this number is not the fix, re-running
  `adoptLegacySessionData` for that user is.
*/
const MAX_ROWS_PER_TABLE = 512;

/*
  What one pass actually moved — logged, and returned for dashboard runs.
*/
const migrationResultValidator = v.object({
  canvases: v.number(),
  /*
    Dashboard ownership rows re-keyed (the count that matters on a link).
  */
  canvasOwners: v.number(),
  documents: v.number(),
  brandKits: v.number(),
  assets: v.number(),
  savedSections: v.number(),
  personas: v.number(),
  comments: v.number(),
});

type MigrationResult = {
  canvases: number;
  canvasOwners: number;
  documents: number;
  brandKits: number;
  assets: number;
  savedSections: number;
  personas: number;
  comments: number;
};

/*
  Move every ownership row from one owner key to another.

  Idempotent: re-running with the same pair is a no-op once the source owns
  nothing. Safe to call when `fromOwnerId === toOwnerId` (returns zeros), which
  happens if a linked user somehow re-enters the flow.

  ──────────────────────────────────────────────────────────────────────────────
  READ THIS BEFORE ADDING OR REMOVING A TABLE HERE. Flock keys the same human
  TWO ways, and the two callers of this function hand in keys of DIFFERENT
  kinds. Which branches can fire depends entirely on which caller you are:

    `canvases.sessionId` / `documents.sessionId`  the CLIENT's localStorage
        UUID, written verbatim from `args.sessionId` (documents.createDocument).
        Documents and canvases are deliberately exempt from identity resolution
        because the doc URL is the capability and share-by-link is the product
        (convex/authIdentity.ts, closing note), so SIGNING IN NEVER CHANGES
        THIS COLUMN. It is not an identity and proves nothing about an account.

    `canvasOwners.ownerId` and the library columns (`brandKits.sessionId`,
        `assets.sessionId`, `savedSections.sessionId`,
        `agents.createdBySessionId`, `comments.sessionId`)  the SERVER-RESOLVED
        owner — `identity.subject`, a Better Auth user id carried by a verified
        JWT, whenever the caller had an identity; the localStorage UUID only as
        the pre-auth fallback (`resolveOwnerIdOrNull`).

  So, per caller:

    reKeyOwnedRows (onLinkAccount) — `fromOwnerId` is the ANONYMOUS BETTER AUTH
        USER ID. It matches the server-resolved columns and CANNOT MATCH
        `canvases.sessionId` / `documents.sessionId`, which hold a browser UUID.
        Those two branches below are therefore INERT on this path by
        construction, not by accident.

    adoptLegacySessionData (operator) — `fromOwnerId` is the browser's
        localStorage UUID. That is exactly what those two branches exist for,
        and re-keying `documents.sessionId` onto the durable id is what makes
        check 1 of `classifyDocumentOwner` (convex/model/cleanup.ts) start
        exempting the adopted rows from the stale sweep. They are load-bearing
        here, which is why they are kept rather than deleted: the branches are
        caller-specific, not dead.
*/
async function migrateOwnedRows(
  ctx: MutationCtx,
  args: { fromOwnerId: string; toOwnerId: string },
): Promise<MigrationResult> {
  const result: MigrationResult = {
    canvases: 0,
    canvasOwners: 0,
    documents: 0,
    brandKits: 0,
    assets: 0,
    savedSections: 0,
    personas: 0,
    comments: 0,
  };
  if (args.fromOwnerId === args.toOwnerId || args.fromOwnerId.length === 0) {
    return result;
  }

  /*
    --- canvasOwners: THE DASHBOARD KEY ------------------------------------

    FIRST, because on the link path it is the only branch that fires at all.
    `canvasOwners.ownerId` is the sole column tying a canvas to an account
    (convex/canvases.ts), so leaving it behind is what made claiming an account
    empty the user's dashboard — the exact opposite of the promise the claim
    affordance makes.
  */
  const ownership = await migrateCanvasOwnerships(ctx, args);
  result.canvasOwners = ownership.movedCount;

  /*
    --- canvases (adoption caller only; see the note above) ---------------
  */
  const canvases = await ctx.db
    .query("canvases")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.fromOwnerId))
    .take(MAX_ROWS_PER_TABLE);
  for (const canvas of canvases) {
    await ctx.db.patch(canvas._id, { sessionId: args.toOwnerId });
    result.canvases += 1;
  }

  /*
    --- documents (adoption caller only; sessionId is denormalized from the
    canvas, so it holds the same browser UUID and is unreachable from a link)
  */
  const documents = await ctx.db
    .query("documents")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.fromOwnerId))
    .take(MAX_ROWS_PER_TABLE);
  for (const document of documents) {
    await ctx.db.patch(document._id, { sessionId: args.toOwnerId });
    result.documents += 1;
  }

  /*
    --- brandKits ----------------------------------------------------------
    One active kit per owner is the v1 invariant (schema.ts `brandKits`). If
    the destination already has one — a linked account that built a kit before
    this ran — the destination's kit WINS and the anonymous one is left behind
    rather than silently overwriting work the user can see.
  */
  const destinationKit = await ctx.db
    .query("brandKits")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.toOwnerId))
    .first();
  if (destinationKit === null) {
    const kits = await ctx.db
      .query("brandKits")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.fromOwnerId))
      .take(MAX_ROWS_PER_TABLE);
    for (const kit of kits) {
      await ctx.db.patch(kit._id, { sessionId: args.toOwnerId });
      result.brandKits += 1;
    }
  }

  /*
    --- assets -------------------------------------------------------------
  */
  const assets = await ctx.db
    .query("assets")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.fromOwnerId))
    .take(MAX_ROWS_PER_TABLE);
  for (const asset of assets) {
    await ctx.db.patch(asset._id, { sessionId: args.toOwnerId });
    result.assets += 1;
  }

  /*
    --- savedSections ------------------------------------------------------
  */
  const savedSections = await ctx.db
    .query("savedSections")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.fromOwnerId))
    .take(MAX_ROWS_PER_TABLE);
  for (const savedSection of savedSections) {
    await ctx.db.patch(savedSection._id, { sessionId: args.toOwnerId });
    result.savedSections += 1;
  }

  /*
    --- agents (persona copies; the owner id is baked into the slug) -------
  */
  result.personas = await migratePersonaCopies(ctx, args);

  /*
    --- comments on the owner's own drafts ---------------------------------

    Sourced from BOTH key kinds, for the same reason the branches above split:
    `documents` above is empty on the link path, so driving comment
    re-attribution off it alone meant the header's "comments are moved" claim
    was only ever true for the operator caller. The canvases named by the
    ownership rows just re-keyed are the link path's equivalent reach — and
    `comments.sessionId` IS server-resolved (convex/comments.ts), so on that
    path the rows genuinely do carry the anonymous user id and are worth moving.
  */
  result.comments = await migrateCommentAuthorship(ctx, {
    ...args,
    documentIds: await collectOwnedDocumentIds(ctx, {
      documents,
      canvasIds: ownership.canvasIds,
    }),
  });

  return result;
}

/*
  Re-key the dashboard ownership rows.

  The one-row-per-(owner, canvas) invariant `recordCanvasOwner` maintains has to
  survive this: `listMyCanvases` iterates the rows directly, so a duplicate pair
  is a duplicate card on the dashboard rather than a harmless extra row. When
  the destination already owns the canvas — a link that half-completed and is
  being retried, or a draft promotion that inherited both keys
  (`inheritCanvasOwners`) — the SOURCE row is dropped instead of patched. The
  canvas still ends up in exactly one place: the destination's list.

  Returns the canvas ids either way, since a canvas the destination already
  owned is still one whose comments belong to the same human.
*/
async function migrateCanvasOwnerships(
  ctx: MutationCtx,
  args: { fromOwnerId: string; toOwnerId: string },
): Promise<{ movedCount: number; canvasIds: Doc<"canvases">["_id"][] }> {
  const ownerRows = await ctx.db
    .query("canvasOwners")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
    .take(MAX_ROWS_PER_TABLE);

  let movedCount = 0;
  const canvasIds: Doc<"canvases">["_id"][] = [];
  for (const ownerRow of ownerRows) {
    canvasIds.push(ownerRow.canvasId);
    const existing = await ctx.db
      .query("canvasOwners")
      .withIndex("by_ownerId_and_canvasId", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("canvasId", ownerRow.canvasId),
      )
      .first();
    if (existing === null) {
      await ctx.db.patch(ownerRow._id, { ownerId: args.toOwnerId });
    } else {
      await ctx.db.delete(ownerRow._id);
    }
    movedCount += 1;
  }
  return { movedCount, canvasIds };
}

/*
  Every document whose comments this migration may re-attribute: the ones found
  by the owner key directly (adoption caller) plus every draft on a canvas the
  owner's dashboard rows point at (link caller). Deduplicated, and bounded by
  the same per-table ceiling — a link is interactive, and each id here costs one
  more indexed `comments` read downstream.
*/
async function collectOwnedDocumentIds(
  ctx: MutationCtx,
  args: {
    documents: Doc<"documents">[];
    canvasIds: Doc<"canvases">["_id"][];
  },
): Promise<Doc<"documents">["_id"][]> {
  const documentIds = new Set<Doc<"documents">["_id"]>(
    args.documents.map((document) => document._id),
  );
  for (const canvasId of args.canvasIds) {
    if (documentIds.size >= MAX_ROWS_PER_TABLE) {
      break;
    }
    const drafts = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", canvasId))
      .take(MAX_ROWS_PER_TABLE - documentIds.size);
    for (const draft of drafts) {
      documentIds.add(draft._id);
    }
  }
  return [...documentIds];
}

/*
  Persona copies carry the owner id in their slug (`user/<ownerId>/<base>` —
  personas.ts `buildSessionCopySlug`), so re-keying the column without
  rewriting the slug would leave rows the picker can no longer resolve as
  copies. The rewrite is deterministic; a slug already taken under the
  destination owner means that owner has their own copy of the same built-in,
  so the anonymous one is dropped from the migration rather than colliding.
*/
async function migratePersonaCopies(
  ctx: MutationCtx,
  args: { fromOwnerId: string; toOwnerId: string },
): Promise<number> {
  const copies = await ctx.db
    .query("agents")
    .withIndex("by_createdBySessionId", (q) =>
      q.eq("createdBySessionId", args.fromOwnerId),
    )
    .take(MAX_ROWS_PER_TABLE);

  let migratedCount = 0;
  for (const copy of copies) {
    const rewrittenSlug = rewriteCopySlug({ row: copy, ...args });
    if (rewrittenSlug !== copy.slug) {
      const existing = await ctx.db
        .query("agents")
        .withIndex("by_slug", (q) => q.eq("slug", rewrittenSlug))
        .first();
      if (existing !== null) {
        continue;
      }
    }
    await ctx.db.patch(copy._id, {
      createdBySessionId: args.toOwnerId,
      slug: rewrittenSlug,
      updatedAtMs: Date.now(),
    });
    migratedCount += 1;
  }
  return migratedCount;
}

/*
  `user/<from>/<base>` → `user/<to>/<base>`; anything else is left alone.
*/
function rewriteCopySlug(args: {
  row: Doc<"agents">;
  fromOwnerId: string;
  toOwnerId: string;
}): string {
  const copyPrefix = `user/${args.fromOwnerId}/`;
  if (!args.row.slug.startsWith(copyPrefix)) {
    return args.row.slug;
  }
  return `user/${args.toOwnerId}/${args.row.slug.slice(copyPrefix.length)}`;
}

/*
  Re-attribute comment threads on the migrated documents: the thread creator,
  each user entry's author, and whoever resolved it. Cheap and indexed, and it
  keeps a review conversation attributed to the same human after they claim
  their account (eval §6.2, recommended and taken).
*/
async function migrateCommentAuthorship(
  ctx: MutationCtx,
  args: {
    fromOwnerId: string;
    toOwnerId: string;
    documentIds: Doc<"documents">["_id"][];
  },
): Promise<number> {
  let migratedCount = 0;
  for (const documentId of args.documentIds) {
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
      .take(MAX_ROWS_PER_TABLE);
    for (const comment of comments) {
      const patch: Partial<Doc<"comments">> = {};
      if (comment.sessionId === args.fromOwnerId) {
        patch.sessionId = args.toOwnerId;
      }
      if (comment.resolvedBySessionId === args.fromOwnerId) {
        patch.resolvedBySessionId = args.toOwnerId;
      }
      const hasAuthoredEntry = comment.thread.some(
        (entry) => entry.authorSessionId === args.fromOwnerId,
      );
      if (hasAuthoredEntry) {
        patch.thread = comment.thread.map((entry) =>
          entry.authorSessionId === args.fromOwnerId
            ? { ...entry, authorSessionId: args.toOwnerId }
            : entry,
        );
      }
      if (Object.keys(patch).length === 0) {
        continue;
      }
      await ctx.db.patch(comment._id, { ...patch, updatedAtMs: Date.now() });
      migratedCount += 1;
    }
  }
  return migratedCount;
}

/*
  `onLinkAccount`: anonymous identity → durable identity. Called from
  convex/auth.ts inside the link transaction, BEFORE Better Auth deletes the
  anonymous user row.
*/
export const reKeyOwnedRows = internalMutation({
  args: { fromOwnerId: v.string(), toOwnerId: v.string() },
  returns: migrationResultValidator,
  handler: async (ctx, args) => {
    const result = await migrateOwnedRows(ctx, args);
    console.log(
      `[auth] linked anonymous ${args.fromOwnerId} → ${args.toOwnerId}:`,
      JSON.stringify(result),
    );
    return result;
  },
});

/*
  Manual, dashboard-only adoption of a pre-auth browser's data. See the file
  header for why this is not public: `legacySessionId` is a leaked value, not
  a secret, so nothing about the caller proves they owned that browser.

  Usage:
    npx convex run --component-free authMigration:adoptLegacySessionData \
      '{"legacySessionId":"<localStorage flock_session_id>","ownerId":"<better auth user id>"}'
*/
export const adoptLegacySessionData = internalMutation({
  args: { legacySessionId: v.string(), ownerId: v.string() },
  returns: migrationResultValidator,
  handler: async (ctx, args) => {
    const result = await migrateOwnedRows(ctx, {
      fromOwnerId: args.legacySessionId,
      toOwnerId: args.ownerId,
    });
    console.log(
      `[auth] adopted legacy session ${args.legacySessionId} → ${args.ownerId}:`,
      JSON.stringify(result),
    );
    return result;
  },
});
