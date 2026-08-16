/* @vitest-environment edge-runtime */
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";
import { MOCK_BRAND_KIT } from "@/lib/brand-kit";
import { buildCustomThemeVariation } from "@/lib/brand-theme-builder";

/*
  brand-kit-v2 §2.1 (user-authored themes) and brand-kit-user-control §6.2/§7.2
  (manual asset URL, social-link editing) against the REAL Convex functions.

  These three writes are pinned end to end rather than only at the pure-function
  level because each one has a consequence the pure layer cannot see: whether
  the "Updated brand available" pill re-arms on every draft of every bound
  canvas, and whether a confirmation survives.
*/

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const SESSION_ID = "session-brand-kit-v2";

function createBackend() {
  return convexTest(schema, modules);
}

/*
  Derived from createBackend, NOT from convexTest: `ReturnType<typeof
  convexTest>` drops the schema generic, which makes ctx.db fall back to system
  tables and breaks withIndex at typecheck while the tests still pass.
*/
type Backend = ReturnType<typeof createBackend>;

const FONTS = { heading: "Georgia, 'Times New Roman', serif", body: "Helvetica, Arial, sans-serif" };

function buildKitInput({ logoUrl }: { logoUrl?: string } = {}) {
  return {
    name: "Acme",
    fonts: FONTS,
    ...(logoUrl === undefined ? {} : { logoUrl }),
    variations: [
      {
        id: "classic-light",
        name: "Classic Light",
        globals: MOCK_BRAND_KIT.variations[0]!.globals,
      },
    ],
  };
}

async function saveKit(t: Backend, input: ReturnType<typeof buildKitInput>) {
  return await t.mutation(api.brandKits.saveBrandKit, { sessionId: SESSION_ID, brandKit: input });
}

async function readKit(t: Backend) {
  const kit = await t.query(api.brandKits.getActiveBrandKit, { sessionId: SESSION_ID });
  if (kit === null) {
    throw new Error("expected a saved kit");
  }
  return kit;
}

/* A theme the filtered picker could actually have produced. */
function buildCustomTheme({ name, takenIds }: { name: string; takenIds: string[] }) {
  const variation = buildCustomThemeVariation({
    name,
    roles: {
      contentBackground: "#ffffff",
      headingText: "#0b1120",
      paragraphText: "#3730a3",
      accent: "#9a3412",
    },
    fonts: FONTS,
    buttonShape: "rounded",
    takenIds,
  });
  if (variation === null) {
    throw new Error("expected the builder to produce a contrast-passing theme");
  }
  return variation;
}

describe("addBrandThemeVariation — custom themes (v2 §2.1)", () => {
  it("appends the theme and leaves every existing one byte-identical", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const before = await readKit(t);

    await t.mutation(api.brandKits.addBrandThemeVariation, {
      sessionId: SESSION_ID,
      variation: buildCustomTheme({ name: "White & Rust", takenIds: ["classic-light"] }),
    });

    const after = await readKit(t);
    expect(after.variations).toHaveLength(2);
    expect(after.variations[0]).toEqual(before.variations[0]);
    expect(after.variations[1]!.name).toBe("White & Rust");
    /*
      The accent has to reach the buttons or the theme looks broken exactly
      where a reader clicks — the owner's "these colors should inform the
      buttons".
    */
    expect(after.variations[1]!.globals.buttonBackgroundColor).toBe("#9a3412");
  });

  it("does NOT re-arm every draft's pill: adding a theme changes nothing a draft renders", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    expect((await readKit(t)).revision).toBe(1);
    await t.mutation(api.brandKits.addBrandThemeVariation, {
      sessionId: SESSION_ID,
      variation: buildCustomTheme({ name: "White & Rust", takenIds: ["classic-light"] }),
    });
    expect((await readKit(t)).revision).toBe(1);
  });

  it("still refuses a theme that fails contrast — the gate is a backstop, not a formality", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const illegible = buildCustomTheme({ name: "Illegible", takenIds: [] });
    await expect(
      t.mutation(api.brandKits.addBrandThemeVariation, {
        sessionId: SESSION_ID,
        variation: {
          ...illegible,
          globals: { ...illegible.globals, paragraphTextColor: "#f5f5f5" },
        },
      }),
    ).rejects.toThrow(/fails contrast/);
    expect((await readKit(t)).variations).toHaveLength(1);
  });

  it("refuses a duplicate id so two themes are never the same theme to Stage M", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await expect(
      t.mutation(api.brandKits.addBrandThemeVariation, {
        sessionId: SESSION_ID,
        variation: { ...buildCustomTheme({ name: "Classic Light", takenIds: [] }), id: "classic-light" },
      }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("setBrandAssetSuggestion — typing a logo address (§6.2)", () => {
  it("parks the typed URL as an UNCONFIRMED suggestion, fetching nothing", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await t.mutation(api.brandKits.setBrandAssetSuggestion, {
      sessionId: SESSION_ID,
      kind: "logo",
      url: "https://acme.com/logo.png",
    });
    const kit = await readKit(t);
    expect(kit.logoUrl).toBe("https://acme.com/logo.png");
    /* Unconfirmed: decision 4 keeps it out of every document until confirmed. */
    expect(kit.logoConfirmedAtMs).toBeUndefined();
  });

  it("refuses an address the confirm step could never fetch", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await expect(
      t.mutation(api.brandKits.setBrandAssetSuggestion, {
        sessionId: SESSION_ID,
        kind: "logo",
        url: "http://127.0.0.1/logo.png",
      }),
    ).rejects.toThrow(/private network/);
    expect((await readKit(t)).logoUrl).toBeUndefined();
  });

  it("is a no-op when the address already on the row is retyped", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput({ logoUrl: "https://acme.com/logo.png" }));
    const before = await readKit(t);
    await t.mutation(api.brandKits.setBrandAssetSuggestion, {
      sessionId: SESSION_ID,
      kind: "logo",
      url: "https://acme.com/logo.png",
    });
    expect((await readKit(t)).revision).toBe(before.revision);
  });
});

describe("updateSocialLinks — the array is finally editable (§7.2)", () => {
  it("canonicalizes what the human typed and stores it", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await t.mutation(api.brandKits.updateSocialLinks, {
      sessionId: SESSION_ID,
      socialLinks: [
        { platform: "linkedin", url: "https://www.linkedin.com/company/acme/?trk=nav" },
        { platform: "x", url: "https://twitter.com/acme" },
      ],
    });
    const kit = await readKit(t);
    expect(kit.socialLinks).toEqual([
      { platform: "x", url: "https://twitter.com/acme" },
      { platform: "linkedin", url: "https://linkedin.com/company/acme" },
    ]);
    /* Metadata only — no draft renders social links, so no pill re-arms. */
    expect(kit.revision).toBe(1);
  });

  it("refuses share chrome rather than storing it as the brand's profile", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await expect(
      t.mutation(api.brandKits.updateSocialLinks, {
        sessionId: SESSION_ID,
        socialLinks: [{ platform: "facebook", url: "https://facebook.com/sharer.php?u=acme.com" }],
      }),
    ).rejects.toThrow(/Facebook profile link/);
  });

  it("clears every link when the user empties the list", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await t.mutation(api.brandKits.updateSocialLinks, {
      sessionId: SESSION_ID,
      socialLinks: [{ platform: "x", url: "https://x.com/acme" }],
    });
    await t.mutation(api.brandKits.updateSocialLinks, { sessionId: SESSION_ID, socialLinks: [] });
    expect((await readKit(t)).socialLinks).toBeUndefined();
  });
});
