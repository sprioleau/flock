import { describe, expect, it } from "vitest";
import type {
  ColumnBlock,
  DividerBlock,
  RowBlock,
  SectionBlock,
} from "../schema/blocks";
import { createSampleDocument, type EmailDocument } from "../store/document";
import {
  applyOperation,
  type ApplyOperationResult,
  type OperationErrorCode,
} from "./apply";
import {
  withRemoveBlockCascadeDefault,
  type Operation,
  type RemoveBlockOperation,
  type RestoreBlocksOperation,
} from "./ops";

/*
  removeBlock's empty-container cascade (`shouldRemoveEmptyAncestors`) —
  column lifecycle rules when content is deleted:

  1. Empty columns never persist: removing a column's last block removes the
     column, and the surviving sibling columns reset to an equal width split
     (explicit widthPercent values stripped — placeBlockBeside's convention).
  2. Empty rows never persist: removing a row's last column removes the row.
  3. One undo restores everything: the inverse stays ONE restoreBlocks that
     carries the removed subtree AND the stripped sibling widths.
  4. Historical compatibility: ops WITHOUT the flag (everything logged before
     the field existed) replay with the original no-cascade semantics.

  Sample document shape (createSampleDocument):
    root
    ├─ sec_a1b2: [txt_e5f6, img_g7h8, div_i9j0]          (leaves directly in a section)
    ├─ sec_c3d4: [row_k1l2]
    │   ├─ col_m3n4 (60%): [txt_r7s8]
    │   └─ col_p5q6 (40%): [btn_t9u0]
    └─ sec_e5f6: [txt_v1w2, cod_x3y4, spc_z5a6, lnk_b7c8]
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

/*
  Purity + exact inverse round trip — the same bar every op is held to.
*/
function expectPureInverseRoundTrip(document: EmailDocument, operation: Operation) {
  const before = structuredClone(document);
  const applied = applyOrThrow(document, operation);
  expect(document).toEqual(before);
  const undone = applyOrThrow(applied.doc, applied.inverse);
  expect(undone.doc).toEqual(before);
  return applied;
}

/*
  Remove the last block of col_m3n4 (2-column row) with the cascade on.
*/
const REMOVE_LAST_IN_COLUMN_OP: RemoveBlockOperation = {
  name: "removeBlock",
  blockId: "txt_r7s8",
  shouldRemoveEmptyAncestors: true,
};

function makeDivider(id: string): DividerBlock {
  return {
    id,
    type: "divider",
    parentId: "col_none", /* overwritten on apply */
    childrenIds: [],
    properties: {},
  } as DividerBlock;
}

/*
  Sample doc grown to a 4-column row via two placeBlockBeside insert drops.
*/
function createFourColumnDocument(): EmailDocument {
  const withThird = applyOrThrow(createSampleDocument(), {
    name: "placeBlockBeside",
    targetBlockId: "btn_t9u0",
    side: "right",
    content: { kind: "new-block", block: makeDivider("div_c301") },
    newColumnId: "col_c302",
  }).doc;
  return applyOrThrow(withThird, {
    name: "placeBlockBeside",
    targetBlockId: "div_c301",
    side: "right",
    content: { kind: "new-block", block: makeDivider("div_c401") },
    newColumnId: "col_c402",
  }).doc;
}

describe("removeBlock without shouldRemoveEmptyAncestors (historical replay semantics)", () => {
  it("leaves an emptied column in place, exactly as before the field existed", () => {
    const document = createSampleDocument();
    const { doc, inverse } = expectPureInverseRoundTrip(document, {
      name: "removeBlock",
      blockId: "txt_r7s8",
    });
    const column = doc.col_m3n4 as ColumnBlock;
    expect(column.childrenIds).toEqual([]);
    /*
      Sibling widths untouched — no redistribution without the flag.
    */
    expect(column.properties.widthPercent).toBe(60);
    expect((doc.col_p5q6 as ColumnBlock).properties.widthPercent).toBe(40);
    /*
      Inverse shape unchanged: no previousWidths field creeps in.
    */
    expect(inverse).toEqual({
      name: "restoreBlocks",
      blocks: [document.txt_r7s8],
      parentId: "col_m3n4",
      index: 0,
    });
  });

  it("explicit shouldRemoveEmptyAncestors: false behaves identically to the absent field", () => {
    const document = createSampleDocument();
    const { doc } = expectPureInverseRoundTrip(document, {
      name: "removeBlock",
      blockId: "txt_r7s8",
      shouldRemoveEmptyAncestors: false,
    });
    expect((doc.col_m3n4 as ColumnBlock).childrenIds).toEqual([]);
  });
});

describe("removeBlock cascade — emptied column collapses", () => {
  it("removes the column with its last block and resets the survivor to the full row width", () => {
    const document = createSampleDocument();
    const { doc, inverse } = expectPureInverseRoundTrip(document, REMOVE_LAST_IN_COLUMN_OP);

    expect(doc.txt_r7s8).toBeUndefined();
    expect(doc.col_m3n4).toBeUndefined();
    const row = doc.row_k1l2 as RowBlock;
    expect(row.childrenIds).toEqual(["col_p5q6"]);
    /*
      Equal split: the survivor's explicit 40% is stripped (no widths = full row).
    */
    expect((doc.col_p5q6 as ColumnBlock).properties.widthPercent).toBeUndefined();

    /*
      ONE inverse restores the block, its column, the position, AND the widths.
    */
    expect(inverse).toEqual({
      name: "restoreBlocks",
      blocks: [document.col_m3n4, document.txt_r7s8],
      parentId: "row_k1l2",
      index: 0,
      previousWidths: [{ columnId: "col_p5q6", widthPercent: 40 }],
    });
  });

  it("keeps a column that still has other content (no cascade, no width changes)", () => {
    const withSecondLeaf = applyOrThrow(createSampleDocument(), {
      name: "addBlock",
      block: makeDivider("div_k201"),
      parentId: "col_m3n4",
      index: 1,
    }).doc;
    const { doc } = expectPureInverseRoundTrip(withSecondLeaf, REMOVE_LAST_IN_COLUMN_OP);
    const column = doc.col_m3n4 as ColumnBlock;
    expect(column.childrenIds).toEqual(["div_k201"]);
    expect(column.properties.widthPercent).toBe(60);
    expect((doc.col_p5q6 as ColumnBlock).properties.widthPercent).toBe(40);
  });

  it("4-column row: one column collapses, the three survivors stay an equal split", () => {
    const document = createFourColumnDocument();
    expect((document.row_k1l2 as RowBlock).childrenIds).toHaveLength(4);

    const { doc, inverse } = expectPureInverseRoundTrip(document, {
      name: "removeBlock",
      blockId: "div_c301",
      shouldRemoveEmptyAncestors: true,
    });
    expect(doc.col_c302).toBeUndefined();
    const row = doc.row_k1l2 as RowBlock;
    expect(row.childrenIds).toEqual(["col_m3n4", "col_p5q6", "col_c402"]);
    for (const columnId of row.childrenIds) {
      expect((doc[columnId] as ColumnBlock).properties.widthPercent).toBeUndefined();
    }
    /*
      The survivors were already width-free, so the inverse carries no widths.
    */
    expect((inverse as RestoreBlocksOperation).previousWidths).toBeUndefined();
  });

  it("removing a COLUMN directly also re-equalizes the survivors", () => {
    const document = createSampleDocument();
    const { doc, inverse } = expectPureInverseRoundTrip(document, {
      name: "removeBlock",
      blockId: "col_m3n4",
      shouldRemoveEmptyAncestors: true,
    });
    expect(doc.col_m3n4).toBeUndefined();
    expect(doc.txt_r7s8).toBeUndefined();
    expect((doc.row_k1l2 as RowBlock).childrenIds).toEqual(["col_p5q6"]);
    expect((doc.col_p5q6 as ColumnBlock).properties.widthPercent).toBeUndefined();
    expect((inverse as RestoreBlocksOperation).previousWidths).toEqual([
      { columnId: "col_p5q6", widthPercent: 40 },
    ]);
  });

  it("does not cascade for a leaf sitting directly in a section", () => {
    const document = createSampleDocument();
    const { doc } = expectPureInverseRoundTrip(document, {
      name: "removeBlock",
      blockId: "img_g7h8",
      shouldRemoveEmptyAncestors: true,
    });
    expect((doc.sec_a1b2 as SectionBlock).childrenIds).toEqual(["txt_e5f6", "div_i9j0"]);
  });

  it("still refuses to remove the root, flag or not", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { name: "removeBlock", blockId: "root", shouldRemoveEmptyAncestors: true },
      code: "root_not_allowed",
    });
  });
});

describe("removeBlock cascade — emptied row collapses with its last column", () => {
  /*
    sec_c3d4's row reduced to one column (col_p5q6) via a first cascade.
  */
  function createSingleColumnRowDocument(): EmailDocument {
    return applyOrThrow(createSampleDocument(), REMOVE_LAST_IN_COLUMN_OP).doc;
  }

  it("deleting the last block of the row's last column deletes the entire row", () => {
    const document = createSingleColumnRowDocument();
    const { doc, inverse } = expectPureInverseRoundTrip(document, {
      name: "removeBlock",
      blockId: "btn_t9u0",
      shouldRemoveEmptyAncestors: true,
    });
    /*
      No empty column, no empty row — the whole chain is gone.
    */
    expect(doc.btn_t9u0).toBeUndefined();
    expect(doc.col_p5q6).toBeUndefined();
    expect(doc.row_k1l2).toBeUndefined();
    /*
      The section persists (sections never collapse).
    */
    expect((doc.sec_c3d4 as SectionBlock).childrenIds).toEqual([]);
    /*
      Row removal strips no widths: the inverse is a plain subtree restore.
    */
    expect(inverse).toEqual({
      name: "restoreBlocks",
      blocks: [document.row_k1l2, document.col_p5q6, document.btn_t9u0],
      parentId: "sec_c3d4",
      index: 0,
    });
  });

  it("keeps the row when another column still has content", () => {
    const document = createSampleDocument();
    const { doc } = expectPureInverseRoundTrip(document, REMOVE_LAST_IN_COLUMN_OP);
    expect(doc.row_k1l2).toBeDefined();
    expect((doc.row_k1l2 as RowBlock).childrenIds).toEqual(["col_p5q6"]);
  });
});

describe("removeBlock cascade — one undo, exact redo", () => {
  it("undo restores block + column + widths; redo re-collapses to the identical document", () => {
    const document = createSampleDocument();
    const removed = applyOrThrow(document, REMOVE_LAST_IN_COLUMN_OP);

    /*
      UNDO: one restoreBlocks puts everything back exactly.
    */
    const undone = applyOrThrow(removed.doc, removed.inverse);
    expect(undone.doc).toEqual(document);

    /*
      REDO: the undo's inverse re-strips the restored widths (flagged
      removeBlock of the column) and lands on the identical post-delete doc.
    */
    expect(undone.inverse).toEqual({
      name: "removeBlock",
      blockId: "col_m3n4",
      shouldRemoveEmptyAncestors: true,
    });
    const redone = applyOrThrow(undone.doc, undone.inverse);
    expect(redone.doc).toEqual(removed.doc);

    /*
      And the cycle stays stable: undoing the redo restores the original again.
    */
    expect(applyOrThrow(redone.doc, redone.inverse).doc).toEqual(document);
  });

  it("row-collapse case: undo/redo round-trips the entire row exactly", () => {
    const singleColumn = applyOrThrow(createSampleDocument(), REMOVE_LAST_IN_COLUMN_OP).doc;
    const removed = applyOrThrow(singleColumn, {
      name: "removeBlock",
      blockId: "btn_t9u0",
      shouldRemoveEmptyAncestors: true,
    });
    const undone = applyOrThrow(removed.doc, removed.inverse);
    expect(undone.doc).toEqual(singleColumn);
    expect(applyOrThrow(undone.doc, undone.inverse).doc).toEqual(removed.doc);
  });
});

describe("restoreBlocks with previousWidths", () => {
  it("fails with target_not_found when a previousWidths column does not exist", () => {
    const document = createSampleDocument();
    const removed = applyOrThrow(document, REMOVE_LAST_IN_COLUMN_OP);
    const inverse = removed.inverse as RestoreBlocksOperation;
    expectErrorCode({
      document: removed.doc,
      operation: {
        ...inverse,
        previousWidths: [{ columnId: "col_gone", widthPercent: 40 }],
      },
      code: "target_not_found",
    });
  });
});

describe("withRemoveBlockCascadeDefault", () => {
  it("defaults an undecided removeBlock to cascading", () => {
    expect(withRemoveBlockCascadeDefault({ name: "removeBlock", blockId: "txt_r7s8" })).toEqual({
      name: "removeBlock",
      blockId: "txt_r7s8",
      shouldRemoveEmptyAncestors: true,
    });
  });

  it("preserves an explicit choice", () => {
    const explicitOptOut: Operation = {
      name: "removeBlock",
      blockId: "txt_r7s8",
      shouldRemoveEmptyAncestors: false,
    };
    expect(withRemoveBlockCascadeDefault(explicitOptOut)).toBe(explicitOptOut);
  });

  it("passes non-removeBlock operations through untouched", () => {
    const reorder: Operation = {
      name: "reorderChildren",
      parentId: "sec_a1b2",
      orderedChildIds: ["img_g7h8", "txt_e5f6", "div_i9j0"],
    };
    expect(withRemoveBlockCascadeDefault(reorder)).toBe(reorder);
  });
});
