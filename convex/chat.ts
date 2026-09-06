import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/*
  Durable main-agent chat for one canvas.

  A canvas remains the access boundary: possession of its id is the deliberate
  share-by-link capability used by documents and canvases. The thread itself
  never carries or trusts a client-supplied owner id, so turns cannot leak
  across canvas ids while collaborators can share one conversation.
*/

const MAX_TURN_ID_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_TURN_CONTENT_LENGTH = 200_000;
const MAX_CHAT_ROWS_PER_CLEANUP = 1000;

const chatThreadValidator = v.object({
  _id: v.id("chatThreads"),
  _creationTime: v.number(),
  canvasId: v.id("canvases"),
  lastSequence: v.number(),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

const chatTurnValidator = v.object({
  _id: v.id("chatTurns"),
  _creationTime: v.number(),
  threadId: v.id("chatThreads"),
  canvasId: v.id("canvases"),
  turnId: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  status: v.literal("finalized"),
  sequence: v.number(),
  createdAtMs: v.number(),
  finalizedAtMs: v.number(),
});

const persistedTurnValidator = v.object({
  turnId: v.string(),
  sequence: v.number(),
  isNew: v.boolean(),
});

type ChatContext = QueryCtx | MutationCtx;

export interface ChatDeletionBudget {
  remaining: number;
}

async function assertCanvasAccess(
  ctx: ChatContext,
  canvasId: Id<"canvases">,
): Promise<void> {
  const canvas = await ctx.db.get(canvasId);
  if (canvas === null) {
    throw new ConvexError("That chat thread is not available.");
  }
}

async function findThreads(ctx: ChatContext, canvasId: Id<"canvases">) {
  const threads = await ctx.db
    .query("chatThreads")
    .withIndex("by_canvasId", (q) => q.eq("canvasId", canvasId))
    .collect();
  return threads.sort(
    (left, right) =>
      left._creationTime - right._creationTime || left._id.localeCompare(right._id),
  );
}

/*
  Convex indexes are not unique constraints. A historical race, import, or
  manual repair can therefore leave multiple rows for one canvas. The oldest
  row (then its stable Convex id) is the canonical write target everywhere;
  callers still inspect every row so no duplicate's turns disappear from
  hydration, idempotency, or cleanup.
*/
async function findCanonicalThread(ctx: ChatContext, canvasId: Id<"canvases">) {
  return (await findThreads(ctx, canvasId))[0] ?? null;
}

async function getOrCreateThreadRow(
  {
    ctx,
    canvasId,
    now,
  }: {
    ctx: MutationCtx;
    canvasId: Id<"canvases">;
    now: number;
  },
) {
  const existing = await findCanonicalThread(ctx, canvasId);
  if (existing !== null) {
    return existing;
  }
  const threadId = await ctx.db.insert("chatThreads", {
    canvasId,
    lastSequence: 0,
    createdAtMs: now,
    updatedAtMs: now,
  });
  const thread = await ctx.db.get(threadId);
  if (thread === null) {
    throw new ConvexError("The chat thread could not be created.");
  }
  return thread;
}

function validateTurnInput(args: {
  turnId: string;
  idempotencyKey: string;
  content: string;
}): void {
  if (args.turnId.length === 0 || args.turnId.length > MAX_TURN_ID_LENGTH) {
    throw new ConvexError("Chat turn id is invalid.");
  }
  if (
    args.idempotencyKey.length === 0 ||
    args.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new ConvexError("Chat idempotency key is invalid.");
  }
  if (args.content.length === 0 || args.content.length > MAX_TURN_CONTENT_LENGTH) {
    throw new ConvexError("Chat turn content is invalid.");
  }
}

function isSameTurnPayload(
  turn: { role: "user" | "assistant"; content: string },
  args: { role: "user" | "assistant"; content: string },
): boolean {
  return turn.role === args.role && turn.content === args.content;
}

function throwIdempotencyConflict(): never {
  throw new ConvexError("This chat retry key was already used for different content.");
}

function throwTurnIdConflict(): never {
  throw new ConvexError("This chat turn id was already finalized with a different retry key.");
}

/*
  Hydrate the one durable thread before the chat UI renders or sends. This is
  a mutation because the first visit should provision the thread atomically;
  subsequent calls return the same row and never create a second thread.
*/
export const getOrCreateThread = mutation({
  args: { canvasId: v.id("canvases"), sessionId: v.string() },
  returns: chatThreadValidator,
  handler: async (ctx, args) => {
    await assertCanvasAccess(ctx, args.canvasId);
    return await getOrCreateThreadRow({ ctx, canvasId: args.canvasId, now: Date.now() });
  },
});

/*
  Read the thread without provisioning it. This is useful for a query-driven
  hydration path and remains capability-checked even when no row exists yet.
*/
export const getThread = query({
  args: { canvasId: v.id("canvases"), sessionId: v.string() },
  returns: v.union(chatThreadValidator, v.null()),
  handler: async (ctx, args) => {
    await assertCanvasAccess(ctx, args.canvasId);
    return await findCanonicalThread(ctx, args.canvasId);
  },
});

/*
  Return only finalized turns, in the exact sequence assigned by Convex.
  Turns are scoped through the canvas id supplied by the client and the
  denormalized canvas id stored on each row is checked before returning it.
*/
export const listTurns = query({
  args: { canvasId: v.id("canvases"), sessionId: v.string() },
  returns: v.array(chatTurnValidator),
  handler: async (ctx, args) => {
    await assertCanvasAccess(ctx, args.canvasId);
    const threads = await findThreads(ctx, args.canvasId);
    if (threads.length === 0) {
      return [];
    }
    const turnsByThread = await Promise.all(
      threads.map(async (thread) => ({
        threadOrder: threads.indexOf(thread),
        turns: await ctx.db
          .query("chatTurns")
          .withIndex("by_threadId_and_sequence", (q) => q.eq("threadId", thread._id))
          .collect(),
      })),
    );
    const seenTurnIds = new Set<string>();
    const seenIdempotencyKeys = new Set<string>();
    return turnsByThread
      .flatMap(({ threadOrder, turns }) =>
        turns
          .filter((turn) => turn.canvasId === args.canvasId)
          .map((turn) => ({ turn, threadOrder })),
      )
      .sort(
        (left, right) =>
          left.turn.sequence - right.turn.sequence ||
          left.threadOrder - right.threadOrder ||
          left.turn._creationTime - right.turn._creationTime ||
          left.turn._id.localeCompare(right.turn._id),
      )
      .filter(({ turn }) => {
        if (seenTurnIds.has(turn.turnId) || seenIdempotencyKeys.has(turn.idempotencyKey)) {
          return false;
        }
        seenTurnIds.add(turn.turnId);
        seenIdempotencyKeys.add(turn.idempotencyKey);
        return true;
      })
      .map(({ turn }) => turn)
      .map((turn) => ({
        _id: turn._id,
        _creationTime: turn._creationTime,
        threadId: turn.threadId,
        canvasId: turn.canvasId,
        turnId: turn.turnId,
        role: turn.role,
        content: turn.content,
        status: turn.status,
        sequence: turn.sequence,
        createdAtMs: turn.createdAtMs,
        finalizedAtMs: turn.finalizedAtMs,
      }));
  },
});

/*
  Persist one complete user or assistant turn.

  The stable turn id catches duplicate UI saves, while the idempotency key
  catches a retried request whose client message id changed. A matching retry
  returns the original sequence and does not write. A conflicting retry fails
  loudly, preserving the first finalized transcript rather than duplicating
  or silently rewriting model context.
*/
export const persistFinalizedTurn = mutation({
  args: {
    canvasId: v.id("canvases"),
    sessionId: v.string(),
    turnId: v.string(),
    idempotencyKey: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
  },
  returns: persistedTurnValidator,
  handler: async (ctx, args) => {
    await assertCanvasAccess(ctx, args.canvasId);
    validateTurnInput(args);
    const now = Date.now();
    const thread = await getOrCreateThreadRow({ ctx, canvasId: args.canvasId, now });
    const threads = await findThreads(ctx, args.canvasId);
    const turnsByThread = await Promise.all(
      threads.map(async (candidate) =>
        await ctx.db
          .query("chatTurns")
          .withIndex("by_threadId_and_sequence", (q) => q.eq("threadId", candidate._id))
          .collect(),
      ),
    );
    const allTurns = turnsByThread.flat();

    const existingByTurnId = allTurns.find((turn) => turn.turnId === args.turnId);
    if (existingByTurnId !== undefined) {
      if (existingByTurnId.idempotencyKey !== args.idempotencyKey) {
        throwTurnIdConflict();
      }
      if (!isSameTurnPayload(existingByTurnId, args)) {
        throwIdempotencyConflict();
      }
      return { turnId: existingByTurnId.turnId, sequence: existingByTurnId.sequence, isNew: false };
    }

    const existingByKey = allTurns.find((turn) => turn.idempotencyKey === args.idempotencyKey);
    if (existingByKey !== undefined) {
      if (!isSameTurnPayload(existingByKey, args)) {
        throwIdempotencyConflict();
      }
      return { turnId: existingByKey.turnId, sequence: existingByKey.sequence, isNew: false };
    }

    const sequence = Math.max(
      thread.lastSequence,
      ...threads.map((candidate) => candidate.lastSequence),
      ...allTurns.map((turn) => turn.sequence),
    ) + 1;
    await ctx.db.insert("chatTurns", {
      threadId: thread._id,
      canvasId: args.canvasId,
      turnId: args.turnId,
      idempotencyKey: args.idempotencyKey,
      role: args.role,
      content: args.content,
      status: "finalized",
      sequence,
      createdAtMs: now,
      finalizedAtMs: now,
    });
    await ctx.db.patch(thread._id, { lastSequence: sequence, updatedAtMs: now });
    return { turnId: args.turnId, sequence, isNew: true };
  },
});

/*
  Delete a canvas's turns before its thread. The mutable budget makes this
  helper safe for the resumable document/canvas cleanup cascade: if a retry
  runs out of rows, the thread remains as the marker and the next pass starts
  with the remaining turns. A missing thread is already complete.
*/
export async function deleteCanvasChat({
  ctx,
  canvasId,
  budget,
}: {
  ctx: MutationCtx;
  canvasId: Id<"canvases">;
  budget: ChatDeletionBudget;
}): Promise<{ isComplete: boolean }> {
  const threads = await findThreads(ctx, canvasId);
  if (threads.length === 0) {
    return { isComplete: true };
  }

  for (const thread of threads) {
    const turns = await ctx.db
      .query("chatTurns")
      .withIndex("by_threadId_and_sequence", (q) => q.eq("threadId", thread._id))
      .take(budget.remaining + 1);
    const deletableTurns = turns.slice(0, budget.remaining);
    for (const turn of deletableTurns) {
      await ctx.db.delete(turn._id);
    }
    budget.remaining -= deletableTurns.length;
    if (turns.length > deletableTurns.length || budget.remaining <= 0) {
      return { isComplete: false };
    }
    await ctx.db.delete(thread._id);
    budget.remaining -= 1;
  }
  return { isComplete: true };
}

/*
  Finish deleting chat rows for an empty canvas when the first canvas-delete
  mutation exhausts its shared row budget. The caller deliberately leaves the
  canvas in place until this continuation has removed the thread, preventing
  an orphaned conversation from being detached from its deletion marker.
*/
export const deleteCanvasChatContinuation = internalMutation({
  args: { canvasId: v.id("canvases") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await deleteCanvasChat({
      ctx,
      canvasId: args.canvasId,
      budget: { remaining: MAX_CHAT_ROWS_PER_CLEANUP },
    });
    if (!result.isComplete) {
      await ctx.scheduler.runAfter(0, internal.chat.deleteCanvasChatContinuation, args);
      return null;
    }
    const canvas = await ctx.db.get(args.canvasId);
    if (canvas === null) {
      return null;
    }
    const hasDraft =
      (await ctx.db
        .query("documents")
        .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
        .first()) !== null;
    if (hasDraft) {
      return null;
    }
    const ownerRows = await ctx.db
      .query("canvasOwners")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .collect();
    for (const ownerRow of ownerRows) {
      await ctx.db.delete(ownerRow._id);
    }
    await ctx.db.delete(args.canvasId);
    return null;
  },
});
