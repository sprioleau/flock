// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ROOT_BLOCK_ID } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { MOCK_BRAND_KIT } from "@/lib/brand-kit";
import { DEFAULT_BRAND_KIT_NAME } from "@/lib/brand-kit-default";

/**
 * THE STARTER KIT (docs/proposals/brand-kit-user-control.md §14.5c), end to end.
 *
 * The problem it exists for: every manual editor in `BrandKitPanel` is gated
 * behind a saved kit row, and the only way to get one was a successful website
 * scrape — so a bot-protected site (or no site) meant no colors, no fonts, no
 * tone of voice, no themes, no logo, and no way to bind a brand to the canvas.
 *
 * What only this file can prove is that the seeded row is a REAL kit rather
 * than a nicer-looking mock: that every editor the panel gates actually works
 * against it without a scrape, that a scrape then replaces it cleanly rather
 * than merging into it, and that seeding restyles nobody.
 */

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const SESSION_ID = "session-starter-kit";

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

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

/** A scraped kit arriving over the same mutation the generate route uses. */
function buildScrapedKit() {
  return {
    name: "Acme Corp",
    sourceUrl: "https://acme.com",
    fonts: { heading: "Georgia, 'Times New Roman', serif", body: "Verdana, Geneva, sans-serif" },
    colors: [
      {
        id: "acme-red",
        hex: "#b91c1c",
        name: "Acme Red",
        category: "primary" as const,
        orderIndex: 0,
        origin: "scraped" as const,
      },
    ],
    toneOfVoice: { descriptors: ["energetic"], origin: "scraped" as const },
    variations: [
      {
        id: "acme-light",
        name: "Acme Light",
        globals: { ...MOCK_BRAND_KIT.variations[0]!.globals },
      },
    ],
  };
}

describe("startDefaultBrandKit — a way in without a scrape", () => {
  it("seeds Flock's brand as a real, saved kit", async () => {
    const t = createBackend();
    expect(await t.query(api.brandKits.getActiveBrandKit, { sessionId: SESSION_ID })).toBeNull();
    await t.mutation(api.brandKits.startDefaultBrandKit, { sessionId: SESSION_ID });
    const kit = await readKit(t);
    expect(kit.name).toBe(DEFAULT_BRAND_KIT_NAME);
    expect(kit.isStarterKit).toBe(true);
    expect(kit.variations.map((variation) => variation.name)).toContain("Midnight");
    expect(kit.colors?.map((color) => color.name)).toEqual(["Black", "Charcoal", "White"]);
    expect(kit.toneOfVoice?.descriptors.length).toBeGreaterThan(0);
    /* The logo is a SUGGESTION — unconfirmed, so nothing may write it into a
       document until the user runs the confirm flow (owner decision 4). */
    expect(kit.logoUrl?.startsWith("data:image/svg+xml")).toBe(true);
    expect(kit.logoConfirmedAtMs).toBeUndefined();
  });

  it("is idempotent and never overwrites a kit the user already has", async () => {
    const t = createBackend();
    await t.mutation(api.brandKits.saveBrandKit, {
      sessionId: SESSION_ID,
      brandKit: buildScrapedKit(),
    });
    const result = await t.mutation(api.brandKits.startDefaultBrandKit, { sessionId: SESSION_ID });
    expect(result.wasAlreadyPresent).toBe(true);
    expect((await readKit(t)).name).toBe("Acme Corp");
  });

  it("restyles nothing: an existing draft renders identically after seeding", async () => {
    const t = createBackend();
    const { documentId } = await t.mutation(api.documents.createDocument, {
      sessionId: SESSION_ID,
    });
    const before = await getRootGlobals(t, documentId);
    await t.mutation(api.brandKits.startDefaultBrandKit, { sessionId: SESSION_ID });
    expect(await getRootGlobals(t, documentId)).toEqual(before);
  });
});

describe("the starter kit is fully editable without ever scraping a site", () => {
  it("takes colors, fonts, tone of voice, a logo address, a new theme and a rename", async () => {
    /*
      One test on purpose: the claim is not "one mutation works", it is "the
      panel is no longer a dead end", and that claim is exactly the set of
      editors the `hasSavedKit` gate used to hide.
    */
    const t = createBackend();
    await t.mutation(api.brandKits.startDefaultBrandKit, { sessionId: SESSION_ID });
    const seeded = await readKit(t);

    await t.mutation(api.brandKits.updateBrandColors, {
      sessionId: SESSION_ID,
      colors: (seeded.colors ?? []).map((color) =>
        color.name === "Charcoal" ? { ...color, hex: "#2f3136", name: "Slate" } : color,
      ),
    });
    await t.mutation(api.brandKits.updateBrandFonts, {
      sessionId: SESSION_ID,
      fonts: { heading: "Georgia, 'Times New Roman', serif", body: "Verdana, Geneva, sans-serif" },
    });
    await t.mutation(api.brandKits.updateBrandToneOfVoice, {
      sessionId: SESSION_ID,
      toneOfVoice: { descriptors: ["warm"], formality: "casual" },
    });
    await t.mutation(api.brandKits.setBrandAssetSuggestion, {
      sessionId: SESSION_ID,
      kind: "logo",
      url: "https://example.com/my-logo.png",
    });
    await t.mutation(api.brandKits.addBrandThemeVariation, {
      sessionId: SESSION_ID,
      variation: {
        id: "mine",
        name: "Mine",
        globals: { ...MOCK_BRAND_KIT.variations[1]!.globals },
      },
    });
    await t.mutation(api.brandKits.renameBrandKit, { sessionId: SESSION_ID, name: "My Brand" });

    const edited = await readKit(t);
    expect(edited.name).toBe("My Brand");
    expect(edited.colors?.map((color) => color.name)).toContain("Slate");
    expect(edited.fonts.body).toBe("Verdana, Geneva, sans-serif");
    expect(edited.toneOfVoice?.descriptors).toEqual(["warm"]);
    expect(edited.logoUrl).toBe("https://example.com/my-logo.png");
    expect(edited.variations.map((variation) => variation.id)).toContain("mine");
    /* Renaming is one of the two gestures that make the kit the user's own. */
    expect(edited.isStarterKit).toBeUndefined();
  });

  it("can be bound to a canvas, which was impossible without a saved kit", async () => {
    const t = createBackend();
    const { canvasId, documentId } = await t.mutation(api.documents.createDocument, {
      sessionId: SESSION_ID,
    });
    await t.mutation(api.brandKits.startDefaultBrandKit, { sessionId: SESSION_ID });
    await t.mutation(api.brandKits.bindSessionKitToCanvas, { canvasId, sessionId: SESSION_ID });
    const status = await t.query(api.brandKits.getCanvasBrandStatus, { canvasId });
    expect(status.binding?.name).toBe(DEFAULT_BRAND_KIT_NAME);
    /* Binding still restyles nothing — the draft is offered an update, not given one. */
    expect(status.drafts.find((draft) => draft.documentId === documentId)).toBeDefined();
  });

  it("propagates NO logo, because the starter logo is not confirmed", async () => {
    /*
      The unconfirmed-asset rule, checked where it matters. A `data:` URI in an
      email `src` is blocked by most clients, so shipping the starter logo
      pre-confirmed would put a broken image in people's emails.
    */
    const t = createBackend();
    const { canvasId, documentId } = await t.mutation(api.documents.createDocument, {
      sessionId: SESSION_ID,
    });
    await t.mutation(api.brandKits.startDefaultBrandKit, { sessionId: SESSION_ID });
    await t.mutation(api.brandKits.bindSessionKitToCanvas, { canvasId, sessionId: SESSION_ID });
    await t.mutation(api.brandKits.applyBrandToDocuments, {
      canvasId,
      documentIds: [documentId],
      sessionId: SESSION_ID,
    });
    const payload = await t.query(api.documents.getDocument, { documentId });
    const images = Object.values(payload?.doc ?? {}).filter(
      (block): block is { type: string; properties: { src?: string } } =>
        (block as { type: string }).type === "image",
    );
    expect(images.some((image) => (image.properties.src ?? "").startsWith("data:"))).toBe(false);
  });
});

describe("a scrape cleanly replaces the starter kit", () => {
  it("sweeps its name, palette, tone, themes and badge — nothing of Flock's survives", async () => {
    /*
      The starter's colors and tone carry `origin: "agent"` precisely so the
      re-scrape reconciliation does NOT protect them. A starter that survived
      the user's own scrape of their own website would be the opposite of a
      starting point.
    */
    const t = createBackend();
    await t.mutation(api.brandKits.startDefaultBrandKit, { sessionId: SESSION_ID });
    const result = await t.mutation(api.brandKits.saveBrandKit, {
      sessionId: SESSION_ID,
      brandKit: buildScrapedKit(),
    });
    expect(result.keptUserEditedColors).toBe(0);
    expect(result.keptUserToneOfVoice).toBe(false);
    const kit = await readKit(t);
    expect(kit.name).toBe("Acme Corp");
    expect(kit.isStarterKit).toBeUndefined();
    expect(kit.colors?.map((color) => color.name)).toEqual(["Acme Red"]);
    expect(kit.toneOfVoice?.descriptors).toEqual(["energetic"]);
    expect(kit.variations.map((variation) => variation.id)).toEqual(["acme-light"]);
    expect(kit.logoUrl).toBeUndefined();
  });

  it("still protects what the user edited on the starter before scraping", async () => {
    /*
      The other half of the same rule: sweeping the STARTER's values must not
      sweep the human's. `planBrandColorsUpdate` stamps an edited color as the
      user's server-side, and that is what makes it stick.
    */
    const t = createBackend();
    await t.mutation(api.brandKits.startDefaultBrandKit, { sessionId: SESSION_ID });
    const seeded = await readKit(t);
    await t.mutation(api.brandKits.updateBrandColors, {
      sessionId: SESSION_ID,
      colors: (seeded.colors ?? []).map((color) =>
        color.name === "Black" ? { ...color, hex: "#101014", name: "My Black" } : color,
      ),
    });
    const result = await t.mutation(api.brandKits.saveBrandKit, {
      sessionId: SESSION_ID,
      brandKit: buildScrapedKit(),
    });
    expect(result.keptUserEditedColors).toBe(1);
    expect((await readKit(t)).colors?.map((color) => color.name)).toContain("My Black");
  });
});
