import { describe, expect, it } from "vitest";
import { getRelativeLuminance } from "./brand-kit-extraction/color-utils";
import { getContrastRatio } from "./brand-kit";

/**
 * CHARACTERIZATION of the WCAG contrast primitive.
 *
 * `getContrastRatio` is the public API three unrelated consumers measure
 * against — brand-kit validation, the theme contrast repair pass, and the
 * `low-contrast-edit` critique rule — and it delegates to the single
 * {@link getRelativeLuminance} in brand-kit-extraction/color-utils.ts. These
 * numbers are pinned to full precision on purpose: a nudged coefficient or a
 * moved gamma knee has to fail here, not silently reclassify every stored
 * theme.
 */
describe("getContrastRatio", () => {
  /*
    The sRGB coefficients (0.2126 / 0.7152 / 0.0722) — black on white is
    exactly 21 only when all three sum to 1.
  */
  it("returns exactly 21 for black on white, in every accepted hex spelling", () => {
    expect(getContrastRatio({ foreground: "#000000", background: "#ffffff" })).toBe(21);
    expect(getContrastRatio({ foreground: "#000", background: "#fff" })).toBe(21);
    expect(getContrastRatio({ foreground: "#FFF", background: "#000" })).toBe(21);
    expect(getContrastRatio({ foreground: "  #ffffff  ", background: "#000000" })).toBe(21);
    expect(getContrastRatio({ foreground: "ffffff", background: "000000" })).toBe(21);
  });

  /*
    Weighting per channel: an all-green pair separates the coefficients.
  */
  it("weights the channels unequally (green dominates red dominates blue)", () => {
    const red = getContrastRatio({ foreground: "#ff0000", background: "#000000" })!;
    const green = getContrastRatio({ foreground: "#00ff00", background: "#000000" })!;
    const blue = getContrastRatio({ foreground: "#0000ff", background: "#000000" })!;
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(green).toBeCloseTo(15.303999999999998, 12);
    expect(red).toBeCloseTo(5.252, 12);
    expect(blue).toBeCloseTo(2.444, 12);
  });

  /*
    The 0.03928 gamma knee. #0a0a0a's channels (10/255 = 0.03921…) take the
    LINEAR branch; #0b0b0b's (11/255 = 0.04313…) take the power branch. Moving
    the threshold moves one of these two ratios.
  */
  it("switches branches at the 0.03928 gamma knee", () => {
    expect(getContrastRatio({ foreground: "#ffffff", background: "#0a0a0a" })).toBeCloseTo(
      19.79814571052481,
      12,
    );
    expect(getContrastRatio({ foreground: "#ffffff", background: "#0b0b0b" })).toBeCloseTo(
      19.682627652657427,
      12,
    );
  });

  /*
    Real theme colors, including a pair that sits just UNDER the 4.5 AA bar.
  */
  it("pins the ratios the AA threshold is judged against", () => {
    expect(getContrastRatio({ foreground: "#3730a3", background: "#ffffff" })).toBeCloseTo(
      9.933329874512658,
      12,
    );
    expect(getContrastRatio({ foreground: "#38bdf8", background: "#0b1120" })).toBeCloseTo(
      8.789519324585777,
      12,
    );
    /*
      4.478… — mid gray on white FAILS AA. The bar is not a rounding artifact.
    */
    expect(getContrastRatio({ foreground: "#777777", background: "#ffffff" })).toBeCloseTo(
      4.478089453577214,
      12,
    );
    expect(getContrastRatio({ foreground: "#777777", background: "#ffffff" })!).toBeLessThan(4.5);
  });

  /*
    Order-independence: the formula divides lighter by darker, not fg by bg.
  */
  it("is symmetric in foreground and background", () => {
    expect(getContrastRatio({ foreground: "#3730a3", background: "#ffffff" })).toBe(
      getContrastRatio({ foreground: "#ffffff", background: "#3730a3" }),
    );
  });

  /*
    THE NEGATIVE CASE. A color the parser cannot read must come back `null`,
    never a number: every consumer branches on null to stay silent rather than
    report a fabricated ratio (the critique rule's whole contract).
  */
  it("returns null — not a number — for anything that is not parseable hex", () => {
    const unparseable = [
      "rebeccapurple",
      "rgb(0,0,0)",
      "hsl(0, 0%, 0%)",
      "#12345",
      "#ggg",
      "#",
      "",
      "   ",
    ];
    for (const color of unparseable) {
      expect(getContrastRatio({ foreground: color, background: "#ffffff" })).toBeNull();
      expect(getContrastRatio({ foreground: "#ffffff", background: color })).toBeNull();
    }
  });
});

/*
  The single source of truth these ratios are built from. Pinned here too so a
  change to the shared helper fails at the helper, not only three layers up.
*/
describe("getRelativeLuminance (the shared primitive)", () => {
  it("pins the luminance of the endpoints and a mid gray", () => {
    expect(getRelativeLuminance("#000000")).toBe(0);
    expect(getRelativeLuminance("#ffffff")).toBe(1);
    expect(getRelativeLuminance("#777777")).toBeCloseTo(0.184474994500441, 12);
    expect(getRelativeLuminance("#3730a3")).toBeCloseTo(0.05570473479332773, 12);
  });

  it("reads short hex, uppercase and surrounding whitespace identically", () => {
    expect(getRelativeLuminance("#fff")).toBe(1);
    expect(getRelativeLuminance("#FFF")).toBe(1);
    expect(getRelativeLuminance("  #ffffff  ")).toBe(1);
    expect(getRelativeLuminance("ffffff")).toBe(1);
    expect(getRelativeLuminance("#AABBCC")).toBe(getRelativeLuminance("#abc"));
  });

  it("returns null for non-hex input", () => {
    expect(getRelativeLuminance("rebeccapurple")).toBeNull();
    expect(getRelativeLuminance("rgb(0,0,0)")).toBeNull();
    expect(getRelativeLuminance("#12345")).toBeNull();
  });
});
