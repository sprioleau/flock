import {
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type EmailDocument,
  type RestoreBlocksOperation,
} from "@tandem/email-sdk";
import { cloneSubtreeWithFreshIds, collectSubtreeBlocks } from "./block-subtree";

/**
 * Saved reusable sections — the pure client half (the Convex half is
 * convex/savedSections.ts):
 *
 * - SAVE snapshots the section's subtree VERBATIM (original ids, flat list,
 *   root first — the restoreBlocks shape) plus a content-derived name.
 * - INSERT re-materializes a saved subtree as ONE restoreBlocks op with
 *   fresh ids minted against the TARGET document (the duplicate-block
 *   pattern), so one saved section inserts into any draft any number of
 *   times without id collisions — one op, one undo step, the single
 *   history spine.
 */

/**
 * The section's subtree as a flat root-first list — the save payload.
 * Null when the id is missing or is not a section (only whole sections are
 * saveable).
 */
export function collectSectionSubtree({
  doc,
  sectionId,
}: {
  doc: EmailDocument;
  sectionId: BlockId;
}): Block[] | null {
  const sectionBlock = doc[sectionId];
  if (sectionBlock === undefined || sectionBlock.type !== "section") {
    return null;
  }
  return collectSubtreeBlocks({ doc, blockId: sectionId });
}

/**
 * A human-recognizable default name for a saved section: the first text
 * run inside the subtree in reading order ("Your Spring Checklist", the
 * footer's company line), else the first button label, else "" (the server
 * seeds the "Saved section" fallback and caps length).
 */
export function seedNameFromSectionSubtree(blocks: readonly Block[]): string {
  for (const block of blocks) {
    if (block.type === "text") {
      for (const node of block.properties.text.content) {
        const nodeText = (node.content ?? [])
          .map((run) => (run.type === "text" ? run.text : " "))
          .join("")
          .trim();
        if (nodeText.length > 0) {
          return nodeText;
        }
      }
    }
  }
  for (const block of blocks) {
    if (block.type === "button") {
      const label = block.properties.label.trim();
      if (label.length > 0) {
        return label;
      }
    }
  }
  return "";
}

/** The selection's enclosing section (or itself), walking parent pointers. */
function findAncestorSectionId(doc: EmailDocument, blockId: BlockId): BlockId | null {
  for (let id: BlockId | null = blockId; id !== null; ) {
    const block: Block | undefined = doc[id];
    if (block === undefined) {
      return null;
    }
    if (block.type === "section") {
      return block.id;
    }
    id = block.parentId;
  }
  return null;
}

export interface InsertSavedSectionPlan {
  op: RestoreBlocksOperation;
  /** The inserted section's FRESH id, to select + reveal after dispatch. */
  sectionId: BlockId;
}

/**
 * Plan the ONE op that inserts a saved section into `doc`: a restoreBlocks
 * op carrying the subtree with fresh ids, anchored under the root AFTER the
 * selection's ancestor section (the palette's section placement rule), else
 * at the bottom. Null when the payload isn't a section subtree or the
 * document has no root.
 */
export function buildInsertSavedSectionPlan({
  doc,
  savedBlocks,
  selectedBlockId,
}: {
  doc: EmailDocument;
  savedBlocks: readonly Block[];
  selectedBlockId: BlockId | null;
}): InsertSavedSectionPlan | null {
  const root = doc[ROOT_BLOCK_ID];
  const subtreeRoot = savedBlocks[0];
  if (root === undefined || subtreeRoot === undefined || subtreeRoot.type !== "section") {
    return null;
  }

  const clonedBlocks = cloneSubtreeWithFreshIds({
    blocks: savedBlocks,
    usedIds: new Set<string>(Object.keys(doc)),
  });

  const anchorSectionId =
    selectedBlockId === null ? null : findAncestorSectionId(doc, selectedBlockId);
  const anchorIndex =
    anchorSectionId === null ? -1 : (root.childrenIds as readonly BlockId[]).indexOf(anchorSectionId);

  return {
    op: {
      name: "restoreBlocks",
      blocks: clonedBlocks,
      parentId: ROOT_BLOCK_ID,
      index: anchorIndex === -1 ? root.childrenIds.length : anchorIndex + 1,
    },
    sectionId: clonedBlocks[0]!.id as BlockId,
  };
}
