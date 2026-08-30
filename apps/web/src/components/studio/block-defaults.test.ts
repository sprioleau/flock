import { describe, expect, it } from "vitest";
import {
  BLOCK_ID_PREFIXES,
  blockSchema,
  createSampleDocument,
  LEAF_BLOCK_TYPES,
} from "@flock/email-sdk";
import {
  createDefaultLeafBlock,
  DEFAULT_DIVIDER_PADDING_PX,
  DEFAULT_HEADING_LEVEL,
  DEFAULT_IMAGE_PADDING_PX,
  DEFAULT_IMAGE_WIDTH_RATIO,
  getDefaultImageWidth,
} from "./block-defaults";

const doc = createSampleDocument();
const parentId = "sec_a1b2";

describe("createDefaultLeafBlock", () => {
  it.each(LEAF_BLOCK_TYPES)("%s factory output validates against blockSchema", (type) => {
    const block = createDefaultLeafBlock({
      type,
      id: `${BLOCK_ID_PREFIXES[type]}_zzzz`,
      parentId,
      doc,
    });
    const parsed = blockSchema.safeParse(block);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    expect(block.type).toBe(type);
    expect(block.childrenIds).toEqual([]);
  });

  it('heading variant → a TEXT block whose doc is a single heading node (owner decision: no separate heading type)', () => {
    const block = createDefaultLeafBlock({
      type: "text",
      variant: "heading",
      id: "txt_zzzz",
      parentId,
      doc,
    });
    expect(block.type).toBe("text");
    if (block.type !== "text") return;
    expect(block.properties.text.content).toHaveLength(1);
    const [node] = block.properties.text.content;
    expect(node).toMatchObject({
      type: "heading",
      attrs: { level: DEFAULT_HEADING_LEVEL },
    });
    expect(blockSchema.safeParse(block).success).toBe(true);
  });

  it("image defaults: 60% of content width, 12px padding on all sides (owner defaults 2026-07-31)", () => {
    expect(DEFAULT_IMAGE_WIDTH_RATIO).toBe(0.6);
    expect(DEFAULT_IMAGE_PADDING_PX).toBe(12);
    const block = createDefaultLeafBlock({ type: "image", id: "img_zzzz", parentId, doc });
    if (block.type !== "image") throw new Error("expected image");
    /*
      Sample doc content width is 600 → 360.
    */
    expect(block.properties.width).toBe(getDefaultImageWidth(doc));
    expect(getDefaultImageWidth(doc)).toBe(360);
    expect(block.properties.paddingTop).toBe(12);
    expect(block.properties.paddingBottom).toBe(12);
    expect(block.properties.paddingLeft).toBe(12);
    expect(block.properties.paddingRight).toBe(12);
  });

  it("divider defaults: 24px padding above and below the line", () => {
    expect(DEFAULT_DIVIDER_PADDING_PX).toBe(24);
    const block = createDefaultLeafBlock({ type: "divider", id: "div_zzzz", parentId, doc });
    if (block.type !== "divider") throw new Error("expected divider");
    expect(block.properties.paddingTop).toBe(24);
    expect(block.properties.paddingBottom).toBe(24);
  });

  it("button defaults: center-aligned", () => {
    const block = createDefaultLeafBlock({ type: "button", id: "btn_zzzz", parentId, doc });
    if (block.type !== "button") throw new Error("expected button");
    expect(block.properties.align).toBe("center");
  });

  it("spacer defaults: 24px height and nothing else", () => {
    const block = createDefaultLeafBlock({ type: "spacer", id: "spc_zzzz", parentId, doc });
    if (block.type !== "spacer") throw new Error("expected spacer");
    expect(block.properties).toEqual({ height: 24 });
  });

  it("link and code defaults are schema-valid with required content present", () => {
    const link = createDefaultLeafBlock({ type: "link", id: "lnk_zzzz", parentId, doc });
    if (link.type !== "link") throw new Error("expected link");
    expect(link.properties.text.length).toBeGreaterThan(0);
    expect(link.properties.href).toMatch(/^https:/);

    const code = createDefaultLeafBlock({ type: "code", id: "cod_zzzz", parentId, doc });
    if (code.type !== "code") throw new Error("expected code");
    expect(code.properties.code.length).toBeGreaterThan(0);
    expect(code.properties.language).toBe("javascript");
  });
});
