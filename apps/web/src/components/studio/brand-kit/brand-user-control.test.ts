// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";
import { MOCK_BRAND_KIT, type BrandColor } from "@/lib/brand-kit";

/**
 * Brand-kit user control (docs/proposals/brand-kit-user-control.md) against
 * the REAL Convex functions: the authored palette and tone of voice are
 * human-editable, human edits SURVIVE a re-scrape (§8), and metadata writes
 * never re-arm the "Updated brand available" pills (§8.3).
 *
 * These are the two questions the proposal flagged as the ones most likely to
 * make editable fields feel broken, so they are pinned end to end rather than
 * only at the pure-function level.
 */

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const SESSION_ID = "session-brand-user-control";

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

/** A valid kit payload (mock variations pass completeness + contrast). */
function buildKitInput({
  colors,
  toneOfVoice,
  socialLinks,
  spacingBump = 0,
}: {
  colors?: BrandColor[];
  toneOfVoice?: { descriptors: string[]; origin: "scraped" | "agent" | "user"; guidance?: string };
  /*
    Exactly the scrape's wire shape: platform + url and NOTHING else. The save
    validator accepts no `origin`, which is what makes these rows byte-identical
    to the ones sitting in production today.
  */
  socialLinks?: { platform: string; url: string }[];
  spacingBump?: number;
} = {}) {
  return {
    name: "Acme",
    fonts: { heading: "Georgia, serif", body: "Helvetica, sans-serif" },
    ...(colors === undefined ? {} : { colors }),
    ...(toneOfVoice === undefined ? {} : { toneOfVoice }),
    ...(socialLinks === undefined ? {} : { socialLinks }),
    variations: [
      {
        id: "classic-light",
        name: "Classic Light",
        globals: {
          ...MOCK_BRAND_KIT.variations[0]!.globals,
          baseSpacing: MOCK_BRAND_KIT.variations[0]!.globals.baseSpacing + spacingBump,
        },
      },
    ],
  };
}

function brandColor(overrides: Partial<BrandColor> & { hex: string; name: string }): BrandColor {
  return {
    id: `color-${overrides.hex.slice(1)}`,
    category: "primary",
    orderIndex: 0,
    origin: "agent",
    ...overrides,
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

describe("updateBrandColors — the palette is editable", () => {
  it("persists a rename and stamps it as the human's, without bumping revision", async () => {
    const t = createBackend();
    await saveKit(t, {
      ...buildKitInput({
        colors: [brandColor({ hex: "#ffc400", name: "Yellow", sourceVariableName: "--banana" })],
      }),
    });
    const before = await readKit(t);
    expect(before.revision).toBe(1);

    await t.mutation(api.brandKits.updateBrandColors, {
      sessionId: SESSION_ID,
      colors: [{ ...before.colors![0]!, name: "Banana" }],
    });

    const after = await readKit(t);
    expect(after.colors![0]!.name).toBe("Banana");
    expect(after.colors![0]!.origin).toBe("user");
    expect(after.colors![0]!.userEditedAtMs).toBeGreaterThan(0);
    // §8.3 / risk 3: renaming a color must NOT re-arm every draft's pill.
    expect(after.revision).toBe(1);
  });

  it("accepts an added color and a removed one in one write", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput({ colors: [brandColor({ hex: "#ffc400", name: "Banana" })] }));
    await t.mutation(api.brandKits.updateBrandColors, {
      sessionId: SESSION_ID,
      colors: [
        brandColor({ hex: "#0b1120", name: "Ink", origin: "user" }),
        brandColor({ hex: "#3730a3", name: "Indigo", category: "accent", origin: "user" }),
      ],
    });
    const kit = await readKit(t);
    expect(kit.colors!.map((color) => color.name)).toEqual(["Ink", "Indigo"]);
  });

  it("rejects an unreadable color with a message a person can act on", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await expect(
      t.mutation(api.brandKits.updateBrandColors, {
        sessionId: SESSION_ID,
        colors: [brandColor({ hex: "banana", name: "Banana" })],
      }),
    ).rejects.toThrow(/isn't a color we can read/);
  });
});

describe("updateBrandFonts — the fonts are editable (brand-kit-v2 §1)", () => {
  const GEORGIA = "Georgia, 'Times New Roman', serif";
  const VERDANA = "Verdana, Geneva, sans-serif";

  it("stores the pick AND re-fonts every theme, so the edit is visible", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    const before = await readKit(t);
    expect(before.revision).toBe(1);

    await t.mutation(api.brandKits.updateBrandFonts, {
      sessionId: SESSION_ID,
      fonts: { heading: GEORGIA, body: VERDANA },
    });

    const after = await readKit(t);
    expect(after.fonts).toEqual({ heading: GEORGIA, body: VERDANA });
    const globals = after.variations[0]!.globals;
    expect(globals.heading1FontFamily).toBe(GEORGIA);
    expect(globals.heading2FontFamily).toBe(GEORGIA);
    expect(globals.heading3FontFamily).toBe(GEORGIA);
    expect(globals.paragraphFontFamily).toBe(VERDANA);
    expect(globals.buttonFontFamily).toBe(VERDANA);
    // Colors are untouched — a font edit re-fonts, it never recolors.
    expect(globals.contentBackgroundColor).toBe(
      before.variations[0]!.globals.contentBackgroundColor,
    );
    // Variations are what a draft renders (§8.3), so this one DOES bump.
    expect(after.revision).toBe(2);
  });

  it("refuses a font that isn't email-safe — selection, never free text", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await expect(
      t.mutation(api.brandKits.updateBrandFonts, {
        sessionId: SESSION_ID,
        fonts: { heading: "Comic Sans MS, cursive", body: VERDANA },
      }),
    ).rejects.toThrow(/isn't one we can send in email/);
    expect((await readKit(t)).revision).toBe(1); // nothing was written
  });

  it("does not re-arm every draft's pill when the pick didn't change", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await t.mutation(api.brandKits.updateBrandFonts, {
      sessionId: SESSION_ID,
      fonts: { heading: GEORGIA, body: VERDANA },
    });
    expect((await readKit(t)).revision).toBe(2);
    await t.mutation(api.brandKits.updateBrandFonts, {
      sessionId: SESSION_ID,
      fonts: { heading: GEORGIA, body: VERDANA },
    });
    expect((await readKit(t)).revision).toBe(2);
  });
});

describe("updateBrandToneOfVoice — the voice is editable", () => {
  it("stores what the human typed as theirs, and clears back to nothing", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await t.mutation(api.brandKits.updateBrandToneOfVoice, {
      sessionId: SESSION_ID,
      toneOfVoice: {
        descriptors: [" warm ", "", "plain-spoken"],
        formality: "casual",
        guidance: "Short sentences.",
      },
    });
    const saved = await readKit(t);
    expect(saved.toneOfVoice!.descriptors).toEqual(["warm", "plain-spoken"]);
    expect(saved.toneOfVoice!.formality).toBe("casual");
    expect(saved.toneOfVoice!.origin).toBe("user");
    expect(saved.revision).toBe(1); // nothing renders a voice

    await t.mutation(api.brandKits.updateBrandToneOfVoice, {
      sessionId: SESSION_ID,
      toneOfVoice: null,
    });
    expect((await readKit(t)).toneOfVoice).toBeUndefined();
  });
});

describe("re-scrape reconciliation (§8) — human edits survive", () => {
  it("keeps the color the human renamed and adopts the new ones from the site", async () => {
    const t = createBackend();
    await saveKit(t, {
      ...buildKitInput({
        colors: [
          brandColor({ hex: "#ffc400", name: "Yellow" }),
          brandColor({ hex: "#0b1120", name: "Ink" }),
        ],
      }),
    });
    const kit = await readKit(t);
    // The human renames one color; the other stays the agent's.
    await t.mutation(api.brandKits.updateBrandColors, {
      sessionId: SESSION_ID,
      colors: [{ ...kit.colors![0]!, name: "Banana" }, kit.colors![1]!],
    });

    // A re-scrape of the redesigned site: different names, one new color.
    const result = await saveKit(t, {
      ...buildKitInput({
        spacingBump: 4,
        colors: [
          brandColor({ hex: "#ffc400", name: "Golden" }), // would clobber "Banana"
          brandColor({ hex: "#123456", name: "Steel" }),
        ],
      }),
    });

    const after = await readKit(t);
    const names = after.colors!.map((color) => color.name);
    expect(names).toContain("Banana"); // the human's rename survived
    expect(names).not.toContain("Golden"); // the scrape did not clobber it
    expect(names).toContain("Steel"); // new site colors still arrive
    expect(names).not.toContain("Ink"); // stale machine entries are replaced
    expect(result.keptUserEditedColors).toBe(1);
  });

  it("keeps a tone of voice the human wrote and reports it", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await t.mutation(api.brandKits.updateBrandToneOfVoice, {
      sessionId: SESSION_ID,
      toneOfVoice: { descriptors: ["warm"], guidance: "Never shout." },
    });

    const result = await saveKit(t, {
      ...buildKitInput({
        spacingBump: 4,
        toneOfVoice: { descriptors: ["bold", "disruptive"], origin: "agent" },
      }),
    });

    const after = await readKit(t);
    expect(after.toneOfVoice!.descriptors).toEqual(["warm"]);
    expect(after.toneOfVoice!.guidance).toBe("Never shout.");
    expect(result.keptUserToneOfVoice).toBe(true);
  });

  /*
    Social links (§7.2) are the third field to earn provenance, and the one
    where the overwrite was still live: before this, hand-editing a link and
    re-running "Create from website URL" silently restored whatever the scraper
    had found. These three pin the whole contract end to end.
  */
  it("keeps a hand-edited link and refuses the scrape's rival URL for it", async () => {
    const t = createBackend();
    await saveKit(
      t,
      buildKitInput({
        socialLinks: [
          { platform: "x", url: "https://x.com/acme" },
          { platform: "linkedin", url: "https://linkedin.com/in/acme-ceo" },
        ],
      }),
    );
    /* The human corrects LinkedIn to the company page. */
    await t.mutation(api.brandKits.updateSocialLinks, {
      sessionId: SESSION_ID,
      socialLinks: [
        { platform: "x", url: "https://x.com/acme" },
        { platform: "linkedin", url: "https://linkedin.com/company/acme" },
      ],
    });

    /* A re-scrape that still reads the CEO's profile out of the footer. */
    const result = await saveKit(
      t,
      buildKitInput({
        spacingBump: 4,
        socialLinks: [
          { platform: "linkedin", url: "https://linkedin.com/in/acme-ceo" },
          { platform: "github", url: "https://github.com/acme" },
        ],
      }),
    );

    const after = await readKit(t);
    /* Stored in the shared display order, not in merge order. */
    expect(after.socialLinks).toEqual([
      /* Survived, verbatim, with its provenance intact for the NEXT scrape. */
      { platform: "linkedin", url: "https://linkedin.com/company/acme", origin: "user" },
      /* Adopted: a platform nobody had claimed. */
      { platform: "github", url: "https://github.com/acme" },
    ]);
    expect(result.keptUserEditedSocialLinks).toBe(1);
    /* The X link the human never edited was machine-owned, so it was swept. */
    expect(after.socialLinks!.some(({ platform }) => platform === "x")).toBe(false);
  });

  /*
    THE regression guard for every row already in production: a kit whose links
    were written before `origin` existed has none on any entry, and a re-scrape
    must still replace them exactly as it did before this field shipped.
  */
  it("replaces links on a pre-provenance row, which is every row today", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput({ socialLinks: [{ platform: "x", url: "https://x.com/acme-2019" }] }));
    const before = await readKit(t);
    expect(before.socialLinks).toEqual([{ platform: "x", url: "https://x.com/acme-2019" }]);
    expect(before.socialLinks![0]!.origin).toBeUndefined();

    const result = await saveKit(
      t,
      buildKitInput({
        spacingBump: 4,
        socialLinks: [{ platform: "x", url: "https://x.com/acme" }],
      }),
    );
    expect((await readKit(t)).socialLinks).toEqual([
      { platform: "x", url: "https://x.com/acme" },
    ]);
    expect(result.keptUserEditedSocialLinks).toBe(0);
  });

  it("does not lock a scraped link just because the editor re-sent it unchanged", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput({ socialLinks: [{ platform: "x", url: "https://x.com/acme" }] }));
    /*
      The editor commits the whole array on any blur. Re-sending the scraped
      link untouched must NOT make it the human's, or one stray click through
      the panel would pin the list against every future scrape.
    */
    await t.mutation(api.brandKits.updateSocialLinks, {
      sessionId: SESSION_ID,
      socialLinks: [{ platform: "x", url: "https://x.com/acme" }],
    });
    expect((await readKit(t)).socialLinks![0]!.origin).toBeUndefined();

    await saveKit(
      t,
      buildKitInput({
        spacingBump: 4,
        socialLinks: [{ platform: "x", url: "https://x.com/acme-hq" }],
      }),
    );
    expect((await readKit(t)).socialLinks).toEqual([
      { platform: "x", url: "https://x.com/acme-hq" },
    ]);
  });

  it("lets the scrape refresh a voice the human never touched", async () => {
    const t = createBackend();
    await saveKit(t, {
      ...buildKitInput({ toneOfVoice: { descriptors: ["stale"], origin: "agent" } }),
    });
    const result = await saveKit(t, {
      ...buildKitInput({
        spacingBump: 4,
        toneOfVoice: { descriptors: ["fresh"], origin: "agent" },
      }),
    });
    expect((await readKit(t)).toneOfVoice!.descriptors).toEqual(["fresh"]);
    expect(result.keptUserToneOfVoice).toBe(false);
  });
});

describe("revision policy (§8.3) — pills only re-arm for what a draft renders", () => {
  it("does not bump revision for a metadata-only save", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    expect((await readKit(t)).revision).toBe(1);
    // Same variations, new palette + voice + name: nothing a draft renders.
    await saveKit(t, {
      ...buildKitInput({
        colors: [brandColor({ hex: "#ffc400", name: "Banana" })],
        toneOfVoice: { descriptors: ["warm"], origin: "agent" },
      }),
      name: "Acme Refreshed",
    });
    const after = await readKit(t);
    expect(after.revision).toBe(1);
    expect(after.name).toBe("Acme Refreshed");
    expect(after.colors).toHaveLength(1);
  });

  it("still bumps revision when the theme variations change", async () => {
    const t = createBackend();
    await saveKit(t, buildKitInput());
    await saveKit(t, buildKitInput({ spacingBump: 4 }));
    expect((await readKit(t)).revision).toBe(2);
  });
});
