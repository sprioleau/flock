// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ROOT_BLOCK_ID } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { MAX_BRAND_KIT_VARIATIONS, MOCK_BRAND_KIT } from "@/lib/brand-kit";

/*
  SOFT THEME DELETION (docs/proposals/brand-kit-user-control.md §14.5b),
  end to end through the real Convex functions.

  The pure planner has its own suite in `lib/brand-theme-lifecycle.test.ts`.
  What only this file can prove is the property the whole decision rests on and
  the four exclusions that make an unlink an unlink:

  - DELETING A THEME RESTYLES NOTHING. The draft that was rendering it renders
    the identical bytes afterwards — this is the assertion that would fail if
    anyone ever made deletion touch a document.
  - The draft is UNLINKED: parentless (`never-applied`), not "overridden
    against a theme that no longer exists".
  - A deleted theme is gone from the kit reads the dropdown is built from, is
    never a propagation target, and does not count against the 8-theme cap.
  - Restoring re-links the draft — with its own overrides intact — again
    without writing to a document.
*/

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const SESSION_ID = "session-theme-deletion";

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

/*
  Two complete, WCAG-passing variation payloads from the validated mock kit.
*/
function buildKitInput() {
  return {
    name: "Acme",
    fonts: { heading: "Georgia, serif", body: "Helvetica, sans-serif" },
    variations: [0, 2].map((index, position) => {
      const source = MOCK_BRAND_KIT.variations[index]!;
      return {
        id: position === 0 ? "classic-light" : "midnight",
        name: position === 0 ? "Classic Light" : "Midnight",
        globals: { ...source.globals },
      };
    }),
  };
}

async function readKit(t: Backend) {
  const kit = await t.query(api.brandKits.getActiveBrandKit, { sessionId: SESSION_ID });
  if (kit === null) {
    throw new Error("no kit");
  }
  return kit;
}

async function getRootGlobals(
  t: Backend,
  documentId: Id<"documents">,
): Promise<Record<string, unknown>> {
  const payload = await t.query(api.documents.getDocument, { documentId });
  const root = payload?.doc[ROOT_BLOCK_ID] as
    | { properties: { globals?: Record<string, unknown> } }
    | undefined;
  return root?.properties.globals ?? {};
}

async function getDraftStatus({
  t,
  canvasId,
  documentId,
}: {
  t: Backend;
  canvasId: Id<"canvases">;
  documentId: Id<"documents">;
}) {
  const status = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
  const draft = status.drafts.find((entry) => entry.documentId === documentId);
  if (draft === undefined) {
    throw new Error("draft missing from status");
  }
  return draft;
}

/*
  A bound canvas holding one draft that has adopted MIDNIGHT — the theme these
  tests delete. Applying it through the theme menu's own recording path is what
  gives the draft the pointer and baseline a real user's draft would carry.
*/
async function seedDraftOnMidnight(t: Backend): Promise<{
  documentId: Id<"documents">;
  canvasId: Id<"canvases">;
}> {
  await t.mutation(api.brandKits.saveBrandKit, {
    sessionId: SESSION_ID,
    brandKit: buildKitInput(),
  });
  const { documentId, canvasId } = await t.mutation(api.documents.createDocument, {
    sessionId: SESSION_ID,
  });
  await t.mutation(api.brandKits.bindSessionKitToCanvas, { canvasId, sessionId: SESSION_ID });
  const midnight = buildKitInput().variations[1]!;
  await t.mutation(api.documents.applyOperations, {
    documentId,
    ops: [{ name: "applyTheme", globals: midnight.globals }],
    context: { authorId: SESSION_ID, author: "user", caller: "frontend" },
  });
  await t.mutation(api.brandKits.recordDocumentBrandPointer, {
    documentId,
    variationId: "midnight",
  });
  return { documentId, canvasId };
}

async function deleteMidnight(t: Backend, isDeleted = true): Promise<void> {
  await t.mutation(api.brandKits.setBrandThemeVariationDeleted, {
    sessionId: SESSION_ID,
    variationId: "midnight",
    isDeleted,
  });
}

describe("deleting a theme unlinks drafts — and restyles none of them", () => {
  it("leaves the draft's globals BYTE-IDENTICAL", async () => {
    /*
      The non-negotiable. Deletion writes one field on the kit row; if anyone
      ever makes it reach into `documents`, this is the assertion that fails.
    */
    const t = createBackend();
    const { documentId } = await seedDraftOnMidnight(t);
    const before = await getRootGlobals(t, documentId);
    await deleteMidnight(t);
    expect(await getRootGlobals(t, documentId)).toEqual(before);
  });

  it("reports the draft as PARENTLESS rather than overridden against a missing theme", async () => {
    const t = createBackend();
    const { documentId, canvasId } = await seedDraftOnMidnight(t);
    expect((await getDraftStatus({ t, canvasId, documentId })).state).toBe("current");
    await deleteMidnight(t);
    const draft = await getDraftStatus({ t, canvasId, documentId });
    expect(draft.state).toBe("never-applied");
    expect(draft.parentVariation).toBeNull();
    expect(draft.overriddenGlobalKeys).toEqual([]);
  });

  it("takes the theme off every kit read the dropdown is built from", async () => {
    const t = createBackend();
    const { canvasId } = await seedDraftOnMidnight(t);
    await deleteMidnight(t);
    /*
      The session read (the panel) and the canvas read (every collaborator's
      theme menu) must agree — both go through the same projection.
    */
    expect((await readKit(t)).variations.map((variation) => variation.id)).toEqual([
      "classic-light",
    ]);
    const canvasKit = await t.query(api.brandKits.getBrandKitForCanvas, { canvasId });
    expect(canvasKit?.kit.variations.map((variation) => variation.id)).toEqual(["classic-light"]);
    /*
      But the row survives, which is what a restore needs.
    */
    expect((await readKit(t)).deletedVariations?.map((variation) => variation.id)).toEqual([
      "midnight",
    ]);
  });

  it("is never a propagation target, and propagating writes the surviving theme", async () => {
    const t = createBackend();
    const { documentId, canvasId } = await seedDraftOnMidnight(t);
    await deleteMidnight(t);
    /*
      The preview the §5.2 prompt shows must not name a deleted theme.
    */
    expect((await getDraftStatus({ t, canvasId, documentId })).targetVariation.id).toBe(
      "classic-light",
    );
    const { results } = await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    expect(results[0]?.variationId).toBe("classic-light");
    /*
      And the restyle that DOES happen is the one somebody confirmed — the
      surviving theme applied verbatim, not the deleted one resurrected.
    */
    expect(await getRootGlobals(t, documentId)).toEqual(
      buildKitInput().variations[0]!.globals,
    );
  });

  it("does not count against the theme cap", async () => {
    const t = createBackend();
    await t.mutation(api.brandKits.saveBrandKit, {
      sessionId: SESSION_ID,
      brandKit: buildKitInput(),
    });
    /*
      Fill the kit to the cap, delete one, and the next append must fit.
    */
    for (let index = 2; index < MAX_BRAND_KIT_VARIATIONS; index += 1) {
      await t.mutation(api.brandKits.addBrandThemeVariation, {
        sessionId: SESSION_ID,
        variation: {
          id: `filler-${index}`,
          name: `Filler ${index}`,
          globals: { ...MOCK_BRAND_KIT.variations[0]!.globals },
        },
      });
    }
    expect((await readKit(t)).variations).toHaveLength(MAX_BRAND_KIT_VARIATIONS);
    await expect(
      t.mutation(api.brandKits.addBrandThemeVariation, {
        sessionId: SESSION_ID,
        variation: {
          id: "one-too-many",
          name: "One Too Many",
          globals: { ...MOCK_BRAND_KIT.variations[0]!.globals },
        },
      }),
    ).rejects.toThrow();
    await deleteMidnight(t);
    await t.mutation(api.brandKits.addBrandThemeVariation, {
      sessionId: SESSION_ID,
      variation: {
        id: "now-it-fits",
        name: "Now It Fits",
        globals: { ...MOCK_BRAND_KIT.variations[0]!.globals },
      },
    });
    expect((await readKit(t)).variations).toHaveLength(MAX_BRAND_KIT_VARIATIONS);
  });

  it("does not re-arm every other draft's pill: the kit revision stays put", async () => {
    /*
      Same reasoning as the append exception. The surviving themes are
      untouched, so the drafts using them have nothing to adopt — and a bump
      would claim otherwise on every draft of every bound canvas.
    */
    const t = createBackend();
    await seedDraftOnMidnight(t);
    const before = (await readKit(t)).revision;
    await deleteMidnight(t);
    expect((await readKit(t)).revision).toBe(before);
  });

  it("refuses to delete the last theme, and stores nothing", async () => {
    const t = createBackend();
    await seedDraftOnMidnight(t);
    await deleteMidnight(t);
    await expect(
      t.mutation(api.brandKits.setBrandThemeVariationDeleted, {
        sessionId: SESSION_ID,
        variationId: "classic-light",
        isDeleted: true,
      }),
    ).rejects.toThrow();
    expect((await readKit(t)).variations).toHaveLength(1);
  });
});

describe("restoring a deleted theme", () => {
  it("re-links the draft that was using it, without touching the draft", async () => {
    /*
      THE payoff of soft deletion, and the thing a hard splice could never give
      back: the id survived, so the pointer still names something real.
    */
    const t = createBackend();
    const { documentId, canvasId } = await seedDraftOnMidnight(t);
    const before = await getRootGlobals(t, documentId);
    await deleteMidnight(t);
    await deleteMidnight(t, false);
    const draft = await getDraftStatus({ t, canvasId, documentId });
    expect(draft.state).toBe("current");
    expect(draft.parentVariation?.id).toBe("midnight");
    expect(await getRootGlobals(t, documentId)).toEqual(before);
  });

  it("brings back a draft's LOCAL overrides with it, not just the link", async () => {
    const t = createBackend();
    const { documentId, canvasId } = await seedDraftOnMidnight(t);
    const globals = await getRootGlobals(t, documentId);
    await t.mutation(api.documents.applyOperations, {
      documentId,
      ops: [{ name: "applyTheme", globals: { ...globals, buttonBackgroundColor: "#ffd166" } }],
      context: { authorId: SESSION_ID, author: "user", caller: "frontend" },
    });
    expect((await getDraftStatus({ t, canvasId, documentId })).overriddenGlobalKeys).toEqual([
      "buttonBackgroundColor",
    ]);
    await deleteMidnight(t);
    /*
      Unlinked: no parent, so nothing to be overridden against.
    */
    expect((await getDraftStatus({ t, canvasId, documentId })).overriddenGlobalKeys).toEqual([]);
    await deleteMidnight(t, false);
    const restored = await getDraftStatus({ t, canvasId, documentId });
    expect(restored.state).toBe("overridden");
    expect(restored.parentVariation?.id).toBe("midnight");
    expect(restored.overriddenGlobalKeys).toEqual(["buttonBackgroundColor"]);
  });
});
