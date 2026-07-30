import { describe, expect, it } from "vitest";
import { createTextDoc } from "../schema/text";
import {
  OPERATION_NAMES,
  operationSchema,
  updateTextOperationSchema,
  type Operation,
} from "./ops";

/** One valid sample of every operation in the union. */
const sampleOperations: Operation[] = [
  { name: "updateBlockProperties", blockId: "btn_a1b2", properties: { label: "Go" } },
  {
    name: "replaceBlockProperties",
    blockId: "btn_a1b2",
    properties: { label: "Go", href: "https://example.com" },
  },
  { name: "updateDocumentSettings", globals: { contentWidth: 640 } },
  {
    name: "applyTheme",
    globals: { emailBackgroundColor: "#000000" },
    sectionOverrides: [{ blockId: "sec_a1b2", innerBackgroundColor: "#fafafa" }],
  },
  {
    name: "addBlock",
    block: { id: "div_a1b2", type: "divider", parentId: "sec_a1b2", childrenIds: [], properties: {} },
    parentId: "sec_a1b2",
    index: 0,
  },
  {
    name: "addSection",
    section: { id: "sec_a1b2", type: "section", parentId: "root", childrenIds: [], properties: {} },
    index: 0,
  },
  {
    name: "restoreBlocks",
    blocks: [
      { id: "div_a1b2", type: "divider", parentId: "sec_a1b2", childrenIds: [], properties: {} },
    ],
    parentId: "sec_a1b2",
    index: 0,
  },
  { name: "removeBlock", blockId: "sec_a1b2" },
  { name: "moveBlock", blockId: "img_a1b2", newParentId: "col_a1b2", index: 1 },
  { name: "reorderChildren", parentId: "sec_a1b2", orderedChildIds: ["txt_a1b2", "img_a1b2"] },
  { name: "updateText", blockId: "txt_a1b2", text: createTextDoc("Hello") },
];

describe("operationSchema", () => {
  it("accepts a valid sample of every operation", () => {
    for (const operation of sampleOperations) {
      const result = operationSchema.safeParse(operation);
      expect(result.success, `expected ${operation.name} to parse`).toBe(true);
    }
  });

  it("covers every OPERATION_NAMES entry with a sample", () => {
    expect(sampleOperations.map((operation) => operation.name).sort()).toEqual(
      [...OPERATION_NAMES].sort(),
    );
  });

  it("rejects an unknown operation name", () => {
    expect(operationSchema.safeParse({ name: "renameBlock", blockId: "txt_a1b2" }).success).toBe(
      false,
    );
  });

  it("rejects unknown envelope keys (strict objects)", () => {
    expect(
      operationSchema.safeParse({ name: "removeBlock", blockId: "sec_a1b2", cascade: true }).success,
    ).toBe(false);
  });

  it("rejects malformed block ids", () => {
    expect(operationSchema.safeParse({ name: "removeBlock", blockId: "section-1" }).success).toBe(
      false,
    );
  });

  it("rejects negative and fractional insertion indexes", () => {
    const base = {
      name: "addSection",
      section: { id: "sec_a1b2", type: "section", parentId: "root", childrenIds: [], properties: {} },
    };
    expect(operationSchema.safeParse({ ...base, index: -1 }).success).toBe(false);
    expect(operationSchema.safeParse({ ...base, index: 0.5 }).success).toBe(false);
  });

  it("rejects an empty restoreBlocks payload", () => {
    expect(
      operationSchema.safeParse({ name: "restoreBlocks", blocks: [], parentId: "root", index: 0 })
        .success,
    ).toBe(false);
  });

  it("rejects unknown global style keys on settings ops", () => {
    expect(
      operationSchema.safeParse({ name: "applyTheme", globals: { brandColor: "#fff" } }).success,
    ).toBe(false);
  });

  it("applyTheme sectionOverrides require section block ids and known keys", () => {
    expect(
      operationSchema.safeParse({
        name: "applyTheme",
        globals: {},
        sectionOverrides: [{ blockId: "txt_a1b2", innerBackgroundColor: "#fff" }],
      }).success,
    ).toBe(false);
    expect(
      operationSchema.safeParse({
        name: "applyTheme",
        globals: {},
        sectionOverrides: [{ blockId: "sec_a1b2", paddingTop: 12 }],
      }).success,
    ).toBe(false);
  });

  it("updateText requires a text block id (typed prefix)", () => {
    expect(
      updateTextOperationSchema.safeParse({
        name: "updateText",
        blockId: "btn_a1b2",
        text: createTextDoc("Hello"),
      }).success,
    ).toBe(false);
  });
});
