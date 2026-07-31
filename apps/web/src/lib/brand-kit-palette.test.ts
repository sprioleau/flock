import { describe, expect, it } from "vitest";
import {
  getBrandKitPalette,
  MAX_BRAND_PALETTE_SWATCHES,
  MOCK_BRAND_KIT,
  type BrandKit,
} from "./brand-kit";

/** A kit with controlled colors: spread the mock's complete globals, recolor. */
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

describe("getBrandKitPalette", () => {
  it("puts the first variation's accent (button background) first", () => {
    const kit = buildKit([
      { name: "Midnight", overrides: { buttonBackgroundColor: "#123456" } },
    ]);
    const palette = getBrandKitPalette(kit);
    expect(palette[0]).toEqual({ color: "#123456", label: "Accent — Midnight" });
  });

  it("dedupes repeated colors (first role/variation wins the label)", () => {
    const kit = buildKit([
      {
        name: "Mono",
        overrides: {
          buttonBackgroundColor: "#ABCDEF", // hex case-normalized
          linkTextColor: "#abcdef", // duplicate of the accent
        },
      },
    ]);
    const palette = getBrandKitPalette(kit);
    const occurrences = palette.filter(({ color }) => color === "#abcdef");
    expect(occurrences).toEqual([{ color: "#abcdef", label: "Accent — Mono" }]);
  });

  it("normalizes short hex and skips non-hex values", () => {
    const kit = buildKit([
      {
        name: "Odd",
        overrides: {
          buttonBackgroundColor: "#0aF",
          linkTextColor: "rgb(1, 2, 3)", // not hex — skipped, no crash
        },
      },
    ]);
    const palette = getBrandKitPalette(kit);
    expect(palette[0].color).toBe("#00aaff");
    expect(palette.some(({ color }) => color.includes("rgb"))).toBe(false);
  });

  it("caps the row at the swatch maximum", () => {
    // 4 variations x 8 roles of distinct colors would exceed the cap.
    const variations = ["A", "B", "C", "D"].map((name, variationIndex) => ({
      name,
      overrides: Object.fromEntries(
        [
          "buttonBackgroundColor",
          "linkTextColor",
          "contentBackgroundColor",
          "emailBackgroundColor",
          "heading1TextColor",
          "paragraphTextColor",
          "buttonTextColor",
          "dividerColor",
        ].map((key, roleIndex) => [key, `#${variationIndex}${roleIndex}0a1b`]),
      ),
    }));
    const palette = getBrandKitPalette(buildKit(variations));
    expect(palette.length).toBe(MAX_BRAND_PALETTE_SWATCHES);
    // Accent bucket first: every variation's accent precedes any link color.
    expect(palette[0].label).toBe("Accent — A");
    expect(palette[3].label).toBe("Accent — D");
    expect(palette[4].label).toBe("Link — A");
  });

  it("produces a sane row for the mock kit (all #rrggbb, deduped)", () => {
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
