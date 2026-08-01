import { describe, expect, it } from "vitest";
import { computeNextDraftName, computeVariationDraftName } from "./draft-naming";

describe("computeVariationDraftName", () => {
  it("appends the marker to an unmarked source name", () => {
    expect(
      computeVariationDraftName({ sourceName: "Draft 1", existingNames: ["Draft 1"] }),
    ).toBe("Draft 1 (variation)");
  });

  it("increments instead of stacking on an already-marked source", () => {
    expect(
      computeVariationDraftName({
        sourceName: "Draft 1 (variation)",
        existingNames: ["Draft 1", "Draft 1 (variation)"],
      }),
    ).toBe("Draft 1 (variation 2)");
  });

  it("keeps counting from a numbered marker", () => {
    expect(
      computeVariationDraftName({
        sourceName: "Draft 1 (variation 2)",
        existingNames: ["Draft 1 (variation 2)"],
      }),
    ).toBe("Draft 1 (variation 3)");
  });

  it("never produces a stacked '(variation) (variation)' name", () => {
    const name = computeVariationDraftName({
      sourceName: "Draft 1 (variation)",
      existingNames: [],
    });
    expect(name.match(/\(variation/g)).toHaveLength(1);
  });

  it("appends the marker once to a renamed draft", () => {
    expect(
      computeVariationDraftName({ sourceName: "Spring promo", existingNames: ["Spring promo"] }),
    ).toBe("Spring promo (variation)");
  });

  it("dedupes against existing canvas names by bumping the ordinal", () => {
    expect(
      computeVariationDraftName({
        sourceName: "Draft 1",
        existingNames: ["Draft 1", "Draft 1 (variation)"],
      }),
    ).toBe("Draft 1 (variation 2)");
    expect(
      computeVariationDraftName({
        sourceName: "Draft 1",
        existingNames: ["Draft 1", "Draft 1 (variation)", "Draft 1 (variation 2)"],
      }),
    ).toBe("Draft 1 (variation 3)");
  });

  it("dedupes when continuing from a marked source too", () => {
    expect(
      computeVariationDraftName({
        sourceName: "Draft 1 (variation)",
        existingNames: ["Draft 1", "Draft 1 (variation)", "Draft 1 (variation 2)"],
      }),
    ).toBe("Draft 1 (variation 3)");
  });

  it("treats a hand-cased marker as the same marker", () => {
    expect(
      computeVariationDraftName({ sourceName: "Draft 1 (Variation 2)", existingNames: [] }),
    ).toBe("Draft 1 (variation 3)");
  });
});

describe("computeNextDraftName", () => {
  it("names the first drafts sequentially", () => {
    expect(computeNextDraftName({ existingNames: [] })).toBe("Draft 1");
    expect(computeNextDraftName({ existingNames: ["Draft 1"] })).toBe("Draft 2");
    expect(computeNextDraftName({ existingNames: ["Draft 1", "Draft 2"] })).toBe("Draft 3");
  });

  it("fills the smallest gap left by renames/deletes", () => {
    expect(computeNextDraftName({ existingNames: ["Draft 1", "Draft 3"] })).toBe("Draft 2");
  });

  it("does not let non-'Draft N' names inflate the numbering", () => {
    expect(computeNextDraftName({ existingNames: ["Welcome email", "Draft 2"] })).toBe(
      "Draft 1",
    );
    expect(
      computeNextDraftName({ existingNames: ["Draft 1", "Draft 1 (variation)"] }),
    ).toBe("Draft 2");
  });
});
