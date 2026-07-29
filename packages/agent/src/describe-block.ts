import type { Block, BlockId, EmailDocument } from "@tandem/email-sdk";

/**
 * Block detail view (plan §9.4 item 1, catalog-lookup pattern).
 *
 * The outline advertises compact per-block summaries; this is the read-only
 * "teach me the full shape" path behind it. Phase 3.2 wraps it as a
 * `get-block-details` analysis tool so the model can pull one block's complete
 * JSON on demand instead of every request carrying every property.
 */

export interface DescribeBlockInput {
  doc: EmailDocument;
  blockId: BlockId;
}

export interface BlockDetails {
  /** The complete block record, exactly as stored in the flat map. */
  block: Block;
  /** Ancestor chain ids, root first, immediate parent last. Empty for the root. */
  ancestorIds: BlockId[];
}

/**
 * Full JSON of one block plus its resolved ancestor chain. Returns null when
 * the id is not in the document (the tool wrapper turns that into a
 * model-facing "no such block" message). Cycle-safe: a corrupt parent loop
 * terminates the walk instead of hanging.
 */
export function describeBlock({ doc, blockId }: DescribeBlockInput): BlockDetails | null {
  const block = doc[blockId];
  if (block === undefined) {
    return null;
  }
  const ancestorIds: BlockId[] = [];
  const visitedIds = new Set<BlockId>([blockId]);
  let currentParentId: BlockId | null = block.parentId;
  while (currentParentId !== null && !visitedIds.has(currentParentId)) {
    visitedIds.add(currentParentId);
    ancestorIds.unshift(currentParentId);
    currentParentId = doc[currentParentId]?.parentId ?? null;
  }
  return { block, ancestorIds };
}
