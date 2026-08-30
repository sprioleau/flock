import {
  addBlockOperationSchema,
  addSectionOperationSchema,
  placeBlockBesideOperationSchema,
  restoreBlocksOperationSchema,
  scaffoldSectionInputSchema,
  updateBlockPropertiesOperationSchema,
  updateTextOperationSchema,
} from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { normalizeToolInput } from "./tool-input-normalizer";

/*
  Regression for the live conformance miss (owner repro, production): the
  model called addSection and sent a text block with its rich-text doc at the
  block's TOP LEVEL, no `childrenIds`, no `properties`, and no operation
  `name`. Zod rejected it with four mechanical issues and a repair round was
  spent. The normalizer closes all four without asking a model again.
*/

const TEXT_DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      /*
        A ProseMirror inline text node: `{ type: "text", text: … }`. It looks
        exactly like a mangled text BLOCK and must never be treated as one.
      */
      content: [{ type: "text", text: "Hello there" }],
    },
  ],
};

/*
  The exact production payload, minus the tool envelope.
*/
const FAILING_ADD_SECTION_INPUT = {
  index: 1,
  section: {
    id: "sec_h101",
    type: "section",
    parentId: "root",
    childrenIds: ["txt_h101"],
    properties: {},
  },
  children: [
    {
      type: "text",
      text: TEXT_DOC,
      id: "txt_h101",
      parentId: "sec_h101",
    },
  ],
};

const VALID_ADD_SECTION_INPUT = {
  name: "addSection",
  index: 1,
  section: {
    id: "sec_h101",
    type: "section",
    parentId: "root",
    childrenIds: ["txt_h101"],
    properties: {},
  },
  children: [
    {
      id: "txt_h101",
      type: "text",
      parentId: "sec_h101",
      childrenIds: [],
      properties: { text: TEXT_DOC },
    },
  ],
};

describe("normalizeToolInput — the production addSection failure", () => {
  it("is rejected with exactly the four reported issues WITHOUT normalization", () => {
    const parsed = addSectionOperationSchema.safeParse(FAILING_ADD_SECTION_INPUT);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
      })),
    ).toEqual([
      { code: "invalid_value", path: "name" },
      { code: "invalid_type", path: "children.0.childrenIds" },
      { code: "invalid_type", path: "children.0.properties" },
      { code: "unrecognized_keys", path: "children.0" },
    ]);
  });

  it("validates after normalization", () => {
    const normalized = normalizeToolInput(addSectionOperationSchema, FAILING_ADD_SECTION_INPUT);
    expect(addSectionOperationSchema.safeParse(normalized).success).toBe(true);
  });

  it("produces exactly the block the model should have sent — nothing invented", () => {
    expect(normalizeToolInput(addSectionOperationSchema, FAILING_ADD_SECTION_INPUT)).toEqual(
      VALID_ADD_SECTION_INPUT,
    );
  });

  it("leaves the rich-text doc's inline text nodes untouched", () => {
    const normalized = normalizeToolInput(
      addSectionOperationSchema,
      FAILING_ADD_SECTION_INPUT,
    ) as typeof VALID_ADD_SECTION_INPUT;
    expect(normalized.children[0]?.properties.text).toEqual(TEXT_DOC);
  });
});

describe("normalizeToolInput — idempotency", () => {
  it("returns an already-valid input unchanged, by identity", () => {
    expect(normalizeToolInput(addSectionOperationSchema, VALID_ADD_SECTION_INPUT)).toBe(
      VALID_ADD_SECTION_INPUT,
    );
  });

  it("normalizing twice is the same as normalizing once", () => {
    const once = normalizeToolInput(addSectionOperationSchema, FAILING_ADD_SECTION_INPUT);
    expect(normalizeToolInput(addSectionOperationSchema, once)).toBe(once);
  });

  it("leaves a valid input for every other block-bearing tool unchanged", () => {
    const validAddBlock = {
      name: "addBlock",
      parentId: "sec_h101",
      index: 0,
      block: {
        id: "div_a1b2",
        type: "divider",
        parentId: "sec_h101",
        childrenIds: [],
        properties: {},
      },
    };
    expect(normalizeToolInput(addBlockOperationSchema, validAddBlock)).toBe(validAddBlock);
  });
});

describe("normalizeToolInput — what it refuses", () => {
  it("does not overwrite a `name` that is present but wrong", () => {
    /*
      updateBlockProperties and replaceBlockProperties are shape-identical
      apart from this literal: "correcting" it would turn a merge into a
      wholesale replace.
    */
    const input = {
      name: "replaceBlockProperties",
      blockId: "txt_h101",
      properties: { textAlign: "center" },
    };
    expect(normalizeToolInput(updateBlockPropertiesOperationSchema, input)).toBe(input);
    expect(updateBlockPropertiesOperationSchema.safeParse(input).success).toBe(false);
  });

  it("does not guess when a stray key and its property twin disagree", () => {
    const ambiguous = {
      index: 0,
      section: {
        id: "sec_h101",
        type: "section",
        parentId: "root",
        childrenIds: ["btn_h101"],
        properties: {},
      },
      children: [
        {
          id: "btn_h101",
          type: "button",
          parentId: "sec_h101",
          childrenIds: [],
          label: "Buy now",
          properties: { label: "Learn more", href: "https://example.com" },
        },
      ],
    };
    expect(normalizeToolInput(addSectionOperationSchema, ambiguous)).toBe(ambiguous);
    expect(addSectionOperationSchema.safeParse(ambiguous).success).toBe(false);
  });

  it("does not fill childrenIds on a CONTAINER block", () => {
    const sectionWithoutChildrenIds = {
      index: 0,
      section: { id: "sec_h101", type: "section", parentId: "root", properties: {} },
    };
    const normalized = normalizeToolInput(addSectionOperationSchema, sectionWithoutChildrenIds);
    expect(normalized).toBe(sectionWithoutChildrenIds);
    expect(addSectionOperationSchema.safeParse(normalized).success).toBe(false);
  });

  it("keeps a payload it cannot save failing with exactly today's issues", () => {
    /*
      No `href` anywhere: a button without a destination is content the model
      never sent, and inventing one is not repair.
    */
    const unsavable = {
      index: 0,
      section: {
        id: "sec_h101",
        type: "section",
        parentId: "root",
        childrenIds: ["btn_h101"],
        properties: {},
      },
      children: [{ id: "btn_h101", type: "button", parentId: "sec_h101", label: "Buy now" }],
    };
    const normalized = normalizeToolInput(addSectionOperationSchema, unsavable);
    expect(normalized).toBe(unsavable);

    const beforeIssues = addSectionOperationSchema.safeParse(unsavable);
    const afterIssues = addSectionOperationSchema.safeParse(normalized);
    expect(afterIssues.success).toBe(false);
    expect(afterIssues.success === false && beforeIssues.success === false).toBe(true);
    if (afterIssues.success || beforeIssues.success) return;
    expect(afterIssues.error.issues).toEqual(beforeIssues.error.issues);
  });

  it("leaves non-object inputs alone", () => {
    expect(normalizeToolInput(addSectionOperationSchema, "not an object")).toBe("not an object");
    expect(normalizeToolInput(addSectionOperationSchema, null)).toBe(null);
  });

  it("does not invent block content for an unknown top-level key", () => {
    const strayUnknownKey = {
      index: 0,
      section: {
        id: "sec_h101",
        type: "section",
        parentId: "root",
        childrenIds: ["div_h101"],
        properties: {},
      },
      children: [
        { id: "div_h101", type: "divider", parentId: "sec_h101", thicknessPx: 4 },
      ],
    };
    /*
      `thicknessPx` is not a divider property, so it stays put and Zod rejects it.
    */
    expect(normalizeToolInput(addSectionOperationSchema, strayUnknownKey)).toBe(strayUnknownKey);
  });
});

describe("normalizeToolInput — the other block-bearing tools", () => {
  it("repairs a block inside addBlock", () => {
    const input = {
      parentId: "sec_h101",
      index: 0,
      block: { id: "lnk_a1b2", type: "link", parentId: "sec_h101", text: "Unsubscribe", href: "https://e.co/u" },
    };
    const normalized = normalizeToolInput(addBlockOperationSchema, input);
    expect(addBlockOperationSchema.safeParse(normalized)).toMatchObject({ success: true });
    expect(normalized).toEqual({
      name: "addBlock",
      parentId: "sec_h101",
      index: 0,
      block: {
        id: "lnk_a1b2",
        type: "link",
        parentId: "sec_h101",
        childrenIds: [],
        properties: { text: "Unsubscribe", href: "https://e.co/u" },
      },
    });
  });

  it("repairs every block in restoreBlocks", () => {
    const input = {
      parentId: "root",
      index: 0,
      blocks: [
        { id: "sec_h101", type: "section", parentId: "root", childrenIds: ["spc_h101"], properties: {} },
        { id: "spc_h101", type: "spacer", parentId: "sec_h101", height: 24 },
      ],
    };
    const normalized = normalizeToolInput(restoreBlocksOperationSchema, input);
    expect(restoreBlocksOperationSchema.safeParse(normalized)).toMatchObject({ success: true });
    expect(normalized).toMatchObject({
      name: "restoreBlocks",
      blocks: [
        { id: "sec_h101" },
        { id: "spc_h101", childrenIds: [], properties: { height: 24 } },
      ],
    });
  });

  it("repairs the block inside placeBlockBeside's discriminated content union", () => {
    const input = {
      targetBlockId: "txt_h101",
      side: "right",
      newColumnId: "col_a1b2",
      newRowId: "row_a1b2",
      newTargetColumnId: "col_c3d4",
      content: {
        kind: "new-block",
        block: { id: "img_a1b2", type: "image", parentId: "col_a1b2", src: "https://e.co/a.png", alt: "A" },
      },
    };
    const normalized = normalizeToolInput(placeBlockBesideOperationSchema, input);
    expect(placeBlockBesideOperationSchema.safeParse(normalized)).toMatchObject({ success: true });
    expect(normalized).toMatchObject({
      name: "placeBlockBeside",
      content: {
        kind: "new-block",
        block: { childrenIds: [], properties: { src: "https://e.co/a.png", alt: "A" } },
      },
    });
  });

  it("fills the `name` discriminator on a block-free tool (scaffoldSection)", () => {
    const input = { templateId: "saved:abc123", position: "top" };
    const normalized = normalizeToolInput(scaffoldSectionInputSchema, input);
    expect(scaffoldSectionInputSchema.safeParse(normalized)).toMatchObject({ success: true });
    expect(normalized).toEqual({ name: "scaffoldSection", templateId: "saved:abc123", position: "top" });
  });

  it("fills the `name` discriminator on updateText without touching its doc", () => {
    const input = { blockId: "txt_h101", text: TEXT_DOC };
    const normalized = normalizeToolInput(updateTextOperationSchema, input);
    expect(updateTextOperationSchema.safeParse(normalized)).toMatchObject({ success: true });
    expect(normalized).toEqual({ name: "updateText", blockId: "txt_h101", text: TEXT_DOC });
  });
});
