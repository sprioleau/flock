import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveOwnerId, resolveOwnerIdOrNull } from "./authIdentity";
import {
  assetKindValidator,
  findAssetUsage,
  MAX_ASSETS_LISTED_PER_SESSION,
  seedAssetName,
} from "./model/assets";

/*
  Content Studio Stage S (docs/proposals/content-studio.md): the per-session
  image library. `register` is THE one seam every upload path funnels through
  at the moment it resolves a serving URL — it subsumes the files.getFileUrl
  step (callers get the URL from registration itself), so adopting it is a
  one-call swap:

  - property-panel upload   → kind "uploaded"   (name = filename)
  - human-path generation   → kind "generated"  (prompt + model alt)
  - agent-path generation   → kind "generated"  (server-side, chat tool)
  - brand-kit confirm-asset → kind "logo" / "social-card" (sourceUrl = scrape origin)

  Owner decision (BINDING): every successful AI generation registers
  unconditionally at upload — the registry IS the "what I made yesterday"
  record; coupling registration to op success would reintroduce untracked
  files on the failure path.

  Ownership consequence: the document-deletion cascade RETAINS registered
  files (model/cleanup.ts) — a registered asset outlives its drafts.

  OWNERSHIP: `sessionId` is a claim, not a credential. Every row here is keyed
  by resolveOwnerId (convex/authIdentity.ts), which prefers the caller's
  verified identity and ignores the argument entirely once one exists.
*/

const assetRowValidator = v.object({
  _id: v.id("assets"),
  _creationTime: v.number(),
  sessionId: v.string(),
  storageId: v.id("_storage"),
  url: v.string(),
  kind: assetKindValidator,
  name: v.string(),
  mimeType: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
  prompt: v.optional(v.string()),
  alt: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

/*
  Load a row and require that the CALLER owns it — the single authorization
  seam shared by `rename` and `remove` (savedSections.requireOwnedRow is the
  precedent this copies).

  The asset id arrives from the client and is therefore a POINTER, not a
  permission: ids are handed out in the grid and travel through props and
  URLs. `resolveOwnerId` decides who the caller is — verified identity when
  there is one, the claimed session id only as the documented pre-auth
  fallback (convex/authIdentity.ts) — and the row's own `sessionId` is what
  that owner is checked against. This is the SAME resolution `register` and
  `listForSession` already do, deliberately: a management mutation that keyed
  off anything else would either refuse the owner their own library or hand
  someone else's away. Quoting another user's session id buys nothing, since
  with an identity present the argument is ignored outright.
*/
async function requireOwnedAsset(
  ctx: MutationCtx,
  args: { sessionId: string; assetId: Id<"assets"> },
): Promise<Doc<"assets">> {
  const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
  const row = await ctx.db.get(args.assetId);
  if (row === null) {
    throw new ConvexError("That image is no longer in your library.");
  }
  if (row.sessionId !== ownerId) {
    /*
      Deliberately the same wording a missing row gets in spirit: a non-owner
      learns only that it is not theirs, never anything about the asset.
    */
    throw new ConvexError("That image belongs to a different library.");
  }
  return row;
}

/*
  Register one uploaded storage file as a session-owned library asset and
  resolve its durable serving URL. Idempotent per storageId (the by_storageId
  index guards double-registration): re-registering returns the existing row
  untouched, so retry loops and approval-flow double-fires are safe.
*/
export const register = mutation({
  args: {
    sessionId: v.string(),
    storageId: v.id("_storage"),
    kind: assetKindValidator,
    /*
      Display name; seeded server-side when absent (filename / prompt stem / kind label).
    */
    name: v.optional(v.string()),
    /*
      kind:"generated" — the generation prompt.
    */
    prompt: v.optional(v.string()),
    /*
      Model- or user-authored alt text; inserted alongside src.
    */
    alt: v.optional(v.string()),
    /*
      kind:"logo"/"social-card" — the scrape origin.
    */
    sourceUrl: v.optional(v.string()),
  },
  returns: v.object({ assetId: v.id("assets"), url: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const existingRow = await ctx.db
      .query("assets")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (existingRow !== null) {
      return { assetId: existingRow._id, url: existingRow.url };
    }

    const url = await ctx.storage.getUrl(args.storageId);
    if (url === null) {
      throw new ConvexError("That file doesn't exist in storage — try uploading it again.");
    }
    /*
      One system-doc read at registration saves every grid render a join.
    */
    const systemDoc = await ctx.db.system.get(args.storageId);

    const nowMs = Date.now();
    const trimmedAlt = args.alt?.trim() ?? "";
    const trimmedSourceUrl = args.sourceUrl?.trim() ?? "";
    const assetId = await ctx.db.insert("assets", {
      sessionId: ownerId,
      storageId: args.storageId,
      url,
      kind: args.kind,
      name: seedAssetName({ kind: args.kind, name: args.name, prompt: args.prompt }),
      ...(systemDoc?.contentType === undefined ? {} : { mimeType: systemDoc.contentType }),
      ...(systemDoc === null ? {} : { sizeBytes: systemDoc.size }),
      ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
      ...(trimmedAlt.length === 0 ? {} : { alt: trimmedAlt }),
      ...(trimmedSourceUrl.length === 0 ? {} : { sourceUrl: trimmedSourceUrl }),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return { assetId, url };
  },
});

/*
  The session's library, newest first, bounded (see
  MAX_ASSETS_LISTED_PER_SESSION). Kind filtering happens client-side — one
  reactive query serves every filter chip without index proliferation.
*/
export const listForSession = query({
  args: { sessionId: v.string() },
  returns: v.array(assetRowValidator),
  handler: async (ctx, args) => {
    /*
      See savedSections.listForSession: a listing that mounts for everyone
      must answer "nobody" with an empty list, not an exception.
    */
    const ownerId = await resolveOwnerIdOrNull(ctx, { claimedSessionId: args.sessionId });
    if (ownerId === null) {
      return [];
    }
    return await ctx.db
      .query("assets")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerId))
      .order("desc")
      .take(MAX_ASSETS_LISTED_PER_SESSION);
  },
});

/*
  Rename one library asset (Stage M, proposal §8).

  Names are not decoration here. Two consumers read them: the human scanning
  a grid of thumbnails, and the AGENT choosing imagery for a generated draft
  — `listAssets` hands the model each asset's name and kind, and the owner's
  own framing (proposal §7.4) is that "the name of the image might be the
  only way to help the model decide which one to pull in". A library of
  IMG_4821.png is a library the agent cannot use. Renaming is therefore a
  first-class library operation, not a cosmetic one.

  A blank name RESEEDS rather than erases: `seedAssetName` falls back to the
  generation prompt (for generated images) and then to the per-kind label, so
  clearing the field can never leave an unlabelled card. Only `name` and
  `updatedAtMs` move — the storage file, the URL every draft points at, and
  the provenance fields are untouched, which is precisely why rename is the
  safe half of this pair and needs no confirmation step.
*/
export const rename = mutation({
  args: { sessionId: v.string(), assetId: v.id("assets"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await requireOwnedAsset(ctx, args);
    await ctx.db.patch(args.assetId, {
      name: seedAssetName({ kind: row.kind, name: args.name, prompt: row.prompt }),
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/*
  Delete one library asset — the row AND the storage file behind it — but
  ONLY when no draft still renders it.

  ============================================================================
  THE DELETION DECISION, and why it is this one (proposal §6.2; owner decision
  2026-07-31, recorded BINDING). The next person will ask, so here is the
  whole argument.
  ============================================================================

  WHAT THE SYSTEM ACTUALLY DOES TODAY, verified before deciding:

    - A draft's link to an image is a plain URL string in a block row's
      `properties.src`. There is no foreign key, no reference count, and no
      way to index it (`properties` is a v.record, so a nested-path index is
      impossible — model/cleanup.ts says the same thing about the same field).
      Nothing anywhere would notice a file disappearing out from under a
      draft; the draft would simply start rendering a broken image, in the
      canvas, in previews, in exported HTML, and in a sent test email.
    - Registration MOVED file ownership to this table. The document-deletion
      cascade now RETAINS any file with a row here (model/cleanup.ts, via
      isUrlRegisteredAsset), which is the whole "the image I uploaded
      yesterday outlives the draft" feature. The consequence that matters
      here: with the cascade recused, THIS mutation and the dead-session
      sweep are the only two places a registered file is ever deleted. If
      delete leaves the file behind, nothing else will ever collect it.

  SO THE THREE CANDIDATE BEHAVIORS, judged against "never destroy work the
  user did not ask to destroy":

    (a) Delete row + file unconditionally. Rejected. One click can silently
        break a draft — possibly a draft on a SHARED canvas that someone else
        is presenting — and there is no undo, because deleting stored bytes
        is not an operation the editor's undo stack can invert. The failure
        is discovered by an audience.
    (b) Soft-delete: hide the row, keep the file. Rejected, and this is the
        interesting rejection. It protects rendered drafts, but it does it by
        creating an invisible, permanently uncollectable file: the cascade
        recuses itself for anything with an asset row, and the dead-session
        sweep only reaps rows it can see. "Safe" here just means the leak is
        silent. It also buys nothing the option below doesn't already buy —
        under (c) a draft is never broken in the first place, so there is no
        damage for a tombstone to be undoing.
    (c) BLOCK the delete while the asset is in use; delete row + file
        atomically when it is not. CHOSEN. Nothing a user can see ever
        breaks, the storage story stays honest (no row, no file, no orphan),
        and the refusal is actionable in a way a silent no-op is not — it
        names the drafts, so "remove it from Spring sale first" is a
        comprehensible instruction rather than a mystery. Canva blocks in-use
        deletes for the same reason; Figma's equivalent is detach-then-delete.

  WHAT HAPPENS TO A DRAFT RENDERING THE IMAGE: by construction, nothing. It
  is the reason the delete was refused. Once the last draft stops pointing at
  the URL the delete succeeds, and no draft is left holding a dead link.

  THE ONE HONEST RESIDUAL: the in-use check sees HEAD block rows only. An
  image referenced solely from a draft's HISTORY — an op inverse, an older
  version snapshot — is invisible to it, so deleting such an asset makes a
  later undo/restore surface a 404 image. This is the identical gap the
  cleanup cascade already accepts and documents; the library inherits it
  rather than widening it, and closing it would mean scanning every
  operation's payload on every delete click.

  SHAPE: a refusal is a RESULT, not an exception (documents.deleteDocument
  is the precedent) — the caller needs the draft names to show them, and a
  thrown error is not a place to put structured data. Genuine authorization
  failures DO throw. Deleting an already-deleted asset succeeds: deletes are
  idempotent, so a double-click or a retry is not an error.
*/
export const remove = mutation({
  args: { sessionId: v.string(), assetId: v.id("assets") },
  returns: v.union(
    v.object({ isOk: v.literal(true) }),
    v.object({
      isOk: v.literal(false),
      reason: v.literal("in_use"),
      /*
        The caller's own referencing drafts, capped (MAX_USAGE_DRAFT_NAMES).
      */
      draftNames: v.array(v.string()),
      /*
        Referencing drafts that are not the caller's to name, plus the overflow.
      */
      otherDraftCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const row = await ctx.db.get(args.assetId);
    if (row === null) {
      return { isOk: true as const }; /* already gone — deletes are idempotent */
    }
    if (row.sessionId !== ownerId) {
      throw new ConvexError("That image belongs to a different library.");
    }

    const usage = await findAssetUsage(ctx, { url: row.url, ownerId });
    if (usage.isInUse) {
      return {
        isOk: false as const,
        reason: "in_use" as const,
        draftNames: usage.draftNames,
        otherDraftCount: usage.otherDraftCount,
      };
    }

    /*
      File first, then row, inside one Convex transaction — so there is no
      interleaving in which the row is gone while the file lingers with
      nothing left to point at it. `.catch` on the storage delete because a
      file already removed by an earlier partial cleanup run must not strand
      its row: the row is the thing the user asked to be rid of.
    */
    await ctx.storage.delete(row.storageId).catch(() => undefined);
    await ctx.db.delete(args.assetId);
    return { isOk: true as const };
  },
});
