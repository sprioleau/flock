import { describe, expect, it } from "vitest";
import { formatBrandSocialContextLine } from "./brand-context";
import { formatBrandEmailDesignContextLine } from "@/lib/brand-email-design";
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

  it("rides the email-design guidance on the FRESH layer, never the cached prefix", () => {
    /*
      The email-design block is composed exactly like the shipped brand line:
      it is one entry in buildBrandContextBlock's assembled brandContextLine,
      so it must land in the per-request documentContext and leave the cached
      static prefix byte-identical — mirroring how system-context pins the
      design law out of SYSTEM_STATIC.
    */
    const emailDesignLine = formatBrandEmailDesignContextLine({
      brandName: "CNN",
      emailDesignDoc: { markdown: "# Layout\n\nSingle column, generous whitespace.", origin: "user" },
    })!;
    const withLine = buildSystemContext({ doc, brandContextLine: emailDesignLine });
    const withoutLine = buildSystemContext({ doc });
    expect(withLine.documentContext).toContain("<brand-email-design>");
    expect(withLine.documentContext).toContain("Single column, generous whitespace.");
    expect(withoutLine.documentContext).not.toContain("<brand-email-design>");
    /*
      Not one byte of the design block leaks into the cached instruction prefix.
    */
    expect(withLine.staticInstructions).toBe(withoutLine.staticInstructions);
    expect(withLine.staticInstructions).not.toContain("<brand-email-design>");
    expect(withLine.staticInstructions).not.toContain("Single column, generous whitespace.");
  });
});
