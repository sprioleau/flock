import { describe, expect, it } from "vitest";
import { EMAIL_SAFE_FONT_OPTIONS } from "@/components/studio/text-editor/email-safe-fonts";
import { MOCK_BRAND_KIT } from "./brand-kit";
import {
  applyBrandFontsToVariations,
  getBrandFontsValidationErrors,
  isEmailSafeFontStack,
} from "./brand-kit-fonts";

/*
  Editable brand fonts (brand-kit-v2 §1): the two rules that make the feature
  real — a brand font is always one of the email-safe stacks, and changing
  one reaches the kit's themes (otherwise the edit changes nothing anybody
  can see).
*/

const GEORGIA = "Georgia, 'Times New Roman', serif";
const VERDANA = "Verdana, Geneva, sans-serif";

describe("getBrandFontsValidationErrors — selection, never free text", () => {
  it("accepts a pair of email-safe stacks", () => {
    expect(getBrandFontsValidationErrors({ heading: GEORGIA, body: VERDANA })).toEqual([]);
  });

  it("accepts every option the dropdown offers", () => {
    for (const option of EMAIL_SAFE_FONT_OPTIONS) {
      expect(
        getBrandFontsValidationErrors({ heading: option.value, body: option.value }),
      ).toEqual([]);
    }
  });

  it("rejects a font no mail client ships, in words a person can act on", () => {
    const errors = getBrandFontsValidationErrors({
      heading: "Comic Sans MS, cursive",
      body: VERDANA,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/heading font isn't one we can send in email/);
  });

  it("rejects an empty stack per role", () => {
    expect(getBrandFontsValidationErrors({ heading: "", body: "  " })).toEqual([
      "Pick a heading font.",
      "Pick a body font.",
    ]);
  });

  it("knows which stacks are on the list", () => {
    expect(isEmailSafeFontStack(GEORGIA)).toBe(true);
    expect(isEmailSafeFontStack("Georgia, serif")).toBe(false); /* near-miss, not the same stack */
  });
});

describe("applyBrandFontsToVariations — a font edit reaches the themes", () => {
  it("re-fonts every heading, paragraph and button role in every variation", () => {
    const variations = applyBrandFontsToVariations({
      variations: MOCK_BRAND_KIT.variations,
      fonts: { heading: GEORGIA, body: VERDANA },
    });
    expect(variations).toHaveLength(MOCK_BRAND_KIT.variations.length);
    for (const variation of variations) {
      expect(variation.globals.heading1FontFamily).toBe(GEORGIA);
      expect(variation.globals.heading2FontFamily).toBe(GEORGIA);
      expect(variation.globals.heading3FontFamily).toBe(GEORGIA);
      expect(variation.globals.paragraphFontFamily).toBe(VERDANA);
      expect(variation.globals.buttonFontFamily).toBe(VERDANA);
    }
  });

  it("recolors and reflows nothing — only the font keys move", () => {
    const [before] = MOCK_BRAND_KIT.variations;
    const [after] = applyBrandFontsToVariations({
      variations: [before!],
      fonts: { heading: GEORGIA, body: VERDANA },
    });
    expect(after!.id).toBe(before!.id);
    expect(after!.name).toBe(before!.name);
    expect(after!.globals.contentBackgroundColor).toBe(before!.globals.contentBackgroundColor);
    expect(after!.globals.paragraphTextColor).toBe(before!.globals.paragraphTextColor);
    expect(after!.globals.contentWidth).toBe(before!.globals.contentWidth);
    expect(after!.globals.baseSpacing).toBe(before!.globals.baseSpacing);
  });

  it("leaves the source variations untouched (no in-place mutation)", () => {
    const original = MOCK_BRAND_KIT.variations[0]!.globals.heading1FontFamily;
    applyBrandFontsToVariations({
      variations: MOCK_BRAND_KIT.variations,
      fonts: { heading: GEORGIA, body: VERDANA },
    });
    expect(MOCK_BRAND_KIT.variations[0]!.globals.heading1FontFamily).toBe(original);
  });
});
