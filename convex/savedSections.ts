import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ENRICHMENT_TEXT_CAPS,
  MAX_SAVED_SECTIONS_LISTED_PER_SESSION,
  seedSavedSectionName,
  truncateEnrichmentText,
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
  useWhen: v.optional(v.string()),
  description: v.optional(v.string()),
  useCount: v.optional(v.number()),
  lastUsedAtMs: v.optional(v.number()),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

/** Load a row and require that `sessionId` owns it (shared by all row ops). */
async function requireOwnedRow(
  ctx: MutationCtx,
  args: { sessionId: string; savedSectionId: Id<"savedSections"> },
): Promise<Doc<"savedSections">> {
  const row = await ctx.db.get(args.savedSectionId);
  if (row === null) {
    throw new ConvexError("That saved section no longer exists.");
  }
  if (row.sessionId !== args.sessionId) {
    throw new ConvexError("That saved section belongs to a different session.");
  }
  return row;
}

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

/** One row by id, session-checked (the enrichment route's read). Null when gone. */
export const getForSession = query({
  args: { sessionId: v.string(), savedSectionId: v.id("savedSections") },
  returns: v.union(savedSectionRowValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.savedSectionId);
    if (row === null || row.sessionId !== args.sessionId) {
      return null;
    }
    return row;
  },
});

/** Rename one saved section (manager modal). Blank names reseed the default. */
export const rename = mutation({
  args: { sessionId: v.string(), savedSectionId: v.id("savedSections"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnedRow(ctx, args);
    await ctx.db.patch(args.savedSectionId, {
      name: seedSavedSectionName(args.name),
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

/**
 * Record one insert (palette group, manager modal, or agent scaffold) —
 * `useCount`/`lastUsedAtMs` feed the compose context's TIEBREAKER stat.
 * Deliberately does NOT touch updatedAtMs: usage is not an edit.
 */
export const recordUse = mutation({
  args: { sessionId: v.string(), savedSectionId: v.id("savedSections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await requireOwnedRow(ctx, args);
    await ctx.db.patch(args.savedSectionId, {
      useCount: (row.useCount ?? 0) + 1,
      lastUsedAtMs: Date.now(),
    });
    return null;
  },
});

/**
 * Patch the async LLM enrichment (useWhen + description) onto a row — the
 * fails-soft tail of a save (/api/saved-sections/enrich). Truncation is the
 * storage backstop (ENRICHMENT_TEXT_CAPS); length guidance lives in the
 * generation prompt.
 */
export const applyEnrichment = mutation({
  args: {
    sessionId: v.string(),
    savedSectionId: v.id("savedSections"),
    useWhen: v.string(),
    description: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnedRow(ctx, args);
    await ctx.db.patch(args.savedSectionId, {
      useWhen: truncateEnrichmentText({ text: args.useWhen, cap: ENRICHMENT_TEXT_CAPS.useWhen }),
      description: truncateEnrichmentText({
        text: args.description,
        cap: ENRICHMENT_TEXT_CAPS.description,
      }),
      updatedAtMs: Date.now(),
    });
    return null;
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
