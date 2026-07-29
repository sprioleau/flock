import {
  applyOperation,
  applyOperations as applyOperationsToDocument,
  type Operation,
} from "@tandem/email-sdk";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import {
  commitVersions,
  loadDocumentState,
  MAX_OPERATIONS_PER_CALL,
  operationErrorValidator,
  toTransportErrors,
  type CommitEntry,
} from "./model/emailDocuments";

/**
 * Phase 4.3 groundwork — per-user undo/redo and one-click AI-batch revert.
 *
 * History model: undo NEVER rewrites the log. Undoing an op applies its
 * stored inverse as a NEW operation (a new version, kind "undo"), and the
 * original row is marked `isUndone`/`undoneByVersion`. Redo applies the undo
 * entry's inverse as a NEW op (kind "redo"), un-marks the original edit, and
 * marks the undo entry as undone. The version sequence therefore stays
 * append-only and dense — which is exactly what makes point-in-time reads
 * (getDocumentAtVersion) trivially correct.
 *
 * Per-user semantics (plan 4.3): undo targets the REQUESTING author's latest
 * not-yet-undone "edit" op, not the globally-latest op. Cross-user conflicts
 * are possible — another author may have changed or removed the target block
 * since — in which case the SDK apply of the inverse fails and the structured
 * errors are returned (reason "conflict") for the caller to surface; the
 * document is never partially modified.
 */

const historyFailureValidator = v.object({
  isOk: v.literal(false),
  reason: v.union(
    v.literal("document_not_found"),
    v.literal("nothing_to_undo"),
    v.literal("nothing_to_redo"),
    v.literal("batch_not_found"),
    v.literal("nothing_to_revert"),
    v.literal("conflict"),
  ),
  errors: v.optional(v.array(operationErrorValidator)),
});

/** Author's latest operation row matching `kind` that is not itself undone. */
async function findLatestEligible({
  ctx,
  documentId,
  authorId,
  kind,
}: {
  ctx: QueryCtx;
  documentId: Id<"documents">;
  authorId: string;
  kind: "edit" | "undo";
}): Promise<Doc<"operations"> | null> {
  // Lazy async iteration: rows are read newest-first and we stop at the first
  // eligible one, so the scan is bounded by how many of the author's recent
  // ops are undo/redo bookkeeping.
  const authorOpsNewestFirst = ctx.db
    .query("operations")
    .withIndex("by_documentId_and_authorId", (q) =>
      q.eq("documentId", documentId).eq("authorId", authorId),
    )
    .order("desc");
  for await (const row of authorOpsNewestFirst) {
    if (row.kind === kind && row.isUndone !== true) {
      return row;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// canUndoRedo — reactive enabled/disabled state for the toolbar buttons
// ---------------------------------------------------------------------------

export const canUndoRedo = query({
  args: {
    documentId: v.id("documents"),
    authorId: v.string(),
  },
  returns: v.object({ canUndo: v.boolean(), canRedo: v.boolean() }),
  handler: async (ctx, args) => {
    // Mirrors exactly what undo/redo would target: the author's latest
    // not-yet-undone "edit" (undo) / "undo" (redo) entry.
    const [undoTarget, redoTarget] = await Promise.all([
      findLatestEligible({ ctx, documentId: args.documentId, authorId: args.authorId, kind: "edit" }),
      findLatestEligible({ ctx, documentId: args.documentId, authorId: args.authorId, kind: "undo" }),
    ]);
    return { canUndo: undoTarget !== null, canRedo: redoTarget !== null };
  },
});

// ---------------------------------------------------------------------------
// undo
// ---------------------------------------------------------------------------

export const undo = mutation({
  args: {
    documentId: v.id("documents"),
    /** The requesting author: only THEIR latest not-undone edit is undone. */
    authorId: v.string(),
  },
  returns: v.union(
    v.object({
      isOk: v.literal(true),
      /** The version of the original edit that was undone. */
      undoneVersion: v.number(),
      /** The version of the new undo entry. */
      newVersion: v.number(),
      headVersion: v.number(),
    }),
    historyFailureValidator,
  ),
  handler: async (ctx, args) => {
    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      return { isOk: false as const, reason: "document_not_found" as const };
    }
    const target = await findLatestEligible({
      ctx,
      documentId: args.documentId,
      authorId: args.authorId,
      kind: "edit",
    });
    if (target === null) {
      return { isOk: false as const, reason: "nothing_to_undo" as const };
    }
    // Rebase-by-revalidation: the inverse may no longer apply cleanly if
    // another author changed the target since. The SDK decides.
    const result = applyOperation(state.doc, target.inverse as Operation);
    if (!result.isOk) {
      return {
        isOk: false as const,
        reason: "conflict" as const,
        errors: toTransportErrors(result.errors),
      };
    }
    const commit = await commitVersions({
      ctx,
      state,
      newDoc: result.doc,
      entries: [
        {
          op: target.inverse as Operation,
          inverse: result.inverse,
          kind: "undo" as const,
          undoesVersion: target.version,
        },
      ],
      // The undo entry is authored by the requester through the UI.
      context: { authorId: args.authorId, author: "user", caller: "frontend" },
    });
    const newVersion = commit.appliedVersions[0]!;
    await ctx.db.patch(target._id, { isUndone: true, undoneByVersion: newVersion });
    return {
      isOk: true as const,
      undoneVersion: target.version,
      newVersion,
      headVersion: commit.headVersion,
    };
  },
});

// ---------------------------------------------------------------------------
// redo
// ---------------------------------------------------------------------------

export const redo = mutation({
  args: {
    documentId: v.id("documents"),
    authorId: v.string(),
  },
  returns: v.union(
    v.object({
      isOk: v.literal(true),
      /** The version of the undo entry that was reversed. */
      redoneUndoVersion: v.number(),
      /** The version of the original edit whose effect was restored. */
      restoredVersion: v.number(),
      /** The version of the new redo entry. */
      newVersion: v.number(),
      headVersion: v.number(),
    }),
    historyFailureValidator,
  ),
  handler: async (ctx, args) => {
    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      return { isOk: false as const, reason: "document_not_found" as const };
    }
    const undoEntry = await findLatestEligible({
      ctx,
      documentId: args.documentId,
      authorId: args.authorId,
      kind: "undo",
    });
    if (undoEntry === null || undoEntry.undoesVersion === undefined) {
      return { isOk: false as const, reason: "nothing_to_redo" as const };
    }
    // The undo entry's inverse re-applies the original edit's effect.
    const result = applyOperation(state.doc, undoEntry.inverse as Operation);
    if (!result.isOk) {
      return {
        isOk: false as const,
        reason: "conflict" as const,
        errors: toTransportErrors(result.errors),
      };
    }
    const commit = await commitVersions({
      ctx,
      state,
      newDoc: result.doc,
      entries: [
        {
          op: undoEntry.inverse as Operation,
          inverse: result.inverse,
          kind: "redo" as const,
          redoesVersion: undoEntry.version,
        },
      ],
      context: { authorId: args.authorId, author: "user", caller: "frontend" },
    });
    const newVersion = commit.appliedVersions[0]!;
    // The undo entry is now itself undone; the original edit is live again
    // (so a further undo targets it once more).
    await ctx.db.patch(undoEntry._id, { isUndone: true, undoneByVersion: newVersion });
    const originalEdit = await ctx.db
      .query("operations")
      .withIndex("by_documentId_and_version", (q) =>
        q.eq("documentId", args.documentId).eq("version", undoEntry.undoesVersion!),
      )
      .unique();
    if (originalEdit !== null) {
      await ctx.db.patch(originalEdit._id, { isUndone: undefined, undoneByVersion: undefined });
    }
    return {
      isOk: true as const,
      redoneUndoVersion: undoEntry.version,
      restoredVersion: undoEntry.undoesVersion,
      newVersion,
      headVersion: commit.headVersion,
    };
  },
});

// ---------------------------------------------------------------------------
// revertBatch — one-click AI-batch revert
// ---------------------------------------------------------------------------

export const revertBatch = mutation({
  args: {
    documentId: v.id("documents"),
    /** The batchId the AI turn's ops were applied under. */
    batchId: v.string(),
    /** The requester; the revert entries are authored by them. */
    authorId: v.string(),
  },
  returns: v.union(
    v.object({
      isOk: v.literal(true),
      /** Versions of the original batch edits that were reverted (newest first). */
      revertedVersions: v.array(v.number()),
      /** Versions of the new undo entries, in application order. */
      appliedVersions: v.array(v.number()),
      headVersion: v.number(),
    }),
    historyFailureValidator,
  ),
  handler: async (ctx, args) => {
    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      return { isOk: false as const, reason: "document_not_found" as const };
    }
    // A batch is one AI turn: bounded by MAX_OPERATIONS_PER_CALL, safe to collect.
    const batchRows = await ctx.db
      .query("operations")
      .withIndex("by_documentId_and_batchId", (q) =>
        q.eq("documentId", args.documentId).eq("batchId", args.batchId),
      )
      .collect();
    if (batchRows.length === 0) {
      return { isOk: false as const, reason: "batch_not_found" as const };
    }
    // Skip bookkeeping entries and edits already undone individually.
    const targets = batchRows
      .filter((row) => row.kind === "edit" && row.isUndone !== true)
      .sort((a, b) => b.version - a.version);
    if (targets.length === 0) {
      return { isOk: false as const, reason: "nothing_to_revert" as const };
    }
    // Apply the inverses newest-first (LIFO), all-or-nothing. If any inverse
    // no longer applies (cross-user conflict), nothing is written.
    const inverseOps = targets.map((row) => row.inverse as Operation);
    const result = applyOperationsToDocument(state.doc, inverseOps);
    if (!result.isOk) {
      return {
        isOk: false as const,
        reason: "conflict" as const,
        errors: toTransportErrors(result.errors),
      };
    }
    const entries: CommitEntry[] = targets.map((row, targetIndex) => ({
      op: row.inverse as Operation,
      inverse: result.inverses[targets.length - 1 - targetIndex]!,
      kind: "undo" as const,
      undoesVersion: row.version,
      // Group the revert itself so it is attributable as one action.
      batchId: `revert:${args.batchId}`,
    }));
    const commit = await commitVersions({
      ctx,
      state,
      newDoc: result.doc,
      entries,
      context: { authorId: args.authorId, author: "user", caller: "frontend" },
    });
    for (const [targetIndex, row] of targets.entries()) {
      await ctx.db.patch(row._id, {
        isUndone: true,
        undoneByVersion: commit.appliedVersions[targetIndex]!,
      });
    }
    return {
      isOk: true as const,
      revertedVersions: targets.map((row) => row.version),
      appliedVersions: commit.appliedVersions,
      headVersion: commit.headVersion,
    };
  },
});

// ---------------------------------------------------------------------------
// rollbackToVersion — restore the document to a historical version
// ---------------------------------------------------------------------------

const rollbackFailureValidator = v.object({
  isOk: v.literal(false),
  reason: v.union(
    v.literal("document_not_found"),
    v.literal("invalid_version"),
    v.literal("nothing_to_restore"),
    v.literal("too_many_operations"),
    v.literal("conflict"),
  ),
  errors: v.optional(v.array(operationErrorValidator)),
});

/**
 * Restore the document to the exact state it had at `version`, WITHOUT
 * rewriting history: the stored inverses of every operation row newer than
 * `version` are applied newest-first (LIFO) as NEW op rows — same style as
 * revertBatch. Because each inverse was generated against the exact document
 * state its op transformed, a full LIFO unwind is deterministic: the result
 * equals `getDocumentAtVersion(version)` and, unlike a partial unwind, it is
 * conflict-free by construction. All-or-nothing.
 *
 * ALL rows in the range are unwound — including undo/redo bookkeeping entries
 * and edits already marked undone (their reversing entry is in the range too,
 * so the pair cancels). Undo-semantics bookkeeping: every unwound row not
 * already `isUndone` is marked undone by its rollback entry, so per-author
 * undo/redo targeting stays consistent afterwards.
 *
 * The rollback entries share batchId `rollback:<version>`: the restore shows
 * up in history as one attributable group and is itself reversible — restore
 * the pre-rollback head version (or redo) to step back.
 */
export const rollbackToVersion = mutation({
  args: {
    documentId: v.id("documents"),
    /** The historical version to restore (0 = the document as created). */
    version: v.number(),
    /** The requester; the rollback entries are authored by them. */
    authorId: v.string(),
  },
  returns: v.union(
    v.object({
      isOk: v.literal(true),
      /** The version whose state the document was restored to. */
      restoredVersion: v.number(),
      /** Versions of the new rollback entries, in application order. */
      appliedVersions: v.array(v.number()),
      headVersion: v.number(),
    }),
    rollbackFailureValidator,
  ),
  handler: async (ctx, args) => {
    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      return { isOk: false as const, reason: "document_not_found" as const };
    }
    const { headVersion } = state.document;
    if (!Number.isInteger(args.version) || args.version < 0 || args.version > headVersion) {
      return { isOk: false as const, reason: "invalid_version" as const };
    }
    if (args.version === headVersion) {
      return { isOk: false as const, reason: "nothing_to_restore" as const };
    }
    // Every op row newer than the target version, newest first (LIFO unwind
    // order). Versions are dense, so this is exactly head - version rows.
    const targets = await ctx.db
      .query("operations")
      .withIndex("by_documentId_and_version", (q) =>
        q.eq("documentId", args.documentId).gt("version", args.version),
      )
      .order("desc")
      .take(MAX_OPERATIONS_PER_CALL + 1);
    if (targets.length > MAX_OPERATIONS_PER_CALL) {
      return { isOk: false as const, reason: "too_many_operations" as const };
    }
    if (targets.length === 0) {
      return { isOk: false as const, reason: "nothing_to_restore" as const };
    }
    // Unreachable in practice (see doc comment) but the SDK still arbitrates;
    // on any failure nothing is written.
    const inverseOps = targets.map((row) => row.inverse as Operation);
    const result = applyOperationsToDocument(state.doc, inverseOps);
    if (!result.isOk) {
      return {
        isOk: false as const,
        reason: "conflict" as const,
        errors: toTransportErrors(result.errors),
      };
    }
    const rollbackBatchId = `rollback:${args.version}`;
    const entries: CommitEntry[] = targets.map((row, targetIndex) => ({
      op: row.inverse as Operation,
      inverse: result.inverses[targets.length - 1 - targetIndex]!,
      kind: "undo" as const,
      undoesVersion: row.version,
      batchId: rollbackBatchId,
    }));
    const commit = await commitVersions({
      ctx,
      state,
      newDoc: result.doc,
      entries,
      context: { authorId: args.authorId, author: "user", caller: "frontend" },
    });
    for (const [targetIndex, row] of targets.entries()) {
      if (row.isUndone !== true) {
        await ctx.db.patch(row._id, {
          isUndone: true,
          undoneByVersion: commit.appliedVersions[targetIndex]!,
        });
      }
    }
    return {
      isOk: true as const,
      restoredVersion: args.version,
      appliedVersions: commit.appliedVersions,
      headVersion: commit.headVersion,
    };
  },
});
