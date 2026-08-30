import { describe, expect, it } from "vitest";
import { formatBrandSocialContextLine } from "./brand-context";
import { buildSystemContext } from "./system-context";

describe("formatBrandSocialContextLine", () => {
  it("formats a compact platform=url line", () => {
    const line = formatBrandSocialContextLine({
      brandName: "CNN",
      socialLinks: [
        { platform: "x", url: "https://x.com/cnn" },
        { platform: "instagram", url: "https://instagram.com/cnn" },
      ],
    });
    expect(line).toBe(
      'Brand social links (from the user\'s saved brand kit "CNN" — use these exact URLs when adding or updating social/footer links): x=https://x.com/cnn, instagram=https://instagram.com/cnn',
    );
  });

  it("returns null when the kit has no links", () => {
    expect(formatBrandSocialContextLine({ brandName: "CNN", socialLinks: [] })).toBeNull();
  });
});

describe("buildSystemContext brand line placement", () => {
  const doc = {
    root: { id: "root", type: "root", parentId: null, childrenIds: [], properties: {} },
  } as never;

  it("appends the brand line to the FRESH document context only", () => {
    const withLine = buildSystemContext({ doc, brandContextLine: "Brand social links: x=https://x.com/cnn" });
    const withoutLine = buildSystemContext({ doc });
    expect(withLine.documentContext).toContain("Brand social links: x=https://x.com/cnn");
    expect(withoutLine.documentContext).not.toContain("Brand social links");
    /*
      The cached static prefix must be byte-identical with and without it.
    */
    expect(withLine.staticInstructions).toBe(withoutLine.staticInstructions);
    expect(withLine.staticInstructions).not.toContain("x.com/cnn");
  });
});
