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
      // inflate walks parentId/childrenIds integrity — a broken subtree throws.
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

  it("returns null for an unknown template id", () => {
    expect(
      buildSectionTemplatePreviewDoc({ templateId: "not-a-template", globals: undefined }),
    ).toBeNull();
  });
});
