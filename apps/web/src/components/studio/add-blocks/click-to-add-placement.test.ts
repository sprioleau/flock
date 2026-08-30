import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createEmptyDocument,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import {
  createDefaultColumnsPreset,
  createDefaultLeafBlock,
  createDefaultSection,
} from "../block-defaults";
import { buildClickToAddPlan } from "./click-to-add-placement";
import type { PaletteItem } from "./palette-items";

/*
  The click-to-add placement rules (proposal §4.3): selection-aware targets,
  and ONE op per click even on an empty document (composite addSection).
*/

const id = (value: string) => value as BlockId;

function apply(doc: EmailDocument, op: Operation): EmailDocument {
  const result = applyOperation(doc, op);
  if (!result.isOk) {
    throw new Error(`fixture apply failed: ${JSON.stringify(result.errors)}`);
  }
  return result.doc;
}

/*
  root > sec_aaaa [txt_aaaa, row(2 cols)] , sec_bbbb [btn_bbbb]
*/
function buildFixtureDoc(): { doc: EmailDocument; rowId: BlockId; firstColumnId: BlockId } {
  let doc = createEmptyDocument();
  doc = apply(doc, { name: "addSection", section: createDefaultSection(id("sec_aaaa")), index: 0 });
  doc = apply(doc, { name: "addSection", section: createDefaultSection(id("sec_bbbb")), index: 1 });
  doc = apply(doc, {
    name: "addBlock",
    block: createDefaultLeafBlock({ type: "text", id: id("txt_aaaa"), parentId: id("sec_aaaa"), doc }),
    parentId: id("sec_aaaa"),
    index: 0,
  });
  const preset = createDefaultColumnsPreset({ columnCount: 2, sectionId: id("sec_aaaa"), doc });
  doc = apply(doc, { name: "restoreBlocks", blocks: preset.blocks, parentId: id("sec_aaaa"), index: 1 });
  doc = apply(doc, {
    name: "addBlock",
    block: createDefaultLeafBlock({
      type: "button",
      id: id("btn_bbbb"),
      parentId: id("sec_bbbb"),
      doc,
    }),
    parentId: id("sec_bbbb"),
    index: 0,
  });
  const firstColumnId = preset.blocks[1]!.id as BlockId;
  return { doc, rowId: preset.rowId, firstColumnId };
}

const textItem: PaletteItem = {
  kind: "leaf",
  id: "text",
  blockType: "text",
  label: "Text",
  description: "",
  Icon: (() => null) as unknown as PaletteItem["Icon"],
};
const columnsItem: PaletteItem = { ...textItem, kind: "columns", id: "columns-3", columnCount: 3 };
const emptySectionItem: PaletteItem = { ...textItem, kind: "empty-section", id: "empty-section" };
const heroItem: PaletteItem = {
  ...textItem,
  kind: "section-template",
  id: "template-hero",
  templateId: "hero",
};

describe("buildClickToAddPlan: leaf items", () => {
  it("selected leaf → inserts AFTER it in its parent", () => {
    const { doc } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: textItem, selectedBlockId: id("txt_aaaa") });
    expect(plan!.op).toMatchObject({ name: "addBlock", parentId: "sec_aaaa", index: 1 });
  });

  it("selected column → appends to the column (after its seed spacer)", () => {
    const { doc, firstColumnId } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: textItem, selectedBlockId: firstColumnId });
    expect(plan!.op).toMatchObject({ name: "addBlock", parentId: firstColumnId, index: 1 });
  });

  it("selected section → appends to the section", () => {
    const { doc } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: textItem, selectedBlockId: id("sec_bbbb") });
    expect(plan!.op).toMatchObject({ name: "addBlock", parentId: "sec_bbbb", index: 1 });
  });

  it("selected row → appends to the row's section", () => {
    const { doc, rowId } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: textItem, selectedBlockId: rowId });
    expect(plan!.op).toMatchObject({ name: "addBlock", parentId: "sec_aaaa", index: 2 });
  });

  it("no selection → appends to the LAST section", () => {
    const { doc } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: textItem, selectedBlockId: null });
    expect(plan!.op).toMatchObject({ name: "addBlock", parentId: "sec_bbbb", index: 1 });
  });

  it("empty document → ONE composite addSection op carrying the leaf", () => {
    const doc = createEmptyDocument();
    const plan = buildClickToAddPlan({ doc, item: textItem, selectedBlockId: null });
    expect(plan!.op.name).toBe("addSection");
    const applied = apply(doc, plan!.op as Operation);
    expect(applied[plan!.newBlockId!]).toMatchObject({ type: "text" });
  });
});

describe("buildClickToAddPlan: columns items", () => {
  it("selected leaf in a section → row lands right after it", () => {
    const { doc } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: columnsItem, selectedBlockId: id("txt_aaaa") });
    expect(plan!.op).toMatchObject({ name: "restoreBlocks", parentId: "sec_aaaa", index: 1 });
    const applied = apply(doc, plan!.op as Operation);
    expect(applied[plan!.newBlockId!]).toMatchObject({ type: "row" });
    expect(applied[plan!.newBlockId!]?.childrenIds).toHaveLength(3);
  });

  it("selection inside a column → row lands after that column's row", () => {
    const { doc, firstColumnId } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: columnsItem, selectedBlockId: firstColumnId });
    expect(plan!.op).toMatchObject({ name: "restoreBlocks", parentId: "sec_aaaa", index: 2 });
  });

  it("empty document → ONE composite addSection op carrying the row subtree", () => {
    const doc = createEmptyDocument();
    const plan = buildClickToAddPlan({ doc, item: columnsItem, selectedBlockId: null });
    expect(plan!.op.name).toBe("addSection");
    const applied = apply(doc, plan!.op as Operation);
    expect(applied[plan!.newBlockId!]).toMatchObject({ type: "row" });
  });
});

describe("buildClickToAddPlan: section items", () => {
  it("empty section inserts after the selection's ancestor section", () => {
    const { doc } = buildFixtureDoc();
    const plan = buildClickToAddPlan({
      doc,
      item: emptySectionItem,
      selectedBlockId: id("txt_aaaa"),
    });
    expect(plan!.op).toMatchObject({ name: "addSection", index: 1 });
  });

  it("empty section with no selection appends at the bottom", () => {
    const { doc } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: emptySectionItem, selectedBlockId: null });
    expect(plan!.op).toMatchObject({ name: "addSection", index: 2 });
  });

  it("template click → scaffoldSection anchored after the ancestor section", () => {
    const { doc } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: heroItem, selectedBlockId: id("btn_bbbb") });
    expect(plan!.op).toEqual({
      name: "scaffoldSection",
      templateId: "hero",
      position: { afterSectionId: "sec_bbbb" },
    });
    expect(plan!.newBlockId).toBeNull(); /* id known only after dispatch */
  });

  it("template click with no selection scaffolds at the bottom", () => {
    const { doc } = buildFixtureDoc();
    const plan = buildClickToAddPlan({ doc, item: heroItem, selectedBlockId: null });
    expect(plan!.op).toMatchObject({ name: "scaffoldSection", position: "bottom" });
  });
});
