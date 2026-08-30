import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { resolveOwnerId } from "./authIdentity";

/*
  Comments mode — canvas review threads (see the schema doc note for the
  shape invariants: pointer-presence anchor model, creation-time denormalized
  context, human-only status flips).

  Module contract mirrors personaFindings.ts: bounded indexed reads, small
  idempotent mutations, and NOTHING here dispatches document operations — an
  agent "fix" runs as a normal chat turn through the one history spine; this
  module only records the conversation around it.

  AUTHORSHIP IS NOT A SECRET AND MUST NOT BE ONE. Two rules, both load-bearing:

  1. Author ids are WRITTEN through resolveOwnerId (convex/authIdentity.ts),
     so nobody can post or resolve a thread as somebody else once identity
     exists.
  2. Author ids are never READ BACK OUT. A comment thread is visible to every
     holder of the canvas link, so returning the raw author id handed each of
     them an ownership key for that person's brand kit, assets, saved sections
     and personas (better-auth-evaluation.md §2.4 item 4). The payloads below
     carry the denormalized `authorName` — which is what the UI actually
     renders — and nothing else about who wrote them. Adding an id back here
     reopens the leak, so don't; if a surface ever needs "is this mine", take
     the caller's session id as an argument and return a boolean.
*/

/*
  Upper bound on comment rows read per canvas listing (demo scale).
*/
const MAX_COMMENTS_PER_CANVAS = 200;

/*
  Upper bound on open pins returned per document (demo scale).
*/
const MAX_OPEN_COMMENTS_PER_DOCUMENT = 100;

/*
  Hard cap on entries one thread may hold (oldest are never evicted — adds fail).
*/
const MAX_THREAD_ENTRIES = 50;

/*
  Caps mirror the composer's practical sizes; oversized input is truncated, not rejected.
*/
const MAX_COMMENT_TEXT_CHARS = 2000;
const MAX_CONTEXT_FIELD_CHARS = 160;

const commentStatusValidator = v.union(
  v.literal("open"),
  v.literal("resolved"),
  v.literal("dismissed"),
);

const anchorValidator = v.object({
  blockId: v.union(v.string(), v.null()),
  x: v.number(),
  y: v.number(),
});

/*
  Wire shape for one thread entry. No author id — see the module note.
*/
const threadEntryValidator = v.object({
  authorKind: v.union(v.literal("user"), v.literal("agent")),
  authorName: v.string(),
  text: v.string(),
  createdAtMs: v.number(),
});

/*
  Wire shape for one thread. No author id — see the module note.
*/
const commentPayloadValidator = v.object({
  commentId: v.id("comments"),
  canvasId: v.id("canvases"),
  documentId: v.id("documents"),
  anchor: anchorValidator,
  context: v.object({
    draftName: v.string(),
    breadcrumb: v.string(),
    blockType: v.optional(v.string()),
    textSnippet: v.optional(v.string()),
  }),
  thread: v.array(threadEntryValidator),
  status: commentStatusValidator,
  resolvedAtMs: v.optional(v.number()),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

/*
  Row → wire. The projection is the redaction boundary: `sessionId`,
  `resolvedBySessionId` and each entry's `authorSessionId` stay in the row
  (the migration seam re-keys them) and never reach a reader.
*/
function toCommentPayload(row: Doc<"comments">) {
  return {
    commentId: row._id,
    canvasId: row.canvasId,
    documentId: row.documentId,
    anchor: row.anchor,
    context: row.context,
    thread: row.thread.map((entry) => ({
      authorKind: entry.authorKind,
      authorName: entry.authorName,
      text: entry.text,
      createdAtMs: entry.createdAtMs,
    })),
    status: row.status,
    ...(row.resolvedAtMs !== undefined ? { resolvedAtMs: row.resolvedAtMs } : {}),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

async function getLiveDocument(
  ctx: MutationCtx,
  documentId: Id<"documents">,
): Promise<Doc<"documents">> {
  const document = await ctx.db.get(documentId);
  if (document === null) {
    throw new Error(`Document ${documentId} does not exist.`);
  }
  return document;
}

/*
  The review panel's canvas-wide feed: every comment thread on the canvas,
  bounded, open first and newest first within each status group (the panel
  renders it as returned).
*/
export const listCommentsForCanvas = query({
  args: { canvasId: v.id("canvases") },
  returns: v.array(commentPayloadValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("comments")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .order("desc")
      .take(MAX_COMMENTS_PER_CANVAS);
    return rows
      .sort((a, b) => {
        const aOpenRank = a.status === "open" ? 0 : 1;
        const bOpenRank = b.status === "open" ? 0 : 1;
        return aOpenRank !== bOpenRank ? aOpenRank - bOpenRank : b.createdAtMs - a.createdAtMs;
      })
      .map(toCommentPayload);
  },
});

/*
  The pins feed: OPEN comments for one document, oldest first (stable pin
  stacking). Resolved/dismissed threads leave the canvas and live only in
  the review panel's history.
*/
export const listOpenCommentsForDocument = query({
  args: { documentId: v.id("documents") },
  returns: v.array(commentPayloadValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("comments")
      .withIndex("by_documentId_and_status", (q) =>
        q.eq("documentId", args.documentId).eq("status", "open"),
      )
      .take(MAX_OPEN_COMMENTS_PER_DOCUMENT);
    return rows.sort((a, b) => a.createdAtMs - b.createdAtMs).map(toCommentPayload);
  },
});

/*
  Place one comment. The client sends what only IT knows (the anchor it
  hit-tested, the breadcrumb/snippet from its rendered doc, the first thread
  entry's text); the server denormalizes what IT owns — canvasId and the
  draft's current name — from the documents row, so callers can't write a
  comment into the wrong canvas.
*/
export const createComment = mutation({
  args: {
    documentId: v.id("documents"),
    sessionId: v.string(),
    authorName: v.string(),
    anchor: anchorValidator,
    context: v.object({
      breadcrumb: v.string(),
      blockType: v.optional(v.string()),
      textSnippet: v.optional(v.string()),
    }),
    text: v.string(),
  },
  returns: v.id("comments"),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const document = await getLiveDocument(ctx, args.documentId);
    const text = truncate(args.text, MAX_COMMENT_TEXT_CHARS);
    if (text.length === 0) {
      throw new Error("A comment needs some text.");
    }
    const nowMs = Date.now();
    return await ctx.db.insert("comments", {
      canvasId: document.canvasId,
      documentId: args.documentId,
      sessionId: ownerId,
      anchor: args.anchor,
      context: {
        draftName: truncate(document.name, MAX_CONTEXT_FIELD_CHARS),
        breadcrumb: truncate(args.context.breadcrumb, MAX_CONTEXT_FIELD_CHARS),
        ...(args.context.blockType !== undefined
          ? { blockType: truncate(args.context.blockType, MAX_CONTEXT_FIELD_CHARS) }
          : {}),
        ...(args.context.textSnippet !== undefined
          ? { textSnippet: truncate(args.context.textSnippet, MAX_CONTEXT_FIELD_CHARS) }
          : {}),
      },
      thread: [
        {
          authorKind: "user" as const,
          authorSessionId: ownerId,
          authorName: truncate(args.authorName, MAX_CONTEXT_FIELD_CHARS),
          text,
          createdAtMs: nowMs,
        },
      ],
      status: "open" as const,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  },
});

/*
  Append one entry to a thread: a human reply ("respond" in the review
  workflow) or the agent's post-fix response note. Works on any status —
  replying to a resolved thread is a conversation, not a reopen (status
  flips stay explicit and human-only).
*/
export const addThreadEntry = mutation({
  args: {
    commentId: v.id("comments"),
    authorKind: v.union(v.literal("user"), v.literal("agent")),
    authorSessionId: v.optional(v.string()),
    authorName: v.string(),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    /*
      The agent's own progress notes carry no session id and need no owner;
      a human reply is attributed to the resolved owner, never to the string
      the client sent.
    */
    const authorOwnerId =
      args.authorSessionId === undefined
        ? undefined
        : await resolveOwnerId(ctx, { claimedSessionId: args.authorSessionId });
    const row = await ctx.db.get(args.commentId);
    if (row === null) {
      return null; /* thread deleted (draft cascade) — reply quietly lost */
    }
    if (row.thread.length >= MAX_THREAD_ENTRIES) {
      throw new Error("This thread is full — resolve it and start a new comment.");
    }
    const text = truncate(args.text, MAX_COMMENT_TEXT_CHARS);
    if (text.length === 0) {
      return null;
    }
    const nowMs = Date.now();
    await ctx.db.patch(args.commentId, {
      thread: [
        ...row.thread,
        {
          authorKind: args.authorKind,
          ...(authorOwnerId === undefined ? {} : { authorSessionId: authorOwnerId }),
          authorName: truncate(args.authorName, MAX_CONTEXT_FIELD_CHARS),
          text,
          createdAtMs: nowMs,
        },
      ],
      updatedAtMs: nowMs,
    });
    return null;
  },
});

/*
  A human accepted the outcome (or withdrew the comment). Idempotent: only
  an OPEN thread flips, so concurrent clicks from two tabs both succeed
  quietly and the first writer's resolution info wins.
*/
export const resolveComment = mutation({
  args: { commentId: v.id("comments"), sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await closeComment({ ctx, commentId: args.commentId, sessionId: args.sessionId, status: "resolved" });
    return null;
  },
});

/*
  A human dismissed the comment without action. Same idempotence as resolve.
*/
export const dismissComment = mutation({
  args: { commentId: v.id("comments"), sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await closeComment({ ctx, commentId: args.commentId, sessionId: args.sessionId, status: "dismissed" });
    return null;
  },
});

async function closeComment({
  ctx,
  commentId,
  sessionId,
  status,
}: {
  ctx: MutationCtx;
  commentId: Id<"comments">;
  /*
    The CLAIMED session id — resolved here, never stored as given.
  */
  sessionId: string;
  status: "resolved" | "dismissed";
}): Promise<void> {
  const ownerId = await resolveOwnerId(ctx, { claimedSessionId: sessionId });
  const row = await ctx.db.get(commentId);
  if (row !== null && row.status === "open") {
    await ctx.db.patch(commentId, {
      status,
      resolvedBySessionId: ownerId,
      resolvedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
  }
}
