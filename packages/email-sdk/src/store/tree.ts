import type { Block, RootBlock } from "../schema/blocks";
import type { BlockId } from "../schema/ids";
import type { EmailDocument } from "./document";

/**
 * Tree derivation — the nested view of the flat document.
 *
 * The flat map is the sole source of truth; the tree is ephemeral and exists
 * only for render-time traversal (Phase 1.4) and structural manipulation
 * convenience. `deflate` treats the tree SHAPE as authoritative: it rewrites
 * every block's parentId/childrenIds from the actual nesting, so
 * deflate(inflate(doc)) round-trips exactly and a hand-edited tree is
 * normalized back into a consistent flat map.
 */

/** A node in the derived tree: the block plus its resolved children, in order. */
export interface EmailTreeNode {
  /** The underlying flat-map block (pointers included, unchanged). */
  block: Block;
  /** Child nodes in childrenIds order. Empty for leaves. */
  children: EmailTreeNode[];
}

/** The tree root — same shape, but the block is guaranteed to be the root block. */
export interface EmailTree extends EmailTreeNode {
  block: RootBlock;
}

/**
 * Build the nested tree from a flat document.
 *
 * Assumes a document that passes checkDocumentIntegrity; throws (rather than
 * returning errors) on structural impossibilities — missing root, multiple
 * roots, dangling child ids, or cycles — since callers are expected to have
 * validated first.
 */
export function inflate(document: EmailDocument): EmailTree {
  const rootBlocks = Object.values(document).filter(
    (block): block is RootBlock => block.type === "root",
  );
  if (rootBlocks.length === 0) {
    throw new Error("inflate: document has no root block");
  }
  if (rootBlocks.length > 1) {
    throw new Error(
      `inflate: document has ${rootBlocks.length} root blocks (${rootBlocks
        .map((block) => block.id)
        .join(", ")})`,
    );
  }
  const root = rootBlocks[0]!;

  const buildNode = (blockId: BlockId, visitedIds: Set<BlockId>): EmailTreeNode => {
    const block = document[blockId];
    if (block === undefined) {
      throw new Error(`inflate: block "${blockId}" is referenced but not present in the document`);
    }
    if (visitedIds.has(blockId)) {
      throw new Error(`inflate: cycle detected at block "${blockId}"`);
    }
    const nextVisitedIds = new Set(visitedIds).add(blockId);
    return {
      block,
      children: block.childrenIds.map((childId: BlockId) => buildNode(childId, nextVisitedIds)),
    };
  };

  return buildNode(root.id, new Set()) as EmailTree;
}

/**
 * Flatten a tree back into a flat document.
 *
 * The tree shape is authoritative: each emitted block's parentId is set to
 * its actual parent in the tree and its childrenIds to its actual children,
 * in order — regardless of what the embedded blocks' pointers said. Throws
 * on duplicate block ids (the same id appearing at two tree positions).
 */
export function deflate(tree: EmailTree): EmailDocument {
  const document: EmailDocument = {};

  const visit = (node: EmailTreeNode, parentId: BlockId | null): void => {
    const { block } = node;
    if (document[block.id] !== undefined) {
      throw new Error(`deflate: duplicate block id "${block.id}" in tree`);
    }
    document[block.id] = {
      ...block,
      parentId,
      childrenIds: node.children.map((child) => child.block.id),
    } as Block;
    for (const child of node.children) {
      visit(child, block.id);
    }
  };

  visit(tree, null);
  return document;
}
