import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import {
  classifyDocumentOwner,
  createEmptyCleanupStats,
  DEFAULT_RETENTION_DAYS,
  deleteDocumentCascade,
  loadAuthUserIndex,
  MAX_ROW_DELETIONS_PER_RUN,
  MAX_STALE_DOCUMENTS_PER_RUN,
  MS_PER_DAY,
  sweepDeadSessionRows,
  type AuthUserIndex,
} from "./model/cleanup";
import { findLiveBlockRow } from "./model/textBlockSync";

/*
  Phase 6.1 — registered internal functions for the unclaimed-session
  cleanup cron (see model/cleanup.ts for the design; crons.ts schedules
  cleanupStaleDocuments daily). Internal-only: never callable from clients.
*/

/*
  Delay before a continuation run when one mutation's budget was not enough.
*/
const CONTINUATION_DELAY_MS = 10_000;

/*
  Hard cap on documents per run, regardless of the arg.
*/
const MAX_DOCUMENTS_ARG = 25;

/*
  Bound on ids per deleteOrphanSyncDocs call (each id fans out component work).
*/
const MAX_ORPHAN_IDS_PER_CALL = 50;

const cleanupStatsValidator = v.object({
  deletedDocuments: v.number(),
  deletedCanvases: v.number(),
  deletedBlocks: v.number(),
  deletedOperations: v.number(),
  deletedSnapshots: v.number(),
  deletedSyncDocs: v.number(),
  deletedStorageFiles: v.number(),
  deletedBrandKits: v.number(),
  deletedAssets: v.number(),
  deletedSavedSections: v.number(),
  deletedPersonaCopies: v.number(),
  /*
    True when a continuation run was scheduled (more stale data remains).
  */
  hasScheduledContinuation: v.boolean(),
  /*
    Stale documents left alone because their owner has a claimed account.
  */
  exemptedClaimedDocuments: v.number(),
});

/*
  Delete every document (and its full constellation) with no activity for
  `retentionDays` (owner decision: 30-day retention), UNLESS its owner has a
  claimed account — claimed accounts are exempt from the sweep entirely
  (model/cleanup.ts classifyDocumentOwner carries the reasoning and the two
  gaps). Once a swept session owns nothing at all, its session-keyed library
  goes too (sweepDeadSessionRows).

  Bounded: at most `maxDocuments` documents and MAX_ROW_DELETIONS_PER_RUN row
  deletions per run; when either bound is hit, a continuation is scheduled —
  so one daily cron tick eventually drains any backlog without ever exceeding
  Convex mutation limits. Idempotent and resumable (see deleteDocumentCascade).

  `onlyDocumentId` narrows the run to a single document (still gated on the
  cutoff) — for surgical testing with `retentionDays: 0` without sweeping
  the whole deployment, AND as the continuation of a user-invoked draft delete
  (documents.deleteDocument). That second caller is why a targeted run skips
  both the ownership exemption and the session sweep: the human asked for that
  specific delete, so refusing to finish the cascade because they signed up
  would strand a half-deleted document forever.
*/
export const cleanupStaleDocuments = internalMutation({
  args: {
    /*
      Days without activity before a document is stale. Default 30.
    */
    retentionDays: v.optional(v.number()),
    /*
      Stale documents to process this run. Default 5, max 25.
    */
    maxDocuments: v.optional(v.number()),
    /*
      Restrict the run to this document (testing / targeted deletes).
    */
    onlyDocumentId: v.optional(v.id("documents")),
  },
  returns: cleanupStatsValidator,
  handler: async (ctx, args) => {
    const retentionDays = Math.max(args.retentionDays ?? DEFAULT_RETENTION_DAYS, 0);
    const maxDocuments = Math.min(
      Math.max(Math.floor(args.maxDocuments ?? MAX_STALE_DOCUMENTS_PER_RUN), 1),
      MAX_DOCUMENTS_ARG,
    );
    const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;
    const isTargetedRun = args.onlyDocumentId !== undefined;

    let staleDocuments: Doc<"documents">[];
    if (args.onlyDocumentId !== undefined) {
      const document = await ctx.db.get(args.onlyDocumentId);
      staleDocuments = document !== null && document.updatedAtMs < cutoffMs ? [document] : [];
    } else {
      staleDocuments = await ctx.db
        .query("documents")
        .withIndex("by_updatedAtMs", (q) => q.lt("updatedAtMs", cutoffMs))
        .take(maxDocuments);
    }

    const budget = { remaining: MAX_ROW_DELETIONS_PER_RUN };
    const stats = createEmptyCleanupStats();

    /*
      The claimed-account exemption. Read once per run rather than per
      document, and BEFORE anything is deleted: when it cannot be built
      completely the run deletes nothing at all, because a partial exemption
      set does not lose a few stale rows, it loses the work of whichever users
      fell off the end of it.
    */
    let authUsers: AuthUserIndex | null = null;
    if (!isTargetedRun && staleDocuments.length > 0) {
      authUsers = await loadAuthUserIndex(ctx);
      if (authUsers === null) {
        return { ...stats, hasScheduledContinuation: false, exemptedClaimedDocuments: 0 };
      }
    }

    const unclaimedOwnerKeys = new Set<string>();
    let hasIncompleteCascade = false;
    let sweptDocumentCount = 0;
    let exemptedClaimedDocuments = 0;
    for (const document of staleDocuments) {
      if (authUsers !== null) {
        const verdict = await classifyDocumentOwner({ ctx, document, authUsers });
        if (verdict.isClaimed) {
          exemptedClaimedDocuments += 1;
          continue;
        }
        for (const ownerKey of verdict.unclaimedOwnerKeys) {
          unclaimedOwnerKeys.add(ownerKey);
        }
      }
      const { isComplete } = await deleteDocumentCascade({ ctx, document, budget, stats });
      if (!isComplete) {
        hasIncompleteCascade = true;
        break;
      }
      sweptDocumentCount += 1;
    }

    /*
      The session-keyed library of every session this run emptied. Ordered
      after the cascades because the liveness gate inside is "owns no canvas
      and no document", which only becomes true once they are gone — and which
      is also what makes this safe after a cascade was cut short: that
      session's document still exists, so its library is left alone.
    */
    if (!isTargetedRun) {
      for (const ownerKey of unclaimedOwnerKeys) {
        await sweepDeadSessionRows({ ctx, ownerKey, cutoffMs, budget, stats });
      }
    }

    /*
      Continue when the budget cut a cascade short, or when a full page of
      stale documents suggests more are waiting behind it.
    */
    //
    /*
      `sweptDocumentCount > 0` is what keeps the exemption from becoming an
      infinite reschedule: the stale scan is ordered by updatedAtMs, so a full
      page of documents that were ALL exempt would be re-read verbatim by the
      continuation, every ten seconds, forever. Making no progress means there
      is nothing to continue — the next daily tick will look again.
    */
    const hasScheduledContinuation =
      hasIncompleteCascade ||
      (!isTargetedRun && staleDocuments.length === maxDocuments && sweptDocumentCount > 0);
    if (hasScheduledContinuation) {
      await ctx.scheduler.runAfter(
        CONTINUATION_DELAY_MS,
        internal.cleanup.cleanupStaleDocuments,
        args,
      );
    }

    console.log(
      `cleanup: retentionDays=${retentionDays} deleted ` +
        `${stats.deletedDocuments} documents, ${stats.deletedCanvases} canvases, ` +
        `${stats.deletedBlocks} blocks, ${stats.deletedOperations} operations, ` +
        `${stats.deletedSnapshots} snapshots, ${stats.deletedSyncDocs} sync docs, ` +
        `${stats.deletedStorageFiles} storage files, ` +
        `${stats.deletedBrandKits} brand kits, ${stats.deletedAssets} assets, ` +
        `${stats.deletedSavedSections} saved sections, ` +
        `${stats.deletedPersonaCopies} persona copies; ` +
        `${exemptedClaimedDocuments} exempt (claimed)` +
        (hasScheduledContinuation ? " (continuation scheduled)" : ""),
    );
    return { ...stats, hasScheduledContinuation, exemptedClaimedDocuments };
  },
});

/*
  ONE-SHOT legacy sweep (NOT part of the cron): delete component sync docs
  left over from before the composite `${documentId}:${blockId}` rekey.

  The prosemirror-sync component exposes NO listing API (its lib.* surface
  is per-id: submitSnapshot/latestVersion/submitSteps/getSnapshot/getSteps/
  deleteSnapshots/deleteSteps/deleteDocument — verified against the
  component source), so orphan ids must be supplied explicitly; enumerate
  them with `npx convex data --component prosemirrorSync snapshots` (known
  orphans on dev: "txt_r7s8", "spike-doc"). Safe by construction: an id that
  resolves to a live block row in a live document is retained, whatever the
  caller passed.
*/
export const deleteOrphanSyncDocs = internalMutation({
  args: { ids: v.array(v.string()) },
  returns: v.object({
    deletedIds: v.array(v.string()),
    retainedIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    if (args.ids.length > MAX_ORPHAN_IDS_PER_CALL) {
      throw new Error(
        `deleteOrphanSyncDocs: ${args.ids.length} ids exceeds the per-call maximum of ${MAX_ORPHAN_IDS_PER_CALL}. Split the batch.`,
      );
    }
    const deletedIds: string[] = [];
    const retainedIds: string[] = [];
    for (const id of args.ids) {
      const liveBlockRow = await findLiveBlockRow(ctx, id);
      if (liveBlockRow !== null) {
        retainedIds.push(id);
        continue;
      }
      /*
        Orphaned (bare pre-rekey id, malformed id, or deleted block/document):
        the component's deleteDocument removes its snapshots now and schedules
        bounded step deletion.
      */
      await ctx.runMutation(components.prosemirrorSync.lib.deleteDocument, { id });
      deletedIds.push(id);
    }
    return { deletedIds, retainedIds };
  },
});
