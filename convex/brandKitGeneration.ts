import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveOwnerId, resolveOwnerIdOrNull } from "./authIdentity";

const statusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
);

const stepValidator = v.union(
  v.literal("queued"),
  v.literal("reading-site"),
  v.literal("finding-identity"),
  v.literal("building-kit"),
  v.literal("saving-kit"),
  v.literal("complete"),
);

const jobValidator = v.object({
  jobId: v.id("brandKitGenerationJobs"),
  sourceUrl: v.string(),
  status: statusValidator,
  step: stepValidator,
  errorMessage: v.optional(v.string()),
  brandKitId: v.optional(v.id("brandKits")),
  notificationSeenAtMs: v.optional(v.number()),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

function projectJob(row: Doc<"brandKitGenerationJobs">) {
  return {
    jobId: row._id,
    sourceUrl: row.sourceUrl,
    status: row.status,
    step: row.step,
    ...(row.errorMessage === undefined ? {} : { errorMessage: row.errorMessage }),
    ...(row.brandKitId === undefined ? {} : { brandKitId: row.brandKitId }),
    ...(row.notificationSeenAtMs === undefined
      ? {}
      : { notificationSeenAtMs: row.notificationSeenAtMs }),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

async function requireOwnedJob(
  ctx: MutationCtx,
  sessionId: string,
  jobId: Id<"brandKitGenerationJobs">,
): Promise<Doc<"brandKitGenerationJobs">> {
  const ownerId = await resolveOwnerId(ctx, { claimedSessionId: sessionId });
  const row = await ctx.db.get(jobId);
  if (row === null || row.sessionId !== ownerId) {
    throw new ConvexError("Brand kit generation job not found.");
  }
  return row;
}

export const start = mutation({
  args: { sessionId: v.string(), sourceUrl: v.string() },
  returns: v.id("brandKitGenerationJobs"),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const now = Date.now();
    return ctx.db.insert("brandKitGenerationJobs", {
      sessionId: ownerId,
      sourceUrl: args.sourceUrl,
      status: "queued",
      step: "queued",
      createdAtMs: now,
      updatedAtMs: now,
    });
  },
});

export const getLatest = query({
  args: { sessionId: v.string() },
  returns: v.union(v.null(), jobValidator),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerIdOrNull(ctx, { claimedSessionId: args.sessionId });
    if (ownerId === null) {
      return null;
    }
    const row = await ctx.db
      .query("brandKitGenerationJobs")
      .withIndex("by_sessionId_updatedAtMs", (q) => q.eq("sessionId", ownerId))
      .order("desc")
      .first();
    return row === null ? null : projectJob(row);
  },
});

export const setProgress = mutation({
  args: {
    sessionId: v.string(),
    jobId: v.id("brandKitGenerationJobs"),
    step: stepValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await requireOwnedJob(ctx, args.sessionId, args.jobId);
    if (row.status === "succeeded" || row.status === "failed") {
      return null;
    }
    await ctx.db.patch(row._id, { status: "running", step: args.step, updatedAtMs: Date.now() });
    return null;
  },
});

export const complete = mutation({
  args: {
    sessionId: v.string(),
    jobId: v.id("brandKitGenerationJobs"),
    brandKitId: v.id("brandKits"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await requireOwnedJob(ctx, args.sessionId, args.jobId);
    await ctx.db.patch(row._id, {
      status: "succeeded",
      step: "complete",
      brandKitId: args.brandKitId,
      errorMessage: undefined,
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

export const fail = mutation({
  args: {
    sessionId: v.string(),
    jobId: v.id("brandKitGenerationJobs"),
    errorMessage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await requireOwnedJob(ctx, args.sessionId, args.jobId);
    await ctx.db.patch(row._id, {
      status: "failed",
      errorMessage: args.errorMessage,
      updatedAtMs: Date.now(),
    });
    return null;
  },
});

export const acknowledge = mutation({
  args: { sessionId: v.string(), jobId: v.id("brandKitGenerationJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await requireOwnedJob(ctx, args.sessionId, args.jobId);
    await ctx.db.patch(row._id, { notificationSeenAtMs: Date.now() });
    return null;
  },
});
