import {
  applyOperation,
  createSampleDocument,
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type SectionBlock,
} from "@tandem/email-sdk";
import { describe, expect, it } from "vitest";
import {
  buildInsertSavedSectionPlan,
  collectSectionSubtree,
  seedNameFromSectionSubtree,
} from "./saved-sections";

const sampleDoc = createSampleDocument();
const root = sampleDoc[ROOT_BLOCK_ID]!;
const firstSectionId = root.childrenIds[0]! as BlockId;

function getSavedFooterSubtree(): Block[] {
  const subtree = collectSectionSubtree({ doc: sampleDoc, sectionId: firstSectionId });
  expect(subtree).not.toBeNull();
  return subtree!;
}

describe("collectSectionSubtree (the save payload)", () => {
  it("returns the section first, then every descendant (restoreBlocks shape)", () => {
    const subtree = getSavedFooterSubtree();
    expect(subtree[0]!.id).toBe(firstSectionId);
    expect(subtree[0]!.type).toBe("section");
    const idsInList = new Set(subtree.map((block) => block.id as string));
    for (const block of subtree.slice(1)) {
      expect(idsInList.has(block.parentId as string)).toBe(true);
    }
    for (const block of subtree) {
      for (const childId of block.childrenIds) {
        expect(idsInList.has(childId)).toBe(true);
      }
    }
  });

  it("refuses non-sections and unknown ids", () => {
    const section = sampleDoc[firstSectionId] as SectionBlock;
    const leafId = section.childrenIds[0]!;
    expect(collectSectionSubtree({ doc: sampleDoc, sectionId: leafId })).toBeNull();
    expect(collectSectionSubtree({ doc: sampleDoc, sectionId: "sec_none" as BlockId })).toBeNull();
  });
});

describe("seedNameFromSectionSubtree", () => {
  it("names the section after its first text run in reading order", () => {
    const subtree = getSavedFooterSubtree();
    const name = seedNameFromSectionSubtree(subtree);
    expect(name.length).toBeGreaterThan(0);
    // The name must be real content from a text block inside the subtree.
    const hasTextSource = subtree.some(
      (block) =>
        block.type === "text" &&
        block.properties.text.content.some((node) =>
          (node.content ?? [])
            .map((run) => (run.type === "text" ? run.text : " "))
            .join("")
            .trim()
            .startsWith(name),
        ),
    );
    expect(hasTextSource).toBe(true);
  });

  it("returns empty for a subtree with no text or button content", () => {
    const subtree = getSavedFooterSubtree().filter(
      (block) => block.type !== "text" && block.type !== "button",
    );
    expect(seedNameFromSectionSubtree(subtree)).toBe("");
  });
});

describe("buildInsertSavedSectionPlan (one op, fresh ids)", () => {
  it("mints fresh ids for every block — no collisions even inserting into the source doc", () => {
    const savedBlocks = getSavedFooterSubtree();
    const plan = buildInsertSavedSectionPlan({
      doc: sampleDoc,
      savedBlocks,
      selectedBlockId: null,
    });
    expect(plan).not.toBeNull();
    const documentIds = new Set(Object.keys(sampleDoc));
    const savedIds = new Set(savedBlocks.map((block) => block.id as string));
    for (const block of plan!.op.blocks) {
      expect(documentIds.has(block.id)).toBe(false);
      expect(savedIds.has(block.id)).toBe(false);
    }
    expect(plan!.sectionId).toBe(plan!.op.blocks[0]!.id);
  });

  it("applies cleanly through the SDK gate and preserves structure + properties", () => {
    const savedBlocks = getSavedFooterSubtree();
    const plan = buildInsertSavedSectionPlan({
      doc: sampleDoc,
      savedBlocks,
      selectedBlockId: null,
    });
    const result = applyOperation(sampleDoc, plan!.op);
    expect(result.isOk).toBe(true);
    if (!result.isOk) {
      return;
    }
    // Inserted at the bottom (no selection), same subtree size, properties intact.
    const newRoot = result.doc[ROOT_BLOCK_ID]!;
    expect(newRoot.childrenIds.at(-1)).toBe(plan!.sectionId);
    expect(Object.keys(result.doc)).toHaveLength(Object.keys(sampleDoc).length + savedBlocks.length);
    const insertedSection = result.doc[plan!.sectionId]!;
    expect(insertedSection.properties).toEqual(savedBlocks[0]!.properties);
    expect(insertedSection.childrenIds).toHaveLength(savedBlocks[0]!.childrenIds.length);
  });

  it("inserts twice without collisions (reusable many times)", () => {
    const savedBlocks = getSavedFooterSubtree();
    const firstPlan = buildInsertSavedSectionPlan({
      doc: sampleDoc,
      savedBlocks,
      selectedBlockId: null,
    });
    const afterFirst = applyOperation(sampleDoc, firstPlan!.op);
    expect(afterFirst.isOk).toBe(true);
    if (!afterFirst.isOk) {
      return;
    }
    const secondPlan = buildInsertSavedSectionPlan({
      doc: afterFirst.doc,
      savedBlocks,
      selectedBlockId: null,
    });
    const afterSecond = applyOperation(afterFirst.doc, secondPlan!.op);
    expect(afterSecond.isOk).toBe(true);
  });

  it("anchors after the selection's ancestor section", () => {
    const savedBlocks = getSavedFooterSubtree();
    const section = sampleDoc[firstSectionId] as SectionBlock;
    const selectedLeafId = section.childrenIds[0]!;
    const plan = buildInsertSavedSectionPlan({
      doc: sampleDoc,
      savedBlocks,
      selectedBlockId: selectedLeafId,
    });
    const anchorIndex = root.childrenIds.indexOf(firstSectionId as never);
    expect(plan!.op.index).toBe(anchorIndex + 1);
  });

  it("refuses a payload whose root is not a section", () => {
    const savedBlocks = getSavedFooterSubtree();
    const plan = buildInsertSavedSectionPlan({
      doc: sampleDoc,
      savedBlocks: savedBlocks.slice(1),
      selectedBlockId: null,
    });
    expect(plan).toBeNull();
  });
});
