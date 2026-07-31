import {
  generateBlockId,
  type Block,
  type BlockId,
  type EmailDocument,
  type RestoreBlocksOperation,
} from "@tandem/email-sdk";

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

  // Collect the subtree depth-first, source block FIRST (the restoreBlocks
  // contract: blocks[0] is the subtree root, re-attached under parentId).
  const subtreeBlocks: Block[] = [];
  const collectSubtree = (id: BlockId): void => {
    const block = doc[id];
    if (block === undefined) {
      return;
    }
    subtreeBlocks.push(block);
    for (const childId of block.childrenIds) {
      collectSubtree(childId);
    }
  };
  collectSubtree(blockId);

  // One fresh typed id per subtree block (generateBlockId does not guarantee
  // uniqueness — retry against the document AND the ids minted so far).
  const usedIds = new Set<string>(Object.keys(doc));
  const freshIdsByOldId = new Map<string, string>();
  for (const block of subtreeBlocks) {
    let freshId = generateBlockId(block.type);
    while (usedIds.has(freshId)) {
      freshId = generateBlockId(block.type);
    }
    usedIds.add(freshId);
    freshIdsByOldId.set(block.id, freshId);
  }

  // Deep-clone with ids remapped. The clone root keeps the source's parentId
  // (apply overwrites it with the op's parentId); every descendant's parentId
  // maps into the cloned subtree. Cast note: Block is a per-type discriminated
  // union over template-literal id types, so remapped ids cannot be proven
  // statically — the store's applyOperations validation is the runtime guard,
  // same policy as the SDK's own section builders.
  const clonedBlocks = subtreeBlocks.map((block) => {
    const clonedBlock = structuredClone(block);
    return {
      ...clonedBlock,
      id: freshIdsByOldId.get(block.id),
      parentId:
        block.id === sourceBlock.id
          ? sourceBlock.parentId
          : freshIdsByOldId.get(block.parentId as string),
      childrenIds: (block.childrenIds as string[]).map((childId) => freshIdsByOldId.get(childId)),
    } as unknown as Block;
  });

  const sourceIndex = (parent.childrenIds as string[]).indexOf(sourceBlock.id);
  return {
    name: "restoreBlocks",
    blocks: clonedBlocks,
    parentId: parent.id,
    index: sourceIndex + 1,
  };
}
