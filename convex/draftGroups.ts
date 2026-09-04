import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";

/*
  Draft groups are deliberately small canvas metadata rows. Documents retain
  their legacy canvas-wide orderIndex, while groupOrderIndex is the ordered
  sequence used only when a document has a groupId.
*/

const groupEntryValidator = v.object({
  _id: v.id("draftGroups"),
  canvasId: v.id("canvases"),
  name: v.string(),
  description: v.optional(v.string()),
  orderIndex: v.number(),
  createdAtMs: v.number(),
  updatedAtMs: v.number(),
});

const groupIdValidator = v.union(v.id("draftGroups"), v.null());

async function getCanvasOrThrow(ctx: MutationCtx, canvasId: Id<"canvases">) {
  const canvas = await ctx.db.get(canvasId);
  if (canvas === null) {
    throw new Error(`Canvas ${canvasId} does not exist.`);
  }
  return canvas;
}

async function getGroupOrThrow(ctx: MutationCtx, groupId: Id<"draftGroups">) {
  const group = await ctx.db.get(groupId);
  if (group === null) {
    throw new Error(`Draft group ${groupId} does not exist.`);
  }
  return group;
}

async function assertGroupOnCanvas(
  ctx: MutationCtx,
  groupId: Id<"draftGroups">,
  canvasId: Id<"canvases">,
) {
  const group = await getGroupOrThrow(ctx, groupId);
  if (group.canvasId !== canvasId) {
    throw new Error("Draft group and document must belong to the same canvas.");
  }
  return group;
}

function normalizeName(name: string): string {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new Error("Draft group name cannot be empty.");
  }
  return normalizedName;
}

function normalizeDescription(description: string | null | undefined): string | undefined {
  if (description === undefined || description === null) {
    return undefined;
  }
  const normalizedDescription = description.trim();
  return normalizedDescription.length > 0 ? normalizedDescription : undefined;
}

function readRequestedPosition(position: number | undefined): number | undefined {
  if (position === undefined) {
    return undefined;
  }
  if (!Number.isFinite(position)) {
    throw new Error("Draft order must be a finite number.");
  }
  return Math.max(0, Math.floor(position));
}

async function getCanvasDrafts(ctx: MutationCtx, canvasId: Id<"canvases">) {
  return await ctx.db
    .query("documents")
    .withIndex("by_canvasId", (q) => q.eq("canvasId", canvasId))
    .collect();
}

function sortByLocalOrder<T extends { orderIndex: number; groupOrderIndex?: number }>(
  rows: T[],
): T[] {
  return rows.sort(
    (a, b) => (a.groupOrderIndex ?? a.orderIndex) - (b.groupOrderIndex ?? b.orderIndex),
  );
}

/*
  Return all groups in their persisted canvas order. Missing canvases naturally
  return an empty list, matching the other canvas-scoped read APIs.
*/
export const list = query({
  args: { canvasId: v.id("canvases") },
  returns: v.array(groupEntryValidator),
  handler: async (ctx, args) => {
    const groups = await ctx.db
      .query("draftGroups")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .collect();
    return groups.sort((a, b) => a.orderIndex - b.orderIndex).map((group) => ({
      _id: group._id,
      canvasId: group.canvasId,
      name: group.name,
      ...(group.description !== undefined ? { description: group.description } : {}),
      orderIndex: group.orderIndex,
      createdAtMs: group.createdAtMs,
      updatedAtMs: group.updatedAtMs,
    }));
  },
});

export const create = mutation({
  args: {
    canvasId: v.id("canvases"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("draftGroups"),
  handler: async (ctx, args) => {
    await getCanvasOrThrow(ctx, args.canvasId);
    const groups = await ctx.db
      .query("draftGroups")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .collect();
    const now = Date.now();
    const groupId = await ctx.db.insert("draftGroups", {
      canvasId: args.canvasId,
      name: normalizeName(args.name),
      ...(normalizeDescription(args.description) !== undefined
        ? { description: normalizeDescription(args.description) }
        : {}),
      orderIndex: groups.reduce((max, group) => Math.max(max, group.orderIndex), -1) + 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await ctx.db.patch(args.canvasId, { updatedAtMs: now });
    return groupId;
  },
});

export const rename = mutation({
  args: { groupId: v.id("draftGroups"), name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const group = await getGroupOrThrow(ctx, args.groupId);
    const name = normalizeName(args.name);
    if (group.name === name) {
      return true;
    }
    const now = Date.now();
    await ctx.db.patch(args.groupId, { name, updatedAtMs: now });
    await ctx.db.patch(group.canvasId, { updatedAtMs: now });
    return true;
  },
});

export const updateDescription = mutation({
  args: {
    groupId: v.id("draftGroups"),
    description: v.union(v.string(), v.null()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const group = await getGroupOrThrow(ctx, args.groupId);
    const description = normalizeDescription(args.description);
    const now = Date.now();
    await ctx.db.patch(args.groupId, { description, updatedAtMs: now });
    await ctx.db.patch(group.canvasId, { updatedAtMs: now });
    return true;
  },
});

/*
  Combined metadata update for clients that edit the name and description in
  one form. Omitted fields retain their current values; null clears text.
*/
export const update = mutation({
  args: {
    groupId: v.id("draftGroups"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const group = await getGroupOrThrow(ctx, args.groupId);
    const patch: { name?: string; description?: string; updatedAtMs: number } = {
      updatedAtMs: Date.now(),
    };
    if (args.name !== undefined) {
      patch.name = normalizeName(args.name);
    }
    if (args.description !== undefined) {
      patch.description = normalizeDescription(args.description);
    }
    await ctx.db.patch(args.groupId, patch);
    await ctx.db.patch(group.canvasId, { updatedAtMs: patch.updatedAtMs });
    return true;
  },
});

/*
  Move a draft between a group and the ungrouped list. The requested position
  is an integer insertion position, clamped to the target list; omitting it
  appends. Every target sibling is renumbered, preventing fractional-order
  drift after repeated drag-and-drop operations.
*/
export const moveDraft = mutation({
  args: {
    documentId: v.id("documents"),
    groupId: groupIdValidator,
    groupOrderIndex: v.optional(v.number()),
    orderIndex: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (document === null) {
      return false;
    }
    const targetGroup =
      args.groupId === null
        ? null
        : await assertGroupOnCanvas(ctx, args.groupId, document.canvasId);
    const position = readRequestedPosition(args.groupOrderIndex ?? args.orderIndex);
    const drafts = await getCanvasDrafts(ctx, document.canvasId);
    const targetDrafts = sortByLocalOrder(
      drafts.filter(
        (row) => row._id !== document._id && (row.groupId ?? null) === args.groupId,
      ),
    );
    const insertionPosition = Math.min(position ?? targetDrafts.length, targetDrafts.length);
    targetDrafts.splice(insertionPosition, 0, document);
    const now = Date.now();
    for (const [index, draft] of targetDrafts.entries()) {
      if (draft._id === document._id) {
        await ctx.db.patch(draft._id, {
          ...(targetGroup === null ? { groupId: undefined, groupOrderIndex: undefined } : {
            groupId: targetGroup._id,
            groupOrderIndex: index,
          }),
          ...(targetGroup === null ? { orderIndex: index } : {}),
          updatedAtMs: now,
        });
      } else if (targetGroup !== null) {
        await ctx.db.patch(draft._id, { groupOrderIndex: index, updatedAtMs: now });
      } else {
        await ctx.db.patch(draft._id, { orderIndex: index, updatedAtMs: now });
      }
    }
    if (document.groupId !== args.groupId) {
      const sourceDrafts = sortByLocalOrder(
        drafts.filter((row) => row._id !== document._id && row.groupId === document.groupId),
      );
      for (const [index, draft] of sourceDrafts.entries()) {
        await ctx.db.patch(draft._id, {
          ...(document.groupId === undefined
            ? { orderIndex: index }
            : { groupOrderIndex: index }),
          updatedAtMs: now,
        });
      }
    }
    await ctx.db.patch(document.canvasId, { updatedAtMs: now });
    return true;
  },
});

export const reorderDrafts = mutation({
  args: {
    canvasId: v.id("canvases"),
    groupId: groupIdValidator,
    documentIds: v.array(v.id("documents")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await getCanvasOrThrow(ctx, args.canvasId);
    if (args.groupId !== null) {
      await assertGroupOnCanvas(ctx, args.groupId, args.canvasId);
    }
    const drafts = await getCanvasDrafts(ctx, args.canvasId);
    const expected = drafts.filter((draft) => (draft.groupId ?? null) === args.groupId);
    if (
      new Set(args.documentIds).size !== args.documentIds.length ||
      expected.length !== args.documentIds.length ||
      args.documentIds.some((documentId) => !expected.some((draft) => draft._id === documentId))
    ) {
      throw new Error("Draft reorder must include exactly the drafts in one canvas list.");
    }
    const now = Date.now();
    for (const [index, documentId] of args.documentIds.entries()) {
      await ctx.db.patch(documentId, {
        ...(args.groupId === null ? { orderIndex: index, groupOrderIndex: undefined } : {
          groupOrderIndex: index,
        }),
        updatedAtMs: now,
      });
    }
    await ctx.db.patch(args.canvasId, { updatedAtMs: now });
    return true;
  },
});

export const reorderGroups = mutation({
  args: { canvasId: v.id("canvases"), groupIds: v.array(v.id("draftGroups")) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await getCanvasOrThrow(ctx, args.canvasId);
    const groups = await ctx.db
      .query("draftGroups")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", args.canvasId))
      .collect();
    if (
      new Set(args.groupIds).size !== args.groupIds.length ||
      groups.length !== args.groupIds.length ||
      args.groupIds.some((groupId) => !groups.some((group) => group._id === groupId))
    ) {
      throw new Error("Group reorder must include exactly the groups on one canvas.");
    }
    const now = Date.now();
    for (const [index, groupId] of args.groupIds.entries()) {
      await ctx.db.patch(groupId, { orderIndex: index, updatedAtMs: now });
    }
    await ctx.db.patch(args.canvasId, { updatedAtMs: now });
    return true;
  },
});

/*
  Delete only the group row. Its documents are retained and become ungrouped,
  with a fresh contiguous ungrouped order, so no draft content is lost.
*/
export const deleteGroup = mutation({
  args: { groupId: v.id("draftGroups") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const group = await getGroupOrThrow(ctx, args.groupId);
    const drafts = await getCanvasDrafts(ctx, group.canvasId);
    const ungrouped = sortByLocalOrder(drafts.filter((draft) => draft.groupId === undefined));
    const members = sortByLocalOrder(drafts.filter((draft) => draft.groupId === group._id));
    const memberIds = new Set(members.map((draft) => draft._id));
    const survivors = [...ungrouped, ...members];
    const now = Date.now();
    for (const [index, draft] of survivors.entries()) {
      await ctx.db.patch(draft._id, {
        ...(memberIds.has(draft._id)
          ? { groupId: undefined, groupOrderIndex: undefined }
          : {}),
        orderIndex: index,
        updatedAtMs: now,
      });
    }
    await ctx.db.delete(group._id);
    await ctx.db.patch(group.canvasId, { updatedAtMs: now });
    return true;
  },
});
