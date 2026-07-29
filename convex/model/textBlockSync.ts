import { components } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Shared (non-registered) helpers for the Phase 5.2 per-text-block
 * ProseMirror sync docs. The sync doc id IS the SDK block id (arbitrary
 * strings are supported by the component), e.g. "txt_ab12cd34".
 *
 * CAVEAT — block ids are NOT globally unique across documents today:
 * `duplicateDocument` copies block rows verbatim and the seeded sample
 * document uses fixed ids ("txt_e5f6", ...), so one block id can resolve to
 * rows in several documents (which then SHARE one sync doc). Resolution
 * policy until the id scheme is revisited (block-id-format-revisit /
 * Phase 5.4 reconciliation):
 *   - existence gating (checkRead/checkWrite) tolerates ambiguity — any live
 *     row grants access;
 *   - writes never guess — the snapshot mirror skips ambiguous ids instead
 *     of patching an arbitrary document's block.
 */

/** We only ever need to distinguish 0 / 1 / "more than 1" matching rows. */
const MAX_BLOCK_ROWS_PER_ID = 2;

export interface LiveBlockRowsResult {
  /** Rows for this block id whose parent document still exists (0..MAX). */
  rows: Doc<"blocks">[];
  /** True when the block id resolves to rows in more than one document. */
  hasAmbiguousMatches: boolean;
}

/**
 * Resolve a sync doc id (= SDK block id) to its live block row(s): rows whose
 * parent document row still exists.
 */
export async function findLiveBlockRows(
  ctx: QueryCtx | MutationCtx,
  blockId: string,
): Promise<LiveBlockRowsResult> {
  const rows = await ctx.db
    .query("blocks")
    .withIndex("by_blockId", (q) => q.eq("blockId", blockId))
    .take(MAX_BLOCK_ROWS_PER_ID);
  const liveRows: Doc<"blocks">[] = [];
  for (const row of rows) {
    const document = await ctx.db.get(row.documentId);
    if (document !== null) {
      liveRows.push(row);
    }
  }
  return { rows: liveRows, hasAmbiguousMatches: liveRows.length > 1 };
}

/**
 * Existence gating for the sync endpoints (checkRead/checkWrite): throw
 * unless the id resolves to at least one block row with a live parent
 * document. Session-capability checks are deferred to Phase 6.1 (no-auth
 * demo-first; the URL/id is the capability).
 */
export async function assertBlockSyncAccess(
  ctx: QueryCtx | MutationCtx,
  blockId: string,
): Promise<void> {
  const { rows } = await findLiveBlockRows(ctx, blockId);
  if (rows.length === 0) {
    throw new Error(
      `Sync access denied: block ${blockId} does not exist (or its document is gone).`,
    );
  }
}

/**
 * Delete the component-side sync data (snapshots now, steps via a scheduled
 * follow-up) for a block's sync doc. Callers:
 *   - commitVersions (model/emailDocuments.ts) when the LAST block row with
 *     this id is hard-deleted at head — restorability is unaffected because
 *     the removal's inverse op carries properties.text (kept fresh by the
 *     snapshot mirror) and ensureBlockDoc recreates the sync doc from it;
 *   - the Phase 6.1 cleanup cron and Phase 5.4 reconciliation, for orphaned
 *     sync docs this in-line hook misses.
 */
export async function deleteBlockSyncDoc(ctx: MutationCtx, blockId: string): Promise<void> {
  await ctx.runMutation(components.prosemirrorSync.lib.deleteDocument, { id: blockId });
}
