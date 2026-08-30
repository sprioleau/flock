// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ROOT_BLOCK_ID } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { MOCK_BRAND_KIT } from "@/lib/brand-kit";

/*
  Theme identity, per-property overrides and the theme EDIT path, end to end
  through the real Convex functions (docs/proposals/brand-kit-user-control.md
  §14.5a). The pure resolver has its own unit suite in
  `lib/brand-theme-link.test.ts`; what only this file can prove is that the
  mutations, the status query and the op stream agree:

  - THE MIGRATION: every shape a `documents.brand` row can have today keeps its
    pill behaviour AND — the property that actually matters — keeps rendering
    the same bytes. A migration that restyles a draft is the failure mode.
  - Editing a parent theme propagates to the drafts referencing it.
  - A property the user overrode SURVIVES that propagation.
  - A per-section background override survives it too (the block layer).
*/

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const SESSION_ID = "session-theme-overrides";

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

/*
  Two complete, WCAG-passing variation payloads from the validated mock kit.
*/
function buildKitInput({ spacingBump = 0 }: { spacingBump?: number } = {}) {
  return {
    name: "Acme",
    fonts: { heading: "Georgia, serif", body: "Helvetica, sans-serif" },
    variations: [0, 1].map((index) => {
      const source = MOCK_BRAND_KIT.variations[index]!;
      return {
        id: index === 0 ? "classic-light" : "midnight",
        name: index === 0 ? "Classic Light" : "Midnight",
        globals: { ...source.globals, baseSpacing: source.globals.baseSpacing + spacingBump },
      };
    }),
  };
}

async function saveKit(t: Backend, input: ReturnType<typeof buildKitInput>): Promise<void> {
  await t.mutation(api.brandKits.saveBrandKit, { sessionId: SESSION_ID, brandKit: input });
}

/*
  A bound canvas holding one draft that has already adopted the kit's first theme.
*/
async function seedAppliedDraft(t: Backend): Promise<{
  documentId: Id<"documents">;
  canvasId: Id<"canvases">;
}> {
  await saveKit(t, buildKitInput());
  const { documentId, canvasId } = await t.mutation(api.documents.createDocument, {
    sessionId: SESSION_ID,
  });
  await t.mutation(api.brandKits.bindSessionKitToCanvas, { canvasId, sessionId: SESSION_ID });
  await t.mutation(api.brandKits.applyBrandToDocuments, {
    canvasId,
    documentIds: [documentId],
    sessionId: SESSION_ID,
  });
  return { documentId, canvasId };
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
  Turn a §14.5a-era row back into a LEGACY one by dropping the baseline
  snapshot — the exact shape of every `documents.brand` row written before this
  landed, and the only way to exercise the migration from inside the tests.
*/
async function stripBaselineGlobals(t: Backend, documentId: Id<"documents">): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db.get(documentId);
    if (row?.brand === undefined) {
      throw new Error("document has no brand pointer to strip");
    }
    await ctx.db.patch(documentId, {
      brand: {
        kitId: row.brand.kitId,
        revision: row.brand.revision,
        variationId: row.brand.variationId,
      },
    });
  });
}

/*
  Hand-edit ONE global, the way a person nudging a color in the panel would.
*/
async function overrideOneGlobal({
  t,
  documentId,
  override,
}: {
  t: Backend;
  documentId: Id<"documents">;
  override: Record<string, unknown>;
}): Promise<void> {
  const globals = await getRootGlobals(t, documentId);
  await t.mutation(api.documents.applyOperations, {
    documentId,
    ops: [{ name: "applyTheme", globals: { ...globals, ...override } }],
    context: { authorId: SESSION_ID, author: "user", caller: "frontend" },
  });
}

/*
  `getDocument` returns the doc through a `v.any()` payload, so the blocks
  arrive untyped. Same boundary the sibling suite crosses (brand-stage-m.test.ts
  shapes the root the same way) — one narrow structural type, in a test.
*/
interface TestBlock {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

async function getDocumentBlocks(t: Backend, documentId: Id<"documents">): Promise<TestBlock[]> {
  const payload = await t.query(api.documents.getDocument, { documentId });
  return Object.values(payload?.doc ?? {}) as TestBlock[];
}

/*
  The id of the draft's first section block (the starter email always has one).
*/
async function getFirstSectionId(t: Backend, documentId: Id<"documents">): Promise<string> {
  const section = (await getDocumentBlocks(t, documentId)).find(
    (block) => block.type === "section",
  );
  if (section === undefined) {
    throw new Error("starter document has no section");
  }
  return section.id;
}

describe("migration — a draft that renders correctly today renders identically after", () => {
  it("legacy pointer + matching payload: still `current`, and propagation is a no-op", async () => {
    const t = createBackend();
    const { documentId, canvasId } = await seedAppliedDraft(t);
    await stripBaselineGlobals(t, documentId);

    const before = await getRootGlobals(t, documentId);
    const draft = await getDraftStatus({ t, canvasId, documentId });
    expect(draft.state).toBe("current");
    expect(draft.parentVariation?.id).toBe("classic-light");
    expect(draft.overriddenGlobalKeys).toEqual([]);

    const { results } = await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    expect(results[0]?.outcome).toBe("already-current");
    expect(await getRootGlobals(t, documentId)).toEqual(before);
  });

  it("legacy pointer + diverged payload: reads `overridden`, renders untouched", async () => {
    /*
      The old `detached`. The link was never severed, so the word was wrong.
    */
    const t = createBackend();
    const { documentId, canvasId } = await seedAppliedDraft(t);
    await overrideOneGlobal({ t, documentId, override: { buttonBackgroundColor: "#ff0000" } });
    await stripBaselineGlobals(t, documentId);

    const before = await getRootGlobals(t, documentId);
    const draft = await getDraftStatus({ t, canvasId, documentId });
    expect(draft.state).toBe("overridden");
    expect(draft.parentVariation?.name).toBe("Classic Light");
    expect(draft.overriddenGlobalKeys).toEqual(["buttonBackgroundColor"]);
    /*
      Reading a status never writes; the draft is byte-identical.
    */
    expect(await getRootGlobals(t, documentId)).toEqual(before);
  });

  it("legacy pointer at an OLDER revision: `outdated`, and propagation writes the theme VERBATIM", async () => {
    /*
      The sharpest migration case. A legacy row has no baseline, so the diff
      would be measured against the variation's CURRENT globals — which have
      moved. Trusting that would report the KIT's own change as the user's
      override and "preserve" it, so the update the person confirmed would
      silently not land. The resolver refuses to trust it; this asserts the
      consequence in the only place that matters, the written payload.
    */
    const t = createBackend();
    const { documentId, canvasId } = await seedAppliedDraft(t);
    await stripBaselineGlobals(t, documentId);
    await saveKit(t, buildKitInput({ spacingBump: 6 }));

    const draft = await getDraftStatus({ t, canvasId, documentId });
    expect(draft.state).toBe("outdated");
    expect(draft.overriddenGlobalKeys).toEqual([]);

    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    const expected = buildKitInput({ spacingBump: 6 }).variations[0]!.globals;
    expect(await getRootGlobals(t, documentId)).toEqual(expected);
  });

  it("pointer for a DIFFERENT kit: `outdated` with no parent in the bound kit", async () => {
    const t = createBackend();
    const { documentId, canvasId } = await seedAppliedDraft(t);
    await t.run(async (ctx) => {
      const otherKitId = await ctx.db.insert("brandKits", {
        sessionId: "someone-else",
        name: "Other",
        fonts: { heading: "Georgia, serif", body: "Helvetica, sans-serif" },
        variations: buildKitInput().variations,
        revision: 1,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      await ctx.db.patch(documentId, {
        brand: { kitId: otherKitId, revision: 1, variationId: "midnight" },
      });
      /*
        Diverge the payload so equality cannot supply an identity instead.
      */
    });
    await overrideOneGlobal({ t, documentId, override: { buttonBackgroundColor: "#ff0000" } });

    const draft = await getDraftStatus({ t, canvasId, documentId });
    expect(draft.state).toBe("outdated");
    expect(draft.parentVariation).toBeNull();
    expect(draft.overriddenGlobalKeys).toEqual([]);
  });

  it("no pointer at all: `never-applied` when nothing matches, `current` when the payload does", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const { documentId, canvasId } = await t.mutation(api.documents.createDocument, {
      sessionId: SESSION_ID,
    });
    await t.mutation(api.brandKits.bindSessionKitToCanvas, { canvasId, sessionId: SESSION_ID });

    const unstyled = await getDraftStatus({ t, canvasId, documentId });
    expect(unstyled.state).toBe("never-applied");
    expect(unstyled.parentVariation).toBeNull();

    /*
      Payload equality alone still confers identity — which is what lets the
      migration be lazy: a draft that already renders a theme needs no backfill.
    */
    await t.mutation(api.documents.applyOperations, {
      documentId,
      ops: [{ name: "applyTheme", globals: buildKitInput().variations[1]!.globals }],
      context: { authorId: SESSION_ID, author: "user", caller: "frontend" },
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(documentId, { brand: undefined });
    });
    const matchedByPayload = await getDraftStatus({ t, canvasId, documentId });
    expect(matchedByPayload.state).toBe("current");
    expect(matchedByPayload.parentVariation?.id).toBe("midnight");
  });
});

describe("editing a parent theme — the payoff", () => {
  it("propagates the edit to a referencing draft while KEEPING its overridden property", async () => {
    const t = createBackend();
    const { documentId, canvasId } = await seedAppliedDraft(t);
    await overrideOneGlobal({ t, documentId, override: { buttonBackgroundColor: "#ff0000" } });

    const editedGlobals = {
      ...buildKitInput().variations[0]!.globals,
      baseSpacing: 40,
      buttonBackgroundColor: "#0b3d91",
    };
    await t.mutation(api.brandKits.updateBrandThemeVariation, {
      sessionId: SESSION_ID,
      variationId: "classic-light",
      name: "Classic Light",
      globals: editedGlobals,
    });

    /*
      An edit gives referencing drafts something to adopt, so the pill arms.
    */
    const pending = await getDraftStatus({ t, canvasId, documentId });
    expect(pending.state).toBe("outdated");
    expect(pending.parentVariation?.id).toBe("classic-light");
    expect(pending.overriddenGlobalKeys).toEqual(["buttonBackgroundColor"]);

    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    const globals = await getRootGlobals(t, documentId);
    /*
      The property nobody touched adopts the edit...
    */
    expect(globals.baseSpacing).toBe(40);
    /*
      ...and the one the person chose is still theirs, not the theme's new blue.
    */
    expect(globals.buttonBackgroundColor).toBe("#ff0000");

    const settled = await getDraftStatus({ t, canvasId, documentId });
    expect(settled.state).toBe("overridden");
    expect(settled.overriddenGlobalKeys).toEqual(["buttonBackgroundColor"]);
  });

  it("a draft with NO overrides adopts an edited theme verbatim", async () => {
    const t = createBackend();
    const { documentId, canvasId } = await seedAppliedDraft(t);
    const editedGlobals = { ...buildKitInput().variations[0]!.globals, baseSpacing: 40 };
    await t.mutation(api.brandKits.updateBrandThemeVariation, {
      sessionId: SESSION_ID,
      variationId: "classic-light",
      name: "Classic Light",
      globals: editedGlobals,
    });
    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    expect(await getRootGlobals(t, documentId)).toEqual(editedGlobals);
    expect((await getDraftStatus({ t, canvasId, documentId })).state).toBe("current");
  });

  it("bumps the revision for a payload edit but NOT for a pure rename", async () => {
    /*
      §8.3's rule: a bump re-arms every bound canvas's pill, so it is only
      honest when drafts have something to adopt. A rename changes nothing any
      draft renders — same reasoning as renameBrandKit.
    */
    const t = createBackend();
    const { documentId, canvasId } = await seedAppliedDraft(t);
    await t.mutation(api.brandKits.updateBrandThemeVariation, {
      sessionId: SESSION_ID,
      variationId: "classic-light",
      name: "Daylight",
      globals: buildKitInput().variations[0]!.globals,
    });
    const afterRename = await getDraftStatus({ t, canvasId, documentId });
    expect(afterRename.state).toBe("current");
    expect(afterRename.parentVariation?.name).toBe("Daylight");

    await t.mutation(api.brandKits.updateBrandThemeVariation, {
      sessionId: SESSION_ID,
      variationId: "classic-light",
      name: "Daylight",
      globals: { ...buildKitInput().variations[0]!.globals, baseSpacing: 40 },
    });
    expect((await getDraftStatus({ t, canvasId, documentId })).state).toBe("outdated");
  });

  it("refuses a theme edit that would fail the contrast gate, and stores nothing", async () => {
    const t = createBackend();
    const { canvasId, documentId } = await seedAppliedDraft(t);
    await expect(
      t.mutation(api.brandKits.updateBrandThemeVariation, {
        sessionId: SESSION_ID,
        variationId: "classic-light",
        name: "Classic Light",
        globals: {
          ...buildKitInput().variations[0]!.globals,
          contentBackgroundColor: "#ffffff",
          paragraphTextColor: "#fefefe",
        },
      }),
    ).rejects.toThrow();
    expect((await getDraftStatus({ t, canvasId, documentId })).state).toBe("current");
  });
});

describe("the block layer — per-section background overrides", () => {
  it("survives a brand propagation that applyTheme would otherwise strip", async () => {
    /*
      innerBackgroundColor / outerBackgroundColor are SECTION properties, and
      applyTheme deliberately removes them. Propagation now carries them back on
      the op's `sectionOverrides`, so "this one section is dark" is an override
      in exactly the sense the owner meant.
    */
    const t = createBackend();
    const { documentId, canvasId } = await seedAppliedDraft(t);
    const sectionId = await getFirstSectionId(t, documentId);
    await t.mutation(api.documents.applyOperations, {
      documentId,
      ops: [
        {
          name: "updateBlockProperties",
          blockId: sectionId,
          properties: { innerBackgroundColor: "#101820" },
        },
      ],
      context: { authorId: SESSION_ID, author: "user", caller: "frontend" },
    });
    await saveKit(t, buildKitInput({ spacingBump: 6 }));

    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    const section = (await getDocumentBlocks(t, documentId)).find(
      (block) => block.id === sectionId,
    );
    expect(section?.type).toBe("section");
    expect(section?.properties.innerBackgroundColor).toBe("#101820");
    /*
      The globals update still landed — preserving is not the same as skipping.
    */
    expect((await getRootGlobals(t, documentId)).baseSpacing).toBe(
      buildKitInput({ spacingBump: 6 }).variations[0]!.globals.baseSpacing,
    );
  });
});
