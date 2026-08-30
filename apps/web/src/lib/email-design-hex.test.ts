import { describe, expect, it } from "vitest";
import type { BrandColor } from "./brand-kit";
import { findHexTokens, resolveHexAgainstKit } from "./email-design-hex";

/*
  A minimal authored color — only the fields the resolver reads matter.
*/
function makeColor({ hex, name }: { hex: string; name: string }): BrandColor {
  return {
    id: `id-${hex}`,
    hex,
    name,
    category: "primary",
    orderIndex: 0,
    origin: "user",
  };
}

describe("findHexTokens", () => {
  it("matches a 6-digit hex and normalizes to lowercase #rrggbb", () => {
    const tokens = findHexTokens("Use #FFC400 for the button.");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ hex: "#ffc400", index: 4, length: 7 });
  });

  it("expands a 3-digit hex to its 6-digit form", () => {
    const tokens = findHexTokens("Background #abc please");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ hex: "#aabbcc", index: 11, length: 4 });
  });

  it("is case-insensitive across both forms", () => {
    expect(findHexTokens("#F0a")[0]!.hex).toBe("#ff00aa");
    expect(findHexTokens("#AbCdEf")[0]!.hex).toBe("#abcdef");
  });

  it("finds multiple hexes in one string with correct indices and lengths", () => {
    const text = "Primary #123456, accent #f0f, done.";
    const tokens = findHexTokens(text);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ hex: "#123456", index: 8, length: 7 });
    expect(tokens[1]).toMatchObject({ hex: "#ff00ff", index: 24, length: 4 });
    /*
      Indices point back into the ORIGINAL text — slicing must recover the
      exact written token, including its original 3-vs-6 length.
    */
    expect(text.slice(tokens[0]!.index, tokens[0]!.index + tokens[0]!.length)).toBe("#123456");
    expect(text.slice(tokens[1]!.index, tokens[1]!.index + tokens[1]!.length)).toBe("#f0f");
  });

  it("ignores hex-ish tokens that are the wrong length", () => {
    /*
      #12 (2 digits), #12345 (5), #aabbccdd (8) are none of the two CSS forms.
    */
    expect(findHexTokens("#12 #12345 #aabbccdd")).toHaveLength(0);
  });

  it("returns an empty list when there is no hex", () => {
    expect(findHexTokens("no colors here")).toEqual([]);
  });
});

describe("resolveHexAgainstKit", () => {
  const colors = [
    makeColor({ hex: "#ffc400", name: "Banana" }),
    makeColor({ hex: "#0b1120", name: "Midnight" }),
  ];

  it("matches a kit color and returns its name with isFromKit true", () => {
    const resolved = resolveHexAgainstKit({ hex: "#ffc400", colors });
    expect(resolved).toEqual({ hex: "#ffc400", kitColorName: "Banana", isFromKit: true });
  });

  it("matches case-insensitively against the kit's stored hex", () => {
    const resolved = resolveHexAgainstKit({ hex: "#FFC400", colors });
    expect(resolved.kitColorName).toBe("Banana");
    expect(resolved.isFromKit).toBe(true);
  });

  it("marks an unmatched hex as unmanaged (isFromKit false, no name)", () => {
    const resolved = resolveHexAgainstKit({ hex: "#123456", colors });
    expect(resolved).toEqual({ hex: "#123456", kitColorName: null, isFromKit: false });
  });

  it("treats an absent palette as no match", () => {
    const resolved = resolveHexAgainstKit({ hex: "#ffc400", colors: undefined });
    expect(resolved.isFromKit).toBe(false);
    expect(resolved.kitColorName).toBeNull();
  });
});
