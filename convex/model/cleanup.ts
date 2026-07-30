import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteBlockSyncDoc } from "./textBlockSync";

/**
 * Phase 6.1 — shared (non-registered) helpers for the unclaimed-session
 * cleanup cron (plan §6.1d). This app is no-auth: every session is
 * "unclaimed", so a document is stale purely by inactivity.
 *
 * Staleness signal: `documents.updatedAtMs`. Every write path funnels through
 * commitVersions (documents.applyOperations, history undo/redo/revert/
 * rollback, agentText.applyAgentTextEdit), which patches `updatedAtMs` on
 * every committed operation; createDocument/duplicateDocument set it at
 * birth. The ONE writer that bypasses it is the ~1s ProseMirror snapshot
 * mirror (prosemirror.ts onSnapshot) — but every editing session ends with a
 * session `updateText` commit, so the lag is bounded by one editing session:
 * negligible against a 30-day threshold, and no new field or shared-file edit
 * was needed. The `by_updatedAtMs` index makes the stale scan a cheap range
 * read.
 *
 * Deletion is a full per-document cascade, ordered so a budget-exhausted
 * partial run is always resumable (the document row is deleted LAST, so an
 * unfinished document stays stale and is re-picked by the next run):
 *
 *   1. operation rows            (can be numerous — paged against the budget)
 *   2. snapshot rows
 *   3. storage files referenced by the document's image blocks (before the
 *      block rows go away, so a partial run never loses the src list)
 *   4. per-text-block ProseMirror sync docs + all block rows
 *   5. the transient ghost-session row, if one was stranded (at most one
 *      per document; normally deleted when the ghost run ends)
 *   6. the document row
 *   7. the parent canvas, iff it now holds no documents (canvases own
 *      documents; an empty canvas of an unclaimed session is dead weight)
 */

export const DEFAULT_RETENTION_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Stale documents picked up per cron run (continuations re-schedule for the rest). */
export const MAX_STALE_DOCUMENTS_PER_RUN = 5;

/**
 * Row-deletion budget per mutation run, well under Convex's per-mutation
 * write limits (mirrors the MAX_OPERATIONS_PER_CALL bounding style in
 * model/emailDocuments.ts). Component sync-doc deletes count against it too;
 * the component internally pages its own snapshot/step deletion via the
 * scheduler, so each call is cheap here.
 */
export const MAX_ROW_DELETIONS_PER_RUN = 1000;

/**
 * Upper bound on the `_storage` scan used to reverse-map serving URLs to
 * storage ids (see resolveStorageIdsByUrl). Beyond this many files the
 * mapping is skipped — files are then retained, never guess-deleted.
 */
export const MAX_STORAGE_FILES_SCANNED = 256;

/**
 * Bound on the whole-table `blocks` read used by the storage-file reference
 * check (`properties` is a v.record, which Convex cannot index by nested
 * path, so an index-backed lookup on properties.src is impossible). The scan
 * runs at most once per cascade, and only for documents that actually
 * reference this deployment's file storage. Over the bound, files are
 * retained — never guess-deleted.
 */
const MAX_BLOCK_ROWS_SCANNED = 4000;

/** Mutable row-deletion budget threaded through one cleanup run. */
export interface DeletionBudget {
  remaining: number;
}

export interface CleanupStats {
  deletedDocuments: number;
  deletedCanvases: number;
  deletedBlocks: number;
  deletedOperations: number;
  deletedSnapshots: number;
  deletedSyncDocs: number;
  deletedStorageFiles: number;
}

export function createEmptyCleanupStats(): CleanupStats {
  return {
    deletedDocuments: 0,
    deletedCanvases: 0,
    deletedBlocks: 0,
    deletedOperations: 0,
    deletedSnapshots: 0,
    deletedSyncDocs: 0,
    deletedStorageFiles: 0,
  };
}

/**
 * Delete the full constellation of one stale document, respecting `budget`.
 * Returns isComplete=false when the budget ran out mid-cascade; the document
 * row is still present then, so the next run resumes it idempotently.
 */
export async function deleteDocumentCascade({
  ctx,
  document,
  budget,
  stats,
}: {
  ctx: MutationCtx;
  document: Doc<"documents">;
  budget: DeletionBudget;
  stats: CleanupStats;
}): Promise<{ isComplete: boolean }> {
  const documentId = document._id;

  // 1. Operation rows — the only table that can be large per document; paged.
  {
    const rows = await ctx.db
      .query("operations")
      .withIndex("by_documentId_and_version", (q) => q.eq("documentId", documentId))
      .take(budget.remaining + 1);
    const deletableRows = rows.slice(0, budget.remaining);
    for (const row of deletableRows) {
      await ctx.db.delete(row._id);
    }
    stats.deletedOperations += deletableRows.length;
    budget.remaining -= deletableRows.length;
    if (rows.length > deletableRows.length) {
      return { isComplete: false };
    }
  }

  // 2. Snapshot rows.
  {
    const rows = await ctx.db
      .query("snapshots")
      .withIndex("by_documentId_and_version", (q) => q.eq("documentId", documentId))
      .take(budget.remaining + 1);
    const deletableRows = rows.slice(0, budget.remaining);
    for (const row of deletableRows) {
      await ctx.db.delete(row._id);
    }
    stats.deletedSnapshots += deletableRows.length;
    budget.remaining -= deletableRows.length;
    if (rows.length > deletableRows.length) {
      return { isComplete: false };
    }
  }

  // Block rows are bounded (an email document is a few dozen blocks).
  const blockRows = await ctx.db
    .query("blocks")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .collect();

  // 3. Storage files referenced by this document's image blocks — BEFORE the
  // block rows are deleted, so a budget-exhausted run cannot orphan a file by
  // losing the only rows that pointed at it.
  const imageSrcUrls = new Set<string>();
  for (const row of blockRows) {
    if (row.type === "image" && typeof row.properties.src === "string") {
      imageSrcUrls.add(row.properties.src);
    }
  }
  const storageResult = await deleteUnreferencedStorageFiles({
    ctx,
    urls: imageSrcUrls,
    excludeDocumentId: documentId,
    budget,
    stats,
  });
  if (!storageResult.isComplete) {
    return { isComplete: false };
  }

  // 4. Per-text-block ProseMirror sync docs (composite id
  // `${documentId}:${blockId}`) and the block rows themselves.
  for (const row of blockRows) {
    if (budget.remaining <= 0) {
      return { isComplete: false };
    }
    if (row.type === "text") {
      await deleteBlockSyncDoc(ctx, { documentId, blockId: row.blockId });
      stats.deletedSyncDocs += 1;
      budget.remaining -= 1;
    }
    await ctx.db.delete(row._id);
    stats.deletedBlocks += 1;
    budget.remaining -= 1;
  }

  // 5. The transient ghost-session row (at most one per document; a stranded
  // row would otherwise dangle forever once its document is gone).
  const ghostSessionRows = await ctx.db
    .query("ghostSessions")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .collect();
  for (const row of ghostSessionRows) {
    if (budget.remaining <= 0) {
      return { isComplete: false };
    }
    await ctx.db.delete(row._id);
    budget.remaining -= 1;
  }

  // 6. The document row, LAST — its presence is the resumption marker.
  if (budget.remaining <= 0) {
    return { isComplete: false };
  }
  await ctx.db.delete(documentId);
  stats.deletedDocuments += 1;
  budget.remaining -= 1;

  // 7. The parent canvas, iff this was its last document.
  const survivingSibling = await ctx.db
    .query("documents")
    .withIndex("by_canvasId", (q) => q.eq("canvasId", document.canvasId))
    .first();
  if (survivingSibling === null) {
    const canvas = await ctx.db.get(document.canvasId);
    if (canvas !== null) {
      await ctx.db.delete(canvas._id);
      stats.deletedCanvases += 1;
    }
  }

  return { isComplete: true };
}

/**
 * Delete the Convex storage files behind `urls` that no OTHER document's
 * block rows reference.
 *
 * Serving URLs do NOT embed the storage id — verified against real dev data:
 * `_storage` id "kg21nnqt…" serves at ".../api/storage/63604288-1e43-…"
 * (an internal UUID). Parsing is therefore impossible; instead we reverse-map
 * by scanning `_storage` (bounded) and comparing each file's stable
 * `ctx.storage.getUrl` output against the candidate URLs. Anything that
 * cannot be resolved is RETAINED, never guess-deleted.
 *
 * Known accepted gap: references living only in a surviving document's
 * HISTORY (op inverses / version snapshots, e.g. a fork that later removed a
 * shared image) are not scanned — undo/restore of such an image would 404.
 * Head block rows of every surviving document ARE checked, via by_imageSrc.
 */
async function deleteUnreferencedStorageFiles({
  ctx,
  urls,
  excludeDocumentId,
  budget,
  stats,
}: {
  ctx: MutationCtx;
  urls: Set<string>;
  excludeDocumentId: Id<"documents">;
  budget: DeletionBudget;
  stats: CleanupStats;
}): Promise<{ isComplete: boolean }> {
  // Only URLs served by THIS deployment's file storage are candidates
  // (sample docs use placehold.co etc.; foreign URLs are not ours to delete).
  const storageUrlPrefix = `${process.env.CONVEX_CLOUD_URL}/api/storage/`;
  const candidateUrls = [...urls].filter((url) => url.startsWith(storageUrlPrefix));
  if (candidateUrls.length === 0) {
    return { isComplete: true };
  }

  // Keep any file still referenced at head by a different document (forks
  // copy block rows verbatim, so cross-document sharing is real). The stale
  // document's own rows still exist at this point, so exclude them by id.
  // One bounded whole-table read (see MAX_BLOCK_ROWS_SCANNED for why no
  // index is possible); over the bound every candidate is retained.
  const allBlockRows = await ctx.db.query("blocks").take(MAX_BLOCK_ROWS_SCANNED + 1);
  if (allBlockRows.length > MAX_BLOCK_ROWS_SCANNED) {
    console.warn(
      `cleanup: blocks table exceeds ${MAX_BLOCK_ROWS_SCANNED} rows; ` +
        `storage-file reference check skipped — files retained for document ${excludeDocumentId}.`,
    );
    return { isComplete: true };
  }
  const foreignSrcUrls = new Set<string>();
  for (const row of allBlockRows) {
    if (
      row.documentId !== excludeDocumentId &&
      row.type === "image" &&
      typeof row.properties.src === "string"
    ) {
      foreignSrcUrls.add(row.properties.src);
    }
  }
  const unreferencedUrls = candidateUrls.filter((url) => !foreignSrcUrls.has(url));
  if (unreferencedUrls.length === 0) {
    return { isComplete: true };
  }

  const storageIdsByUrl = await resolveStorageIdsByUrl({ ctx, urls: unreferencedUrls });
  for (const url of unreferencedUrls) {
    const storageId = storageIdsByUrl.get(url);
    if (storageId === undefined) {
      // Already deleted by an earlier partial run, or unresolvable (scan
      // bound exceeded) — retain rather than guess.
      continue;
    }
    if (budget.remaining <= 0) {
      return { isComplete: false };
    }
    await ctx.storage.delete(storageId);
    stats.deletedStorageFiles += 1;
    budget.remaining -= 1;
  }
  return { isComplete: true };
}

/** Reverse-map serving URLs to `_storage` ids via a bounded table scan. */
async function resolveStorageIdsByUrl({
  ctx,
  urls,
}: {
  ctx: MutationCtx;
  urls: string[];
}): Promise<Map<string, Id<"_storage">>> {
  const wantedUrls = new Set(urls);
  const storageIdsByUrl = new Map<string, Id<"_storage">>();
  const files = await ctx.db.system.query("_storage").take(MAX_STORAGE_FILES_SCANNED + 1);
  const hasScannedAllFiles = files.length <= MAX_STORAGE_FILES_SCANNED;
  if (!hasScannedAllFiles) {
    console.warn(
      `cleanup: _storage holds more than ${MAX_STORAGE_FILES_SCANNED} files; ` +
        `URL→id resolution is partial and unresolved files will be retained.`,
    );
  }
  for (const file of files.slice(0, MAX_STORAGE_FILES_SCANNED)) {
    if (storageIdsByUrl.size === wantedUrls.size) {
      break;
    }
    const servingUrl = await ctx.storage.getUrl(file._id);
    if (servingUrl !== null && wantedUrls.has(servingUrl)) {
      storageIdsByUrl.set(servingUrl, file._id);
    }
  }
  return storageIdsByUrl;
}
