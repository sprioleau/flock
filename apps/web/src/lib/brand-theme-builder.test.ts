import { describe, expect, it } from "vitest";
import {
  getBrandKitValidationErrors,
  getContrastRatio,
  getVariationContrastPairs,
  MIN_THEME_CONTRAST_RATIO,
  MOCK_BRAND_KIT,
  type BrandColor,
} from "./brand-kit";
import {
  buildCustomThemeName,
  buildCustomThemeVariation,
  buildThemeCandidates,
  buildUniqueVariationId,
  deriveEmailBackgroundColor,
  getButtonShapeFromRadius,
  getEligibleTextColors,
  getEligibleThemeBackgrounds,
  getPaletteHexes,
  MAX_THEME_CANDIDATES,
  pickNextThemeCandidate,
} from "./brand-theme-builder";

/*
  Custom themes: filter-before-offering and shuffle (brand-kit-v2 §2.1).

  The property that makes this feature worth having is that NOTHING the picker
  offers can be refused later — so the suite proves the filter and the shuffle
  against the SAME contrast rule the server gate enforces
  (`getBrandKitValidationErrors`), rather than against a restated threshold
  that could drift away from it.
*/

const FONTS = { heading: "Georgia, serif", body: "Helvetica, sans-serif" };

/* Ink / white / banana / indigo: a normal brand palette with real contrast. */
const PALETTE = ["#0b1120", "#ffffff", "#ffc400", "#3730a3"];

/* Three close mid-greys: nothing in it pairs at 4.5:1 with anything else. */
const MONOCHROME_PALETTE = ["#808080", "#8a8a8a", "#757575"];

function paletteColor(hex: string, name: string): BrandColor {
  return { id: `color-${hex.slice(1)}`, hex, name, category: "primary", orderIndex: 0, origin: "agent" };
}

describe("getPaletteHexes — the palette as offerable colors", () => {
  it("normalizes, drops unreadable entries, and keeps panel order without duplicates", () => {
    expect(
      getPaletteHexes([
        paletteColor("#FFC400", "Banana"),
        paletteColor("banana", "Broken"),
        paletteColor("#ffc400", "Banana again"),
        paletteColor("#0B1120", "Ink"),
      ]),
    ).toEqual(["#ffc400", "#0b1120"]);
  });
});

describe("getEligibleTextColors — the filter that replaces refusal", () => {
  it("offers only colors that clear the same bar the server gate enforces", () => {
    const eligible = getEligibleTextColors({ background: "#ffffff", paletteHexes: PALETTE });
    for (const foreground of eligible) {
      expect(getContrastRatio({ foreground, background: "#ffffff" })).toBeGreaterThanOrEqual(
        MIN_THEME_CONTRAST_RATIO,
      );
    }
    /* Banana on white is ~1.6:1 — the exact combination a user would have */
    /* picked and then been refused for. */
    expect(eligible).not.toContain("#ffc400");
    expect(eligible).toContain("#0b1120");
  });

  it("never offers a background's own color as its text color", () => {
    expect(getEligibleTextColors({ background: "#0b1120", paletteHexes: PALETTE })).not.toContain(
      "#0b1120",
    );
  });

  it("returns nothing for a background nothing in the palette can sit on", () => {
    expect(
      getEligibleTextColors({ background: "#808080", paletteHexes: MONOCHROME_PALETTE }),
    ).toEqual([]);
  });
});

describe("getEligibleThemeBackgrounds — no dead-end backgrounds", () => {
  it("keeps only backgrounds that have at least one readable text color", () => {
    expect(getEligibleThemeBackgrounds(PALETTE)).toEqual(["#0b1120", "#ffffff", "#ffc400", "#3730a3"]);
  });

  it("is empty for a monochrome palette, so the UI can say so instead of shuffling into nothing", () => {
    expect(getEligibleThemeBackgrounds(MONOCHROME_PALETTE)).toEqual([]);
  });
});

describe("buildThemeCandidates — every stop is safe by construction", () => {
  it("produces candidates whose expanded variation passes every guarded pairing", () => {
    const candidates = buildThemeCandidates(PALETTE);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const variation = buildCustomThemeVariation({
        name: "Candidate",
        roles: candidate.roles,
        fonts: FONTS,
        buttonShape: "rounded",
        takenIds: [],
      });
      expect(variation).not.toBeNull();
      for (const pair of getVariationContrastPairs(variation!)) {
        expect(pair.ratio).not.toBeNull();
        expect(pair.ratio!).toBeGreaterThanOrEqual(MIN_THEME_CONTRAST_RATIO);
      }
    }
  });

  it("never makes the accent the background, so a button is always visible", () => {
    for (const { roles } of buildThemeCandidates(PALETTE)) {
      expect(roles.accent).not.toBe(roles.contentBackground);
    }
  });

  it("gives headings at least as much contrast as paragraphs", () => {
    for (const { roles } of buildThemeCandidates(PALETTE)) {
      const headingRatio = getContrastRatio({
        foreground: roles.headingText,
        background: roles.contentBackground,
      })!;
      const paragraphRatio = getContrastRatio({
        foreground: roles.paragraphText,
        background: roles.contentBackground,
      })!;
      expect(headingRatio).toBeGreaterThanOrEqual(paragraphRatio);
    }
  });

  it("is empty for a monochrome palette rather than offering an unusable stop", () => {
    expect(buildThemeCandidates(MONOCHROME_PALETTE)).toEqual([]);
  });

  it("stays bounded for a full-size palette", () => {
    const bigPalette = [
      "#000000", "#111111", "#ffffff", "#fafafa", "#ffc400", "#3730a3",
      "#9a3412", "#166534", "#0b1120", "#f1e8da", "#7dd3fc", "#52402f",
    ];
    expect(buildThemeCandidates(bigPalette).length).toBeLessThanOrEqual(MAX_THEME_CANDIDATES);
  });
});

describe("pickNextThemeCandidate — the shuffle always moves", () => {
  const candidates = buildThemeCandidates(PALETTE);

  it("never returns the candidate already showing", () => {
    for (const current of candidates) {
      for (const randomValue of [0, 0.25, 0.5, 0.75, 0.999]) {
        const next = pickNextThemeCandidate({ candidates, currentKey: current.key, randomValue });
        expect(next).not.toBeNull();
        expect(next!.key).not.toBe(current.key);
      }
    }
  });

  it("keeps showing the only candidate rather than clearing the preview", () => {
    const only = candidates[0]!;
    expect(pickNextThemeCandidate({ candidates: [only], currentKey: only.key, randomValue: 0.5 })).toEqual(
      only,
    );
  });

  it("returns null when there is nothing to shuffle through", () => {
    expect(pickNextThemeCandidate({ candidates: [], currentKey: null, randomValue: 0.5 })).toBeNull();
  });

  it("stays in range at the top of Math.random()'s interval", () => {
    const next = pickNextThemeCandidate({ candidates, currentKey: null, randomValue: 0.9999999 });
    expect(next).not.toBeNull();
    expect(candidates).toContainEqual(next!);
  });
});

describe("buildCustomThemeVariation — a custom theme is the same object a scraped one is", () => {
  const roles = {
    contentBackground: "#ffffff",
    headingText: "#0b1120",
    paragraphText: "#3730a3",
    accent: "#ffc400",
  };

  it("wires the accent into the buttons and derives a readable label", () => {
    const variation = buildCustomThemeVariation({
      name: "Banana Light",
      roles,
      fonts: FONTS,
      buttonShape: "pill",
      takenIds: [],
    })!;
    expect(variation.globals.buttonBackgroundColor).toBe("#ffc400");
    expect(variation.globals.buttonBorderColor).toBe("#ffc400");
    expect(variation.globals.buttonBorderRadius).toBe(999);
    expect(
      getContrastRatio({
        foreground: variation.globals.buttonTextColor,
        background: "#ffc400",
      })!,
    ).toBeGreaterThanOrEqual(MIN_THEME_CONTRAST_RATIO);
  });

  it("takes the kit's fonts and holds layout keys at renderer defaults", () => {
    const variation = buildCustomThemeVariation({
      name: "Banana Light",
      roles,
      fonts: FONTS,
      buttonShape: "rounded",
      takenIds: [],
    })!;
    expect(variation.globals.heading1FontFamily).toBe(FONTS.heading);
    expect(variation.globals.paragraphFontFamily).toBe(FONTS.body);
    expect(variation.globals.contentWidth).toBe(MOCK_BRAND_KIT.variations[0]!.globals.contentWidth);
  });

  it("produces a kit the server gate accepts when appended to a real one", () => {
    const variation = buildCustomThemeVariation({
      name: "Banana Light",
      roles,
      fonts: FONTS,
      buttonShape: "rounded",
      takenIds: MOCK_BRAND_KIT.variations.map((existing) => existing.id),
    })!;
    expect(
      getBrandKitValidationErrors({
        ...MOCK_BRAND_KIT,
        variations: [...MOCK_BRAND_KIT.variations, variation],
      }),
    ).toEqual([]);
  });

  it("falls back to a name rather than storing an empty one", () => {
    expect(
      buildCustomThemeVariation({
        name: "   ",
        roles,
        fonts: FONTS,
        buttonShape: "rounded",
        takenIds: [],
      })!.name,
    ).toBe("Custom theme");
  });
});

describe("buildUniqueVariationId — two themes are never the same theme to Stage M", () => {
  it("suffixes a slug that is already taken", () => {
    expect(buildUniqueVariationId({ name: "Warm Sand", takenIds: ["warm-sand"] })).toBe("warm-sand-2");
    expect(
      buildUniqueVariationId({ name: "Warm Sand", takenIds: ["warm-sand", "warm-sand-2"] }),
    ).toBe("warm-sand-3");
  });

  it("leaves a free slug alone", () => {
    expect(buildUniqueVariationId({ name: "Warm Sand", takenIds: ["midnight"] })).toBe("warm-sand");
  });
});

describe("naming and derived colors", () => {
  it("names a theme from the kit's own color names", () => {
    expect(buildCustomThemeName({ backgroundName: "Ink", accentName: "Banana" })).toBe("Ink & Banana");
    expect(buildCustomThemeName({ backgroundName: undefined, accentName: "Banana" })).toBe("Banana");
    expect(buildCustomThemeName({ backgroundName: " ", accentName: undefined })).toBe("Custom theme");
  });

  it("keeps a dark theme's outer background dark and a light theme's light", () => {
    const dark = deriveEmailBackgroundColor({
      contentBackground: "#0b1120",
      paragraphText: "#cbd5e1",
    });
    const light = deriveEmailBackgroundColor({
      contentBackground: "#ffffff",
      paragraphText: "#374151",
    });
    expect(getContrastRatio({ foreground: dark, background: "#ffffff" })!).toBeGreaterThan(
      getContrastRatio({ foreground: light, background: "#ffffff" })!,
    );
  });

  it("inherits the kit's button shape instead of squaring off a brand's pills", () => {
    expect(getButtonShapeFromRadius(999)).toBe("pill");
    expect(getButtonShapeFromRadius(0)).toBe("square");
    expect(getButtonShapeFromRadius(6)).toBe("rounded");
    expect(getButtonShapeFromRadius(4)).toBe("rounded");
    expect(getButtonShapeFromRadius(undefined)).toBe("rounded");
  });
});
