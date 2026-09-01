import { describe, expect, it } from "vitest";
import { getBrandKitValidationErrors, getVariationContrastPairs, MIN_THEME_CONTRAST_RATIO } from "./brand-kit";
import { getStarterArchetypes } from "./brand-kit-archetypes";
import { brandKitSchema } from "./brand-kit-extraction/generate-brand-kit";

/*
  The three owner-designed starter archetypes are what the brand-first
  onboarding gate saves as a REAL, editable brand kit when a scrape fails or
  the person has no website. Two things matter more than any other:

  1. THEY ARE ACTUALLY SAVEABLE — `saveBrandKit` rejects anything that fails
     `getBrandKitValidationErrors` (the real persistence gate; see
     convex/brandKits.ts `assertBrandKitIsValid`), so a kit that fails it
     here would 500 for every single person who picks that archetype.
  2. EVERY COLOR CAME FROM THE SHARED CONTRAST-REPAIR PIPELINE, not a
     hand-picked hex — `getVariationContrastPairs` is asserted directly, per
     the owner's spec, on top of the whole-kit gate above.

  `brandKitSchema` (generate-brand-kit.ts) is the SCRAPE route's wire
  contract, which additionally requires 3-4 variations per kit — a quality
  bar on what the scrape must produce, not a floor `saveBrandKit` enforces
  (see brand-kit-archetypes.ts's file comment). These archetypes ship with
  the owner-specified ONE variation each, so shape is checked against the
  schema's own field-level sub-schemas (colors, and one variation's shape)
  rather than the whole-kit schema, which would fail every archetype on
  variation COUNT alone regardless of shape correctness.
*/

const EXPECTED_ARCHETYPE_NAMES = ["Daylight", "Gilded", "Nocturne"];

describe("getStarterArchetypes", () => {
  it("returns exactly the three named, owner-specified archetypes", () => {
    const archetypes = getStarterArchetypes();
    expect(archetypes.map((archetype) => archetype.name)).toEqual(EXPECTED_ARCHETYPE_NAMES);
  });

  it("gives every archetype exactly one named theme variation", () => {
    for (const archetype of getStarterArchetypes()) {
      expect(archetype.variations).toHaveLength(1);
      expect(archetype.variations[0]?.name).toBe(archetype.name);
    }
  });

  it("passes the real saveBrandKit gate for every archetype (getBrandKitValidationErrors)", () => {
    for (const archetype of getStarterArchetypes()) {
      expect(getBrandKitValidationErrors(archetype)).toEqual([]);
    }
  });

  it("fails the same gate once a variation's contrast is broken — the check is not vacuous", () => {
    const [daylight] = getStarterArchetypes();
    if (daylight === undefined) {
      throw new Error("expected at least one archetype");
    }
    const brokenVariation = daylight.variations[0];
    if (brokenVariation === undefined) {
      throw new Error("expected a variation");
    }
    const broken = {
      ...daylight,
      variations: [
        {
          ...brokenVariation,
          globals: { ...brokenVariation.globals, paragraphTextColor: "#fdfdfd" },
        },
      ],
    };
    expect(getBrandKitValidationErrors(broken).length).toBeGreaterThan(0);
  });

  it("clears WCAG-AA on every guarded pairing, for every archetype", () => {
    for (const archetype of getStarterArchetypes()) {
      for (const variation of archetype.variations) {
        for (const pair of getVariationContrastPairs(variation)) {
          expect(pair.ratio).not.toBeNull();
          expect(pair.ratio ?? 0).toBeGreaterThanOrEqual(MIN_THEME_CONTRAST_RATIO);
        }
      }
    }
  });

  it("shapes every color exactly like a saved kit's palette (brandKitSchema.shape.colors)", () => {
    const colorsSchema = brandKitSchema.shape.colors;
    for (const archetype of getStarterArchetypes()) {
      const result = colorsSchema.safeParse(archetype.colors);
      expect(result.success).toBe(true);
    }
  });

  it("shapes every variation exactly like a saved kit's theme (brandKitSchema.shape.variations.element)", () => {
    const variationSchema = brandKitSchema.shape.variations.element;
    for (const archetype of getStarterArchetypes()) {
      for (const variation of archetype.variations) {
        const result = variationSchema.safeParse(variation);
        expect(result.success).toBe(true);
      }
    }
  });

  it("shapes the rest of the kit like a saved kit (brandKitSchema minus the scrape-only variation count)", () => {
    const restSchema = brandKitSchema.omit({ variations: true });
    for (const archetype of getStarterArchetypes()) {
      const { variations, ...rest } = archetype;
      void variations;
      const result = restSchema.safeParse(rest);
      expect(result.success).toBe(true);
    }
  });

  it("resolves font labels to the real email-safe stacks, not the bare label", () => {
    const [daylight, gilded] = getStarterArchetypes();
    expect(daylight?.fonts.heading).toBe("'Trebuchet MS', Helvetica, sans-serif");
    expect(daylight?.fonts.body).toBe("Helvetica, Arial, sans-serif");
    expect(gilded?.fonts.heading).toBe("Georgia, 'Times New Roman', serif");
  });

  it("maps each archetype's button shape to the matching radius", () => {
    const [daylight, gilded, nocturne] = getStarterArchetypes();
    expect(daylight?.variations[0]?.globals.buttonBorderRadius).toBe(6);
    expect(gilded?.variations[0]?.globals.buttonBorderRadius).toBe(0);
    expect(nocturne?.variations[0]?.globals.buttonBorderRadius).toBe(6);
  });

  it("builds fresh objects on every call — a caller mutating one call's result can't corrupt the next", () => {
    const first = getStarterArchetypes();
    const second = getStarterArchetypes();
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.colors).not.toBe(second[0]?.colors);
  });
});
