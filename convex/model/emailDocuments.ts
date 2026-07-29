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
 */
export async function commitVersions({
  ctx,
  state,
  newDoc,
  entries,
  context,
}: {
  ctx: MutationCtx;
  state: DocumentState;
  newDoc: EmailDocument;
  entries: CommitEntry[];
  context: ApplyContext;
}): Promise<CommitResult> {
  const { document } = state;
  const now = Date.now();
  const oldHeadVersion = document.headVersion;
  const newHeadVersion = oldHeadVersion + entries.length;

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
  }
  for (const [blockId, row] of state.blockRowsByBlockId) {
    if (!newBlockIdSet.has(blockId)) {
      await ctx.db.delete(row._id);
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
