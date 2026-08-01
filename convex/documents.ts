import {
  applyOperations as applyOperationsToDocument,
  createEmptyDocument,
  createSampleDocument,
  createStarterDocument,
  withRemoveBlockCascadeDefault,
  type Operation,
} from "@flock/email-sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import {
  createEmptyCleanupStats,
  deleteDocumentCascade,
  MAX_ROW_DELETIONS_PER_RUN,
} from "./model/cleanup";
import { emailDocumentValidator, operationAuthorValidator, actionCallerValidator } from "./schema";
import {
  applyContextValidator,
  commitVersions,
  loadDocumentState,
  MAX_OPERATIONS_PAGE_SIZE,
  MAX_OPERATIONS_PER_CALL,
  operationErrorValidator,
  reconstructDocumentAtVersion,
  toTransportErrors,
  type CommitEntry,
} from "./model/emailDocuments";

/**
 * Phase 4.1 — document lifecycle, THE operation write path, and reads
 * (including the point-in-time version read that proves the history design).
 * Undo/redo/batch-revert live in convex/history.ts.
 *
 * All functions are public: the frontend store swap calls them directly, and
 * the Phase 4.2 AI route calls `applyOperations` server-side. Per the
 * no-auth demo-first decision (plan gap 4 / Phase 6.1), the document id is
 * the capability — anyone holding it may read and write; `sessionId` only
 * keys listing and future cleanup.
 */

// ---------------------------------------------------------------------------
// createDocument / duplicateDocument
// ---------------------------------------------------------------------------

/** Next orderIndex after the last draft on a canvas (drafts per canvas stay small; collect is bounded). */
async function computeAppendOrderIndex(
  ctx: MutationCtx,
  canvasId: Id<"canvases">,
): Promise<number> {
  const siblings = await ctx.db
    .query("documents")
    .withIndex("by_canvasId", (q) => q.eq("canvasId", canvasId))
    .collect();
  return siblings.reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1;
}

export const createDocument = mutation({
  args: {
    sessionId: v.string(),
    /** Canvas to add this draft to; omitted = create a fresh canvas for it. */
    canvasId: v.optional(v.id("canvases")),
    /** Draft display name (unique per canvas by convention). */
    name: v.optional(v.string()),
    /** Title for the canvas, used only when `canvasId` is omitted. */
    canvasTitle: v.optional(v.string()),
    /**
     * Seed the deterministic every-block-type sample document (tests/demos)
     * instead of the default designed starter email.
     */
    shouldSeedSample: v.optional(v.boolean()),
    /**
     * Seed a childless root (no sections) instead of the starter email —
     * the AI draft-generation flow composes the whole email from blank, so
     * starter sections would only pollute the generated result.
     */
    shouldSeedEmpty: v.optional(v.boolean()),
  },
  returns: v.object({ documentId: v.id("documents"), canvasId: v.id("canvases") }),
  handler: async (ctx, args) => {
    const now = Date.now();
    let canvasId = args.canvasId;
    if (canvasId === undefined) {
      canvasId = await ctx.db.insert("canvases", {
        sessionId: args.sessionId,
        ...(args.canvasTitle !== undefined ? { title: args.canvasTitle } : {}),
        createdAtMs: now,
        updatedAtMs: now,
      });
    } else {
      const canvas = await ctx.db.get(canvasId);
      if (canvas === null) {
        throw new Error(`Canvas ${canvasId} does not exist.`);
      }
    }
    // Every new document/draft opens on the designed starter email (Resend-
    // welcome-style; see createStarterDocument) — never empty. Two exceptions:
    // the deterministic every-block-type sample (tests/demos) and the blank
    // seed the AI draft-generation flow composes into.
    const doc =
      args.shouldSeedSample === true
        ? createSampleDocument()
        : args.shouldSeedEmpty === true
          ? createEmptyDocument()
          : createStarterDocument();
    const documentId = await ctx.db.insert("documents", {
      canvasId,
      sessionId: args.sessionId,
      name: args.name ?? "Draft 1",
      orderIndex: await computeAppendOrderIndex(ctx, canvasId),
      headVersion: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });
    for (const block of Object.values(doc)) {
      await ctx.db.insert("blocks", {
        documentId,
        blockId: block.id,
        type: block.type,
        parentId: block.parentId,
        childrenIds: block.childrenIds as string[],
        properties: block.properties as Record<string, unknown>,
      });
    }
    // Version 0 snapshot: the anchor every point-in-time read replays from.
    await ctx.db.insert("snapshots", {
      documentId,
      version: 0,
      doc: doc as Record<string, unknown>,
      createdAtMs: now,
    });
    return { documentId, canvasId };
  },
});

export const duplicateDocument = mutation({
  args: {
    documentId: v.id("documents"),
    /** Name for the copy; defaults to "<source name> (copy)". */
    name: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.id("documents")),
  handler: async (ctx, args) => {
    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      return null;
    }
    const source = state.document;
    const now = Date.now();
    // Place the copy directly after the source: midpoint to the next draft,
    // or source + 1 when the source is last.
    const siblings = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", source.canvasId))
      .collect();
    const nextSiblings = siblings
      .filter((row) => row.orderIndex > source.orderIndex)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const orderIndex =
      nextSiblings.length > 0
        ? (source.orderIndex + nextSiblings[0]!.orderIndex) / 2
        : source.orderIndex + 1;
    // Figma-fork semantics: the copy starts a fresh, independent version
    // sequence (headVersion 0, its own v0 snapshot of the source's HEAD).
    // Lineage fields record where it came from; histories never interleave.
    const newDocumentId = await ctx.db.insert("documents", {
      canvasId: source.canvasId,
      sessionId: source.sessionId,
      name: args.name ?? `${source.name} (copy)`,
      orderIndex,
      headVersion: 0,
      forkedFromDocumentId: source._id,
      forkedFromVersion: source.headVersion,
      createdAtMs: now,
      updatedAtMs: now,
    });
    for (const row of state.blockRowsByBlockId.values()) {
      await ctx.db.insert("blocks", {
        documentId: newDocumentId,
        blockId: row.blockId,
        type: row.type,
        parentId: row.parentId,
        childrenIds: row.childrenIds,
        properties: row.properties,
      });
    }
    await ctx.db.insert("snapshots", {
      documentId: newDocumentId,
      version: 0,
      doc: state.doc as Record<string, unknown>,
      createdAtMs: now,
    });
    await ctx.db.patch(source.canvasId, { updatedAtMs: now });
    return newDocumentId;
  },
});

/**
 * Rename a draft's USER-FACING name (§10.2 dual naming: `name` is
 * human-editable and never touched by the agent; `agentName` is the agent's
 * parallel summary and is never writable from here). Blank names are
 * rejected as a no-op rather than thrown — the UI trims and guards, this is
 * just the server-side backstop.
 */
export const renameDocument = mutation({
  args: {
    documentId: v.id("documents"),
    name: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (name.length === 0) {
      return false;
    }
    const document = await ctx.db.get(args.documentId);
    if (document === null) {
      return false;
    }
    if (document.name === name) {
      return true;
    }
    const now = Date.now();
    await ctx.db.patch(args.documentId, { name, updatedAtMs: now });
    await ctx.db.patch(document.canvasId, { updatedAtMs: now });
    return true;
  },
});

// ---------------------------------------------------------------------------
// deleteDocument / promoteDocumentToNewCanvas
// ---------------------------------------------------------------------------

/**
 * Delete one draft and its full constellation (blocks, operations, snapshots,
 * ProseMirror sync docs, exclusively-referenced storage files, ghost
 * sessions, persona findings) via the SAME cascade the Phase 6.1 cleanup
 * cron uses — one deletion path, no drift.
 *
 * Guard: the LAST draft on a canvas can never be deleted (the UI disables
 * the action; this is the server-side backstop). Deleting always leaves the
 * canvas with at least one draft, so the cascade's empty-canvas step never
 * fires here.
 *
 * If the cascade exhausts its row budget (a document with a very long op
 * log), the document row is still present and a targeted cleanup
 * continuation is scheduled to finish the job; the client can treat the
 * delete as done either way.
 */
export const deleteDocument = mutation({
  args: { documentId: v.id("documents") },
  returns: v.union(
    v.object({ isOk: v.literal(true) }),
    v.object({
      isOk: v.literal(false),
      reason: v.union(v.literal("not_found"), v.literal("last_draft")),
    }),
  ),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (document === null) {
      return { isOk: false as const, reason: "not_found" as const };
    }
    // Drafts per canvas stay small (a handful of frames); bounded.
    const siblings = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", document.canvasId))
      .collect();
    const hasSurvivingSibling = siblings.some((row) => row._id !== document._id);
    if (!hasSurvivingSibling) {
      return { isOk: false as const, reason: "last_draft" as const };
    }

    const budget = { remaining: MAX_ROW_DELETIONS_PER_RUN };
    const stats = createEmptyCleanupStats();
    const { isComplete } = await deleteDocumentCascade({ ctx, document, budget, stats });
    if (!isComplete) {
      // Finish the cascade out-of-band: retentionDays 0 makes the cutoff
      // "now", and onlyDocumentId narrows the run to this document.
      await ctx.scheduler.runAfter(0, internal.cleanup.cleanupStaleDocuments, {
        retentionDays: 0,
        onlyDocumentId: document._id,
      });
    }
    await ctx.db.patch(document.canvasId, { updatedAtMs: Date.now() });
    return { isOk: true as const };
  },
});

/**
 * §10.2 "promote a draft to its own canvas": MOVE the document to a freshly
 * created canvas titled after the draft. The document id — and with it the
 * whole history spine (operations/snapshots/blocks/sync docs/findings are
 * all keyed by documentId) — is unchanged; only `canvasId` and the canvas
 * placement move. Existing `?doc=` links keep working and now open the new
 * canvas.
 *
 * Guard: a draft that is already alone on its canvas has nothing to promote
 * (the UI disables the action; this is the backstop).
 */
export const promoteDocumentToNewCanvas = mutation({
  args: { documentId: v.id("documents") },
  returns: v.union(
    v.object({ isOk: v.literal(true), canvasId: v.id("canvases") }),
    v.object({
      isOk: v.literal(false),
      reason: v.union(v.literal("not_found"), v.literal("already_alone")),
    }),
  ),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (document === null) {
      return { isOk: false as const, reason: "not_found" as const };
    }
    const siblings = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", document.canvasId))
      .collect();
    const hasSurvivingSibling = siblings.some((row) => row._id !== document._id);
    if (!hasSurvivingSibling) {
      return { isOk: false as const, reason: "already_alone" as const };
    }
    const now = Date.now();
    const newCanvasId = await ctx.db.insert("canvases", {
      sessionId: document.sessionId,
      title: document.name,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await ctx.db.patch(document._id, {
      canvasId: newCanvasId,
      orderIndex: 0,
      updatedAtMs: now,
    });
    await ctx.db.patch(document.canvasId, { updatedAtMs: now });
    return { isOk: true as const, canvasId: newCanvasId };
  },
});

// ---------------------------------------------------------------------------
// applyOperations — THE write path
// ---------------------------------------------------------------------------

const applyOperationsResultValidator = v.union(
  v.object({
    isOk: v.literal(true),
    headVersion: v.number(),
    /** One version per input op, in order. */
    appliedVersions: v.array(v.number()),
  }),
  v.object({
    isOk: v.literal(false),
    /** Index into `ops` of the operation that failed (0 for pre-apply failures). */
    failedOperationIndex: v.number(),
    errors: v.array(operationErrorValidator),
  }),
);

export const applyOperations = mutation({
  args: {
    documentId: v.id("documents"),
    /** Operation JSON payloads; each is Zod-validated by the SDK before anything is written. */
    ops: v.array(v.any()),
    context: applyContextValidator,
  },
  returns: applyOperationsResultValidator,
  handler: async (ctx, args) => {
    if (args.ops.length === 0) {
      return {
        isOk: false as const,
        failedOperationIndex: 0,
        errors: [
          { code: "op_validation_failed", message: "ops must contain at least one operation." },
        ],
      };
    }
    if (args.ops.length > MAX_OPERATIONS_PER_CALL) {
      return {
        isOk: false as const,
        failedOperationIndex: 0,
        errors: [
          {
            code: "op_validation_failed",
            message: `ops contains ${args.ops.length} operations; the maximum per call is ${MAX_OPERATIONS_PER_CALL}. Split the batch.`,
          },
        ],
      };
    }
    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      return {
        isOk: false as const,
        failedOperationIndex: 0,
        errors: [
          { code: "target_not_found", message: `Document ${args.documentId} does not exist.` },
        ],
      };
    }

    // Live-entry normalization: a removeBlock with no explicit cascade choice
    // collapses emptied columns/rows (withRemoveBlockCascadeDefault). Applied
    // HERE — where new ops enter the log — and never to stored ops/inverses,
    // so historical rows replay with their original semantics. Frontend ops
    // arrive already normalized by the SDK action registry (identical result);
    // this catches raw http/cli/mcp callers.
    // (Null-safe: malformed payload elements pass through untouched so the
    // SDK's Zod validation can reject them with a structured error.)
    const ops = (args.ops as Operation[]).map((op) =>
      op !== null && typeof op === "object" ? withRemoveBlockCascadeDefault(op) : op,
    );

    // All-or-nothing SDK apply. The SDK Zod-validates each op envelope and
    // re-validates schema + referential integrity of every intermediate doc —
    // no additional integrity pass is needed here. On failure the head is
    // untouched and the structured errors go back to the caller (LLM repair
    // loop / user), NOT thrown.
    const result = applyOperationsToDocument(state.doc, ops);
    if (!result.isOk) {
      return {
        isOk: false as const,
        failedOperationIndex: result.failedOperationIndex,
        errors: toTransportErrors(result.errors),
      };
    }

    // `result.inverses` is in REVERSE order: inverses[0] undoes the LAST op.
    const entries: CommitEntry[] = ops.map((op, opIndex) => ({
      op,
      inverse: result.inverses[ops.length - 1 - opIndex]!,
      kind: "edit" as const,
    }));
    const commit = await commitVersions({
      ctx,
      state,
      newDoc: result.doc,
      entries,
      context: args.context,
      // Text writes whose content did not come from a block's sync doc must
      // force the sync doc to match (Phase 5.4 gap: a stale sync doc would
      // resurface in the editor and silently revert this write on the next
      // session commit). Frontend USER ops are the exception — their text
      // came FROM the sync doc. Frontend AGENT updateText never lands here
      // (routed to agentText.applyAgentTextEdit), so forcing the remaining
      // agent-authored cases is safe.
      shouldForceTextSyncDocs:
        args.context.caller !== "frontend" || args.context.author === "agent",
    });
    return { isOk: true as const, ...commit };
  },
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const documentPayloadValidator = v.object({
  documentId: v.id("documents"),
  doc: emailDocumentValidator,
  headVersion: v.number(),
  canvasId: v.id("canvases"),
  name: v.string(),
  orderIndex: v.number(),
  forkedFromDocumentId: v.optional(v.id("documents")),
  forkedFromVersion: v.optional(v.number()),
  sessionId: v.string(),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

/** Shared read for getDocument / getDocumentByKey: head doc + metadata, or null. */
async function readDocumentPayload(ctx: QueryCtx, documentId: Id<"documents">) {
  const state = await loadDocumentState(ctx, documentId);
  if (state === null) {
    return null;
  }
  const { document } = state;
  return {
    documentId: document._id,
    doc: state.doc as Record<string, unknown>,
    headVersion: document.headVersion,
    canvasId: document.canvasId,
    name: document.name,
    orderIndex: document.orderIndex,
    ...(document.forkedFromDocumentId !== undefined
      ? { forkedFromDocumentId: document.forkedFromDocumentId }
      : {}),
    ...(document.forkedFromVersion !== undefined
      ? { forkedFromVersion: document.forkedFromVersion }
      : {}),
    sessionId: document.sessionId,
    createdAtMs: document.createdAtMs,
    updatedAtMs: document.updatedAtMs,
  };
}

export const getDocument = query({
  args: { documentId: v.id("documents") },
  returns: v.union(v.null(), documentPayloadValidator),
  handler: async (ctx, args) => readDocumentPayload(ctx, args.documentId),
});

/**
 * getDocument keyed by an UNTRUSTED string (the `?doc=` URL param). A
 * malformed or foreign id normalizes to null instead of throwing an argument
 * validation error, so the frontend can render a clean "not found" state.
 */
export const getDocumentByKey = query({
  args: { documentKey: v.string() },
  returns: v.union(v.null(), documentPayloadValidator),
  handler: async (ctx, args) => {
    const documentId = ctx.db.normalizeId("documents", args.documentKey);
    if (documentId === null) {
      return null;
    }
    return readDocumentPayload(ctx, documentId);
  },
});

/**
 * Lean existence check for the web app's access-gate proxy (apps/web/src/proxy.ts):
 * a URL carrying a valid `?doc=<id>` passes the gate without the password.
 * Keyed by an UNTRUSTED string — malformed/foreign ids normalize to null and
 * return false rather than throwing. Exposes nothing beyond a boolean per id,
 * and the id is only guessable if you already hold it (the id IS the
 * capability, same as the rest of the app).
 */
export const documentExists = query({
  args: { documentKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const documentId = ctx.db.normalizeId("documents", args.documentKey);
    if (documentId === null) {
      return false;
    }
    const document = await ctx.db.get(documentId);
    return document !== null;
  },
});

/**
 * Sibling of documentExists for the `?canvas=` capability link: a lean
 * existence check keyed by an UNTRUSTED string. Same trust model — the
 * canvas id IS the capability, and nothing beyond a boolean per id leaks.
 */
export const canvasExists = query({
  args: { canvasKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const canvasId = ctx.db.normalizeId("canvases", args.canvasKey);
    if (canvasId === null) {
      return false;
    }
    const canvas = await ctx.db.get(canvasId);
    return canvas !== null;
  },
});

/**
 * Resolve a `?canvas=<id>` link to the draft the studio should open: the
 * canvas's most recently updated draft ("continue where the canvas left
 * off"); the drafts bar then shows all of its siblings. Keyed by an
 * UNTRUSTED string — malformed/foreign ids, and canvases with no drafts,
 * normalize to null.
 */
export const getCanvasEntryDocument = query({
  args: { canvasKey: v.string() },
  returns: v.union(v.null(), v.id("documents")),
  handler: async (ctx, args) => {
    const canvasId = ctx.db.normalizeId("canvases", args.canvasKey);
    if (canvasId === null) {
      return null;
    }
    // Drafts per canvas stay small (a handful of frames); bounded.
    const drafts = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", canvasId))
      .collect();
    if (drafts.length === 0) {
      return null;
    }
    const mostRecentDraft = drafts.reduce((latest, row) =>
      row.updatedAtMs > latest.updatedAtMs ? row : latest,
    );
    return mostRecentDraft._id;
  },
});

const operationEntryValidator = v.object({
  version: v.number(),
  op: v.any(),
  inverse: v.any(),
  authorId: v.string(),
  author: operationAuthorValidator,
  caller: actionCallerValidator,
  batchId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  kind: v.union(v.literal("edit"), v.literal("undo"), v.literal("redo")),
  undoesVersion: v.optional(v.number()),
  redoesVersion: v.optional(v.number()),
  isUndone: v.optional(v.boolean()),
  undoneByVersion: v.optional(v.number()),
  createdAtMs: v.number(),
});

export const getOperations = query({
  args: {
    documentId: v.id("documents"),
    /** Return ops with version > sinceVersion (default 0 = from the beginning). */
    sinceVersion: v.optional(v.number()),
    /** Page size, clamped to 1..200. The version itself is the continuation cursor. */
    limit: v.optional(v.number()),
  },
  returns: v.object({
    operations: v.array(operationEntryValidator),
    isDone: v.boolean(),
    /** Pass back as `sinceVersion` to fetch the next page. */
    nextSinceVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const sinceVersion =
      Number.isFinite(args.sinceVersion) && args.sinceVersion! >= 0
        ? Math.floor(args.sinceVersion!)
        : 0;
    const limit = Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.floor(args.limit!), 1), MAX_OPERATIONS_PAGE_SIZE)
      : 100;
    const rows = await ctx.db
      .query("operations")
      .withIndex("by_documentId_and_version", (q) =>
        q.eq("documentId", args.documentId).gt("version", sinceVersion),
      )
      .order("asc")
      .take(limit + 1);
    const page = rows.slice(0, limit);
    return {
      operations: page.map((row) => ({
        version: row.version,
        op: row.op,
        inverse: row.inverse,
        authorId: row.authorId,
        author: row.author,
        caller: row.caller,
        ...(row.batchId !== undefined ? { batchId: row.batchId } : {}),
        ...(row.threadId !== undefined ? { threadId: row.threadId } : {}),
        kind: row.kind,
        ...(row.undoesVersion !== undefined ? { undoesVersion: row.undoesVersion } : {}),
        ...(row.redoesVersion !== undefined ? { redoesVersion: row.redoesVersion } : {}),
        ...(row.isUndone !== undefined ? { isUndone: row.isUndone } : {}),
        ...(row.undoneByVersion !== undefined ? { undoneByVersion: row.undoneByVersion } : {}),
        createdAtMs: row.createdAtMs,
      })),
      isDone: rows.length <= limit,
      nextSinceVersion: page.length > 0 ? page[page.length - 1]!.version : sinceVersion,
    };
  },
});

export const getDocumentAtVersion = query({
  args: {
    documentId: v.id("documents"),
    version: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      doc: emailDocumentValidator,
      version: v.number(),
      headVersion: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (document === null) {
      return null;
    }
    const doc = await reconstructDocumentAtVersion({ ctx, document, version: args.version });
    if (doc === null) {
      return null;
    }
    return {
      doc: doc as Record<string, unknown>,
      version: args.version,
      headVersion: document.headVersion,
    };
  },
});

const documentListEntryValidator = v.object({
  _id: v.id("documents"),
  canvasId: v.id("canvases"),
  name: v.string(),
  /** Agent-authored semantic summary (§10.2 dual naming) — displayed, never user-edited. */
  agentName: v.optional(v.string()),
  orderIndex: v.number(),
  headVersion: v.number(),
  forkedFromDocumentId: v.optional(v.id("documents")),
  forkedFromVersion: v.optional(v.number()),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

interface DocumentListEntrySource {
  _id: Id<"documents">;
  canvasId: Id<"canvases">;
  name: string;
  agentName?: string;
  orderIndex: number;
  headVersion: number;
  forkedFromDocumentId?: Id<"documents">;
  forkedFromVersion?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

function toDocumentListEntry(row: DocumentListEntrySource) {
  return {
    _id: row._id,
    canvasId: row.canvasId,
    name: row.name,
    ...(row.agentName !== undefined ? { agentName: row.agentName } : {}),
    orderIndex: row.orderIndex,
    headVersion: row.headVersion,
    ...(row.forkedFromDocumentId !== undefined
      ? { forkedFromDocumentId: row.forkedFromDocumentId }
      : {}),
    ...(row.forkedFromVersion !== undefined ? { forkedFromVersion: row.forkedFromVersion } : {}),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

export const listDocumentsBySession = query({
  args: { sessionId: v.string() },
  returns: v.array(documentListEntryValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("documents")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(100);
    return rows.map(toDocumentListEntry);
  },
});

export const listDocumentsByCanvas = query({
  args: { canvasId: v.id("canvases") },
  returns: v.array(documentListEntryValidator),
  handler: async (ctx, args) => {
    // Drafts per canvas stay small (a handful of Figma-style frames); bounded.
    const rows = await ctx.db
      .query("documents")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .collect();
    return rows
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map(toDocumentListEntry);
  },
});
