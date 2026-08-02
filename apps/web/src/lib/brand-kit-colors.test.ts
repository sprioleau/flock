/**
 * The authored palette (docs/proposals/brand-kit-user-control.md §3): the
 * `--banana` naming ladder, the deterministic color description that always
 * terminates it, and the read rule that makes an authored palette WIN over the
 * derived one in every color picker.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_BRAND_COLORS,
  MAX_BRAND_PALETTE_SWATCHES,
  MOCK_BRAND_KIT,
  deriveColorNameFromVariable,
  describeHexColor,
  getBrandColorsValidationErrors,
  getBrandKitPalette,
  getToneOfVoiceValidationErrors,
  resolveBrandColorName,
  sortBrandColorsForDisplay,
  type BrandColor,
  type BrandColorCategory,
} from "./brand-kit";

function buildColor({
  hex,
  name,
  category = "primary",
  orderIndex = 0,
  ...rest
}: {
  hex: string;
  name: string;
  category?: BrandColorCategory;
  orderIndex?: number;
} & Partial<BrandColor>): BrandColor {
  return { id: `id-${hex}`, hex, name, category, orderIndex, origin: "agent", ...rest };
}

describe("deriveColorNameFromVariable (the owner's --banana)", () => {
  it("names a color what the site called it", () => {
    expect(deriveColorNameFromVariable("--banana")).toBe("Banana");
    expect(deriveColorNameFromVariable("--sky-bright")).toBe("Sky Bright");
    expect(deriveColorNameFromVariable("--forest_green")).toBe("Forest Green");
  });

  it("drops leading namespace noise but never the whole name", () => {
    expect(deriveColorNameFromVariable("--ui-accent-1")).toBe("Accent 1");
    expect(deriveColorNameFromVariable("--color-theme-ink")).toBe("Ink");
    // "--brand" is all noise words: keep the last one rather than derive nothing.
    expect(deriveColorNameFromVariable("--brand")).toBe("Brand");
  });

  it("returns null when nothing meaningful survives", () => {
    expect(deriveColorNameFromVariable("--c-4")).toBeNull();
    expect(deriveColorNameFromVariable("--x")).toBeNull();
    expect(deriveColorNameFromVariable("--")).toBeNull();
  });
});

describe("describeHexColor (the always-terminating fallback)", () => {
  it("describes the color itself, never brand mythology", () => {
    expect(describeHexColor("#ffc400")).toBe("Yellow");
    expect(describeHexColor("#0b1120")).toBe("Deep Blue");
    expect(describeHexColor("#fff4b0")).toBe("Pale Yellow");
  });

  it("names low-chroma colors by lightness", () => {
    expect(describeHexColor("#fdfdfd")).toBe("Off White");
    expect(describeHexColor("#808080")).toBe("Gray");
    expect(describeHexColor("#050505")).toBe("Near Black");
  });

  it("degrades to a safe label for unparseable input", () => {
    expect(describeHexColor("rebeccapurple")).toBe("Brand color");
  });
});

describe("resolveBrandColorName (the three-rung ladder)", () => {
  it("prefers the model's proposal", () => {
    expect(
      resolveBrandColorName({ proposedName: "Banana", variableName: "--c-4", hex: "#ffc400" }),
    ).toBe("Banana");
  });

  it("falls back to the declared variable when the model said nothing", () => {
    expect(resolveBrandColorName({ proposedName: "  ", variableName: "--banana", hex: "#ffc400" })).toBe(
      "Banana",
    );
  });

  it("falls back to a description of the color when the variable says nothing", () => {
    expect(resolveBrandColorName({ variableName: "--c-4", hex: "#ffc400" })).toBe("Yellow");
    expect(resolveBrandColorName({ hex: "#ffc400" })).toBe("Yellow");
  });
});

describe("getBrandKitPalette read rule (authored beats derived)", () => {
  it("renders the authored palette verbatim — names and all", () => {
    const kit = {
      ...MOCK_BRAND_KIT,
      colors: [
        buildColor({ hex: "#ffc400", name: "Banana", category: "accent" }),
        buildColor({ hex: "#0b1120", name: "Ink", category: "primary" }),
      ],
    };
    const palette = getBrandKitPalette(kit);
    // Primaries lead the PICKER row, accents next (the panel groups differently).
    expect(palette).toEqual([
      { color: "#0b1120", label: "Ink" },
      { color: "#ffc400", label: "Banana" },
    ]);
  });

  it("keeps near-duplicate colors a human deliberately curated", () => {
    const kit = {
      ...MOCK_BRAND_KIT,
      colors: [
        buildColor({ hex: "#3730a3", name: "Indigo", orderIndex: 0 }),
        buildColor({ hex: "#3831a5", name: "Indigo Deep", orderIndex: 1 }),
      ],
    };
    // The derived path would merge these (RGB distance < 36); the authored
    // path must not — a human who curated two close tints meant to.
    expect(getBrandKitPalette(kit).map(({ label }) => label)).toEqual(["Indigo", "Indigo Deep"]);
  });

  it("still caps the picker row", () => {
    const kit = {
      ...MOCK_BRAND_KIT,
      colors: Array.from({ length: 10 }, (_, index) =>
        buildColor({
          hex: `#${index}${index}00${index}${index}`,
          name: `Color ${index}`,
          orderIndex: index,
        }),
      ),
    };
    expect(getBrandKitPalette(kit)).toHaveLength(MAX_BRAND_PALETTE_SWATCHES);
  });

  it("falls through to the derivation for legacy and mock kits", () => {
    expect(getBrandKitPalette(MOCK_BRAND_KIT)[0]?.label).toBe("Accent — Classic Light");
    expect(getBrandKitPalette({ ...MOCK_BRAND_KIT, colors: [] })[0]?.label).toBe(
      "Accent — Classic Light",
    );
  });

  it("skips authored entries whose hex can't be read rather than rendering junk", () => {
    const kit = {
      ...MOCK_BRAND_KIT,
      colors: [buildColor({ hex: "not-a-color", name: "Broken" }), buildColor({ hex: "#ffc400", name: "Banana" })],
    };
    expect(getBrandKitPalette(kit)).toEqual([{ color: "#ffc400", label: "Banana" }]);
  });
});

describe("sortBrandColorsForDisplay", () => {
  it("groups primary → secondary → accent, then by order within a group", () => {
    const sorted = sortBrandColorsForDisplay([
      buildColor({ hex: "#111111", name: "A", category: "accent", orderIndex: 1 }),
      buildColor({ hex: "#222222", name: "B", category: "primary", orderIndex: 1 }),
      buildColor({ hex: "#333333", name: "C", category: "secondary", orderIndex: 0 }),
      buildColor({ hex: "#444444", name: "D", category: "primary", orderIndex: 0 }),
    ]);
    expect(sorted.map(({ name }) => name)).toEqual(["D", "B", "C", "A"]);
  });
});

describe("validation (hard errors only — never contrast)", () => {
  it("accepts an absent palette and an absent voice", () => {
    expect(getBrandColorsValidationErrors(undefined)).toEqual([]);
    expect(getToneOfVoiceValidationErrors(undefined)).toEqual([]);
  });

  it("rejects unreadable hexes, empty names and duplicate ids", () => {
    const errors = getBrandColorsValidationErrors([
      { ...buildColor({ hex: "nope", name: "Bad" }), id: "same" },
      { ...buildColor({ hex: "#ffc400", name: "  " }), id: "same" },
    ]);
    expect(errors.some((error) => error.includes("isn't a color we can read"))).toBe(true);
    expect(errors.some((error) => error.includes("needs a name"))).toBe(true);
    expect(errors.some((error) => error.includes("Duplicate brand color id"))).toBe(true);
  });

  it("rejects a palette over the cap", () => {
    const tooMany = Array.from({ length: MAX_BRAND_COLORS + 1 }, (_, index) =>
      buildColor({ hex: "#ffc400", name: `Color ${index}` }),
    ).map((color, index) => ({ ...color, id: `id-${index}` }));
    expect(getBrandColorsValidationErrors(tooMany)[0]).toContain(`${MAX_BRAND_COLORS} colors`);
  });

  it("bounds tone-of-voice descriptors, guidance and the avoid list", () => {
    const errors = getToneOfVoiceValidationErrors({
      descriptors: ["a", "b", "c", "d"],
      guidance: "x".repeat(500),
      avoid: Array.from({ length: 20 }, (_, index) => `word${index}`),
      origin: "user",
    });
    expect(errors).toHaveLength(3);
  });
});
