import type { BlockId, EmailDocument, RestoreBlocksOperation } from "@flock/email-sdk";
import { cloneSubtreeWithFreshIds, collectSubtreeBlocks } from "./block-subtree";

/**
 * Build the ONE operation that duplicates a block: a `restoreBlocks` op
 * (an existing pure SDK operation, explicitly "valid to call directly")
 * carrying a deep clone of the block's whole subtree — every block with a
 * fresh typed id — inserted under the SAME parent immediately AFTER the
 * source block.
 *
 * Composing an existing op keeps the duplicate on the single history spine:
 * it dispatches through the store like any edit, is undoable (inverse =
 * removeBlock of the clone), and needs no new write path. The clone is
 * validated by the same applyOperations gate as every other op.
 *
 * Returns null when the block cannot be duplicated (missing, or the root).
 */
export function buildDuplicateBlockOperation({
  doc,
  blockId,
}: {
  doc: EmailDocument;
  blockId: BlockId;
}): RestoreBlocksOperation | null {
  const sourceBlock = doc[blockId];
  if (sourceBlock === undefined || sourceBlock.parentId === null) {
    return null; // unknown block, or the root — never duplicable
  }
  const parent = doc[sourceBlock.parentId];
  if (parent === undefined) {
    return null;
  }

  const subtreeBlocks = collectSubtreeBlocks({ doc, blockId });
  const clonedBlocks = cloneSubtreeWithFreshIds({
    blocks: subtreeBlocks,
    usedIds: new Set<string>(Object.keys(doc)),
  });

  const sourceIndex = (parent.childrenIds as string[]).indexOf(sourceBlock.id);
  return {
    name: "restoreBlocks",
    blocks: clonedBlocks,
    parentId: parent.id,
    index: sourceIndex + 1,
  };
}
