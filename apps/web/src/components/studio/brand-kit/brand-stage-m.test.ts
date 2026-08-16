// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { generateBlockId, ROOT_BLOCK_ID } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { MOCK_BRAND_KIT } from "@/lib/brand-kit";

/**
 * Brand-kit Stage M backend (docs/proposals/brand-kit-architecture.md §3–§8,
 * owner decisions 1–4): canvas binding restyles nothing; propagation is one
 * per-draft batch through the one history spine with PRESERVE-VARIATION
 * semantics; the staleness query composes payload-equality with the advisory
 * pointer; role:"logo" images re-source to the CONFIRMED logo only; and the
 * Stage-S storage deletes became registry-aware (registered files survive).
 *
 * Runs the REAL Convex functions against convex-test's in-memory backend.
 * Kits are seeded deterministically from MOCK_BRAND_KIT (validated payloads).
 */

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const SESSION_ID = "session-brand-m";

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

/** A complete, WCAG-passing variation payload (from the validated mock kit). */
function mockVariationGlobals(index: number): Record<string, unknown> {
  return { ...MOCK_BRAND_KIT.variations[index]!.globals };
}

/** Deterministic kit input: mock variations under stable test-owned ids. */
function buildKitInput({
  variationCount = 2,
  spacingBump = 0,
  logoUrl,
}: {
  variationCount?: number;
  /** Bump baseSpacing to change variation payloads WITHOUT touching contrast. */
  spacingBump?: number;
  logoUrl?: string;
} = {}) {
  return {
    name: "Acme",
    fonts: { heading: "Georgia, serif", body: "Helvetica, sans-serif" },
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    variations: Array.from({ length: variationCount }, (_, index) => ({
      id: index === 0 ? "classic-light" : "midnight",
      name: index === 0 ? "Classic Light" : "Midnight",
      globals: {
        ...mockVariationGlobals(index),
        baseSpacing: (mockVariationGlobals(index).baseSpacing as number) + spacingBump,
      },
    })),
  };
}

async function saveKit(t: Backend, input: ReturnType<typeof buildKitInput>): Promise<void> {
  await t.mutation(api.brandKits.saveBrandKit, { sessionId: SESSION_ID, brandKit: input });
}

async function createDraft(
  t: Backend,
  canvasId?: Id<"canvases">,
): Promise<{ documentId: Id<"documents">; canvasId: Id<"canvases"> }> {
  return await t.mutation(api.documents.createDocument, {
    sessionId: SESSION_ID,
    ...(canvasId !== undefined ? { canvasId } : {}),
  });
}

async function getDocumentRow(t: Backend, documentId: Id<"documents">): Promise<Doc<"documents">> {
  const row = await t.run(async (ctx) => ctx.db.get(documentId));
  if (row === null) {
    throw new Error("document row missing");
  }
  return row;
}

async function getRootGlobals(
  t: Backend,
  documentId: Id<"documents">,
): Promise<Record<string, unknown> | undefined> {
  const payload = await t.query(api.documents.getDocument, { documentId });
  const root = payload?.doc[ROOT_BLOCK_ID] as
    | { properties: { globals?: Record<string, unknown> } }
    | undefined;
  return root?.properties.globals;
}

async function getAllOperations(t: Backend, documentId: Id<"documents">) {
  const page = await t.query(api.documents.getOperations, { documentId, limit: 200 });
  return page.operations;
}

async function bindKit(t: Backend, canvasId: Id<"canvases">) {
  return await t.mutation(api.brandKits.bindSessionKitToCanvas, {
    canvasId,
    sessionId: SESSION_ID,
  });
}

async function storePngFile(t: Backend, bytes: number[]): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
  });
}

/** Confirm the kit's logo suggestion into storage (the route's mutation half). */
async function confirmLogo(
  t: Backend,
  { sourceUrl }: { sourceUrl: string },
): Promise<{ url: string; storageId: Id<"_storage"> }> {
  const storageId = await storePngFile(t, [9, 9, 9, 9]);
  const { url } = await t.mutation(api.brandKits.confirmAsset, {
    sessionId: SESSION_ID,
    kind: "logo",
    storageId,
    expectedSourceUrl: sourceUrl,
  });
  return { url, storageId };
}

describe("canvas brand binding", () => {
  it("binding restyles NOTHING: no ops, no globals change; the status flips to never-applied", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const { documentId, canvasId } = await createDraft(t);
    const globalsBefore = await getRootGlobals(t, documentId);
    const headBefore = (await getDocumentRow(t, documentId)).headVersion;

    await bindKit(t, canvasId);

    expect((await getDocumentRow(t, documentId)).headVersion).toBe(headBefore);
    expect(await getRootGlobals(t, documentId)).toEqual(globalsBefore);
    const status = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
    expect(status.binding?.name).toBe("Acme");
    expect(status.binding?.revision).toBe(1);
    expect(status.drafts).toHaveLength(1);
    expect(status.drafts[0]?.state).toBe("never-applied");
  });

  it("resolves the canvas brand through the binding for every capability holder", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const { canvasId } = await createDraft(t);
    await bindKit(t, canvasId);
    const resolved = await t.query(api.brandKits.getBrandKitForCanvas, { canvasId });
    expect(resolved?.source).toBe("binding");
    expect(resolved?.kit.name).toBe("Acme");
    // Unbind → falls back to the canvas creator-session's kit (legacy chain).
    await t.mutation(api.brandKits.unbindCanvasBrandKit, { canvasId });
    const fallback = await t.query(api.brandKits.getBrandKitForCanvas, { canvasId });
    expect(fallback?.source).toBe("session");
  });
});

describe("applyBrandToDocuments — the explicit propagation", () => {
  it("emits ONE user-authored batch per draft with the brand: batchId shape", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const { documentId: draft1, canvasId } = await createDraft(t);
    const { documentId: draft2 } = await createDraft(t, canvasId);
    const { kitId } = await bindKit(t, canvasId);

    const result = await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [draft1, draft2],
      sessionId: SESSION_ID,
    });

    expect(result.results.map((entry) => entry.outcome)).toEqual(["updated", "updated"]);
    for (const documentId of [draft1, draft2]) {
      const expectedBatchId = `brand:${kitId}:r1:${documentId}`;
      const ops = await getAllOperations(t, documentId);
      const brandOps = ops.filter((op) => op.batchId === expectedBatchId);
      expect(brandOps).toHaveLength(1); // exactly one applyTheme, one batch
      expect(brandOps[0]?.author).toBe("user");
      expect(brandOps[0]?.authorId).toBe(SESSION_ID);
      // Never-applied drafts get the kit's FIRST variation.
      expect(await getRootGlobals(t, documentId)).toEqual(buildKitInput().variations[0]!.globals);
      // Theme link written in the same transaction, carrying the §14.5a
      // baseline snapshot the per-property override diff is measured against.
      const row = await getDocumentRow(t, documentId);
      expect(row.brand).toEqual({
        kitId,
        revision: 1,
        variationId: "classic-light",
        baselineGlobals: buildKitInput().variations[0]!.globals,
      });
    }
  });

  it("PRESERVES the draft's variation identity across a kit update, falling back to theme 1 when it vanishes", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const { documentId: draft1, canvasId } = await createDraft(t);
    const { documentId: draft2 } = await createDraft(t, canvasId);
    const { kitId } = await bindKit(t, canvasId);
    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [draft1, draft2],
      sessionId: SESSION_ID,
    });
    // draft2 moves to "Midnight" the way the theme menu does: an applyTheme op
    // plus the advisory pointer record.
    const midnightGlobals = buildKitInput().variations[1]!.globals;
    await t.mutation(api.documents.applyOperations, {
      documentId: draft2,
      ops: [{ name: "applyTheme", globals: midnightGlobals }],
      context: { authorId: SESSION_ID, author: "user", caller: "frontend" },
    });
    await t.mutation(api.brandKits.recordDocumentBrandPointer, {
      documentId: draft2,
      variationId: "midnight",
    });

    // Kit revision 2: both variation payloads change (baseSpacing bump).
    const updatedKit = buildKitInput({ spacingBump: 4 });
    await saveKit(t, updatedKit);
    const statusBefore = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
    expect(statusBefore.drafts.map((draft) => draft.state)).toEqual(["outdated", "outdated"]);
    expect(
      statusBefore.drafts.find((draft) => draft.documentId === draft2)?.targetVariation.id,
    ).toBe("midnight");

    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [draft1, draft2],
      sessionId: SESSION_ID,
    });
    // Midnight stays midnight (updated payload); classic-light stays classic-light.
    expect(await getRootGlobals(t, draft1)).toEqual(updatedKit.variations[0]!.globals);
    expect(await getRootGlobals(t, draft2)).toEqual(updatedKit.variations[1]!.globals);
    expect((await getDocumentRow(t, draft2)).brand?.variationId).toBe("midnight");

    // Kit revision 3 drops "Midnight" entirely → draft2 falls back to theme 1.
    const shrunkKit = buildKitInput({ variationCount: 1, spacingBump: 8 });
    await saveKit(t, shrunkKit);
    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [draft2],
      sessionId: SESSION_ID,
    });
    expect(await getRootGlobals(t, draft2)).toEqual(shrunkKit.variations[0]!.globals);
    expect((await getDocumentRow(t, draft2)).brand).toEqual({
      kitId,
      revision: 3,
      variationId: "classic-light",
      // The baseline moves to the theme just applied: from here the draft's
      // overrides are measured against THIS payload, not the vanished one.
      baselineGlobals: shrunkKit.variations[0]!.globals,
    });
  });

  it("revertBatch restores the draft's exact pre-apply globals (per-draft revert)", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const { documentId, canvasId } = await createDraft(t);
    const { kitId } = await bindKit(t, canvasId);
    const globalsBefore = await getRootGlobals(t, documentId);

    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    expect(await getRootGlobals(t, documentId)).not.toEqual(globalsBefore);

    const revert = await t.mutation(api.history.revertBatch, {
      documentId,
      batchId: `brand:${kitId}:r1:${documentId}`,
      authorId: SESSION_ID,
    });
    expect(revert.isOk).toBe(true);
    expect(await getRootGlobals(t, documentId)).toEqual(globalsBefore);
  });

  it("re-sources role:\"logo\" images to the CONFIRMED logo in the SAME batch — and never an unconfirmed one", async () => {
    const t = createBackend();
    const sourceUrl = "https://example.com/logo.png";
    await saveKit(t, buildKitInput({ logoUrl: sourceUrl }));
    const { documentId, canvasId } = await createDraft(t);
    const { kitId } = await bindKit(t, canvasId);

    // A role-marked image block (the palette's Logo preset shape) inside the
    // starter doc's first section.
    const payload = await t.query(api.documents.getDocument, { documentId });
    const sectionId = Object.values(payload!.doc as Record<string, { id: string; type: string }>)
      .find((block) => block.type === "section")!.id;
    const logoBlockId = generateBlockId("image");
    const applied = await t.mutation(api.documents.applyOperations, {
      documentId,
      ops: [
        {
          name: "addBlock",
          block: {
            id: logoBlockId,
            type: "image",
            parentId: sectionId,
            childrenIds: [],
            properties: { src: "https://placehold.co/240x80", alt: "Brand logo", role: "logo" },
          },
          parentId: sectionId,
          index: 0,
        },
      ],
      context: { authorId: SESSION_ID, author: "user", caller: "frontend" },
    });
    expect(JSON.stringify(!applied.isOk ? applied : "")).toBe('""');

    // Unconfirmed logo (suggestion only): propagation must NOT touch the image.
    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    const afterUnconfirmed = await t.query(api.documents.getDocument, { documentId });
    expect(
      (afterUnconfirmed!.doc[logoBlockId] as { properties: { src: string } }).properties.src,
    ).toBe("https://placehold.co/240x80");

    // Confirm the logo (revision bumps) and propagate again.
    const { url: confirmedUrl } = await confirmLogo(t, { sourceUrl });
    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    const afterConfirmed = await t.query(api.documents.getDocument, { documentId });
    const logoBlock = afterConfirmed!.doc[logoBlockId] as {
      properties: { src: string; alt: string; role: string };
    };
    expect(logoBlock.properties.src).toBe(confirmedUrl);
    expect(logoBlock.properties.alt).toBe("Acme logo");
    expect(logoBlock.properties.role).toBe("logo");
    // The re-source rode the same per-draft batch as the pointer refresh:
    // exactly one brand batch exists for revision 2 (r2 after the confirm bump).
    const ops = await getAllOperations(t, documentId);
    const r2BatchIds = new Set(
      ops
        .filter((op) => op.batchId?.startsWith(`brand:${kitId}:r2:`))
        .map((op) => op.batchId),
    );
    expect(r2BatchIds.size).toBe(1);
  });
});

describe("getCanvasBrandStatus — pill states", () => {
  it("current → outdated on revision bump → current after update; hand-edits read as overridden", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const { documentId, canvasId } = await createDraft(t);
    await bindKit(t, canvasId);
    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    const currentStatus = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
    expect(currentStatus.drafts[0]?.state).toBe("current");

    // Revision bump (payload change) → the pill arms.
    await saveKit(t, buildKitInput({ spacingBump: 4 }));
    const staleStatus = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
    expect(staleStatus.drafts[0]?.state).toBe("outdated");

    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    const updatedStatus = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
    expect(updatedStatus.drafts[0]?.state).toBe("current");

    // A deliberate hand-edit away from the brand: OVERRIDDEN (§14.5a — the
    // link is intact, one property is the user's), never "outdated". The
    // parent theme and the exact overridden property come back with it.
    const customGlobals = {
      ...buildKitInput({ spacingBump: 4 }).variations[0]!.globals,
      baseSpacing: 99,
    };
    await t.mutation(api.documents.applyOperations, {
      documentId,
      ops: [{ name: "applyTheme", globals: customGlobals }],
      context: { authorId: SESSION_ID, author: "user", caller: "frontend" },
    });
    const overriddenStatus = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
    expect(overriddenStatus.drafts[0]?.state).toBe("overridden");
    expect(overriddenStatus.drafts[0]?.parentVariation?.id).toBe("classic-light");
    expect(overriddenStatus.drafts[0]?.overriddenGlobalKeys).toEqual(["baseSpacing"]);
  });

  it("returns an empty status for unbound canvases (no pills without a binding)", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const { canvasId } = await createDraft(t);
    const status = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
    expect(status.binding).toBeNull();
    expect(status.drafts).toEqual([]);
  });
});

describe("registry-aware kit storage lifecycle (Stage-S conversion)", () => {
  it("a replaced/removed logo file that is a REGISTERED asset survives; unregistered still deletes", async () => {
    const t = createBackend();
    const sourceUrl = "https://example.com/logo.png";
    await saveKit(t, buildKitInput({ logoUrl: sourceUrl }));
    const { storageId: registeredId } = await confirmLogo(t, { sourceUrl });
    // The confirm-asset route registers every confirmed binary — simulate it.
    await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId: registeredId,
      kind: "logo",
    });

    await t.mutation(api.brandKits.removeBrandKitAsset, { sessionId: SESSION_ID, kind: "logo" });
    // Registered → retained: the Library still renders it.
    const registeredUrl = await t.run(async (ctx) => ctx.storage.getUrl(registeredId));
    expect(registeredUrl).not.toBeNull();
    const library = await t.query(api.assets.listForSession, { sessionId: SESSION_ID });
    expect(library.some((asset) => asset.storageId === registeredId)).toBe(true);

    // An UNREGISTERED confirmed file keeps the old immediate delete.
    await saveKit(t, buildKitInput({ logoUrl: sourceUrl, spacingBump: 4 }));
    const { storageId: unregisteredId } = await confirmLogo(t, { sourceUrl });
    await t.mutation(api.brandKits.clearBrandKit, { sessionId: SESSION_ID });
    const unregisteredUrl = await t.run(async (ctx) => ctx.storage.getUrl(unregisteredId));
    expect(unregisteredUrl).toBeNull();
    // The registered file survives clearBrandKit too.
    expect(await t.run(async (ctx) => ctx.storage.getUrl(registeredId))).not.toBeNull();
  });
});
