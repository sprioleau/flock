import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import type { TextDoc } from "@flock/email-sdk";
import { buildEditorSchema, Transform } from "../../apps/web/src/lib/editorSchema";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Shared (non-registered) helpers for the Phase 5.2 per-text-block
 * ProseMirror sync docs.
 *
 * Sync doc ids are DOCUMENT-SCOPED composites: `${documentId}:${blockId}`
 * (e.g. "j97eq0gp...:txt_ab12cd34"). SDK block ids are only unique within a
 * document (the seeded sample uses fixed ids; duplicateDocument copies rows
 * verbatim), so bare-block-id keying made colliding blocks across drafts
 * share one live sync doc. Composite keying resolves every sync doc to
 * exactly one block row, and hands the auth hooks the parent document id for
 * free (Phase 6.1 capability checks).
 */

export interface SyncDocKey {
  documentId: Id<"documents">;
  blockId: string;
}

/** Compose the sync doc id for a block. The client mirrors this format. */
export function buildSyncDocId({ documentId, blockId }: SyncDocKey): string {
  return `${documentId}:${blockId}`;
}

/**
 * Parse a sync doc id. Returns null for malformed ids (including the bare
 * block ids of pre-rekey sync docs, which are orphaned component data for
 * the Phase 6.1 cleanup cron).
 */
export function parseSyncDocId(id: string): SyncDocKey | null {
  const separatorIndex = id.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === id.length - 1) {
    return null;
  }
  return {
    documentId: id.slice(0, separatorIndex) as Id<"documents">,
    blockId: id.slice(separatorIndex + 1),
  };
}

/**
 * Resolve a sync doc id to its live block row: the row must exist AND its
 * parent document row must still exist. Returns null otherwise (malformed
 * id, deleted block, or deleted document).
 */
export async function findLiveBlockRow(
  ctx: QueryCtx | MutationCtx,
  id: string,
): Promise<Doc<"blocks"> | null> {
  const key = parseSyncDocId(id);
  if (key === null) {
    return null;
  }
  const document = await ctx.db.get(key.documentId);
  if (document === null) {
    return null;
  }
  return await ctx.db
    .query("blocks")
    .withIndex("by_documentId_and_blockId", (q) =>
      q.eq("documentId", key.documentId).eq("blockId", key.blockId),
    )
    .unique();
}

/**
 * Existence gating for the sync endpoints (checkRead/checkWrite): throw
 * unless the id resolves to a block row with a live parent document.
 * Session-capability checks are deferred to Phase 6.1 (no-auth demo-first;
 * the URL/id is the capability).
 */
export async function assertBlockSyncAccess(
  ctx: QueryCtx | MutationCtx,
  id: string,
): Promise<void> {
  const row = await findLiveBlockRow(ctx, id);
  if (row === null) {
    throw new Error(
      `Sync access denied: sync doc ${id} does not resolve to a live block.`,
    );
  }
}

/**
 * Delete the component-side sync data (snapshots now, steps via a scheduled
 * follow-up) for a block's sync doc. Callers:
 *   - commitVersions (model/emailDocuments.ts) when a text block row is
 *     hard-deleted at head — restorability is unaffected because the
 *     removal's inverse op carries properties.text (kept fresh by the
 *     snapshot mirror) and ensureBlockDoc recreates the sync doc from it;
 *   - the Phase 6.1 cleanup cron and Phase 5.4 reconciliation, for orphaned
 *     sync docs this in-line hook misses.
 */
export async function deleteBlockSyncDoc(ctx: MutationCtx, key: SyncDocKey): Promise<void> {
  await ctx.runMutation(components.prosemirrorSync.lib.deleteDocument, {
    id: buildSyncDocId(key),
  });
}

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);

/**
 * Synthetic clientIds for non-human step submitters, so the UI (and Phase
 * 6.2 presence) can attribute/animate them distinctly from keystrokes.
 * Owner directive from Spike B: the AI has a dedicated clientId from day one.
 */
export const AI_AGENT_CLIENT_ID = "flock-agent";
export const HISTORY_CLIENT_ID = "flock-history";

/**
 * Force a block's sync doc to exactly match an op-authoritative TextDoc —
 * the write-back half of the "session op + mirror" design: whenever the op
 * log rewrites a text block's properties.text (undo, redo, revertBatch,
 * rollbackToVersion), the live ProseMirror doc must follow, or reopening the
 * editor would resurface the pre-rewrite content from the sync doc.
 *
 * Whole-doc replacement is CORRECT here (unlike AI edits, which must merge):
 * a history rewrite is authoritative, so concurrent in-flight keystrokes on
 * the old content lose by design. The transform callback is idempotent and
 * recomputes from the live doc on every rebase retry (Spike B semantics).
 * No-ops when the sync doc does not exist (properties.text is then the only
 * truth, and ensureBlockDoc seeds from it on the next edit) or when the doc
 * already matches.
 */
export async function replaceSyncDocContent({
  ctx,
  key,
  text,
  clientId,
}: {
  ctx: MutationCtx;
  key: SyncDocKey;
  text: TextDoc;
  clientId: string;
}): Promise<void> {
  const id = buildSyncDocId(key);
  const existingVersion = await ctx.runQuery(components.prosemirrorSync.lib.latestVersion, {
    id,
  });
  if (existingVersion === null) {
    return;
  }
  const schema = buildEditorSchema();
  const targetDoc = schema.nodeFromJSON(text);
  await prosemirrorSync.transform(
    ctx,
    id,
    schema,
    (doc) => {
      if (doc.eq(targetDoc)) {
        return null;
      }
      const tr = new Transform(doc);
      tr.replaceWith(0, doc.content.size, targetDoc.content);
      return tr;
    },
    { clientId },
  );
}
