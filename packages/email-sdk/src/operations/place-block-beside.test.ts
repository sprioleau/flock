import { describe, expect, it } from "vitest";
import type { Block, ColumnBlock, DividerBlock, RowBlock, SectionBlock } from "../schema/blocks";
import { createSampleDocument, type EmailDocument } from "../store/document";
import {
  applyOperation,
  MAX_COLUMNS_PER_ROW,
  type ApplyOperationResult,
  type OperationErrorCode,
} from "./apply";
import type { Operation, PlaceBlockBesideOperation } from "./ops";

/*
  placeBlockBeside / unplaceBlockBeside — the drag-to-create-columns op pair.

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

const NEW_DIVIDER: DividerBlock = {
  id: "div_zz01",
  type: "divider",
  parentId: "col_zz02", /* overwritten with newColumnId on apply */
  childrenIds: [],
  properties: {},
};

/*
  A palette-style wrap-case drop: new divider on img_g7h8's right edge.
*/
const WRAP_NEW_BLOCK_OP: PlaceBlockBesideOperation = {
  name: "placeBlockBeside",
  targetBlockId: "img_g7h8",
  side: "right",
  content: { kind: "new-block", block: structuredClone(NEW_DIVIDER) },
  newColumnId: "col_zz02",
  newRowId: "row_zz03",
  newTargetColumnId: "col_zz04",
};

describe("placeBlockBeside — wrap case (target directly in a section)", () => {
  it("wraps the target in a new row of two width-less columns, content on the chosen side", () => {
    const document = createSampleDocument();
    const { doc } = expectPureInverseRoundTrip(document, WRAP_NEW_BLOCK_OP);

    const section = doc.sec_a1b2 as SectionBlock;
    expect(section.childrenIds).toEqual(["txt_e5f6", "row_zz03", "div_i9j0"]);

    const row = doc.row_zz03 as RowBlock;
    expect(row.parentId).toBe("sec_a1b2");
    /*
      side "right": target column first, content column second.
    */
    expect(row.childrenIds).toEqual(["col_zz04", "col_zz02"]);

    const targetColumn = doc.col_zz04 as ColumnBlock;
    expect(targetColumn.childrenIds).toEqual(["img_g7h8"]);
    expect(targetColumn.properties.widthPercent).toBeUndefined();
    expect(doc.img_g7h8!.parentId).toBe("col_zz04");

    const contentColumn = doc.col_zz02 as ColumnBlock;
    expect(contentColumn.childrenIds).toEqual(["div_zz01"]);
    expect(contentColumn.properties.widthPercent).toBeUndefined();
    expect(doc.div_zz01!.parentId).toBe("col_zz02");
  });

  it('side "left" puts the content column before the target column', () => {
    const document = createSampleDocument();
    const { doc } = expectPureInverseRoundTrip(document, {
      ...WRAP_NEW_BLOCK_OP,
      side: "left",
    });
    expect((doc.row_zz03 as RowBlock).childrenIds).toEqual(["col_zz02", "col_zz04"]);
  });

  it("moves an existing block from another section into the new column (and back on undo)", () => {
    const document = createSampleDocument();
    const operation: PlaceBlockBesideOperation = {
      ...WRAP_NEW_BLOCK_OP,
      content: { kind: "existing-block", blockId: "cod_x3y4" },
    };
    const { doc } = expectPureInverseRoundTrip(document, operation);
    expect(doc.cod_x3y4!.parentId).toBe("col_zz02");
    expect((doc.sec_e5f6 as SectionBlock).childrenIds).toEqual([
      "txt_v1w2",
      "spc_z5a6",
      "lnk_b7c8",
    ]);
  });

  it("moves an existing block from a column into the new column (old column left empty)", () => {
    const document = createSampleDocument();
    const operation: PlaceBlockBesideOperation = {
      ...WRAP_NEW_BLOCK_OP,
      content: { kind: "existing-block", blockId: "btn_t9u0" },
    };
    const { doc } = expectPureInverseRoundTrip(document, operation);
    expect(doc.btn_t9u0!.parentId).toBe("col_zz02");
    expect((doc.col_p5q6 as ColumnBlock).childrenIds).toEqual([]);
  });

  it("handles content coming from the SAME section as the target", () => {
    const document = createSampleDocument();
    const operation: PlaceBlockBesideOperation = {
      name: "placeBlockBeside",
      targetBlockId: "txt_e5f6",
      side: "right",
      content: { kind: "existing-block", blockId: "div_i9j0" },
      newColumnId: "col_zz02",
      newRowId: "row_zz03",
      newTargetColumnId: "col_zz04",
    };
    const { doc } = expectPureInverseRoundTrip(document, operation);
    expect((doc.sec_a1b2 as SectionBlock).childrenIds).toEqual(["row_zz03", "img_g7h8"]);
    expect(doc.div_i9j0!.parentId).toBe("col_zz02");
  });

  it("fails without the wrap scaffolding ids", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { ...WRAP_NEW_BLOCK_OP, newRowId: undefined, newTargetColumnId: undefined },
      code: "op_validation_failed",
    });
  });
});

describe("placeBlockBeside — insert case (target inside a column)", () => {
  const INSERT_NEW_BLOCK_OP: PlaceBlockBesideOperation = {
    name: "placeBlockBeside",
    targetBlockId: "txt_r7s8",
    side: "right",
    content: { kind: "new-block", block: structuredClone(NEW_DIVIDER) },
    newColumnId: "col_zz02",
  };

  it("inserts a new column beside the target's column and strips explicit widths", () => {
    const document = createSampleDocument();
    const { doc } = expectPureInverseRoundTrip(document, INSERT_NEW_BLOCK_OP);

    const row = doc.row_k1l2 as RowBlock;
    expect(row.childrenIds).toEqual(["col_m3n4", "col_zz02", "col_p5q6"]);
    /*
      Equal split: every explicit width stripped (undo restores 60/40 —
      asserted by the round-trip deep-equal above).
    */
    expect((doc.col_m3n4 as ColumnBlock).properties.widthPercent).toBeUndefined();
    expect((doc.col_p5q6 as ColumnBlock).properties.widthPercent).toBeUndefined();
    expect((doc.col_zz02 as ColumnBlock).properties.widthPercent).toBeUndefined();
    /*
      Untouched non-width properties survive the strip.
    */
    expect((doc.col_m3n4 as ColumnBlock).properties.verticalAlign).toBe("middle");
    expect(doc.div_zz01!.parentId).toBe("col_zz02");
  });

  it('side "left" inserts the new column before the target\'s column', () => {
    const document = createSampleDocument();
    const { doc } = expectPureInverseRoundTrip(document, { ...INSERT_NEW_BLOCK_OP, side: "left" });
    expect((doc.row_k1l2 as RowBlock).childrenIds).toEqual([
      "col_zz02",
      "col_m3n4",
      "col_p5q6",
    ]);
  });

  it("moves an existing block from a sibling column of the same row", () => {
    const document = createSampleDocument();
    const operation: PlaceBlockBesideOperation = {
      ...INSERT_NEW_BLOCK_OP,
      content: { kind: "existing-block", blockId: "btn_t9u0" },
    };
    const { doc } = expectPureInverseRoundTrip(document, operation);
    expect((doc.row_k1l2 as RowBlock).childrenIds).toEqual(["col_m3n4", "col_zz02", "col_p5q6"]);
    expect(doc.btn_t9u0!.parentId).toBe("col_zz02");
    expect((doc.col_p5q6 as ColumnBlock).childrenIds).toEqual([]);
  });

  it(`caps rows at ${MAX_COLUMNS_PER_ROW} columns`, () => {
    let document: EmailDocument = createSampleDocument();
    /*
      Grow the 2-column row to the cap, one placement at a time.
    */
    for (let columnCount = 2; columnCount < MAX_COLUMNS_PER_ROW; columnCount += 1) {
      const suffix = `zz0${columnCount}`;
      document = applyOrThrow(document, {
        ...INSERT_NEW_BLOCK_OP,
        content: {
          kind: "new-block",
          block: { ...structuredClone(NEW_DIVIDER), id: `div_${suffix}` },
        },
        newColumnId: `col_${suffix}`,
      }).doc;
    }
    expect((document.row_k1l2 as RowBlock).childrenIds).toHaveLength(MAX_COLUMNS_PER_ROW);
    expectErrorCode({
      document,
      operation: { ...INSERT_NEW_BLOCK_OP, newColumnId: "col_zz09" },
      code: "nesting_violation",
    });
  });
});

describe("placeBlockBeside — validation", () => {
  it("fails when the target does not exist", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { ...WRAP_NEW_BLOCK_OP, targetBlockId: "img_none" },
      code: "target_not_found",
    });
  });

  it("rejects non-leaf targets at the envelope (typed id schema)", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: {
        ...WRAP_NEW_BLOCK_OP,
        targetBlockId: "sec_a1b2",
      } as unknown as Operation,
      code: "op_validation_failed",
    });
  });

  it("fails when a scaffolding id already exists in the document", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: { ...WRAP_NEW_BLOCK_OP, newColumnId: "col_m3n4" },
      code: "duplicate_block_id",
    });
  });

  it("fails when the new content block's id already exists", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: {
        ...WRAP_NEW_BLOCK_OP,
        content: {
          kind: "new-block",
          block: { ...structuredClone(NEW_DIVIDER), id: "div_i9j0" },
        },
      },
      code: "duplicate_block_id",
    });
  });

  it("fails when placing a block beside itself", () => {
    expectErrorCode({
      document: createSampleDocument(),
      operation: {
        ...WRAP_NEW_BLOCK_OP,
        content: { kind: "existing-block", blockId: "img_g7h8" },
      },
      code: "op_validation_failed",
    });
  });
});

describe("unplaceBlockBeside — inverse fidelity", () => {
  it("redo cycle: undo's inverse reapplies to the exact post-placement document", () => {
    for (const content of [
      { kind: "new-block", block: structuredClone(NEW_DIVIDER) } as const,
      { kind: "existing-block", blockId: "btn_t9u0" } as const,
    ]) {
      const document = createSampleDocument();
      const placed = applyOrThrow(document, { ...WRAP_NEW_BLOCK_OP, content });
      const undone = applyOrThrow(placed.doc, placed.inverse);
      expect(undone.doc).toEqual(document);
      /*
        The undo's inverse is a placeBlockBeside that restores the placement.
      */
      expect(undone.inverse.name).toBe("placeBlockBeside");
      const redone = applyOrThrow(undone.doc, undone.inverse);
      expect(redone.doc).toEqual(placed.doc);
    }
  });

  it("refuses to dissolve a column a newer change landed in (undo conflict)", () => {
    const document = createSampleDocument();
    const placed = applyOrThrow(document, WRAP_NEW_BLOCK_OP);
    const extraBlock: Block = {
      id: "spc_zz09",
      type: "spacer",
      parentId: "col_zz02",
      childrenIds: [],
      properties: { height: 8 },
    };
    const grown = applyOrThrow(placed.doc, {
      name: "addBlock",
      block: extraBlock,
      parentId: "col_zz02",
      index: 1,
    });
    expectErrorCode({
      document: grown.doc,
      operation: placed.inverse,
      code: "op_validation_failed",
    });
  });

  it("fails when previousWidths references a missing column", () => {
    const document = createSampleDocument();
    const placed = applyOrThrow(document, {
      name: "placeBlockBeside",
      targetBlockId: "txt_r7s8",
      side: "right",
      content: { kind: "new-block", block: structuredClone(NEW_DIVIDER) },
      newColumnId: "col_zz02",
    });
    expect(placed.inverse.name).toBe("unplaceBlockBeside");
    if (placed.inverse.name !== "unplaceBlockBeside") {
      return;
    }
    expectErrorCode({
      document: placed.doc,
      operation: {
        ...placed.inverse,
        previousWidths: [{ columnId: "col_zz08", widthPercent: 50 }],
      },
      code: "target_not_found",
    });
  });
});
