import { generateBlockId, type Block, type BlockId, type EmailDocument } from "@tandem/email-sdk";

/**
 * Shared subtree plumbing for the flows that snapshot and re-materialize a
 * block together with its descendants: duplicate-block (clone-in-place) and
 * saved sections (save now, insert later, possibly into a different
 * document). Both compose the ONE existing `restoreBlocks` op, whose
 * contract these helpers encode: a flat list, subtree root FIRST, every
 * descendant's parentId pointing into the list.
 */

/**
 * Collect a block's subtree depth-first, the block itself FIRST (the
 * restoreBlocks contract). Unknown ids are skipped defensively.
 */
export function collectSubtreeBlocks({
  doc,
  blockId,
}: {
  doc: EmailDocument;
  blockId: BlockId;
}): Block[] {
  const subtreeBlocks: Block[] = [];
  const collect = (id: BlockId): void => {
    const block = doc[id];
    if (block === undefined) {
      return;
    }
    subtreeBlocks.push(block);
    for (const childId of block.childrenIds) {
      collect(childId);
    }
  };
  collect(blockId);
  return subtreeBlocks;
}

/**
 * Deep-clone a flat subtree (root first) with one fresh typed id per block —
 * ids, parentId, and childrenIds pointers all remapped into the clone. The
 * clone ROOT keeps its original parentId value (restoreBlocks overwrites it
 * with the op's parentId on apply).
 *
 * `usedIds` is the id set fresh ids must avoid — pass the TARGET document's
 * ids (generateBlockId does not guarantee uniqueness; minted ids are also
 * checked against each other).
 *
 * Cast note: Block is a per-type discriminated union over template-literal
 * id types, so remapped ids cannot be proven statically — the store's
 * applyOperations validation is the runtime guard, same policy as the SDK's
 * own section builders.
 */
export function cloneSubtreeWithFreshIds({
  blocks,
  usedIds,
}: {
  blocks: readonly Block[];
  usedIds: ReadonlySet<string>;
}): Block[] {
  const reservedIds = new Set<string>(usedIds);
  const freshIdsByOldId = new Map<string, string>();
  for (const block of blocks) {
    let freshId = generateBlockId(block.type);
    while (reservedIds.has(freshId)) {
      freshId = generateBlockId(block.type);
    }
    reservedIds.add(freshId);
    freshIdsByOldId.set(block.id, freshId);
  }

  const subtreeRootId = blocks[0]?.id;
  return blocks.map((block) => {
    const clonedBlock = structuredClone(block);
    return {
      ...clonedBlock,
      id: freshIdsByOldId.get(block.id),
      parentId:
        block.id === subtreeRootId
          ? block.parentId
          : freshIdsByOldId.get(block.parentId as string),
      childrenIds: (block.childrenIds as string[]).map((childId) => freshIdsByOldId.get(childId)),
    } as unknown as Block;
  });
}
