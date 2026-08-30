import { ROOT_BLOCK_ID, type BlockId, type EmailDocument } from "@flock/email-sdk";

export interface GetAncestorIdsArgs {
  doc: EmailDocument;
  blockId: BlockId;
}

/*
  Ancestor ids of a block, outermost-first (section → … → direct parent).
  The root and the block itself are excluded, so a section returns [] and a
  leaf inside a column returns [sectionId, rowId, columnId]. An unknown
  blockId also returns [].
*/
export function getAncestorIds({ doc, blockId }: GetAncestorIdsArgs): BlockId[] {
  const ancestorIds: BlockId[] = [];
  let parentId = doc[blockId]?.parentId ?? null;
  while (parentId !== null && parentId !== ROOT_BLOCK_ID) {
    ancestorIds.unshift(parentId);
    parentId = doc[parentId]?.parentId ?? null;
  }
  return ancestorIds;
}
