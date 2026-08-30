import { describe, expect, it } from "vitest";
import {
  getBrandKitPalette,
  MAX_BRAND_PALETTE_SWATCHES,
  MOCK_BRAND_KIT,
  type BrandKit,
} from "./brand-kit";

/*
  A kit with controlled colors: spread the mock's complete globals, recolor.
*/
function buildKit(variations: Array<{ name: string; overrides: Record<string, string> }>): BrandKit {
  return {
    ...MOCK_BRAND_KIT,
    variations: variations.map(({ name, overrides }, index) => ({
      id: `variation-${index}`,
      name,
      globals: { ...MOCK_BRAND_KIT.variations[0].globals, ...overrides },
    })),
  };
}

describe("getBrandKitPalette (item 24: prominence-ranked, max 6)", () => {
  it("pins the signature accent (first variation's button background) first", () => {
    const kit = buildKit([
      { name: "Midnight", overrides: { buttonBackgroundColor: "#123456" } },
      { name: "Later", overrides: { buttonBackgroundColor: "#994400" } },
    ]);
    const palette = getBrandKitPalette(kit);
    expect(palette[0]).toEqual({ color: "#123456", label: "Accent — Midnight" });
  });

  it("never returns more than the cap", () => {
    /*
      4 variations × 8 roles of wildly distinct colors.
    */
    const distinct = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#800000", "#008080", "#808000", "#4b0082", "#ff8800"];
    const variations = ["A", "B", "C", "D"].map((name, variationIndex) => ({
      name,
      overrides: Object.fromEntries(
        [
          "buttonBackgroundColor",
          "linkTextColor",
          "heading1TextColor",
          "paragraphTextColor",
          "contentBackgroundColor",
          "emailBackgroundColor",
          "buttonTextColor",
          "dividerColor",
        ].map((key, roleIndex) => [key, distinct[(variationIndex * 3 + roleIndex) % distinct.length]]),
      ),
    }));
    const palette = getBrandKitPalette(buildKit(variations));
    expect(palette.length).toBeLessThanOrEqual(MAX_BRAND_PALETTE_SWATCHES);
    expect(MAX_BRAND_PALETTE_SWATCHES).toBe(6);
  });

  it("frequency across variations outranks a single low-weight appearance", () => {
    const kit = buildKit([
      /*
        #aa1122 is the body text everywhere (weight 2 × 3 variations = 6);
        #3355ff appears once as a divider (0.5). Frequency must win.
      */
      { name: "One", overrides: { paragraphTextColor: "#aa1122", dividerColor: "#3355ff" } },
      { name: "Two", overrides: { paragraphTextColor: "#aa1122" } },
      { name: "Three", overrides: { paragraphTextColor: "#aa1122" } },
    ]);
    const palette = getBrandKitPalette(kit);
    const bodyRank = palette.findIndex(({ color }) => color === "#aa1122");
    const dividerRank = palette.findIndex(({ color }) => color === "#3355ff");
    expect(bodyRank).toBeGreaterThanOrEqual(0);
    /*
      The divider one-off is either ranked below or dropped by the cap.
    */
    if (dividerRank !== -1) {
      expect(bodyRank).toBeLessThan(dividerRank);
    }
  });

  it("merges near-duplicate tints instead of listing both", () => {
    const kit = buildKit([
      {
        name: "Tints",
        overrides: {
          /*
            Mid-purples far from the mock base palette; ~7 RGB apart — tints
            of one brand color, so exactly one may survive.
          */
          heading1TextColor: "#7722aa",
          paragraphTextColor: "#7726ae",
        },
      },
    ]);
    const palette = getBrandKitPalette(kit);
    const purples = palette.filter(({ color }) => color === "#7722aa" || color === "#7726ae");
    expect(purples.length).toBe(1);
    expect(purples[0].color).toBe("#7722aa"); /* the higher-weight heading wins */
  });

  it("keeps genuinely different hues apart", () => {
    const kit = buildKit([
      {
        name: "Hues",
        overrides: {
          buttonBackgroundColor: "#e11d48", /* red accent */
          linkTextColor: "#2563eb", /* blue link — far away, must survive */
        },
      },
    ]);
    const colors = getBrandKitPalette(kit).map(({ color }) => color);
    expect(colors).toContain("#e11d48");
    expect(colors).toContain("#2563eb");
  });

  it("labels a color by its most prominent role and keeps tooltips", () => {
    const kit = buildKit([
      {
        name: "Mono",
        overrides: {
          buttonBackgroundColor: "#abcdef",
          dividerColor: "#abcdef", /* same color, lower-weight role */
        },
      },
    ]);
    const palette = getBrandKitPalette(kit);
    expect(palette[0]).toEqual({ color: "#abcdef", label: "Accent — Mono" });
  });

  it("produces a sane capped row for the mock kit (all #rrggbb, deduped)", () => {
    const palette = getBrandKitPalette(MOCK_BRAND_KIT);
    expect(palette.length).toBeGreaterThan(0);
    expect(palette.length).toBeLessThanOrEqual(MAX_BRAND_PALETTE_SWATCHES);
    const colors = palette.map(({ color }) => color);
    expect(new Set(colors).size).toBe(colors.length);
    for (const color of colors) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
