import type { Block } from "../schema/blocks";
import {
  LEAF_BLOCK_TYPES,
  type BlockId,
  type BlockType,
  type LeafBlockType,
} from "../schema/ids";
import type { EmailDocument } from "./document";

/**
 * Referential-integrity checker for the flat document.
 *
 * Per-block SHAPE validation is Zod's job (blockSchema / emailDocumentSchema).
 * This checker validates the relationships BETWEEN blocks — things a
 * per-block schema cannot see — and is deliberately defensive: it re-checks
 * a few invariants the schemas already enforce (e.g. leaves having no
 * children) so it stays trustworthy on data that skipped schema validation.
 *
 * It returns structured errors rather than throwing; an empty error list
 * means the document is structurally sound and safe to inflate/render.
 */

export type IntegrityErrorCode =
  /** No block of type "root" exists. */
  | "missing_root"
  /** More than one block of type "root" exists. */
  | "multiple_roots"
  /** A root block has a non-null parentId. */
  | "root_has_parent"
  /** A non-root block has a null/undefined parentId. */
  | "missing_parent"
  /** A record key differs from the id of the block stored under it. */
  | "block_key_mismatch"
  /** A block's parentId references an id not present in the document. */
  | "parent_not_found"
  /** A childrenIds entry references an id not present in the document. */
  | "child_not_found"
  /** child.parentId and the parent's childrenIds disagree. */
  | "parent_child_mismatch"
  /** A block appears more than once across childrenIds lists. */
  | "child_multiply_referenced"
  /** A block is its own ancestor. */
  | "cycle_detected"
  /** A block is not reachable from the root (an orphan or orphan island). */
  | "unreachable_block"
  /** A child's type is not allowed under its parent's type. */
  | "invalid_nesting"
  /** A leaf block (text, button, image, divider) lists children. */
  | "leaf_has_children";

/** One structured integrity violation. */
export interface IntegrityError {
  code: IntegrityErrorCode;
  /** Human-readable explanation, safe to feed back to an LLM as a repair hint. */
  message: string;
  /** The primary offending block (when one exists). */
  blockId?: BlockId;
  /** A second involved block (e.g. the parent in a pointer disagreement). */
  relatedBlockId?: BlockId;
}

export interface IntegrityCheckResult {
  isValid: boolean;
  errors: IntegrityError[];
}

/**
 * Which child block types each container type accepts.
 * root > section > (row | leaf) · row > column > leaf · leaves: none.
 */
export const ALLOWED_CHILD_TYPES: Record<BlockType, readonly BlockType[]> = {
  root: ["section"],
  section: ["row", ...LEAF_BLOCK_TYPES],
  row: ["column"],
  column: [...LEAF_BLOCK_TYPES],
  text: [],
  button: [],
  image: [],
  divider: [],
};

function isLeafType(type: BlockType): type is LeafBlockType {
  return (LEAF_BLOCK_TYPES as readonly BlockType[]).includes(type);
}

/** Check every referential-integrity rule; never throws. */
export function checkDocumentIntegrity(document: EmailDocument): IntegrityCheckResult {
  const errors: IntegrityError[] = [];
  const entries = Object.entries(document) as [BlockId, Block][];

  // --- Record keys must match block ids -----------------------------------
  for (const [key, block] of entries) {
    if (key !== block.id) {
      errors.push({
        code: "block_key_mismatch",
        message: `Document key "${key}" holds a block whose id is "${block.id}".`,
        blockId: block.id,
      });
    }
  }

  // --- Exactly one root ----------------------------------------------------
  const rootBlocks = entries.map(([, block]) => block).filter((block) => block.type === "root");
  if (rootBlocks.length === 0) {
    errors.push({ code: "missing_root", message: "Document has no root block." });
  } else if (rootBlocks.length > 1) {
    for (const rootBlock of rootBlocks) {
      errors.push({
        code: "multiple_roots",
        message: `Document has ${rootBlocks.length} root blocks; "${rootBlock.id}" is one of them.`,
        blockId: rootBlock.id,
      });
    }
  }
  const root = rootBlocks.length === 1 ? rootBlocks[0] : undefined;

  // --- Parent pointer presence ---------------------------------------------
  for (const [, block] of entries) {
    if (block.type === "root") {
      // Widen: the schema types say a root's parentId is always null, but
      // this checker is deliberately defensive about unvalidated runtime data.
      const rootParentId = block.parentId as BlockId | null;
      if (rootParentId !== null) {
        errors.push({
          code: "root_has_parent",
          message: `Root block "${block.id}" has parentId "${rootParentId}"; expected null.`,
          blockId: block.id,
        });
      }
      continue;
    }
    // Widen: the schema types say non-root parentId is always a string, but
    // this checker is deliberately defensive about unvalidated runtime data.
    const parentId = block.parentId as BlockId | null | undefined;
    if (parentId === null || parentId === undefined) {
      errors.push({
        code: "missing_parent",
        message: `Block "${block.id}" (${block.type}) has no parentId but is not the root.`,
        blockId: block.id,
      });
      continue;
    }
    if (document[parentId] === undefined) {
      errors.push({
        code: "parent_not_found",
        message: `Block "${block.id}" points at parent "${parentId}", which does not exist.`,
        blockId: block.id,
        relatedBlockId: parentId,
      });
    }
  }

  // --- Children: existence, exclusivity, agreement, nesting, leaf rule -----
  const referenceCountByChildId = new Map<BlockId, number>();

  for (const [, block] of entries) {
    if (isLeafType(block.type) && block.childrenIds.length > 0) {
      errors.push({
        code: "leaf_has_children",
        message: `Leaf block "${block.id}" (${block.type}) lists ${block.childrenIds.length} children; leaves must have empty childrenIds.`,
        blockId: block.id,
      });
    }

    const seenInThisParent = new Set<BlockId>();
    for (const childId of block.childrenIds as BlockId[]) {
      referenceCountByChildId.set(childId, (referenceCountByChildId.get(childId) ?? 0) + 1);

      if (seenInThisParent.has(childId)) {
        errors.push({
          code: "child_multiply_referenced",
          message: `Block "${block.id}" lists child "${childId}" more than once.`,
          blockId: childId,
          relatedBlockId: block.id,
        });
      }
      seenInThisParent.add(childId);

      const child = document[childId];
      if (child === undefined) {
        errors.push({
          code: "child_not_found",
          message: `Block "${block.id}" lists child "${childId}", which does not exist.`,
          blockId: block.id,
          relatedBlockId: childId,
        });
        continue;
      }

      if (child.parentId !== block.id) {
        errors.push({
          code: "parent_child_mismatch",
          message: `Block "${block.id}" lists "${childId}" as a child, but that block's parentId is "${String(child.parentId)}".`,
          blockId: childId,
          relatedBlockId: block.id,
        });
      }

      if (!ALLOWED_CHILD_TYPES[block.type].includes(child.type)) {
        const allowed = ALLOWED_CHILD_TYPES[block.type];
        errors.push({
          code: "invalid_nesting",
          message: `A ${child.type} block ("${childId}") cannot be a child of a ${block.type} block ("${block.id}"). Allowed children of ${block.type}: ${
            allowed.length > 0 ? allowed.join(", ") : "none"
          }.`,
          blockId: childId,
          relatedBlockId: block.id,
        });
      }
    }
  }

  // A child referenced by more than one parent (cross-parent duplicates).
  for (const [childId, referenceCount] of referenceCountByChildId) {
    if (referenceCount > 1 && document[childId] !== undefined) {
      const listingParentIds = entries
        .filter(([, block]) => (block.childrenIds as BlockId[]).includes(childId))
        .map(([, block]) => block.id);
      if (listingParentIds.length > 1) {
        errors.push({
          code: "child_multiply_referenced",
          message: `Block "${childId}" is listed as a child by multiple parents: ${listingParentIds.join(", ")}.`,
          blockId: childId,
        });
      }
    }
  }

  // A non-root block whose parent exists must be listed by that parent.
  for (const [, block] of entries) {
    if (block.type === "root" || block.parentId === null || block.parentId === undefined) {
      continue;
    }
    const parent = document[block.parentId];
    if (parent !== undefined && !(parent.childrenIds as BlockId[]).includes(block.id)) {
      errors.push({
        code: "parent_child_mismatch",
        message: `Block "${block.id}" claims parent "${parent.id}", but that parent does not list it in childrenIds.`,
        blockId: block.id,
        relatedBlockId: parent.id,
      });
    }
  }

  // --- Cycles (walk each block's parent chain) ------------------------------
  const knownCyclicIds = new Set<BlockId>();
  for (const [, block] of entries) {
    if (knownCyclicIds.has(block.id)) {
      continue;
    }
    const chainIds = new Set<BlockId>();
    let current: Block | undefined = block;
    while (current !== undefined && current.parentId !== null && current.parentId !== undefined) {
      if (chainIds.has(current.id)) {
        for (const cyclicId of chainIds) {
          knownCyclicIds.add(cyclicId);
        }
        errors.push({
          code: "cycle_detected",
          message: `Block "${current.id}" is part of a parent-pointer cycle: ${[...chainIds].join(" → ")}.`,
          blockId: current.id,
        });
        break;
      }
      chainIds.add(current.id);
      current = document[current.parentId];
    }
  }

  // --- Reachability from the root ------------------------------------------
  if (root !== undefined) {
    const reachableIds = new Set<BlockId>();
    const queue: BlockId[] = [root.id];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (reachableIds.has(currentId)) {
        continue;
      }
      reachableIds.add(currentId);
      const current = document[currentId];
      if (current !== undefined) {
        queue.push(...(current.childrenIds as BlockId[]));
      }
    }
    for (const [, block] of entries) {
      if (!reachableIds.has(block.id)) {
        errors.push({
          code: "unreachable_block",
          message: `Block "${block.id}" (${block.type}) is not reachable from the root.`,
          blockId: block.id,
        });
      }
    }
  }

  return { isValid: errors.length === 0, errors };
}
