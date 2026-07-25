import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_STYLES, globalStylesSchema } from "./globals";

describe("globalStylesSchema", () => {
  it("accepts an empty object (all renderer defaults)", () => {
    expect(globalStylesSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial theme", () => {
    const theme = {
      emailBackgroundColor: "#0b0c10",
      contentBackgroundColor: "#1f2833",
      buttonBackgroundColor: "#66fcf1",
      buttonTextColor: "#0b0c10",
      heading1TextAlign: "center" as const,
    };
    expect(globalStylesSchema.safeParse(theme).success).toBe(true);
  });

  it("accepts the full DEFAULT_GLOBAL_STYLES payload (defaults stay schema-valid)", () => {
    const result = globalStylesSchema.safeParse(DEFAULT_GLOBAL_STYLES);
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys (Nuni fields outside our block set)", () => {
    expect(globalStylesSchema.safeParse({ palette: ["#fff"] }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ heading4FontFamily: "helvetica" }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ backgroundColor: "#fff" }).success).toBe(false);
  });

  it("rejects invalid text alignment values", () => {
    expect(globalStylesSchema.safeParse({ paragraphTextAlign: "justify" }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ heading2TextAlign: "middle" }).success).toBe(false);
  });

  it("rejects out-of-range or non-integer contentWidth", () => {
    expect(globalStylesSchema.safeParse({ contentWidth: 200 }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ contentWidth: 6000 }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ contentWidth: 600.5 }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ contentWidth: 600 }).success).toBe(true);
  });

  it("rejects negative numeric values", () => {
    expect(globalStylesSchema.safeParse({ buttonBorderRadius: -1 }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ baseSpacing: -4 }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ buttonVerticalPadding: -2 }).success).toBe(false);
  });

  it("rejects empty-string colors and fonts", () => {
    expect(globalStylesSchema.safeParse({ emailBackgroundColor: "" }).success).toBe(false);
    expect(globalStylesSchema.safeParse({ paragraphFontFamily: "" }).success).toBe(false);
  });
});

describe("DEFAULT_GLOBAL_STYLES", () => {
  it("documents a default for every schema field", () => {
    const schemaKeys = Object.keys(globalStylesSchema.shape).sort();
    const defaultKeys = Object.keys(DEFAULT_GLOBAL_STYLES).sort();
    expect(defaultKeys).toEqual(schemaKeys);
  });
});
