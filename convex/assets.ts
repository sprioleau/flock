import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { resolveOwnerId, resolveOwnerIdOrNull } from "./authIdentity";
import {
  assetKindValidator,
  MAX_ASSETS_LISTED_PER_SESSION,
  seedAssetName,
} from "./model/assets";

/**
 * Content Studio Stage S (docs/proposals/content-studio.md): the per-session
 * image library. `register` is THE one seam every upload path funnels through
 * at the moment it resolves a serving URL — it subsumes the files.getFileUrl
 * step (callers get the URL from registration itself), so adopting it is a
 * one-call swap:
 *
 * - property-panel upload   → kind "uploaded"   (name = filename)
 * - human-path generation   → kind "generated"  (prompt + model alt)
 * - agent-path generation   → kind "generated"  (server-side, chat tool)
 * - brand-kit confirm-asset → kind "logo" / "social-card" (sourceUrl = scrape origin)
 *
 * Owner decision (BINDING): every successful AI generation registers
 * unconditionally at upload — the registry IS the "what I made yesterday"
 * record; coupling registration to op success would reintroduce untracked
 * files on the failure path.
 *
 * Ownership consequence: the document-deletion cascade RETAINS registered
 * files (model/cleanup.ts) — a registered asset outlives its drafts.
 *
 * OWNERSHIP: `sessionId` is a claim, not a credential. Every row here is keyed
 * by resolveOwnerId (convex/authIdentity.ts), which prefers the caller's
 * verified identity and ignores the argument entirely once one exists.
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

/**
 * Register one uploaded storage file as a session-owned library asset and
 * resolve its durable serving URL. Idempotent per storageId (the by_storageId
 * index guards double-registration): re-registering returns the existing row
 * untouched, so retry loops and approval-flow double-fires are safe.
 */
export const register = mutation({
  args: {
    sessionId: v.string(),
    storageId: v.id("_storage"),
    kind: assetKindValidator,
    /** Display name; seeded server-side when absent (filename / prompt stem / kind label). */
    name: v.optional(v.string()),
    /** kind:"generated" — the generation prompt. */
    prompt: v.optional(v.string()),
    /** Model- or user-authored alt text; inserted alongside src. */
    alt: v.optional(v.string()),
    /** kind:"logo"/"social-card" — the scrape origin. */
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
    // One system-doc read at registration saves every grid render a join.
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

/**
 * The session's library, newest first, bounded (see
 * MAX_ASSETS_LISTED_PER_SESSION). Kind filtering happens client-side — one
 * reactive query serves every filter chip without index proliferation.
 */
export const listForSession = query({
  args: { sessionId: v.string() },
  returns: v.array(assetRowValidator),
  handler: async (ctx, args) => {
    // See savedSections.listForSession: a listing that mounts for everyone
    // must answer "nobody" with an empty list, not an exception.
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
