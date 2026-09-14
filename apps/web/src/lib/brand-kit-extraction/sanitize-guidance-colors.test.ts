import { describe, expect, it } from "vitest";
import { sanitizeGuidanceColors } from "./sanitize-guidance-colors";

describe("sanitizeGuidanceColors", () => {
  it("keeps saved palette values and removes exact colors the model invented", () => {
    expect(
      sanitizeGuidanceColors({
        markdown:
          "Use #F0F0F0 for text, #0b0e14 for the canvas, and `#70757e` for borders.",
        allowedHexes: ["#f0f0f0", "#70757e"],
      }),
    ).toBe(
      "Use #f0f0f0 for text, a saved brand color for the canvas, and `#70757e` for borders.",
    );
  });

  it("does not mistake longer hexadecimal identifiers for color claims", () => {
    expect(
      sanitizeGuidanceColors({
        markdown: "Keep issue #12345678 and fragment #abcdefg unchanged.",
        allowedHexes: [],
      }),
    ).toBe("Keep issue #12345678 and fragment #abcdefg unchanged.");
  });
});
