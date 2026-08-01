import {
  LEAF_BLOCK_TYPES,
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type EmailDocument,
  type SectionBlock,
} from "@tandem/email-sdk";
import type { DispatchableOp } from "@/lib/editor-store";
import {
  createDefaultColumnsPreset,
  createDefaultLeafBlock,
  createDefaultSection,
  generateUniqueBlockId,
} from "../block-defaults";
import type { BrandLogoSource, LeafBlockVariant } from "../block-defaults";
import type { PaletteItem } from "./palette-items";

/**
 * Click-to-add placement (the palette's no-drag path), selection-aware and
 * pure so it is directly testable. One click = ONE op = one undo — even on
 * an empty document, where leaf/columns items compose a single `addSection`
 * op that carries the new content as its prebuilt subtree instead of
 * dispatching a section op and a block op separately.
 *
 * Placement rules (proposal §4.3):
 * 1. Selected leaf → insert AFTER it in its parent.
 * 2. Selected container → append to it (section/column; a selected row
 *    appends to its section).
 * 3. No selection → append to the LAST section (or start a section).
 * Section items anchor after the selection's ancestor section, else bottom.
 */
export interface ClickToAddPlan {
  op: DispatchableOp;
  /**
   * The inserted subtree's root, to select + reveal — or null when the id is
   * only known after dispatch (scaffoldSection resolves server-shaped: read
   * the resulting addSection op's section id from the dispatch result).
   */
  newBlockId: BlockId | null;
}

function isLeafBlock(block: Block): boolean {
  return (LEAF_BLOCK_TYPES as readonly string[]).includes(block.type);
}

/** The selection's enclosing section (or itself), walking parent pointers. */
function findAncestorSection(doc: EmailDocument, blockId: BlockId): SectionBlock | null {
  for (let id: BlockId | null = blockId; id !== null; ) {
    const block: Block | undefined = doc[id];
    if (block === undefined) {
      return null;
    }
    if (block.type === "section") {
      return block;
    }
    id = block.parentId;
  }
  return null;
}

/** The document's last top-level section, or null when it has none. */
function getLastSection(doc: EmailDocument): SectionBlock | null {
  const root = doc[ROOT_BLOCK_ID];
  if (root === undefined) {
    return null;
  }
  const lastSectionId = root.childrenIds[root.childrenIds.length - 1];
  const lastSection = lastSectionId === undefined ? undefined : doc[lastSectionId];
  return lastSection !== undefined && lastSection.type === "section" ? lastSection : null;
}

export function buildClickToAddPlan(args: {
  doc: EmailDocument;
  item: PaletteItem;
  selectedBlockId: BlockId | null;
  /** The confirmed brand logo for the Logo preset (null = placeholder). */
  brandLogo?: BrandLogoSource | null;
}): ClickToAddPlan | null {
  const { doc, item, selectedBlockId, brandLogo } = args;
  const selected = selectedBlockId === null ? undefined : doc[selectedBlockId];
  switch (item.kind) {
    case "leaf":
      return planLeafAdd({
        doc,
        blockType: item.blockType,
        variant: item.variant,
        selected,
        brandLogo,
      });
    case "columns":
      return planColumnsAdd({ doc, columnCount: item.columnCount, selected });
    case "empty-section":
      return planEmptySectionAdd({ doc, selected });
    case "section-template": {
      const anchorSection = selected === undefined ? null : findAncestorSection(doc, selected.id);
      return {
        op: {
          name: "scaffoldSection",
          templateId: item.templateId,
          position: anchorSection === null ? "bottom" : { afterSectionId: anchorSection.id },
        },
        newBlockId: null,
      };
    }
  }
}

function planLeafAdd(args: {
  doc: EmailDocument;
  blockType: (typeof LEAF_BLOCK_TYPES)[number];
  variant: LeafBlockVariant | undefined;
  selected: Block | undefined;
  brandLogo: BrandLogoSource | null | undefined;
}): ClickToAddPlan | null {
  const { doc, blockType, variant, selected, brandLogo } = args;
  const target = resolveLeafTarget(doc, selected);
  if (target === null) {
    // No sections yet: one composite addSection op carrying the new leaf.
    const sectionId = generateUniqueBlockId({ type: "section", doc });
    const leafId = generateUniqueBlockId({ type: blockType, doc });
    const leaf = createDefaultLeafBlock({
      type: blockType,
      variant,
      id: leafId,
      parentId: sectionId,
      doc,
      brandLogo,
    });
    return {
      op: {
        name: "addSection",
        section: { ...createDefaultSection(sectionId), childrenIds: [leafId] },
        index: doc[ROOT_BLOCK_ID]?.childrenIds.length ?? 0,
        children: [leaf],
      },
      newBlockId: leafId,
    };
  }
  const id = generateUniqueBlockId({ type: blockType, doc });
  return {
    op: {
      name: "addBlock",
      block: createDefaultLeafBlock({
        type: blockType,
        variant,
        id,
        parentId: target.parentId,
        doc,
        brandLogo,
      }),
      parentId: target.parentId,
      index: target.index,
    },
    newBlockId: id,
  };
}

/** Where a new leaf lands per the selection rules; null = no section exists. */
function resolveLeafTarget(
  doc: EmailDocument,
  selected: Block | undefined,
): { parentId: BlockId; index: number } | null {
  if (selected !== undefined) {
    if (isLeafBlock(selected) && selected.parentId !== null) {
      const parent = doc[selected.parentId];
      if (parent !== undefined) {
        // childrenIds is a per-container-type id union — widen for indexOf.
        const siblingIds = parent.childrenIds as readonly BlockId[];
        return { parentId: parent.id, index: siblingIds.indexOf(selected.id) + 1 };
      }
    }
    if (selected.type === "section" || selected.type === "column") {
      return { parentId: selected.id, index: selected.childrenIds.length };
    }
    if (selected.type === "row" && selected.parentId !== null) {
      const section = doc[selected.parentId];
      if (section !== undefined) {
        return { parentId: section.id, index: section.childrenIds.length };
      }
    }
  }
  const lastSection = getLastSection(doc);
  return lastSection === null
    ? null
    : { parentId: lastSection.id, index: lastSection.childrenIds.length };
}

function planColumnsAdd(args: {
  doc: EmailDocument;
  columnCount: 2 | 3 | 4;
  selected: Block | undefined;
}): ClickToAddPlan | null {
  const { doc, columnCount, selected } = args;
  const target = resolveRowTarget(doc, selected);
  if (target === null) {
    // No sections yet: one composite addSection op carrying the row subtree.
    const sectionId = generateUniqueBlockId({ type: "section", doc });
    const preset = createDefaultColumnsPreset({ columnCount, sectionId, doc });
    return {
      op: {
        name: "addSection",
        section: { ...createDefaultSection(sectionId), childrenIds: [preset.rowId] },
        index: doc[ROOT_BLOCK_ID]?.childrenIds.length ?? 0,
        children: preset.blocks,
      },
      newBlockId: preset.rowId,
    };
  }
  const preset = createDefaultColumnsPreset({ columnCount, sectionId: target.sectionId, doc });
  return {
    op: {
      name: "restoreBlocks",
      blocks: preset.blocks,
      parentId: target.sectionId,
      index: target.index,
    },
    newBlockId: preset.rowId,
  };
}

/**
 * Where a new row lands: after the selection's nearest ancestor-or-self that
 * sits directly in a section (leaf or row), appended into a selected
 * section, or appended to the last section. Null = no section exists.
 */
function resolveRowTarget(
  doc: EmailDocument,
  selected: Block | undefined,
): { sectionId: BlockId; index: number } | null {
  if (selected !== undefined) {
    if (selected.type === "section") {
      return { sectionId: selected.id, index: selected.childrenIds.length };
    }
    for (let id: BlockId | null = selected.id; id !== null; ) {
      const block: Block | undefined = doc[id];
      if (block === undefined || block.parentId === null) {
        break;
      }
      const parent = doc[block.parentId];
      if (parent !== undefined && parent.type === "section") {
        return { sectionId: parent.id, index: parent.childrenIds.indexOf(block.id) + 1 };
      }
      id = block.parentId;
    }
  }
  const lastSection = getLastSection(doc);
  return lastSection === null
    ? null
    : { sectionId: lastSection.id, index: lastSection.childrenIds.length };
}

function planEmptySectionAdd(args: {
  doc: EmailDocument;
  selected: Block | undefined;
}): ClickToAddPlan | null {
  const { doc, selected } = args;
  const root = doc[ROOT_BLOCK_ID];
  if (root === undefined) {
    return null;
  }
  const anchorSection = selected === undefined ? null : findAncestorSection(doc, selected.id);
  const anchorIndex =
    anchorSection === null
      ? -1
      : (root.childrenIds as readonly BlockId[]).indexOf(anchorSection.id);
  const id = generateUniqueBlockId({ type: "section", doc });
  return {
    op: {
      name: "addSection",
      section: createDefaultSection(id),
      index: anchorIndex === -1 ? root.childrenIds.length : anchorIndex + 1,
    },
    newBlockId: id,
  };
}
