import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createEmptyDocument,
  resolveScaffoldSectionOperation,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import {
  createDefaultColumnsPreset,
  createDefaultLeafBlock,
  createDefaultSection,
} from "../block-defaults";
import type { PaletteItem } from "../add-blocks/palette-items";
import type { DropTarget } from "./drag-drop-store";
import {
  buildDropOperation,
  buildPaletteDropInsertion,
  computeReorderedChildIds,
  resolveColumnCellHitBlockId,
  resolveColumnSplitCandidate,
  resolveContainerId,
} from "./drop-target";

/**
 * Pure-logic coverage for the drop pipeline (resolveDropTarget itself needs
 * live DOM rects and is exercised in the browser): the op each drop
 * dispatches, for both drag sources. Every produced op must APPLY cleanly —
 * the SDK's validation is the arbiter that palette insertions are
 * well-formed documents.
 */

const id = (value: string) => value as BlockId;

function apply(doc: EmailDocument, op: Operation): EmailDocument {
  const result = applyOperation(doc, op);
  if (!result.isOk) {
    throw new Error(`fixture apply failed: ${JSON.stringify(result.errors)}`);
  }
  return result.doc;
}

/** root > sec_aaaa [txt_aaaa, btn_aaaa] , sec_bbbb [] */
function buildFixtureDoc(): EmailDocument {
  let doc = createEmptyDocument();
  doc = apply(doc, { name: "addSection", section: createDefaultSection(id("sec_aaaa")), index: 0 });
  doc = apply(doc, { name: "addSection", section: createDefaultSection(id("sec_bbbb")), index: 1 });
  doc = apply(doc, {
    name: "addBlock",
    block: createDefaultLeafBlock({ type: "text", id: id("txt_aaaa"), parentId: id("sec_aaaa"), doc }),
    parentId: id("sec_aaaa"),
    index: 0,
  });
  doc = apply(doc, {
    name: "addBlock",
    block: createDefaultLeafBlock({
      type: "button",
      id: id("btn_aaaa"),
      parentId: id("sec_aaaa"),
      doc,
    }),
    parentId: id("sec_aaaa"),
    index: 1,
  });
  return doc;
}

const dropTarget = (parentId: string, beforeChildId: string | null): DropTarget => ({
  kind: "insert",
  documentId: null,
  parentId: id(parentId),
  beforeChildId: beforeChildId === null ? null : id(beforeChildId),
  isNoop: false,
  indicatorLine: null,
});

const columnSplitDropTarget = (targetBlockId: string, side: "left" | "right"): DropTarget => ({
  kind: "column-split",
  documentId: null,
  targetBlockId: id(targetBlockId),
  side,
  isNoop: false,
  indicatorLine: null,
});

const leafItem: PaletteItem = {
  kind: "leaf",
  id: "text",
  blockType: "text",
  label: "Text",
  description: "",
  Icon: (() => null) as unknown as PaletteItem["Icon"],
};
const columnsItem: PaletteItem = { ...leafItem, kind: "columns", id: "columns-2", columnCount: 2 };
const emptySectionItem: PaletteItem = { ...leafItem, kind: "empty-section", id: "empty-section" };
const templateItem: PaletteItem = {
  ...leafItem,
  kind: "section-template",
  id: "template-hero",
  templateId: "hero",
};

describe("buildPaletteDropInsertion", () => {
  it("leaf tile → one addBlock with defaults at the resolved index", () => {
    const doc = buildFixtureDoc();
    const insertion = buildPaletteDropInsertion({
      doc,
      item: leafItem,
      dropTarget: dropTarget("sec_aaaa", "btn_aaaa"),
    });
    expect(insertion).not.toBeNull();
    expect(insertion!.op.name).toBe("addBlock");
    if (insertion!.op.name !== "addBlock") return;
    expect(insertion!.op.parentId).toBe("sec_aaaa");
    expect(insertion!.op.index).toBe(1); // before btn_aaaa
    expect(insertion!.op.block.type).toBe("text");
    expect(insertion!.op.block.id).toBe(insertion!.newBlockId);
    expect(doc[insertion!.newBlockId!]).toBeUndefined(); // fresh id
    const applied = apply(doc, insertion!.op);
    expect(applied[id("sec_aaaa")]?.childrenIds).toEqual(["txt_aaaa", insertion!.newBlockId, "btn_aaaa"]);
  });

  it("leaf tile → append when beforeChildId is null", () => {
    const doc = buildFixtureDoc();
    const insertion = buildPaletteDropInsertion({
      doc,
      item: leafItem,
      dropTarget: dropTarget("sec_aaaa", null),
    });
    expect(insertion!.op.name === "addBlock" && insertion!.op.index).toBe(2);
  });

  it("columns tile → ONE restoreBlocks carrying row + equal SPACER-SEEDED columns", () => {
    const doc = buildFixtureDoc();
    const insertion = buildPaletteDropInsertion({
      doc,
      item: columnsItem,
      dropTarget: dropTarget("sec_bbbb", null),
    });
    expect(insertion).not.toBeNull();
    expect(insertion!.op.name).toBe("restoreBlocks");
    if (insertion!.op.name !== "restoreBlocks") return;
    const [row, ...rest] = insertion!.op.blocks;
    expect(row!.type).toBe("row");
    expect(row!.id).toBe(insertion!.newBlockId);
    const columns = rest.filter((block) => block.type === "column");
    expect(columns).toHaveLength(2);
    const applied = apply(doc, insertion!.op);
    expect(applied[id("sec_bbbb")]?.childrenIds).toEqual([row!.id]);
    expect(applied[row!.id as BlockId]?.childrenIds).toHaveLength(2);
    // Each fresh column carries ONE spacer: the seed that keeps the layout
    // alive under removeBlock's empty-column cascade (deleting a column's
    // spacer collapses that column; the last one removes the whole row).
    for (const column of columns) {
      expect(column.parentId).toBe(row!.id);
      const appliedColumn = applied[column.id as BlockId];
      expect(appliedColumn?.childrenIds).toHaveLength(1);
      expect(applied[appliedColumn!.childrenIds[0]! as BlockId]?.type).toBe("spacer");
    }
  });

  it("4-columns tile → four equal spacer-seeded columns, still ONE restoreBlocks", () => {
    const doc = buildFixtureDoc();
    const insertion = buildPaletteDropInsertion({
      doc,
      item: { ...columnsItem, id: "columns-4", columnCount: 4 },
      dropTarget: dropTarget("sec_bbbb", null),
    });
    expect(insertion).not.toBeNull();
    if (insertion!.op.name !== "restoreBlocks") throw new Error("expected restoreBlocks");
    const applied = apply(doc, insertion!.op);
    const rowId = insertion!.newBlockId! as BlockId;
    const columnIds = applied[rowId]!.childrenIds as readonly BlockId[];
    expect(columnIds).toHaveLength(4);
    const widths = columnIds.map((columnId) => {
      const column = applied[columnId]!;
      expect(column.childrenIds).toHaveLength(1);
      expect(applied[column.childrenIds[0]! as BlockId]?.type).toBe("spacer");
      return column.type === "column" ? column.properties.widthPercent : undefined;
    });
    expect(widths.reduce((total: number, width) => total + (width ?? 0), 0)).toBeCloseTo(100, 2);
    // The preset lands AT the 4-column cap: every leaf's edge zones must be
    // dead, so the at-cap deactivation survives the new tile.
    const seededSpacerId = applied[columnIds[0]!]!.childrenIds[0]! as BlockId;
    expect(
      resolveColumnSplitCandidate({
        doc: applied,
        draggedType: "text",
        draggedBlockId: null,
        hitBlockId: seededSpacerId,
      }),
    ).toBeNull();
  });

  it("empty-section tile → one addSection at the root index", () => {
    const doc = buildFixtureDoc();
    const insertion = buildPaletteDropInsertion({
      doc,
      item: emptySectionItem,
      dropTarget: dropTarget("root", "sec_bbbb"),
    });
    expect(insertion!.op.name).toBe("addSection");
    if (insertion!.op.name !== "addSection") return;
    expect(insertion!.op.index).toBe(1); // between sec_aaaa and sec_bbbb
    const applied = apply(doc, insertion!.op);
    expect(applied[id("root")]?.childrenIds).toEqual(["sec_aaaa", insertion!.newBlockId, "sec_bbbb"]);
  });

  it("template tile → ONE scaffoldSection intent anchored above the gap's section", () => {
    const doc = buildFixtureDoc();
    const insertion = buildPaletteDropInsertion({
      doc,
      item: templateItem,
      dropTarget: dropTarget("root", "sec_bbbb"),
    });
    expect(insertion).not.toBeNull();
    expect(insertion!.op.name).toBe("scaffoldSection");
    if (insertion!.op.name !== "scaffoldSection") return;
    expect(insertion!.op.templateId).toBe("hero");
    expect(insertion!.op.position).toEqual({ beforeSectionId: "sec_bbbb" });
    // The id is only known after dispatch resolves the intent (newBlockId
    // null is the read-it-from-the-applied-op contract, as in click-to-add).
    expect(insertion!.newBlockId).toBeNull();
    // The intent must RESOLVE against this document to one applying addSection
    // in the gap — the same translation dispatch performs.
    const resolved = resolveScaffoldSectionOperation({ doc, input: insertion!.op });
    expect(resolved.isOk).toBe(true);
    if (!resolved.isOk) return;
    expect(resolved.op.index).toBe(1); // between sec_aaaa and sec_bbbb
    const applied = apply(doc, resolved.op);
    expect(applied[id("root")]?.childrenIds).toEqual([
      "sec_aaaa",
      resolved.op.section.id,
      "sec_bbbb",
    ]);
  });

  it("template tile → position \"bottom\" when the gap appends (null reference)", () => {
    const doc = buildFixtureDoc();
    const insertion = buildPaletteDropInsertion({
      doc,
      item: templateItem,
      dropTarget: dropTarget("root", null),
    });
    expect(insertion!.op.name === "scaffoldSection" && insertion!.op.position).toBe("bottom");
  });
});

describe("buildDropOperation (existing-block drags, regression)", () => {
  it("same-parent drop → one reorderChildren", () => {
    const doc = buildFixtureDoc();
    const op = buildDropOperation({
      doc,
      draggedBlockId: id("btn_aaaa"),
      dropTarget: dropTarget("sec_aaaa", "txt_aaaa"),
    });
    expect(op).toEqual({
      name: "reorderChildren",
      parentId: "sec_aaaa",
      orderedChildIds: ["btn_aaaa", "txt_aaaa"],
    });
  });

  it("cross-parent drop → one moveBlock at the resolved index", () => {
    const doc = buildFixtureDoc();
    const op = buildDropOperation({
      doc,
      draggedBlockId: id("txt_aaaa"),
      dropTarget: dropTarget("sec_bbbb", null),
    });
    expect(op).toEqual({
      name: "moveBlock",
      blockId: "txt_aaaa",
      newParentId: "sec_bbbb",
      index: 0,
    });
  });

  it("noop targets dispatch nothing", () => {
    const doc = buildFixtureDoc();
    const op = buildDropOperation({
      doc,
      draggedBlockId: id("txt_aaaa"),
      dropTarget: { ...dropTarget("sec_aaaa", "txt_aaaa"), isNoop: true },
    });
    expect(op).toBeNull();
  });
});

describe("buildDropOperation (existing-SECTION drags — owner reversal of arrows-only)", () => {
  it("section drop into a root gap → ONE reorderChildren on root (single undo)", () => {
    const doc = buildFixtureDoc();
    const op = buildDropOperation({
      doc,
      draggedBlockId: id("sec_bbbb"),
      dropTarget: dropTarget("root", "sec_aaaa"),
    });
    expect(op).toEqual({
      name: "reorderChildren",
      parentId: "root",
      orderedChildIds: ["sec_bbbb", "sec_aaaa"],
    });
    const applied = apply(doc, op!);
    expect(applied[id("root")]?.childrenIds).toEqual(["sec_bbbb", "sec_aaaa"]);
  });

  it("first section dragged to the end (null reference appends)", () => {
    const doc = buildFixtureDoc();
    const op = buildDropOperation({
      doc,
      draggedBlockId: id("sec_aaaa"),
      dropTarget: dropTarget("root", null),
    });
    expect(op).toEqual({
      name: "reorderChildren",
      parentId: "root",
      orderedChildIds: ["sec_bbbb", "sec_aaaa"],
    });
  });

  it("same-position section drop reorders to the identical list (resolver marks it noop)", () => {
    const doc = buildFixtureDoc();
    // resolveDropTarget derives isNoop from exactly this equality; pin it so
    // a release-in-place stays dispatch-free.
    expect(
      computeReorderedChildIds({
        childIds: doc[id("root")]!.childrenIds,
        draggedBlockId: id("sec_aaaa"),
        beforeChildId: id("sec_bbbb"),
      }),
    ).toEqual(doc[id("root")]!.childrenIds);
  });
});

describe("resolveContainerId (nesting legality, pure hit-chain walk)", () => {
  /** Fixture doc plus a 2-column row inside sec_bbbb; returns a column id. */
  function buildColumnsFixture(): { doc: EmailDocument; columnId: BlockId } {
    const base = buildFixtureDoc();
    const preset = createDefaultColumnsPreset({ columnCount: 2, sectionId: id("sec_bbbb"), doc: base });
    const doc = apply(base, {
      name: "restoreBlocks",
      blocks: preset.blocks,
      parentId: id("sec_bbbb"),
      index: 0,
    });
    const columnId = doc[preset.rowId]?.childrenIds[0];
    if (columnId === undefined) {
      throw new Error("columns fixture has no column");
    }
    return { doc, columnId };
  }

  it("a dragged SECTION over a leaf in another section resolves to root, never the section", () => {
    const doc = buildFixtureDoc();
    expect(resolveContainerId({ doc, draggedType: "section", hitBlockId: id("txt_aaaa") })).toBe(
      "root",
    );
    expect(resolveContainerId({ doc, draggedType: "section", hitBlockId: id("sec_aaaa") })).toBe(
      "root",
    );
  });

  it("a dragged SECTION over a column resolves to root — sections never enter columns", () => {
    const { doc, columnId } = buildColumnsFixture();
    expect(resolveContainerId({ doc, draggedType: "section", hitBlockId: columnId })).toBe("root");
  });

  it("a dragged SECTION over canvas padding (no block) resolves to root", () => {
    const doc = buildFixtureDoc();
    expect(resolveContainerId({ doc, draggedType: "section", hitBlockId: null })).toBe("root");
  });

  it("a dragged LEAF over a column resolves to that column (regression)", () => {
    const { doc, columnId } = buildColumnsFixture();
    expect(resolveContainerId({ doc, draggedType: "text", hitBlockId: columnId })).toBe(columnId);
  });

  it("a dragged LEAF over canvas padding resolves to nothing — leaves are not root-legal", () => {
    const doc = buildFixtureDoc();
    expect(resolveContainerId({ doc, draggedType: "text", hitBlockId: null })).toBeNull();
  });
});

describe("resolveColumnCellHitBlockId (empty-column cells are first-class targets)", () => {
  /**
   * Fixture: sec_bbbb holds a 2-column row whose SECOND column was emptied
   * (its seed spacer moved out) — the owner-repro shape where an empty
   * column's cell hit-tests to the ROW because the column shell only covers
   * its min-height strip.
   */
  function buildEmptyColumnFixture(): {
    doc: EmailDocument;
    rowId: BlockId;
    filledColumnId: BlockId;
    emptyColumnId: BlockId;
  } {
    const base = buildFixtureDoc();
    const preset = createDefaultColumnsPreset({ columnCount: 2, sectionId: id("sec_bbbb"), doc: base });
    let doc = apply(base, {
      name: "restoreBlocks",
      blocks: preset.blocks,
      parentId: id("sec_bbbb"),
      index: 0,
    });
    const rowId = preset.rowId;
    const [filledColumnId, emptyColumnId] = doc[rowId]!.childrenIds as readonly BlockId[];
    // Empty the second column by MOVING its seed spacer out (moveBlock does
    // not cascade — this is exactly how empty columns arise in practice).
    doc = apply(doc, {
      name: "moveBlock",
      blockId: doc[emptyColumnId!]!.childrenIds[0]! as BlockId,
      newParentId: id("sec_aaaa"),
      index: 0,
    });
    expect(doc[emptyColumnId!]?.childrenIds).toHaveLength(0);
    return { doc, rowId, filledColumnId: filledColumnId!, emptyColumnId: emptyColumnId! };
  }

  /** Cells tile the row: filled column spans x 0–100, empty column 100–200. */
  const getColumnSpan =
    (fixture: { filledColumnId: BlockId; emptyColumnId: BlockId }) =>
    (columnId: BlockId): { left: number; right: number } | null =>
      columnId === fixture.filledColumnId
        ? { left: 0, right: 100 }
        : columnId === fixture.emptyColumnId
          ? { left: 100, right: 200 }
          : null;

  it("a ROW hit refines to the column whose cell span contains the pointer", () => {
    const fixture = buildEmptyColumnFixture();
    expect(
      resolveColumnCellHitBlockId({
        doc: fixture.doc,
        hitBlockId: fixture.rowId,
        pointerX: 150,
        getColumnSpan: getColumnSpan(fixture),
      }),
    ).toBe(fixture.emptyColumnId);
    expect(
      resolveColumnCellHitBlockId({
        doc: fixture.doc,
        hitBlockId: fixture.rowId,
        pointerX: 50,
        getColumnSpan: getColumnSpan(fixture),
      }),
    ).toBe(fixture.filledColumnId);
  });

  it("…and the refined hit resolves a LEAF drag to the empty column itself", () => {
    const fixture = buildEmptyColumnFixture();
    const hitBlockId = resolveColumnCellHitBlockId({
      doc: fixture.doc,
      hitBlockId: fixture.rowId,
      pointerX: 150,
      getColumnSpan: getColumnSpan(fixture),
    });
    expect(resolveContainerId({ doc: fixture.doc, draggedType: "text", hitBlockId })).toBe(
      fixture.emptyColumnId,
    );
    // …and never to a column-split (splits need a LEAF under the pointer).
    expect(
      resolveColumnSplitCandidate({
        doc: fixture.doc,
        draggedType: "text",
        draggedBlockId: null,
        hitBlockId,
      }),
    ).toBeNull();
  });

  it("palette drop into the empty column → one addBlock as its first child", () => {
    const fixture = buildEmptyColumnFixture();
    const insertion = buildPaletteDropInsertion({
      doc: fixture.doc,
      item: leafItem,
      dropTarget: dropTarget(fixture.emptyColumnId, null),
    });
    expect(insertion!.op).toMatchObject({ name: "addBlock", parentId: fixture.emptyColumnId, index: 0 });
    const applied = apply(fixture.doc, insertion!.op as Operation);
    expect(applied[fixture.emptyColumnId]?.childrenIds).toEqual([insertion!.newBlockId]);
  });

  it("existing-block drop into the empty column → one moveBlock as its first child", () => {
    const fixture = buildEmptyColumnFixture();
    const op = buildDropOperation({
      doc: fixture.doc,
      draggedBlockId: id("btn_aaaa"),
      dropTarget: dropTarget(fixture.emptyColumnId, null),
    });
    expect(op).toEqual({
      name: "moveBlock",
      blockId: "btn_aaaa",
      newParentId: fixture.emptyColumnId,
      index: 0,
    });
    const applied = apply(fixture.doc, op!);
    expect(applied[fixture.emptyColumnId]?.childrenIds).toEqual(["btn_aaaa"]);
  });

  it("non-row hits pass through untouched; a row hit with no matching span stays a row hit", () => {
    const fixture = buildEmptyColumnFixture();
    expect(
      resolveColumnCellHitBlockId({
        doc: fixture.doc,
        hitBlockId: id("txt_aaaa"),
        pointerX: 150,
        getColumnSpan: getColumnSpan(fixture),
      }),
    ).toBe("txt_aaaa");
    expect(
      resolveColumnCellHitBlockId({
        doc: fixture.doc,
        hitBlockId: null,
        pointerX: 150,
        getColumnSpan: getColumnSpan(fixture),
      }),
    ).toBeNull();
    expect(
      resolveColumnCellHitBlockId({
        doc: fixture.doc,
        hitBlockId: fixture.rowId,
        pointerX: 999,
        getColumnSpan: getColumnSpan(fixture),
      }),
    ).toBe(fixture.rowId);
  });
});

describe("column-split drops (drag-to-create columns)", () => {
  /** Fixture doc plus a 2-column row in sec_bbbb with a leaf in column A. */
  function buildColumnLeafFixture(): { doc: EmailDocument; columnLeafId: BlockId } {
    const base = buildFixtureDoc();
    const preset = createDefaultColumnsPreset({
      columnCount: 2,
      sectionId: id("sec_bbbb"),
      doc: base,
    });
    let doc = apply(base, {
      name: "restoreBlocks",
      blocks: preset.blocks,
      parentId: id("sec_bbbb"),
      index: 0,
    });
    const columnId = doc[preset.rowId]!.childrenIds[0]! as BlockId;
    const columnLeafId = id("txt_incl");
    doc = apply(doc, {
      name: "addBlock",
      block: createDefaultLeafBlock({ type: "text", id: columnLeafId, parentId: columnId, doc }),
      parentId: columnId,
      index: 0,
    });
    return { doc, columnLeafId };
  }

  it("existing-block edge drop on a section-level leaf → ONE placeBlockBeside (wrap case) that applies", () => {
    const doc = buildFixtureDoc();
    const op = buildDropOperation({
      doc,
      draggedBlockId: id("btn_aaaa"),
      dropTarget: columnSplitDropTarget("txt_aaaa", "right"),
    });
    expect(op).not.toBeNull();
    expect(op!.name).toBe("placeBlockBeside");
    if (op!.name !== "placeBlockBeside") return;
    expect(op!.targetBlockId).toBe("txt_aaaa");
    expect(op!.side).toBe("right");
    expect(op!.content).toEqual({ kind: "existing-block", blockId: "btn_aaaa" });
    // Wrap case: the section-level target needs the full scaffolding.
    expect(op!.newRowId).toBeDefined();
    expect(op!.newTargetColumnId).toBeDefined();
    const applied = apply(doc, op!);
    expect(applied[op!.newRowId! as BlockId]?.childrenIds).toEqual([
      op!.newTargetColumnId,
      op!.newColumnId,
    ]);
    expect(applied[id("btn_aaaa")]?.parentId).toBe(op!.newColumnId);
    expect(applied[id("txt_aaaa")]?.parentId).toBe(op!.newTargetColumnId);
  });

  it("edge drop on a leaf already inside a column → insert case (no row scaffolding) that applies", () => {
    const { doc, columnLeafId } = buildColumnLeafFixture();
    const op = buildDropOperation({
      doc,
      draggedBlockId: id("btn_aaaa"),
      dropTarget: columnSplitDropTarget(columnLeafId, "left"),
    });
    expect(op).not.toBeNull();
    if (op!.name !== "placeBlockBeside") return;
    expect(op!.newRowId).toBeUndefined();
    expect(op!.newTargetColumnId).toBeUndefined();
    const applied = apply(doc, op!);
    const targetColumnId = doc[columnLeafId]!.parentId! as BlockId;
    const rowId = doc[targetColumnId]!.parentId! as BlockId;
    // side "left": the new column lands before the target's column.
    const rowChildIds = applied[rowId]!.childrenIds as readonly BlockId[];
    expect(rowChildIds.indexOf(op!.newColumnId as BlockId)).toBe(
      rowChildIds.indexOf(targetColumnId) - 1,
    );
  });

  it("palette edge drop → ONE placeBlockBeside carrying a default-built new leaf", () => {
    const doc = buildFixtureDoc();
    const insertion = buildPaletteDropInsertion({
      doc,
      item: leafItem,
      dropTarget: columnSplitDropTarget("txt_aaaa", "right"),
    });
    expect(insertion).not.toBeNull();
    expect(insertion!.op.name).toBe("placeBlockBeside");
    if (insertion!.op.name !== "placeBlockBeside") return;
    expect(insertion!.op.content.kind).toBe("new-block");
    if (insertion!.op.content.kind !== "new-block") return;
    expect(insertion!.op.content.block.id).toBe(insertion!.newBlockId);
    expect(doc[insertion!.newBlockId!]).toBeUndefined(); // fresh id
    const applied = apply(doc, insertion!.op);
    expect(applied[insertion!.newBlockId!]?.parentId).toBe(insertion!.op.newColumnId);
    expect(applied[insertion!.newBlockId!]?.type).toBe("text");
  });

  it("non-leaf palette items never produce a column-split insertion", () => {
    const doc = buildFixtureDoc();
    for (const item of [columnsItem, emptySectionItem, templateItem]) {
      expect(
        buildPaletteDropInsertion({ doc, item, dropTarget: columnSplitDropTarget("txt_aaaa", "left") }),
      ).toBeNull();
    }
  });

  it("resolveColumnSplitCandidate gates on leaf-over-leaf, self-drops, and the column cap", () => {
    const { doc, columnLeafId } = buildColumnLeafFixture();
    // Eligible: leaf dragged over a section-level leaf, or a column leaf.
    expect(
      resolveColumnSplitCandidate({
        doc,
        draggedType: "button",
        draggedBlockId: id("btn_aaaa"),
        hitBlockId: id("txt_aaaa"),
      }),
    ).toEqual({ targetBlockId: "txt_aaaa" });
    expect(
      resolveColumnSplitCandidate({
        doc,
        draggedType: "button",
        draggedBlockId: id("btn_aaaa"),
        hitBlockId: columnLeafId,
      }),
    ).toEqual({ targetBlockId: columnLeafId });
    // Ineligible: dragging a section, hovering a section, hovering yourself.
    expect(
      resolveColumnSplitCandidate({
        doc,
        draggedType: "section",
        draggedBlockId: id("sec_aaaa"),
        hitBlockId: id("txt_aaaa"),
      }),
    ).toBeNull();
    expect(
      resolveColumnSplitCandidate({
        doc,
        draggedType: "button",
        draggedBlockId: id("btn_aaaa"),
        hitBlockId: id("sec_aaaa"),
      }),
    ).toBeNull();
    expect(
      resolveColumnSplitCandidate({
        doc,
        draggedType: "text",
        draggedBlockId: id("txt_aaaa"),
        hitBlockId: id("txt_aaaa"),
      }),
    ).toBeNull();
  });

  it("edge zones deactivate at the 4-column cap (grown via successive edge drops)", () => {
    const fixture = buildColumnLeafFixture();
    const { columnLeafId } = fixture;
    let doc = fixture.doc;
    // Grow the 2-column row to 4 columns with palette edge drops.
    for (let drops = 0; drops < 2; drops += 1) {
      expect(
        resolveColumnSplitCandidate({
          doc,
          draggedType: "text",
          draggedBlockId: null,
          hitBlockId: columnLeafId,
        }),
      ).not.toBeNull();
      const insertion = buildPaletteDropInsertion({
        doc,
        item: leafItem,
        dropTarget: columnSplitDropTarget(columnLeafId, "right"),
      });
      if (insertion === null || insertion.op.name !== "placeBlockBeside") {
        throw new Error("expected a placeBlockBeside insertion");
      }
      doc = apply(doc, insertion.op);
    }
    const rowId = doc[doc[columnLeafId]!.parentId! as BlockId]!.parentId! as BlockId;
    expect(doc[rowId]?.childrenIds).toHaveLength(4);
    // At the cap the candidate resolver goes dead for every leaf in the row.
    expect(
      resolveColumnSplitCandidate({
        doc,
        draggedType: "text",
        draggedBlockId: null,
        hitBlockId: columnLeafId,
      }),
    ).toBeNull();
  });
});

describe("computeReorderedChildIds", () => {
  it("moves the dragged id before the reference child", () => {
    expect(
      computeReorderedChildIds({
        childIds: [id("a"), id("b"), id("c")],
        draggedBlockId: id("c"),
        beforeChildId: id("a"),
      }),
    ).toEqual(["c", "a", "b"]);
  });

  it("null reference appends", () => {
    expect(
      computeReorderedChildIds({
        childIds: [id("a"), id("b")],
        draggedBlockId: id("a"),
        beforeChildId: null,
      }),
    ).toEqual(["b", "a"]);
  });
});
