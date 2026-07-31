import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createEmptyDocument,
  resolveScaffoldSectionOperation,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@tandem/email-sdk";
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
  parentId: id(parentId),
  beforeChildId: beforeChildId === null ? null : id(beforeChildId),
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

  it("columns tile → ONE restoreBlocks carrying row + equal columns", () => {
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
    for (const column of columns) {
      expect(column.parentId).toBe(row!.id);
    }
    const applied = apply(doc, insertion!.op);
    expect(applied[id("sec_bbbb")]?.childrenIds).toEqual([row!.id]);
    expect(applied[row!.id as BlockId]?.childrenIds).toHaveLength(2);
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
