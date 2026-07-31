import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";

/**
 * Multi-agent canvas v1 — persisted advisory persona findings (proposal §3.6
 * client-merge sketch, §5.6). The /api/personas runner RECORDS findings here
 * after its batched analysis call; every tab of every collaborator reads the
 * open rows reactively (listOpenFindings) and surfaces them as
 * source:"analysis" suggestion cards; dismiss/apply flip the row's status so
 * ALL tabs converge. See the schema doc comment for the full shape
 * invariants (unvalidated ops JSON, staleness snapshots, one-way lifecycle).
 *
 * ADVISORY invariant restated: nothing in this module dispatches operations.
 * A finding's ops reach the document ONLY when a human clicks Apply in the
 * suggestions UI, which goes through the store's normal dispatch →
 * documents.applyOperations with `persona:<slug>` provenance — the single
 * history spine. markFindingApplied merely records that it happened.
 */

/** Upper bound on open findings returned/held per document (demo scale). */
const MAX_OPEN_FINDINGS_PER_DOCUMENT = 24;

/** Sanity cap on findings one recordFindings call may carry (route caps at 4/run). */
const MAX_FINDINGS_PER_RECORD = 12;

const findingStatusValidator = v.union(
  v.literal("open"),
  v.literal("dismissed"),
  v.literal("applied"),
);

/** The recordable payload — exactly what the runner composes per finding. */
const findingInputValidator = v.object({
  personaSlug: v.string(),
  personaName: v.string(),
  personaColor: v.string(),
  patternKey: v.string(),
  title: v.string(),
  description: v.string(),
  targetBlockNames: v.array(v.string()),
  targetBlockIds: v.array(v.string()),
  /** Dry-run-validated ops JSON (runtime guard: email-sdk Zod, in the route). */
  ops: v.array(v.any()),
  /** blockId → stableStringify(block) from the doc the ops were validated against. */
  targetSnapshots: v.record(v.string(), v.string()),
});

const findingPayloadValidator = v.object({
  findingId: v.id("personaFindings"),
  personaSlug: v.string(),
  personaName: v.string(),
  personaColor: v.string(),
  patternKey: v.string(),
  title: v.string(),
  description: v.string(),
  targetBlockNames: v.array(v.string()),
  targetBlockIds: v.array(v.string()),
  ops: v.array(v.any()),
  targetSnapshots: v.record(v.string(), v.string()),
  createdAtMs: v.number(),
});

function toFindingPayload(row: Doc<"personaFindings">) {
  return {
    findingId: row._id,
    personaSlug: row.personaSlug,
    personaName: row.personaName,
    personaColor: row.personaColor,
    patternKey: row.patternKey,
    title: row.title,
    description: row.description,
    targetBlockNames: row.targetBlockNames,
    targetBlockIds: row.targetBlockIds,
    ops: row.ops,
    targetSnapshots: row.targetSnapshots,
    createdAtMs: row.createdAtMs,
  };
}

async function assertLiveDocument(
  ctx: MutationCtx,
  documentId: Id<"documents">,
): Promise<void> {
  const document = await ctx.db.get(documentId);
  if (document === null) {
    throw new Error(`Document ${documentId} does not exist.`);
  }
}

/**
 * The reactive card feed: every OPEN finding for a document, newest first.
 * Clients derive the visible card set from this (their own local staleness
 * filter + the ≤3-visible cap); the runner reads it to prune stale rows and
 * assemble its §5.6b dedup context.
 */
export const listOpenFindings = query({
  args: { documentId: v.id("documents") },
  returns: v.array(findingPayloadValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("personaFindings")
      .withIndex("by_documentId_and_status", (q) =>
        q.eq("documentId", args.documentId).eq("status", "open"),
      )
      .take(MAX_OPEN_FINDINGS_PER_DOCUMENT);
    return rows.sort((a, b) => b.createdAtMs - a.createdAtMs).map(toFindingPayload);
  },
});

/** Upper bound on history rows returned (recommendations modal, demo scale). */
const MAX_HISTORY_FINDINGS = 100;

const findingHistoryPayloadValidator = v.object({
  findingId: v.id("personaFindings"),
  personaSlug: v.string(),
  personaName: v.string(),
  personaColor: v.string(),
  title: v.string(),
  description: v.string(),
  targetBlockNames: v.array(v.string()),
  status: findingStatusValidator,
  /** True when the finding carries ops a human can apply (else informational). */
  isActionable: v.boolean(),
  createdAtMs: v.number(),
});

/**
 * The recommendations-history feed: EVERY finding for a document — open,
 * dismissed, and applied — newest first, bounded. Backs the recommendations
 * modal (all/agent tabs) and the facepile popover's recent list. Rows are
 * trimmed to display fields only: no ops JSON or snapshots ride along (the
 * modal's per-item actions go through the same dismiss/apply mutations the
 * cards use, keyed by findingId).
 */
export const listFindingsForDocument = query({
  args: { documentId: v.id("documents") },
  returns: v.array(findingHistoryPayloadValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("personaFindings")
      .withIndex("by_documentId", (q) => q.eq("documentId", args.documentId))
      .order("desc")
      .take(MAX_HISTORY_FINDINGS);
    return rows
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((row) => ({
        findingId: row._id,
        personaSlug: row.personaSlug,
        personaName: row.personaName,
        personaColor: row.personaColor,
        title: row.title,
        description: row.description,
        targetBlockNames: row.targetBlockNames,
        status: row.status,
        isActionable: row.ops.length > 0,
        createdAtMs: row.createdAtMs,
      }));
  },
});

/**
 * Record one runner pass's findings. Dedup rules (§5.6):
 * - a DISMISSED row with the same patternKey wins — the finding is skipped
 *   (server-side twin of the client's localStorage dismissal keys);
 * - an OPEN row with the same patternKey is REPLACED in place (the new pass
 *   re-affirmed the finding against the current doc — fresher copy, fresher
 *   snapshots), keeping the row id stable for any tab currently showing it;
 * - otherwise insert, bounded by MAX_OPEN_FINDINGS_PER_DOCUMENT.
 * An APPLIED row never blocks re-recording: the doc changed when it was
 * applied, so a same-key finding is presumptively about the new state.
 */
export const recordFindings = mutation({
  args: {
    documentId: v.id("documents"),
    findings: v.array(findingInputValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLiveDocument(ctx, args.documentId);
    const existing = await ctx.db
      .query("personaFindings")
      .withIndex("by_documentId", (q) => q.eq("documentId", args.documentId))
      .collect();
    const dismissedPatternKeys = new Set(
      existing.filter((row) => row.status === "dismissed").map((row) => row.patternKey),
    );
    const openByPatternKey = new Map(
      existing.filter((row) => row.status === "open").map((row) => [row.patternKey, row]),
    );
    let openCount = openByPatternKey.size;
    const nowMs = Date.now();
    for (const finding of args.findings.slice(0, MAX_FINDINGS_PER_RECORD)) {
      if (dismissedPatternKeys.has(finding.patternKey)) {
        continue;
      }
      const openMatch = openByPatternKey.get(finding.patternKey);
      if (openMatch !== undefined) {
        await ctx.db.patch(openMatch._id, {
          ...finding,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        continue;
      }
      if (openCount >= MAX_OPEN_FINDINGS_PER_DOCUMENT) {
        continue;
      }
      await ctx.db.insert("personaFindings", {
        documentId: args.documentId,
        ...finding,
        status: "open",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      openCount += 1;
    }
    return null;
  },
});

/**
 * Delete OPEN rows the runner found stale (a target-block snapshot drifted).
 * Only the runner calls this — clients hide stale findings locally and never
 * mutate, which is what keeps apply/staleness race-free across tabs. Rows
 * that were dismissed/applied (or deleted) since the runner read them are
 * left untouched: status transitions outrank a stale sweep.
 */
export const pruneStaleFindings = mutation({
  args: {
    documentId: v.id("documents"),
    findingIds: v.array(v.id("personaFindings")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const findingId of args.findingIds.slice(0, MAX_OPEN_FINDINGS_PER_DOCUMENT)) {
      const row = await ctx.db.get(findingId);
      if (row !== null && row.documentId === args.documentId && row.status === "open") {
        await ctx.db.delete(findingId);
      }
    }
    return null;
  },
});

/**
 * A human dismissed the finding: it disappears from EVERY tab's open feed,
 * and its patternKey blocks re-recording (see recordFindings). Idempotent —
 * concurrent dismissals from two tabs both succeed quietly.
 */
export const dismissFinding = mutation({
  args: { findingId: v.id("personaFindings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.findingId);
    if (row !== null && row.status === "open") {
      await ctx.db.patch(args.findingId, { status: "dismissed", updatedAtMs: Date.now() });
    }
    return null;
  },
});

/**
 * A human applied the finding's ops (which went through the normal suggestions
 * dispatch path — this mutation only RECORDS the outcome). `appliedBatchId`
 * links to the op-log batch carrying the `persona:<slug>`-provenance ops.
 * Idempotent; a row that was pruned or dismissed in the meantime is left as-is.
 */
export const markFindingApplied = mutation({
  args: { findingId: v.id("personaFindings"), appliedBatchId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.findingId);
    if (row !== null && row.status === "open") {
      await ctx.db.patch(args.findingId, {
        status: "applied",
        appliedBatchId: args.appliedBatchId,
        updatedAtMs: Date.now(),
      });
    }
    return null;
  },
});

// Referenced by the schema doc comment; keeps the status union in one place
// for future callers (e.g. a findings-history query).
export { findingStatusValidator };
