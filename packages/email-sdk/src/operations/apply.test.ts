import { describe, expect, it } from "vitest";
import type { ColumnBlock, DividerBlock, RowBlock, SectionBlock, TextBlock } from "../schema/blocks";
import { createTextDoc } from "../schema/text";
import { createSampleDocument, type EmailDocument } from "../store/document";
import {
  applyOperation,
  applyOperations,
  type ApplyOperationResult,
  type OperationErrorCode,
} from "./apply";
import type { Operation } from "./ops";

/**
 * Sample document shape (createSampleDocument):
 *   root
 *   ├─ sec_a1b2: [txt_e5f6, img_g7h8, div_i9j0]
 *   └─ sec_c3d4: [row_k1l2]
 *       ├─ col_m3n4: [txt_r7s8]
 *       └─ col_p5q6: [btn_t9u0]
 */

function applyOrThrow(document: EmailDocument, operation: Operation) {
  const result = applyOperation(document, operation);
  if (!result.isOk) {
    throw new Error(
      `Expected operation "${operation.name}" to succeed, got: ${result.errors
        .map((error) => `${error.code}: ${error.message}`)
        .join(" | ")}`,
    );
  }
  return result;
}

function expectErrorCode({
  document,
  operation,
  code,
}: {
  document: EmailDocument;
  operation: Operation;
  code: OperationErrorCode;
}): ApplyOperationResult {
  const result = applyOperation(document, operation);
  expect(result.isOk).toBe(false);
  if (!result.isOk) {
    expect(result.errors.map((error) => error.code)).toContain(code);
  }
  return result;
}

/**
 * The core quality bar, asserted for every op:
 * 1. Purity — the input document is deep-equal unchanged after apply.
 * 2. Inverse round trip — applying the op then its inverse restores a
 *    document deep-equal to the original.
 */
function expectPureInverseRoundTrip(document: EmailDocument, operation: Operation) {
  const before = structuredClone(document);
  const applied = applyOrThrow(document, operation);
  expect(document).toEqual(before);
  const reverted = applyOrThrow(applied.doc, applied.inverse);
  expect(applied.doc).not.toBe(reverted.doc);
  expect(reverted.doc).toEqual(before);
  return applied;
}

const createNewDivider = (): DividerBlock => ({
  id: "div_zz01",
  type: "divider",
  parentId: "col_m3n4",
  childrenIds: [],
  properties: { paddingTop: 8 },
});

const createNewSection = (childrenIds: string[] = []): SectionBlock =>
  ({
    id: "sec_zz02",
    type: "section",
    parentId: "root",
    childrenIds,
    properties: { innerBackgroundColor: "#eeeeee" },
  }) as SectionBlock;

const createNewSectionText = (): TextBlock => ({
  id: "txt_zz03",
  type: "text",
  parentId: "sec_zz02",
  childrenIds: [],
  properties: { text: createTextDoc("Fresh section copy") },
});

// ---------------------------------------------------------------------------
// updateBlockProperties
// ---------------------------------------------------------------------------

describe("applyOperation — updateBlockProperties", () => {
  it("merges partial overrides, preserving unmentioned properties", () => {
    const document = createSampleDocument();
    const result = applyOrThrow(document, {
      name: "updateBlockProperties",
      blockId: "btn_t9u0",
      properties: { label: "Ride now", backgroundColor: "#ff0000" },
    });
    const button = result.doc.btn_t9u0!;
    expect(button.properties).toEqual({
      label: "Ride now",
      href: "https://example.com/start",
      align: "center",
      backgroundColor: "#ff0000",
    });
  });

  it("is pure and its inverse round-trips", () => {
    expectPureInverseRoundTrip(createSampleDocument(), {
      name: "updateBlockProperties",
      blockId: "img_g7h8",
      properties: { width: 300, align: "left" },
    });
  });

  it("clears an override when a key is set to undefined, and still round-trips", () => {
    const document = createSampleDocument();
    const applied = expectPureInverseRoundTrip(document, {
      name: "updateBlockProperties",
      blockId: "img_g7h8",
      properties: { width: undefined },
    });
    expect(applied.doc.img_g7h8!.properties).not.toHaveProperty("width");
  });

  it("generates a replaceBlockProperties inverse carrying the full prior properties", () => {
    const document = createSampleDocument();
    const applied = applyOrThrow(document, {
      name: "updateBlockProperties",
      blockId: "btn_t9u0",
      properties: { label: "Changed" },
    });
    expect(applied.inverse).toEqual({
      name: "replaceBlockProperties",
      blockId: "btn_t9u0",
      properties: {
        label: "Get started",
        href: "https://example.com/start",
        align: "center",
      },
    });
  });

  it("rejects a missing target", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "updateBlockProperties", blockId: "btn_none", properties: { label: "x" } },
      code: "target_not_found",
    });
  });

  it("rejects unknown property keys via the merged block's strict schema", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "updateBlockProperties", blockId: "btn_t9u0", properties: { fontSize: 12 } },
      code: "schema_validation_failed",
    });
  });

  it("rejects invalid property values via the merged block's schema", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "updateBlockProperties", blockId: "btn_t9u0", properties: { label: 42 } },
      code: "schema_validation_failed",
    });
  });

  it("leaves the input document unchanged on failure", () => {
    const document = createSampleDocument();
    const before = structuredClone(document);
    applyOperation(document, {
      name: "updateBlockProperties",
      blockId: "btn_t9u0",
      properties: { label: 42 },
    });
    expect(document).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// replaceBlockProperties
// ---------------------------------------------------------------------------

describe("applyOperation — replaceBlockProperties", () => {
  it("replaces the entire properties object and round-trips", () => {
    const document = createSampleDocument();
    const applied = expectPureInverseRoundTrip(document, {
      name: "replaceBlockProperties",
      blockId: "btn_t9u0",
      properties: { label: "Only these", href: "https://example.com/other" },
    });
    expect(applied.doc.btn_t9u0!.properties).toEqual({
      label: "Only these",
      href: "https://example.com/other",
    });
  });

  it("rejects properties missing required fields", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "replaceBlockProperties", blockId: "btn_t9u0", properties: { label: "No href" } },
      code: "schema_validation_failed",
    });
  });

  it("rejects a missing target", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "replaceBlockProperties", blockId: "txt_none", properties: {} },
      code: "target_not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// updateDocumentSettings
// ---------------------------------------------------------------------------

describe("applyOperation — updateDocumentSettings", () => {
  it("merges partial globals into root.properties.globals", () => {
    const document = createSampleDocument();
    const result = applyOrThrow(document, {
      name: "updateDocumentSettings",
      globals: { contentWidth: 640, linkTextColor: "#123456" },
    });
    const root = result.doc.root!;
    expect(root.type).toBe("root");
    if (root.type === "root") {
      expect(root.properties.globals).toEqual({
        emailBackgroundColor: "#f4f4f4",
        contentBackgroundColor: "#ffffff",
        contentWidth: 640,
        buttonBackgroundColor: "#1a1a2e",
        heading1TextAlign: "center",
        linkTextColor: "#123456",
      });
    }
  });

  it("is pure and its inverse round-trips", () => {
    expectPureInverseRoundTrip(createSampleDocument(), {
      name: "updateDocumentSettings",
      globals: { baseSpacing: 32 },
    });
  });

  it("round-trips exactly on a root whose properties have no globals key", () => {
    const documentWithoutGlobals: EmailDocument = {
      root: { id: "root", type: "root", parentId: null, childrenIds: [], properties: {} },
    };
    expectPureInverseRoundTrip(documentWithoutGlobals, {
      name: "updateDocumentSettings",
      globals: { contentWidth: 640 },
    });
  });

  it("rejects invalid global values at the envelope", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "updateDocumentSettings", globals: { contentWidth: 100 } },
      code: "op_validation_failed",
    });
  });
});

// ---------------------------------------------------------------------------
// applyTheme
// ---------------------------------------------------------------------------

describe("applyOperation — applyTheme", () => {
  /** Sample doc plus a section carrying BOTH theme-scoped overrides and padding. */
  const createDocumentWithSectionOverrides = (): EmailDocument => {
    const document = createSampleDocument();
    const section = document.sec_c3d4! as SectionBlock;
    document.sec_c3d4 = {
      ...section,
      properties: {
        ...section.properties,
        outerBackgroundColor: "#333333",
        paddingTop: 40,
      },
    };
    return document;
  };

  it("wholesale-replaces the globals (unlisted globals are dropped)", () => {
    const document = createSampleDocument();
    const result = applyOrThrow(document, {
      name: "applyTheme",
      globals: { emailBackgroundColor: "#000000", buttonTextColor: "#00ff00" },
    });
    const root = result.doc.root!;
    if (root.type === "root") {
      expect(root.properties.globals).toEqual({
        emailBackgroundColor: "#000000",
        buttonTextColor: "#00ff00",
      });
    }
  });

  it("strips theme-scoped background overrides from every section, preserving other overrides", () => {
    const document = createDocumentWithSectionOverrides();
    const result = applyOrThrow(document, {
      name: "applyTheme",
      globals: { emailBackgroundColor: "#000000" },
    });
    // sec_c3d4 carried innerBackgroundColor (#fafafa), outerBackgroundColor, and paddingTop.
    expect(result.doc.sec_c3d4!.properties).toEqual({ paddingTop: 40 });
    // sec_a1b2 carried no overrides and is untouched (structurally shared).
    expect(result.doc.sec_a1b2).toBe(document.sec_a1b2);
  });

  it("is pure and its inverse round-trips (restoring globals AND section overrides)", () => {
    const applied = expectPureInverseRoundTrip(createDocumentWithSectionOverrides(), {
      name: "applyTheme",
      globals: { emailBackgroundColor: "#101010" },
    });
    expect(applied.inverse).toEqual({
      name: "applyTheme",
      globals: {
        emailBackgroundColor: "#f4f4f4",
        contentBackgroundColor: "#ffffff",
        contentWidth: 600,
        buttonBackgroundColor: "#1a1a2e",
        heading1TextAlign: "center",
      },
      sectionOverrides: [
        {
          blockId: "sec_c3d4",
          innerBackgroundColor: "#fafafa",
          outerBackgroundColor: "#333333",
        },
      ],
    });
  });

  it("generates the classic root-snapshot inverse when no section carries an override", () => {
    const document = createSampleDocument();
    delete document.sec_c3d4; // drop the override-carrying section (and its subtree refs)
    const root = document.root!;
    document.root = { ...root, childrenIds: ["sec_a1b2", "sec_e5f6"] } as typeof root;
    for (const blockId of ["row_k1l2", "col_m3n4", "txt_r7s8", "col_p5q6", "btn_t9u0"] as const) {
      delete document[blockId];
    }
    const applied = expectPureInverseRoundTrip(document, {
      name: "applyTheme",
      globals: { emailBackgroundColor: "#101010" },
    });
    expect(applied.inverse.name).toBe("replaceBlockProperties");
  });

  it("round-trips exactly on a root whose properties have no globals key", () => {
    const documentWithoutGlobals: EmailDocument = {
      root: { id: "root", type: "root", parentId: null, childrenIds: [], properties: {} },
    };
    expectPureInverseRoundTrip(documentWithoutGlobals, {
      name: "applyTheme",
      globals: { contentWidth: 640 },
    });
  });

  it("undo then redo re-strips the restored overrides (inverse of the inverse)", () => {
    const original = createDocumentWithSectionOverrides();
    const applied = applyOrThrow(original, {
      name: "applyTheme",
      globals: { emailBackgroundColor: "#101010" },
    });
    const undone = applyOrThrow(applied.doc, applied.inverse);
    expect(undone.doc).toEqual(original);
    const redone = applyOrThrow(undone.doc, undone.inverse);
    expect(redone.doc).toEqual(applied.doc);
  });

  it("sets sectionOverrides after the strip when called directly", () => {
    const result = applyOrThrow(createDocumentWithSectionOverrides(), {
      name: "applyTheme",
      globals: { emailBackgroundColor: "#000000" },
      sectionOverrides: [{ blockId: "sec_a1b2", innerBackgroundColor: "#abcdef" }],
    });
    expect(result.doc.sec_a1b2!.properties).toEqual({ innerBackgroundColor: "#abcdef" });
    expect(result.doc.sec_c3d4!.properties).toEqual({ paddingTop: 40 });
  });

  it("rejects a sectionOverrides entry whose section does not exist", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: {
        name: "applyTheme",
        globals: {},
        sectionOverrides: [{ blockId: "sec_none", innerBackgroundColor: "#ffffff" }],
      },
      code: "target_not_found",
    });
  });

  it("rejects a sectionOverrides entry with a non-section block id at the envelope", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: {
        name: "applyTheme",
        globals: {},
        sectionOverrides: [{ blockId: "txt_e5f6", innerBackgroundColor: "#ffffff" }],
      } as never,
      code: "op_validation_failed",
    });
  });

  it("rejects unknown globals keys at the envelope", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "applyTheme", globals: { brandColor: "#fff" } as never },
      code: "op_validation_failed",
    });
  });
});

// ---------------------------------------------------------------------------
// addBlock
// ---------------------------------------------------------------------------

describe("applyOperation — addBlock", () => {
  it("inserts the block at the given index under the parent", () => {
    const document = createSampleDocument();
    const result = applyOrThrow(document, {
      name: "addBlock",
      block: createNewDivider(),
      parentId: "col_m3n4",
      index: 1,
    });
    expect(result.doc.col_m3n4!.childrenIds).toEqual(["txt_r7s8", "div_zz01"]);
    expect(result.doc.div_zz01).toMatchObject({ id: "div_zz01", parentId: "col_m3n4" });
  });

  it("is pure and its removeBlock inverse round-trips", () => {
    const applied = expectPureInverseRoundTrip(createSampleDocument(), {
      name: "addBlock",
      block: createNewDivider(),
      parentId: "col_m3n4",
      index: 0,
    });
    expect(applied.inverse).toEqual({ name: "removeBlock", blockId: "div_zz01" });
  });

  it("overwrites the provided block's parentId with the operation's parentId", () => {
    const document = createSampleDocument();
    const divider = { ...createNewDivider(), parentId: "sec_a1b2" } as DividerBlock;
    const result = applyOrThrow(document, {
      name: "addBlock",
      block: divider,
      parentId: "col_m3n4",
      index: 0,
    });
    expect(result.doc.div_zz01!.parentId).toBe("col_m3n4");
  });

  it("rejects a duplicate block id", () => {
    const document = createSampleDocument();
    const divider = { ...createNewDivider(), id: "div_i9j0" } as DividerBlock;
    expectErrorCode({
      document: document,
      operation: { name: "addBlock", block: divider, parentId: "col_m3n4", index: 0 },
      code: "duplicate_block_id",
    });
  });

  it("rejects a missing parent", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "addBlock", block: createNewDivider(), parentId: "sec_none", index: 0 },
      code: "target_not_found",
    });
  });

  it("rejects a nesting violation (column directly under the root)", () => {
    const document = createSampleDocument();
    const column: ColumnBlock = {
      id: "col_zz05",
      type: "column",
      parentId: "row_k1l2",
      childrenIds: [],
      properties: {},
    };
    expectErrorCode({
      document: document,
      operation: { name: "addBlock", block: column, parentId: "root", index: 0 },
      code: "nesting_violation",
    });
  });

  it("rejects an out-of-range index", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "addBlock", block: createNewDivider(), parentId: "col_m3n4", index: 5 },
      code: "index_out_of_range",
    });
  });

  it("fails the post-apply integrity check when a container claims an existing block", () => {
    const document = createSampleDocument();
    const trojanRow: RowBlock = {
      id: "row_zz04",
      type: "row",
      parentId: "sec_a1b2",
      childrenIds: ["col_m3n4"],
      properties: {},
    };
    const before = structuredClone(document);
    expectErrorCode({
      document: document,
      operation: { name: "addBlock", block: trojanRow, parentId: "sec_a1b2", index: 0 },
      code: "integrity_check_failed",
    });
    expect(document).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// addSection
// ---------------------------------------------------------------------------

describe("applyOperation — addSection", () => {
  it("inserts an empty section at the given index under the root", () => {
    const document = createSampleDocument();
    const result = applyOrThrow(document, {
      name: "addSection",
      section: createNewSection(),
      index: 1,
    });
    expect(result.doc.root!.childrenIds).toEqual(["sec_a1b2", "sec_zz02", "sec_c3d4", "sec_e5f6"]);
  });

  it("is pure and round-trips (bare section)", () => {
    const applied = expectPureInverseRoundTrip(createSampleDocument(), {
      name: "addSection",
      section: createNewSection(),
      index: 2,
    });
    expect(applied.inverse).toEqual({ name: "removeBlock", blockId: "sec_zz02" });
  });

  it("inserts a prebuilt subtree atomically and round-trips", () => {
    const document = createSampleDocument();
    const applied = expectPureInverseRoundTrip(document, {
      name: "addSection",
      section: createNewSection(["txt_zz03"]),
      index: 0,
      children: [createNewSectionText()],
    });
    expect(applied.doc.root!.childrenIds).toEqual(["sec_zz02", "sec_a1b2", "sec_c3d4", "sec_e5f6"]);
    expect(applied.doc.txt_zz03!.parentId).toBe("sec_zz02");
  });

  it("rejects children that do not form a closed subtree", () => {
    const document = createSampleDocument();
    const strayText = { ...createNewSectionText(), parentId: "sec_a1b2" } as TextBlock;
    expectErrorCode({
      document: document,
      operation: { name: "addSection", section: createNewSection(["txt_zz03"]), index: 0, children: [strayText] },
      code: "op_validation_failed",
    });
  });

  it("rejects a section whose childrenIds dangle (integrity net)", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "addSection", section: createNewSection(["txt_zz03"]), index: 0 },
      code: "integrity_check_failed",
    });
  });

  it("rejects a duplicate section id", () => {
    const document = createSampleDocument();
    const section = { ...createNewSection(), id: "sec_a1b2" } as SectionBlock;
    expectErrorCode({
      document: document,
      operation: { name: "addSection", section, index: 0 },
      code: "duplicate_block_id",
    });
  });

  it("rejects an out-of-range index", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "addSection", section: createNewSection(), index: 4 },
      code: "index_out_of_range",
    });
  });
});

// ---------------------------------------------------------------------------
// removeBlock (and restoreBlocks, its inverse)
// ---------------------------------------------------------------------------

describe("applyOperation — removeBlock", () => {
  it("removes a leaf and splices it out of its parent", () => {
    const document = createSampleDocument();
    const result = applyOrThrow(document, { name: "removeBlock", blockId: "btn_t9u0" });
    expect(result.doc.btn_t9u0).toBeUndefined();
    expect(result.doc.col_p5q6!.childrenIds).toEqual([]);
  });

  it("cascades: removing a section removes every descendant", () => {
    const document = createSampleDocument();
    const result = applyOrThrow(document, { name: "removeBlock", blockId: "sec_c3d4" });
    for (const removedId of ["sec_c3d4", "row_k1l2", "col_m3n4", "txt_r7s8", "col_p5q6", "btn_t9u0"]) {
      expect(result.doc[removedId]).toBeUndefined();
    }
    expect(result.doc.root!.childrenIds).toEqual(["sec_a1b2", "sec_e5f6"]);
    expect(Object.keys(result.doc)).toHaveLength(Object.keys(document).length - 6);
  });

  it("is pure and a leaf removal round-trips via restoreBlocks", () => {
    expectPureInverseRoundTrip(createSampleDocument(), { name: "removeBlock", blockId: "img_g7h8" });
  });

  it("is pure and a cascading removal round-trips via restoreBlocks", () => {
    const applied = expectPureInverseRoundTrip(createSampleDocument(), {
      name: "removeBlock",
      blockId: "sec_c3d4",
    });
    expect(applied.inverse.name).toBe("restoreBlocks");
    if (applied.inverse.name === "restoreBlocks") {
      expect(applied.inverse.parentId).toBe("root");
      expect(applied.inverse.index).toBe(1);
      expect(applied.inverse.blocks.map((block) => block.id)).toEqual([
        "sec_c3d4",
        "row_k1l2",
        "col_m3n4",
        "txt_r7s8",
        "col_p5q6",
        "btn_t9u0",
      ]);
    }
  });

  it("restores at the original position among siblings", () => {
    const document = createSampleDocument();
    const applied = applyOrThrow(document, { name: "removeBlock", blockId: "img_g7h8" });
    const reverted = applyOrThrow(applied.doc, applied.inverse);
    expect(reverted.doc.sec_a1b2!.childrenIds).toEqual(["txt_e5f6", "img_g7h8", "div_i9j0"]);
  });

  it("rejects removing the root", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "removeBlock", blockId: "root" },
      code: "root_not_allowed",
    });
  });

  it("rejects a missing target", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "removeBlock", blockId: "sec_none" },
      code: "target_not_found",
    });
  });
});

describe("applyOperation — restoreBlocks (direct)", () => {
  it("restores a subtree and round-trips (inverse is removeBlock)", () => {
    const document = createSampleDocument();
    const applied = expectPureInverseRoundTrip(document, {
      name: "restoreBlocks",
      blocks: [createNewDivider()],
      parentId: "sec_a1b2",
      index: 3,
    });
    expect(applied.doc.sec_a1b2!.childrenIds).toEqual([
      "txt_e5f6",
      "img_g7h8",
      "div_i9j0",
      "div_zz01",
    ]);
    expect(applied.inverse).toEqual({ name: "removeBlock", blockId: "div_zz01" });
  });

  it("rejects ids that already exist in the document", () => {
    const document = createSampleDocument();
    const divider = { ...createNewDivider(), id: "div_i9j0" } as DividerBlock;
    expectErrorCode({
      document: document,
      operation: { name: "restoreBlocks", blocks: [divider], parentId: "sec_a1b2", index: 0 },
      code: "duplicate_block_id",
    });
  });

  it("rejects a subtree root that violates nesting rules", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "restoreBlocks", blocks: [createNewDivider()], parentId: "root", index: 0 },
      code: "nesting_violation",
    });
  });
});

// ---------------------------------------------------------------------------
// moveBlock
// ---------------------------------------------------------------------------

describe("applyOperation — moveBlock", () => {
  it("reparents a leaf across containers and round-trips", () => {
    const document = createSampleDocument();
    const applied = expectPureInverseRoundTrip(document, {
      name: "moveBlock",
      blockId: "img_g7h8",
      newParentId: "col_m3n4",
      index: 0,
    });
    expect(applied.doc.sec_a1b2!.childrenIds).toEqual(["txt_e5f6", "div_i9j0"]);
    expect(applied.doc.col_m3n4!.childrenIds).toEqual(["img_g7h8", "txt_r7s8"]);
    expect(applied.doc.img_g7h8!.parentId).toBe("col_m3n4");
    expect(applied.inverse).toEqual({
      name: "moveBlock",
      blockId: "img_g7h8",
      newParentId: "sec_a1b2",
      index: 1,
    });
  });

  it("reorders within the same parent and round-trips", () => {
    const document = createSampleDocument();
    const applied = expectPureInverseRoundTrip(document, {
      name: "moveBlock",
      blockId: "txt_e5f6",
      newParentId: "sec_a1b2",
      index: 2,
    });
    expect(applied.doc.sec_a1b2!.childrenIds).toEqual(["img_g7h8", "div_i9j0", "txt_e5f6"]);
  });

  it("moves a whole subtree with the block (section reorder under root)", () => {
    const document = createSampleDocument();
    const applied = expectPureInverseRoundTrip(document, {
      name: "moveBlock",
      blockId: "sec_c3d4",
      newParentId: "root",
      index: 0,
    });
    expect(applied.doc.root!.childrenIds).toEqual(["sec_c3d4", "sec_a1b2", "sec_e5f6"]);
    expect(applied.doc.txt_r7s8!.parentId).toBe("col_m3n4");
  });

  it("rejects moving the root", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "moveBlock", blockId: "root", newParentId: "sec_a1b2", index: 0 },
      code: "root_not_allowed",
    });
  });

  it("rejects moving a block into its own subtree (cycle)", () => {
    const result = expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "moveBlock", blockId: "sec_c3d4", newParentId: "col_m3n4", index: 0 },
      code: "nesting_violation",
    });
    if (!result.isOk) {
      expect(result.errors[0]!.message).toMatch(/own subtree/);
    }
  });

  it("rejects a move that violates nesting rules (text into a row)", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "moveBlock", blockId: "txt_e5f6", newParentId: "row_k1l2", index: 0 },
      code: "nesting_violation",
    });
  });

  it("rejects a missing block and a missing destination", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "moveBlock", blockId: "txt_none", newParentId: "sec_a1b2", index: 0 },
      code: "target_not_found",
    });
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "moveBlock", blockId: "txt_e5f6", newParentId: "sec_none", index: 0 },
      code: "target_not_found",
    });
  });

  it("rejects an out-of-range index (same-parent bound excludes the moved block)", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "moveBlock", blockId: "txt_e5f6", newParentId: "sec_a1b2", index: 3 },
      code: "index_out_of_range",
    });
  });
});

// ---------------------------------------------------------------------------
// reorderChildren
// ---------------------------------------------------------------------------

describe("applyOperation — reorderChildren", () => {
  it("applies the new order and round-trips", () => {
    const document = createSampleDocument();
    const applied = expectPureInverseRoundTrip(document, {
      name: "reorderChildren",
      parentId: "sec_a1b2",
      orderedChildIds: ["div_i9j0", "txt_e5f6", "img_g7h8"],
    });
    expect(applied.doc.sec_a1b2!.childrenIds).toEqual(["div_i9j0", "txt_e5f6", "img_g7h8"]);
    expect(applied.inverse).toEqual({
      name: "reorderChildren",
      parentId: "sec_a1b2",
      orderedChildIds: ["txt_e5f6", "img_g7h8", "div_i9j0"],
    });
  });

  it("rejects an order missing a child", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "reorderChildren", parentId: "sec_a1b2", orderedChildIds: ["txt_e5f6", "img_g7h8"] },
      code: "children_not_permutation",
    });
  });

  it("rejects duplicated ids", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: {
        name: "reorderChildren",
        parentId: "sec_a1b2",
        orderedChildIds: ["txt_e5f6", "txt_e5f6", "div_i9j0"],
      },
      code: "children_not_permutation",
    });
  });

  it("rejects ids that are not children of the parent", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: {
        name: "reorderChildren",
        parentId: "sec_a1b2",
        orderedChildIds: ["txt_e5f6", "img_g7h8", "btn_t9u0"],
      },
      code: "children_not_permutation",
    });
  });

  it("rejects a missing parent", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "reorderChildren", parentId: "sec_none", orderedChildIds: [] },
      code: "target_not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// updateText
// ---------------------------------------------------------------------------

describe("applyOperation — updateText", () => {
  it("replaces the text doc and round-trips", () => {
    const document = createSampleDocument();
    const newText = createTextDoc("Completely new copy");
    const applied = expectPureInverseRoundTrip(document, {
      name: "updateText",
      blockId: "txt_r7s8",
      text: newText,
    });
    const textBlock = applied.doc.txt_r7s8!;
    if (textBlock.type === "text") {
      expect(textBlock.properties.text).toEqual(newText);
    }
    expect(applied.inverse.name).toBe("updateText");
  });

  it("preserves the block's non-text properties", () => {
    const document = createSampleDocument();
    const applied = applyOrThrow(document, {
      name: "updateText",
      blockId: "txt_e5f6",
      text: createTextDoc("Shorter"),
    });
    const textBlock = applied.doc.txt_e5f6!;
    if (textBlock.type === "text") {
      expect(textBlock.properties.paddingTop).toBe(24);
      expect(textBlock.properties.paddingBottom).toBe(12);
    }
  });

  it("rejects a missing text block", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "updateText", blockId: "txt_none", text: createTextDoc("x") },
      code: "target_not_found",
    });
  });

  it("rejects a non-text block id at the envelope (typed id prefix)", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "updateText", blockId: "btn_t9u0", text: createTextDoc("x") } as never,
      code: "op_validation_failed",
    });
  });

  it("rejects an invalid text doc at the envelope", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: {
        name: "updateText",
        blockId: "txt_r7s8",
        text: { type: "doc", content: [{ type: "blockquote", content: [] }] },
      } as never,
      code: "op_validation_failed",
    });
  });
});

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

describe("applyOperation — envelope validation", () => {
  it("rejects an unknown operation name", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "explodeBlock", blockId: "txt_e5f6" } as never,
      code: "op_validation_failed",
    });
  });

  it("rejects extra keys on the envelope", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "removeBlock", blockId: "txt_e5f6", force: true } as never,
      code: "op_validation_failed",
    });
  });
});

// ---------------------------------------------------------------------------
// applyOperations — batches
// ---------------------------------------------------------------------------

describe("applyOperations", () => {
  it("applies sequentially and returns inverses in reverse order", () => {
    const document = createSampleDocument();
    const operations: Operation[] = [
      { name: "updateText", blockId: "txt_r7s8", text: createTextDoc("Batched") },
      { name: "addBlock", block: createNewDivider(), parentId: "col_m3n4", index: 1 },
      { name: "removeBlock", blockId: "btn_t9u0" },
    ];
    const result = applyOperations(document, operations);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.inverses.map((inverse) => inverse.name)).toEqual([
        "restoreBlocks",
        "removeBlock",
        "updateText",
      ]);
      expect(result.doc.div_zz01).toBeDefined();
      expect(result.doc.btn_t9u0).toBeUndefined();
    }
  });

  it("undoes an entire batch by applying the inverses front-to-back", () => {
    const document = createSampleDocument();
    const before = structuredClone(document);
    const operations: Operation[] = [
      { name: "applyTheme", globals: { emailBackgroundColor: "#222222" } },
      { name: "moveBlock", blockId: "img_g7h8", newParentId: "col_p5q6", index: 0 },
      { name: "removeBlock", blockId: "sec_c3d4" },
    ];
    const result = applyOperations(document, operations);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      const undone = applyOperations(result.doc, result.inverses);
      expect(undone.isOk).toBe(true);
      if (undone.isOk) {
        expect(undone.doc).toEqual(before);
      }
    }
    expect(document).toEqual(before);
  });

  it("is all-or-nothing: a mid-batch failure reports the index and changes nothing", () => {
    const document = createSampleDocument();
    const before = structuredClone(document);
    const operations: Operation[] = [
      { name: "updateText", blockId: "txt_r7s8", text: createTextDoc("First succeeds") },
      { name: "removeBlock", blockId: "root" },
      { name: "removeBlock", blockId: "btn_t9u0" },
    ];
    const result = applyOperations(document, operations);
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.failedOperationIndex).toBe(1);
      expect(result.errors.map((error) => error.code)).toContain("root_not_allowed");
    }
    expect(document).toEqual(before);
  });

  it("handles an empty batch", () => {
    const document = createSampleDocument();
    const result = applyOperations(document, []);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.doc).toEqual(document);
      expect(result.inverses).toEqual([]);
    }
  });
});
