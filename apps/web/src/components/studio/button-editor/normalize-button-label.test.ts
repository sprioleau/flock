import { describe, expect, it } from "vitest";
import { normalizeButtonLabel } from "./normalize-button-label";

describe("normalizeButtonLabel", () => {
  it("passes a plain label through", () => {
    expect(normalizeButtonLabel("Get started")).toBe("Get started");
  });

  it("flattens multiline pastes to single spaces", () => {
    expect(normalizeButtonLabel("Get\nstarted now")).toBe("Get started now");
    expect(normalizeButtonLabel("Line one Line two")).toBe("Line one Line two");
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(normalizeButtonLabel("  Buy   now \t ")).toBe("Buy now");
  });

  it('returns "" for effectively-empty input (caller keeps the previous label)', () => {
    expect(normalizeButtonLabel("   \n\t ")).toBe("");
    expect(normalizeButtonLabel("")).toBe("");
  });
});
