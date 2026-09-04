// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

async function createCanvasAndDraft({
  t,
  sessionId,
  canvasId,
}: {
  t: Backend;
  sessionId: string;
  canvasId?: Id<"canvases">;
}) {
  return await t.mutation(api.documents.createDocument, {
    sessionId,
    ...(canvasId === undefined ? {} : { canvasId }),
    shouldSeedEmpty: true,
  });
}

describe("draft groups persistence", () => {
  it("orders groups and keeps group membership/local order through duplication", async () => {
    const t = createBackend();
    const first = await createCanvasAndDraft({ t, sessionId: "groups-order-session" });
    const groupId = await t.mutation(api.draftGroups.create, {
      canvasId: first.canvasId,
      name: "  Campaigns  ",
      description: "  Seasonal drafts ",
    });
    const second = await createCanvasAndDraft({
      t,
      sessionId: "groups-order-session",
      canvasId: first.canvasId,
    });
    await t.mutation(api.draftGroups.moveDraft, {
      documentId: first.documentId,
      groupId,
      groupOrderIndex: 0,
    });
    await t.mutation(api.draftGroups.moveDraft, {
      documentId: second.documentId,
      groupId,
      groupOrderIndex: 0,
    });
    const duplicateId = await t.mutation(api.documents.duplicateDocument, {
      documentId: second.documentId,
    });

    const groups = await t.query(api.draftGroups.list, { canvasId: first.canvasId });
    const drafts = await t.query(api.documents.listDocumentsByCanvas, { canvasId: first.canvasId });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("Campaigns");
    expect(groups[0]!.description).toBe("Seasonal drafts");
    expect(drafts.filter((draft) => draft.groupId === groupId)).toHaveLength(3);
    expect(drafts.find((draft) => draft._id === duplicateId)?.groupOrderIndex).toBe(1);
    expect(
      drafts
        .filter((draft) => draft.groupId === groupId)
        .map((draft) => draft.groupOrderIndex)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([0, 1, 2]);
  });

  it("rejects cross-canvas membership and safely ungroups on delete", async () => {
    const t = createBackend();
    const first = await createCanvasAndDraft({ t, sessionId: "groups-cross-canvas-a" });
    const second = await createCanvasAndDraft({ t, sessionId: "groups-cross-canvas-b" });
    const foreignGroupId = await t.mutation(api.draftGroups.create, {
      canvasId: second.canvasId,
      name: "Foreign",
    });

    await expect(
      t.mutation(api.draftGroups.moveDraft, {
        documentId: first.documentId,
        groupId: foreignGroupId,
      }),
    ).rejects.toThrow(/same canvas/);

    const localGroupId = await t.mutation(api.draftGroups.create, {
      canvasId: first.canvasId,
      name: "Local",
    });
    await t.mutation(api.draftGroups.moveDraft, {
      documentId: first.documentId,
      groupId: localGroupId,
    });
    await t.mutation(api.draftGroups.deleteGroup, { groupId: localGroupId });

    const remainingDraft = await t.query(api.documents.getDocument, { documentId: first.documentId });
    const remainingGroups = await t.query(api.draftGroups.list, { canvasId: first.canvasId });
    expect(remainingDraft).not.toBeNull();
    expect(remainingDraft?.groupId).toBeUndefined();
    expect(remainingGroups).toHaveLength(0);
  });

  it("reorders groups and keeps ungrouped draft positions dense after repeated moves", async () => {
    const t = createBackend();
    const first = await createCanvasAndDraft({ t, sessionId: "groups-reorder-session" });
    const second = await createCanvasAndDraft({
      t,
      sessionId: "groups-reorder-session",
      canvasId: first.canvasId,
    });
    const third = await createCanvasAndDraft({
      t,
      sessionId: "groups-reorder-session",
      canvasId: first.canvasId,
    });
    const firstGroupId = await t.mutation(api.draftGroups.create, {
      canvasId: first.canvasId,
      name: "First",
    });
    const secondGroupId = await t.mutation(api.draftGroups.create, {
      canvasId: first.canvasId,
      name: "Second",
    });

    await t.mutation(api.draftGroups.reorderGroups, {
      canvasId: first.canvasId,
      groupIds: [secondGroupId, firstGroupId],
    });
    await t.mutation(api.draftGroups.moveDraft, {
      documentId: second.documentId,
      groupId: firstGroupId,
    });
    await t.mutation(api.draftGroups.moveDraft, {
      documentId: second.documentId,
      groupId: null,
      orderIndex: 1,
    });

    const groups = await t.query(api.draftGroups.list, { canvasId: first.canvasId });
    const drafts = await t.query(api.documents.listDocumentsByCanvas, {
      canvasId: first.canvasId,
    });
    expect(groups.map((group) => group._id)).toEqual([secondGroupId, firstGroupId]);
    expect(
      drafts
        .filter((draft) => draft.groupId === undefined)
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((draft) => [draft._id, draft.orderIndex]),
    ).toEqual([
      [first.documentId, 0],
      [second.documentId, 1],
      [third.documentId, 2],
    ]);
  });
});
