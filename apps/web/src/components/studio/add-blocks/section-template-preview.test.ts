import { describe, expect, it } from "vitest";
import { inflate, ROOT_BLOCK_ID, SECTION_TEMPLATES } from "@flock/email-sdk";
import { buildSectionTemplatePreviewDoc } from "./SectionTemplatePreview";

describe("buildSectionTemplatePreviewDoc", () => {
  it("instantiates EVERY catalog template into a well-formed one-section document", () => {
    for (const template of SECTION_TEMPLATES) {
      const doc = buildSectionTemplatePreviewDoc({ templateId: template.id, globals: undefined });
      expect(doc).not.toBeNull();
      const root = doc![ROOT_BLOCK_ID];
      expect(root?.type === "root" && root.childrenIds).toHaveLength(1);
      /*
        inflate walks parentId/childrenIds integrity — a broken subtree throws.
      */
      const tree = inflate(doc!);
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0]!.block.type).toBe("section");
    }
  });

  it("carries the caller's globals onto the preview root (theme parity)", () => {
    const globals = { contentBackgroundColor: "#112233" };
    const doc = buildSectionTemplatePreviewDoc({ templateId: "hero", globals });
    const root = doc![ROOT_BLOCK_ID];
    expect(root?.type === "root" && root.properties.globals).toEqual(globals);
  });

  /*
    THE COST OF THE OTHER HALF OF THE FABRICATION FIX, PINNED.

    A hero's call to action and a footer's postal address carry no default any
    more: a draft only gets them when the caller supplies them, so nothing is
    invented into a sent email. A THUMBNAIL is the one place that would be the
    wrong answer — a browsing user picking a hero should see the hero,
    button and all — so the gallery, and only the gallery, builds from the
    template's sample preview values.
  */
  it("still shows a hero's button and a footer's address line, so the catalog is not misrepresented", () => {
    const hero = buildSectionTemplatePreviewDoc({ templateId: "hero", globals: undefined });
    expect(Object.values(hero!).some((block) => block.type === "button")).toBe(true);

    const footer = buildSectionTemplatePreviewDoc({ templateId: "footer", globals: undefined });
    expect(JSON.stringify(footer)).toContain("123 Market Street");
  });

  it("returns null for an unknown template id", () => {
    expect(
      buildSectionTemplatePreviewDoc({ templateId: "not-a-template", globals: undefined }),
    ).toBeNull();
  });
});
