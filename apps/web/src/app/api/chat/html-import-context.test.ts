import { describe, expect, it } from "vitest";
import { formatHtmlImportContextLine } from "./html-import-context";

describe("formatHtmlImportContextLine", () => {
  it("gives refinement turns the bounded importer losses without including source HTML", () => {
    const line = formatHtmlImportContextLine({
      importerVersion: "1",
      warnings: [
        { code: "style_removed", detail: "The source contained a style block." },
        { code: "relative_url", detail: "A relative image URL was omitted." },
      ],
      unsupportedFeatures: ["style", "responsive media query"],
    });

    expect(line).toContain("[HTML IMPORT CONTEXT");
    expect(line).toContain("validated from HTML");
    expect(line).toContain("style_removed: The source contained a style block.");
    expect(line).toContain("Unsupported constructs: style, responsive media query");
    expect(line).toContain("normal editor tools");
    expect(line).not.toContain("sanitizedHtml");
  });

  it("bounds report text before it can become prompt context", () => {
    const line = formatHtmlImportContextLine({
      importerVersion: "1",
      warnings: Array.from({ length: 20 }, (_, index) => ({
        code: `warning-${index}`,
        detail: "x".repeat(500),
      })),
      unsupportedFeatures: Array.from({ length: 20 }, (_, index) => `feature-${index}`),
    });

    expect(line).toContain("warning-11");
    expect(line).not.toContain("warning-12");
    expect(line).toContain("feature-11");
    expect(line).not.toContain("feature-12");
    expect(line).not.toContain("x".repeat(241));
  });
});
