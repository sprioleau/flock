import {
  applyOperation,
  type Block,
  type EmailDocument,
  type Operation,
  type OperationAuthor,
  type OperationError,
} from "@tandem/email-sdk";
import type { ActionCaller } from "@tandem/email-sdk";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { deleteBlockSyncDoc, HISTORY_CLIENT_ID, replaceSyncDocContent } from "./textBlockSync";

/**
 * Shared (non-registered) helpers for the Phase 4.1 document mutations and
 * queries. Everything here runs inside the calling function's transaction.
 *
 * Integrity note: `applyOperation`/`applyOperations` (email-sdk) re-validate
 * the RESULTING document against the full Zod document schema AND the
 * referential integrity checker on every successful application — so these
 * helpers never re-run `checkDocumentIntegrity` themselves; a doc that came
 * out of the SDK apply engine is structurally sound by construction.
 */

/** Snapshot every N versions. Crossing a multiple-of-N boundary inside a mutation writes one. */
export const SNAPSHOT_INTERVAL = 20;

/** Upper bound on ops per applyOperations call (each op = 1 op row + a few block writes). */
export const MAX_OPERATIONS_PER_CALL = 100;

/** Bound on how many rows getOperations returns per call. */
export const MAX_OPERATIONS_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Validators shared by the registered functions
// ---------------------------------------------------------------------------

export const operationErrorValidator = v.object({
  code: v.string(),
  message: v.string(),
  blockId: v.optional(v.string()),
  relatedBlockId: v.optional(v.string()),
});

export const applyContextValidator = v.object({
  authorId: v.string(),
  author: v.union(v.literal("user"), v.literal("agent")),
  caller: v.union(
    v.literal("tool"),
    v.literal("http"),
    v.literal("frontend"),
    v.literal("cli"),
    v.literal("mcp"),
  ),
  batchId: v.optional(v.string()),
  threadId: v.optional(v.string()),
});

export interface ApplyContext {
  authorId: string;
  author: OperationAuthor;
  caller: ActionCaller;
  batchId?: string;
  threadId?: string;
}

/** OperationError with the branded BlockId widened to string for Convex transport. */
export interface TransportOperationError {
  code: string;
  message: string;
  blockId?: string;
  relatedBlockId?: string;
}

export function toTransportErrors(errors: OperationError[]): TransportOperationError[] {
  return errors.map((error) => ({
    code: error.code,
    message: error.message,
    ...(error.blockId !== undefined ? { blockId: error.blockId as string } : {}),
    ...(error.relatedBlockId !== undefined
      ? { relatedBlockId: error.relatedBlockId as string }
      : {}),
  }));
}

// ---------------------------------------------------------------------------
// Loading the head state
// ---------------------------------------------------------------------------

export interface DocumentState {
  document: Doc<"documents">;
  /** blockId (email-sdk id) → current block row. */
  blockRowsByBlockId: Map<string, Doc<"blocks">>;
  /** The head document assembled from the block rows. */
  doc: EmailDocument;
}

/**
 * Rebuild the flat EmailDocument from block rows. Rows were written from a
 * document the SDK apply engine already validated, so the cast is safe.
 */
export function assembleEmailDocument(blockRows: Doc<"blocks">[]): EmailDocument {
  const doc: Record<string, Block> = {};
  for (const row of blockRows) {
    doc[row.blockId] = {
      id: row.blockId,
      type: row.type,
      parentId: row.parentId,
      childrenIds: row.childrenIds,
      properties: row.properties,
    } as Block;
  }
  return doc as EmailDocument;
}

/**
 * Load a document row plus all of its block rows (bounded: an email document
 * is a few dozen blocks — far under Convex's ~16k read limit).
 */
export async function loadDocumentState(
  ctx: QueryCtx | MutationCtx,
  documentId: Id<"documents">,
): Promise<DocumentState | null> {
  const document = await ctx.db.get(documentId);
  if (document === null) {
    return null;
  }
  const blockRows = await ctx.db
    .query("blocks")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .collect();
  const blockRowsByBlockId = new Map(blockRows.map((row) => [row.blockId, row]));
  return { document, blockRowsByBlockId, doc: assembleEmailDocument(blockRows) };
}

// ---------------------------------------------------------------------------
// Committing new versions (the single write path)
// ---------------------------------------------------------------------------

export interface CommitEntry {
  /** The operation that was applied (for undo entries this is the original's inverse). */
  op: Operation;
  /** The exact inverse returned by the SDK when `op` was applied. */
  inverse: Operation;
  kind: "edit" | "undo" | "redo";
  undoesVersion?: number;
  redoesVersion?: number;
  batchId?: string;
}

export interface CommitResult {
  headVersion: number;
  /** The versions assigned to `entries`, in order (dense: oldHead+1 .. newHead). */
  appliedVersions: number[];
}

/**
 * Persist the outcome of a successful SDK apply: append one operation row per
 * entry (each entry = exactly one version), diff-write the changed block
 * rows, bump `headVersion`, and snapshot when a SNAPSHOT_INTERVAL boundary is
 * crossed. Runs inside the calling mutation's transaction — all-or-nothing.
 *
 * Block diff strategy: the SDK apply engine structurally shares unchanged
 * blocks, so a block changed iff `newDoc[blockId] !== state.doc[blockId]`
 * (reference inequality). Blocks absent from `newDoc` are deleted; blocks
 * absent from the old doc are inserted.
 *
 * `shouldForceTextSyncDocs` (Phase 5.4 boundary rule): when set and the
 * commit changes a text block's properties.text, the block's live
 * ProseMirror sync doc is forced to match via replaceSyncDocContent
 * (clientId HISTORY_CLIENT_ID), otherwise an open editor would keep — and a
 * later session commit would resurrect — the superseded sync-doc content.
 * Set by every text write whose content did NOT come from the sync doc:
 *   - history rewrites (undo / redo / revertBatch / rollbackToVersion) —
 *     authoritative by design, MAY clobber in-flight typing;
 *   - non-frontend callers (cli / mcp / http / tool) and frontend
 *     agent-authored ops applied via documents.applyOperations.
 * NOT set by:
 *   - frontend USER session commits (their text came FROM the sync doc; a
 *     write-back would clobber another user's still-in-flight keystrokes);
 *   - agentText.applyAgentTextEdit (it merges into the sync doc itself via
 *     a targeted transform — the whole point of Phase 5.3).
 *
 * Concurrent-session duplicate ops (Wave 1 finding, ACCEPTED behavior): two
 * users editing the same block each commit their own session `updateText` on
 * close, producing near-duplicate history entries with identical converged
 * content. A dedupe here (skip an updateText whose text equals the block
 * row's current properties.text) was considered and REJECTED as unsafe:
 * (a) the snapshot mirror lags ~1s, so properties.text is routinely stale
 * relative to the sync doc at commit time — the comparison races; (b) each
 * entry consumes a version and the client overlay acks pendingOps by
 * `appliedVersions`/headVersion coverage, so silently skipping an op would
 * desync the ack contract; (c) the second author's undo would then target an
 * older, unrelated op. Two identical-content entries are harmless: undoing
 * either applies an inverse that restores the same converged text.
 */
export async function commitVersions({
  ctx,
  state,
  newDoc,
  entries: rawEntries,
  context,
  shouldForceTextSyncDocs = false,
}: {
  ctx: MutationCtx;
  state: DocumentState;
  newDoc: EmailDocument;
  entries: CommitEntry[];
  context: ApplyContext;
  /** Force changed text blocks' sync docs to match the committed
   * properties.text — see the doc comment for exactly who sets this. */
  shouldForceTextSyncDocs?: boolean;
}): Promise<CommitResult> {
  const { document } = state;
  const now = Date.now();
  const oldHeadVersion = document.headVersion;
  const newHeadVersion = oldHeadVersion + rawEntries.length;

  // 0. Anchor updateText inverses to the OP LOG before appending (see
  // withOpLogTextInverses — the mirror otherwise degenerates them).
  const entries = await withOpLogTextInverses({ ctx, document, entries: rawEntries });

  // 1. Append the operation rows.
  const appliedVersions: number[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const version = oldHeadVersion + entryIndex + 1;
    appliedVersions.push(version);
    await ctx.db.insert("operations", {
      documentId: document._id,
      version,
      op: entry.op,
      inverse: entry.inverse,
      authorId: context.authorId,
      author: context.author,
      caller: context.caller,
      ...(entry.batchId !== undefined || context.batchId !== undefined
        ? { batchId: entry.batchId ?? context.batchId }
        : {}),
      ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
      kind: entry.kind,
      ...(entry.undoesVersion !== undefined ? { undoesVersion: entry.undoesVersion } : {}),
      ...(entry.redoesVersion !== undefined ? { redoesVersion: entry.redoesVersion } : {}),
      createdAtMs: now,
    });
  }

  // 2. Diff-write the block rows.
  const newBlockIds = Object.keys(newDoc);
  const newBlockIdSet = new Set(newBlockIds);
  for (const blockId of newBlockIds) {
    const newBlock = newDoc[blockId as keyof EmailDocument]!;
    const oldBlock = state.doc[blockId as keyof EmailDocument];
    if (oldBlock === undefined) {
      await ctx.db.insert("blocks", {
        documentId: document._id,
        blockId,
        type: newBlock.type,
        parentId: newBlock.parentId,
        childrenIds: newBlock.childrenIds as string[],
        properties: newBlock.properties as Record<string, unknown>,
      });
    } else if (oldBlock !== newBlock) {
      const row = state.blockRowsByBlockId.get(blockId)!;
      await ctx.db.patch(row._id, {
        type: newBlock.type,
        parentId: newBlock.parentId,
        childrenIds: newBlock.childrenIds as string[],
        properties: newBlock.properties as Record<string, unknown>,
      });
    }
    // Authoritative write-back (see the doc comment): force the sync doc to
    // the committed text. Runs for inserted text blocks too — normally a no-op
    // (deletion already removed the sync doc; ensureBlockDoc re-seeds on the
    // next edit) but it heals any sync doc a missed cleanup left behind.
    // Structural sharing makes the reference gate exact: unchanged text keeps
    // its identity, and replaceSyncDocContent itself no-ops on absent/equal.
    if (
      shouldForceTextSyncDocs &&
      newBlock.type === "text" &&
      (oldBlock === undefined ||
        oldBlock.type !== "text" ||
        oldBlock.properties.text !== newBlock.properties.text)
    ) {
      await replaceSyncDocContent({
        ctx,
        key: { documentId: document._id, blockId },
        text: newBlock.properties.text,
        clientId: HISTORY_CLIENT_ID,
      });
    }
  }
  for (const [blockId, row] of state.blockRowsByBlockId) {
    if (!newBlockIdSet.has(blockId)) {
      await ctx.db.delete(row._id);
      // Phase 5.2: text blocks may have a per-block ProseMirror sync doc
      // (keyed by `${documentId}:${blockId}`, so exactly this row's). Undo
      // stays safe: the removal's inverse op carries properties.text and
      // ensureBlockDoc recreates the sync doc from it on the next edit.
      if (row.type === "text") {
        await deleteBlockSyncDoc(ctx, { documentId: row.documentId, blockId });
      }
    }
  }

  // 3. Bump the head.
  await ctx.db.patch(document._id, { headVersion: newHeadVersion, updatedAtMs: now });

  // 4. Snapshot when this commit crossed a SNAPSHOT_INTERVAL boundary.
  const hasCrossedSnapshotBoundary =
    Math.floor(newHeadVersion / SNAPSHOT_INTERVAL) > Math.floor(oldHeadVersion / SNAPSHOT_INTERVAL);
  if (hasCrossedSnapshotBoundary) {
    await ctx.db.insert("snapshots", {
      documentId: document._id,
      version: newHeadVersion,
      doc: newDoc as Record<string, unknown>,
      createdAtMs: now,
    });
  }

  return { headVersion: newHeadVersion, appliedVersions };
}

/**
 * Phase 5.4 finding (session-op inverse degeneracy): the SDK computes an
 * updateText inverse from the document it applies to — which here is
 * assembled from BLOCK ROWS, whose properties.text the snapshot mirror
 * (prosemirror.ts onSnapshot) advances ~1s behind live typing WITHOUT op
 * rows. So by the time a session's `updateText` op commits, properties.text
 * usually already equals (or nearly equals) the op's own text, and the SDK
 * inverse degenerates to "restore what the mirror already wrote" — undoing a
 * text session became a visible no-op, and rollbackToVersion's "result
 * equals getDocumentAtVersion(version)" guarantee silently broke for text.
 *
 * Fix, applied to EVERY commit at the single append point: replay the
 * entries over the OP-LOG document (reconstructed at the old head) and
 * re-anchor each updateText entry's inverse to the op-log text the entry is
 * really superseding. Ops depend on structure, never on text values, so the
 * replay cannot diverge from the block-row apply that already succeeded
 * (guarded anyway). Cost: one bounded reconstruction plus one re-apply per
 * entry, only when a commit contains an updateText.
 *
 * Known edge (accepted): version snapshots are written from block-row state,
 * so a snapshot that lands mid-session bakes that moment's mirror text into
 * the reconstruction anchor for blocks with no later updateText op. The
 * correction and getDocumentAtVersion share the anchor, so history stays
 * self-consistent.
 */
async function withOpLogTextInverses({
  ctx,
  document,
  entries,
}: {
  ctx: MutationCtx;
  document: Doc<"documents">;
  entries: CommitEntry[];
}): Promise<CommitEntry[]> {
  const hasTextEntry = entries.some((entry) => entry.op.name === "updateText");
  if (!hasTextEntry) {
    return entries;
  }
  let opLogDoc = await reconstructDocumentAtVersion({
    ctx,
    document,
    version: document.headVersion,
  });
  if (opLogDoc === null) {
    // Unreachable (headVersion is always in range); keep the SDK inverses.
    return entries;
  }
  const corrected: CommitEntry[] = [];
  for (const entry of entries) {
    let inverse = entry.inverse;
    if (entry.op.name === "updateText" && inverse.name === "updateText") {
      const opLogBlock = opLogDoc[entry.op.blockId];
      if (opLogBlock !== undefined && opLogBlock.type === "text") {
        inverse = { ...inverse, text: opLogBlock.properties.text };
      }
      // Block absent from the op-log doc = born earlier in this same batch;
      // the SDK inverse came from in-batch state and is already correct.
    }
    corrected.push(inverse === entry.inverse ? entry : { ...entry, inverse });
    const replay = applyOperation(opLogDoc, entry.op);
    if (!replay.isOk) {
      // Should not happen (the op already applied to the block-row doc, and
      // applicability never depends on text values). Fall back to the SDK
      // inverses for the remaining entries rather than fail the commit.
      console.warn(
        `withOpLogTextInverses: op-log replay of ${entry.op.name} failed; keeping SDK inverses for the remainder.`,
      );
      corrected.push(...entries.slice(corrected.length));
      break;
    }
    opLogDoc = replay.doc;
  }
  return corrected;
}

// ---------------------------------------------------------------------------
// Point-in-time reads
// ---------------------------------------------------------------------------

/**
 * Reconstruct the document as of `version`: nearest snapshot ≤ version, then
 * replay the ops in between (bounded by SNAPSHOT_INTERVAL plus one batch, so
 * the read set stays small). Returns null when the version is out of range.
 */
export async function reconstructDocumentAtVersion({
  ctx,
  document,
  version,
}: {
  ctx: QueryCtx | MutationCtx;
  document: Doc<"documents">;
  version: number;
}): Promise<EmailDocument | null> {
  if (!Number.isInteger(version) || version < 0 || version > document.headVersion) {
    return null;
  }
  const snapshot = await ctx.db
    .query("snapshots")
    .withIndex("by_documentId_and_version", (q) =>
      q.eq("documentId", document._id).lte("version", version),
    )
    .order("desc")
    .first();
  if (snapshot === null) {
    // Version 0 is always snapshotted at creation; missing means corrupt history.
    throw new Error(
      `No snapshot at or below version ${version} for document ${document._id}; history is corrupt.`,
    );
  }
  let doc = snapshot.doc as EmailDocument;
  if (snapshot.version === version) {
    return doc;
  }
  const opsToReplay = await ctx.db
    .query("operations")
    .withIndex("by_documentId_and_version", (q) =>
      q.eq("documentId", document._id).gt("version", snapshot.version).lte("version", version),
    )
    .order("asc")
    .collect();
  for (const opRow of opsToReplay) {
    const result = applyOperation(doc, opRow.op as Operation);
    if (!result.isOk) {
      // Ops replay deterministically from the state they were applied to.
      throw new Error(
        `Replaying operation version ${opRow.version} of document ${document._id} failed: ${result.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    doc = result.doc;
  }
  return doc;
}
