import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  MAX_SAVED_SECTIONS_LISTED_PER_SESSION,
  seedSavedSectionName,
  validateSavedSectionSubtree,
} from "./model/savedSections";

/**
 * Saved reusable sections (schema.ts `savedSections`): a session's bookmarked
 * section subtrees — save from the section action row, re-insert from the
 * Blocks palette's Saved group. Session-scoped exactly like `assets` (the
 * demoable-identity model): every canvas/draft of the session reads one list.
 *
 * The subtree is stored VERBATIM (original ids, restoreBlocks shape, root
 * first). Fresh ids are minted client-side at INSERT time — the
 * duplicate-block pattern — so a saved section can be inserted into any
 * document any number of times without id collisions, and the stored row
 * never needs rewriting.
 */

const savedSectionRowValidator = v.object({
  _id: v.id("savedSections"),
  _creationTime: v.number(),
  sessionId: v.string(),
  name: v.string(),
  blocks: v.array(v.any()),
  blockCount: v.number(),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

/**
 * Save one section subtree into the session's list. The blocks payload is
 * validated with the email-sdk Zod schemas + a subtree-closure check BEFORE
 * the row is written (the v.any() column's runtime guard — house policy).
 */
export const save = mutation({
  args: {
    sessionId: v.string(),
    /** Display name; seeded to "Saved section" when absent/blank. */
    name: v.optional(v.string()),
    /** The section's flat subtree, root first (restoreBlocks shape). */
    blocks: v.array(v.any()),
  },
  returns: v.object({ savedSectionId: v.id("savedSections") }),
  handler: async (ctx, args) => {
    const validation = validateSavedSectionSubtree(args.blocks);
    if (!validation.isValid) {
      throw new ConvexError(validation.message);
    }
    const nowMs = Date.now();
    const savedSectionId = await ctx.db.insert("savedSections", {
      sessionId: args.sessionId,
      name: seedSavedSectionName(args.name),
      blocks: args.blocks,
      blockCount: args.blocks.length,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return { savedSectionId };
  },
});

/**
 * The session's saved sections, newest first, bounded (see
 * MAX_SAVED_SECTIONS_LISTED_PER_SESSION). Rows carry the full blocks payload
 * so insert is one local op — no second fetch at click time.
 */
export const listForSession = query({
  args: { sessionId: v.string() },
  returns: v.array(savedSectionRowValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("savedSections")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(MAX_SAVED_SECTIONS_LISTED_PER_SESSION);
  },
});

/** Delete one saved section. Only the owning session may remove its rows. */
export const remove = mutation({
  args: { sessionId: v.string(), savedSectionId: v.id("savedSections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.savedSectionId);
    if (row === null) {
      return null; // already gone — deletes are idempotent
    }
    if (row.sessionId !== args.sessionId) {
      throw new ConvexError("That saved section belongs to a different session.");
    }
    await ctx.db.delete(args.savedSectionId);
    return null;
  },
});
