import { describe, expect, it } from "vitest";
import type { EmailDocument } from "@tandem/email-sdk";
import { buildSocialFillUpdates, hasSocialRow } from "./brand-kit-social-fill";
import type { BrandSocialLink } from "./social-links";

/** A minimal footer-ish section: social text row + unsubscribe link block. */
function buildFixtureDoc(): EmailDocument {
  const socialTextDoc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "X",
            marks: [
              { type: "textStyle", attrs: { fontSize: "12px" } },
              { type: "link", attrs: { href: "https://x.com/oldhandle" } },
            ],
          },
          { type: "text", text: " | ", marks: [{ type: "textStyle", attrs: { fontSize: "12px" } }] },
          {
            type: "text",
            text: "Instagram",
            marks: [
              { type: "textStyle", attrs: { fontSize: "12px" } },
              { type: "link", attrs: { href: "https://instagram.com/oldhandle" } },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Acme Inc. · 123 Market St" }],
      },
    ],
  };
  return {
    root: { id: "root", type: "root", parentId: null, childrenIds: ["sec_f1"], properties: {} },
    sec_f1: { id: "sec_f1", type: "section", parentId: "root", childrenIds: ["txt_s1", "lnk_u1", "lnk_g1"], properties: {} },
    txt_s1: { id: "txt_s1", type: "text", parentId: "sec_f1", childrenIds: [], properties: { text: socialTextDoc } },
    lnk_u1: { id: "lnk_u1", type: "link", parentId: "sec_f1", childrenIds: [], properties: { text: "Unsubscribe", href: "*|UNSUB|*" } },
    lnk_g1: { id: "lnk_g1", type: "link", parentId: "sec_f1", childrenIds: [], properties: { text: "GitHub", href: "https://github.com/old-org" } },
  } as unknown as EmailDocument;
}

const KIT_LINKS: BrandSocialLink[] = [
  { platform: "x", url: "https://x.com/acme" },
  { platform: "facebook", url: "https://facebook.com/acme" },
  { platform: "github", url: "https://github.com/acme" },
];

describe("hasSocialRow", () => {
  it("detects social link runs and social link blocks in the section", () => {
    expect(hasSocialRow({ doc: buildFixtureDoc(), sectionId: "sec_f1" })).toBe(true);
  });

  it("is false for a section without social links", () => {
    const doc = buildFixtureDoc();
    // Strip the social text block and the social link block.
    (doc.sec_f1 as { childrenIds: string[] }).childrenIds = ["lnk_u1"];
    expect(hasSocialRow({ doc, sectionId: "sec_f1" })).toBe(false);
  });
});

describe("buildSocialFillUpdates", () => {
  it("rebuilds the social paragraph from the kit, keeping separator + styling marks", () => {
    const updates = buildSocialFillUpdates({
      doc: buildFixtureDoc(),
      sectionId: "sec_f1",
      socialLinks: KIT_LINKS,
    });
    const textUpdate = updates.find(({ blockId }) => blockId === "txt_s1");
    expect(textUpdate).toBeDefined();
    const nextDoc = textUpdate?.properties.text as {
      content: { type: string; content?: { text?: string; marks?: { type: string; attrs?: { href?: string } }[] }[] }[];
    };
    const socialRuns = nextDoc.content[0].content ?? [];
    // 3 kit links joined by 2 separators = 5 runs.
    expect(socialRuns.map((run) => run.text)).toEqual(["X", " | ", "Facebook", " | ", "GitHub"]);
    // Links point at the kit URLs; styling mark carried over.
    const firstRun = socialRuns[0];
    expect(firstRun.marks?.some((mark) => mark.type === "link" && mark.attrs?.href === "https://x.com/acme")).toBe(true);
    expect(firstRun.marks?.some((mark) => mark.type === "textStyle")).toBe(true);
    // The company-line paragraph is untouched.
    expect(nextDoc.content[1].content?.[0].text).toBe("Acme Inc. · 123 Market St");
  });

  it("updates platform-matched link blocks and leaves the unsubscribe link alone", () => {
    const updates = buildSocialFillUpdates({
      doc: buildFixtureDoc(),
      sectionId: "sec_f1",
      socialLinks: KIT_LINKS,
    });
    const githubUpdate = updates.find(({ blockId }) => blockId === "lnk_g1");
    expect(githubUpdate?.properties).toEqual({ href: "https://github.com/acme", text: "GitHub" });
    expect(updates.some(({ blockId }) => blockId === "lnk_u1")).toBe(false);
  });

  it("returns [] when the kit has no links or nothing differs", () => {
    expect(
      buildSocialFillUpdates({ doc: buildFixtureDoc(), sectionId: "sec_f1", socialLinks: [] }),
    ).toEqual([]);
  });
});
