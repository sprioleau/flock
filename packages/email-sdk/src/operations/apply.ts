import { z } from "zod";
import { blockSchema, type Block } from "../schema/blocks";
import { ROOT_BLOCK_ID, type BlockId } from "../schema/ids";
import { emailDocumentSchema, type EmailDocument } from "../store/document";
import { ALLOWED_CHILD_TYPES, checkDocumentIntegrity } from "../store/integrity";
import {
  operationSchema,
  type Operation,
  type AddBlockOperation,
  type AddSectionOperation,
  type ApplyThemeOperation,
  type MoveBlockOperation,
  type RemoveBlockOperation,
  type ReorderChildrenOperation,
  type ReplaceBlockPropertiesOperation,
  type RestoreBlocksOperation,
  type UpdateBlockPropertiesOperation,
  type UpdateDocumentSettingsOperation,
  type UpdateTextOperation,
} from "./ops";

/**
 * The apply engine — pure operation application with inverse generation.
 *
 * `applyOperation(doc, op)` NEVER mutates its input. On success it returns a
 * new document (structurally sharing unchanged blocks) plus the inverse
 * operation that exactly undoes the change: applying an op and then its
 * inverse yields a document deep-equal to the original. Inverses power the
 * SDK-owned undo/redo of Phase 4.3.
 *
 * Non-negotiable invariant: EVERY successful apply re-validates the resulting
 * document against both the full Zod document schema and the referential
 * integrity checker. An operation whose per-op checks pass but whose result
 * is structurally unsound (e.g. adding a container that claims an existing
 * block as a child) fails with `integrity_check_failed` and the input
 * document is left as the source of truth.
 */

// ---------------------------------------------------------------------------
// Errors & results
// ---------------------------------------------------------------------------

export type OperationErrorCode =
  /** The operation envelope failed its Zod schema. */
  | "op_validation_failed"
  /** A referenced block (target or parent) does not exist in the document. */
  | "target_not_found"
  /** An added/restored block's id already exists (or repeats in the payload). */
  | "duplicate_block_id"
  /** An insertion index is outside the valid range for the parent. */
  | "index_out_of_range"
  /** The parent type cannot accept the child type, or the move creates a cycle. */
  | "nesting_violation"
  /** The root block cannot be removed or moved. */
  | "root_not_allowed"
  /** reorderChildren's ids are not an exact permutation of the current children. */
  | "children_not_permutation"
  /** The target block's type does not match the operation's expectation. */
  | "wrong_block_type"
  /** A merged/constructed block (or the whole document) failed schema validation. */
  | "schema_validation_failed"
  /** The resulting document failed the referential integrity check. */
  | "integrity_check_failed";

/** One structured operation failure, safe to feed back to an LLM as a repair hint. */
export interface OperationError {
  code: OperationErrorCode;
  /** Human-readable explanation of what went wrong and (where possible) how to fix it. */
  message: string;
  /** The primary offending block, when one exists. */
  blockId?: BlockId;
  /** A second involved block (e.g. the parent in an insertion failure). */
  relatedBlockId?: BlockId;
}

export type ApplyOperationResult =
  | {
      isOk: true;
      /** The new document. The input document is never mutated. */
      doc: EmailDocument;
      /** The operation that exactly undoes this one. */
      inverse: Operation;
    }
  | { isOk: false; errors: OperationError[] };

export type ApplyOperationsResult =
  | {
      isOk: true;
      /** The document after every operation has been applied, in order. */
      doc: EmailDocument;
      /** Inverses in REVERSE order — applying them in this order undoes the batch. */
      inverses: Operation[];
    }
  | {
      isOk: false;
      errors: OperationError[];
      /** Index (into the input array) of the operation that failed. */
      failedOperationIndex: number;
    };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Failure = { isOk: false; errors: OperationError[] };

const fail = (...errors: OperationError[]): Failure => ({ isOk: false, errors });

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

/** Ids of a block and all its descendants, pre-order. Cycle-safe (defensive). */
function getSubtreeIds(document: EmailDocument, subtreeRootId: BlockId): BlockId[] {
  const orderedIds: BlockId[] = [];
  const visitedIds = new Set<BlockId>();
  const walk = (blockId: BlockId): void => {
    if (visitedIds.has(blockId)) {
      return;
    }
    visitedIds.add(blockId);
    const block = document[blockId];
    if (block === undefined) {
      return;
    }
    orderedIds.push(blockId);
    for (const childId of block.childrenIds as BlockId[]) {
      walk(childId);
    }
  };
  walk(subtreeRootId);
  return orderedIds;
}

/**
 * Shallow-merge `overrides` into `base`. A key whose override value is
 * `undefined` is REMOVED from the result — this is how updateBlockProperties
 * clears a single override (non-JSON callers only).
 */
function mergeProperties(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function insertAt<T>({ items, index, item }: { items: readonly T[]; index: number; item: T }): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

/** Validate a candidate block against the block schema, mapping failure to an OperationError. */
function parseBlock(candidate: unknown, blockId: BlockId): { block: Block } | Failure {
  const parsed = blockSchema.safeParse(candidate);
  if (!parsed.success) {
    return fail({
      code: "schema_validation_failed",
      message: `Block "${blockId}" would not conform to its schema after this operation: ${formatZodIssues(parsed.error)}`,
      blockId,
    });
  }
  return { block: parsed.data };
}

type PerOpSuccess = { isOk: true; doc: EmailDocument; inverse: Operation };
type PerOpResult = PerOpSuccess | Failure;

const ok = (doc: EmailDocument, inverse: Operation): PerOpSuccess => ({ isOk: true, doc, inverse });

// ---------------------------------------------------------------------------
// Per-operation handlers
// ---------------------------------------------------------------------------

function applyUpdateBlockProperties(
  document: EmailDocument,
  op: UpdateBlockPropertiesOperation,
): PerOpResult {
  const block = document[op.blockId];
  if (block === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.blockId}" does not exist in the document.`,
      blockId: op.blockId,
    });
  }
  const mergedProperties = mergeProperties(
    block.properties as Record<string, unknown>,
    op.properties,
  );
  const parsed = parseBlock({ ...block, properties: mergedProperties }, op.blockId);
  if ("isOk" in parsed) {
    return parsed;
  }
  return ok({ ...document, [op.blockId]: parsed.block }, {
    name: "replaceBlockProperties",
    blockId: op.blockId,
    properties: structuredClone(block.properties) as Record<string, unknown>,
  });
}

function applyReplaceBlockProperties(
  document: EmailDocument,
  op: ReplaceBlockPropertiesOperation,
): PerOpResult {
  const block = document[op.blockId];
  if (block === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.blockId}" does not exist in the document.`,
      blockId: op.blockId,
    });
  }
  const parsed = parseBlock({ ...block, properties: op.properties }, op.blockId);
  if ("isOk" in parsed) {
    return parsed;
  }
  return ok({ ...document, [op.blockId]: parsed.block }, {
    name: "replaceBlockProperties",
    blockId: op.blockId,
    properties: structuredClone(block.properties) as Record<string, unknown>,
  });
}

/**
 * Both settings ops share an inverse strategy: snapshot the root's ENTIRE
 * properties object and restore it with replaceBlockProperties. A merge (or
 * wholesale globals swap) cannot generally be undone by another merge, and a
 * whole-properties restore also round-trips the "globals key absent" case
 * exactly.
 */
function applyGlobalsChange(
  document: EmailDocument,
  op: UpdateDocumentSettingsOperation | ApplyThemeOperation,
): PerOpResult {
  const root = document[ROOT_BLOCK_ID];
  if (root === undefined || root.type !== "root") {
    return fail({
      code: "target_not_found",
      message: 'Document has no root block; cannot update document settings.',
      blockId: ROOT_BLOCK_ID,
    });
  }
  const nextGlobals =
    op.name === "applyTheme"
      ? op.globals
      : mergeProperties(
          (root.properties.globals ?? {}) as Record<string, unknown>,
          op.globals as Record<string, unknown>,
        );
  const parsed = parseBlock(
    { ...root, properties: { ...root.properties, globals: nextGlobals } },
    ROOT_BLOCK_ID,
  );
  if ("isOk" in parsed) {
    return parsed;
  }
  return ok({ ...document, [ROOT_BLOCK_ID]: parsed.block }, {
    name: "replaceBlockProperties",
    blockId: ROOT_BLOCK_ID,
    properties: structuredClone(root.properties) as Record<string, unknown>,
  });
}

function applyAddBlock(document: EmailDocument, op: AddBlockOperation): PerOpResult {
  const parent = document[op.parentId];
  if (parent === undefined) {
    return fail({
      code: "target_not_found",
      message: `Parent block "${op.parentId}" does not exist in the document.`,
      blockId: op.parentId,
    });
  }
  if (document[op.block.id] !== undefined) {
    return fail({
      code: "duplicate_block_id",
      message: `A block with id "${op.block.id}" already exists; generate a fresh id before adding.`,
      blockId: op.block.id,
    });
  }
  const allowedChildTypes = ALLOWED_CHILD_TYPES[parent.type];
  if (!allowedChildTypes.includes(op.block.type)) {
    return fail({
      code: "nesting_violation",
      message: `A ${op.block.type} block cannot be a child of a ${parent.type} block ("${op.parentId}"). Allowed children of ${parent.type}: ${
        allowedChildTypes.length > 0 ? allowedChildTypes.join(", ") : "none"
      }.`,
      blockId: op.block.id,
      relatedBlockId: op.parentId,
    });
  }
  if (op.index > parent.childrenIds.length) {
    return fail({
      code: "index_out_of_range",
      message: `Index ${op.index} is out of range: parent "${op.parentId}" has ${parent.childrenIds.length} children (valid: 0–${parent.childrenIds.length}).`,
      blockId: op.parentId,
    });
  }
  const parsed = parseBlock({ ...op.block, parentId: op.parentId }, op.block.id);
  if ("isOk" in parsed) {
    return parsed;
  }
  const nextDocument: EmailDocument = {
    ...document,
    [op.block.id]: parsed.block,
    [op.parentId]: {
      ...parent,
      childrenIds: insertAt({ items: parent.childrenIds as BlockId[], index: op.index, item: op.block.id }),
    } as Block,
  };
  return ok(nextDocument, { name: "removeBlock", blockId: op.block.id });
}

/**
 * Shared core of addSection and restoreBlocks: insert a closed subtree
 * (root-first flat list) under a parent at an index.
 */
function applyInsertSubtree({
  document,
  blocks,
  parentId,
  index,
}: {
  document: EmailDocument;
  blocks: Block[];
  parentId: BlockId;
  index: number;
}): PerOpResult {
  const parent = document[parentId];
  if (parent === undefined) {
    return fail({
      code: "target_not_found",
      message: `Parent block "${parentId}" does not exist in the document.`,
      blockId: parentId,
    });
  }
  const subtreeRoot = blocks[0]!;
  const blockIds = new Set<BlockId>();
  for (const block of blocks) {
    if (blockIds.has(block.id)) {
      return fail({
        code: "duplicate_block_id",
        message: `Block id "${block.id}" appears more than once in the provided blocks.`,
        blockId: block.id,
      });
    }
    blockIds.add(block.id);
    if (document[block.id] !== undefined) {
      return fail({
        code: "duplicate_block_id",
        message: `A block with id "${block.id}" already exists in the document; generate a fresh id.`,
        blockId: block.id,
      });
    }
  }
  for (const block of blocks.slice(1)) {
    const blockParentId = block.parentId as BlockId | null;
    if (blockParentId === null || !blockIds.has(blockParentId)) {
      return fail({
        code: "op_validation_failed",
        message: `Provided blocks are not a closed subtree: "${block.id}" has parentId "${String(blockParentId)}", which is not among the provided blocks. Every non-root block's parent must be in the list.`,
        blockId: block.id,
      });
    }
  }
  const allowedChildTypes = ALLOWED_CHILD_TYPES[parent.type];
  if (!allowedChildTypes.includes(subtreeRoot.type)) {
    return fail({
      code: "nesting_violation",
      message: `A ${subtreeRoot.type} block cannot be a child of a ${parent.type} block ("${parentId}"). Allowed children of ${parent.type}: ${
        allowedChildTypes.length > 0 ? allowedChildTypes.join(", ") : "none"
      }.`,
      blockId: subtreeRoot.id,
      relatedBlockId: parentId,
    });
  }
  if (index > parent.childrenIds.length) {
    return fail({
      code: "index_out_of_range",
      message: `Index ${index} is out of range: parent "${parentId}" has ${parent.childrenIds.length} children (valid: 0–${parent.childrenIds.length}).`,
      blockId: parentId,
    });
  }
  const parsedRoot = parseBlock({ ...subtreeRoot, parentId }, subtreeRoot.id);
  if ("isOk" in parsedRoot) {
    return parsedRoot;
  }
  const nextDocument: EmailDocument = { ...document };
  for (const block of blocks) {
    nextDocument[block.id] = block;
  }
  nextDocument[subtreeRoot.id] = parsedRoot.block;
  nextDocument[parentId] = {
    ...parent,
    childrenIds: insertAt({ items: parent.childrenIds as BlockId[], index, item: subtreeRoot.id }),
  } as Block;
  return ok(nextDocument, { name: "removeBlock", blockId: subtreeRoot.id });
}

function applyAddSection(document: EmailDocument, op: AddSectionOperation): PerOpResult {
  return applyInsertSubtree({
    document,
    blocks: [op.section, ...(op.children ?? [])],
    parentId: ROOT_BLOCK_ID,
    index: op.index,
  });
}

function applyRestoreBlocks(document: EmailDocument, op: RestoreBlocksOperation): PerOpResult {
  return applyInsertSubtree({ document, blocks: op.blocks, parentId: op.parentId, index: op.index });
}

function applyRemoveBlock(document: EmailDocument, op: RemoveBlockOperation): PerOpResult {
  if (op.blockId === ROOT_BLOCK_ID) {
    return fail({
      code: "root_not_allowed",
      message: "The root block cannot be removed.",
      blockId: ROOT_BLOCK_ID,
    });
  }
  const block = document[op.blockId];
  if (block === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.blockId}" does not exist in the document.`,
      blockId: op.blockId,
    });
  }
  const parentId = block.parentId as BlockId | null;
  const parent = parentId === null ? undefined : document[parentId];
  if (parentId === null || parent === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.blockId}" has no existing parent ("${String(parentId)}"); the document is structurally unsound.`,
      blockId: op.blockId,
    });
  }
  const removedIndex = (parent.childrenIds as BlockId[]).indexOf(op.blockId);
  if (removedIndex === -1) {
    return fail({
      code: "target_not_found",
      message: `Parent "${parentId}" does not list "${op.blockId}" as a child; the document is structurally unsound.`,
      blockId: op.blockId,
      relatedBlockId: parentId,
    });
  }
  const removedIds = getSubtreeIds(document, op.blockId);
  const removedBlocks = removedIds.map((removedId) => document[removedId]!);
  const nextDocument: EmailDocument = { ...document };
  for (const removedId of removedIds) {
    delete nextDocument[removedId];
  }
  nextDocument[parentId] = {
    ...parent,
    childrenIds: (parent.childrenIds as BlockId[]).filter((childId) => childId !== op.blockId),
  } as Block;
  return ok(nextDocument, {
    name: "restoreBlocks",
    blocks: structuredClone(removedBlocks),
    parentId,
    index: removedIndex,
  });
}

function applyMoveBlock(document: EmailDocument, op: MoveBlockOperation): PerOpResult {
  if (op.blockId === ROOT_BLOCK_ID) {
    return fail({
      code: "root_not_allowed",
      message: "The root block cannot be moved.",
      blockId: ROOT_BLOCK_ID,
    });
  }
  const block = document[op.blockId];
  if (block === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.blockId}" does not exist in the document.`,
      blockId: op.blockId,
    });
  }
  const newParent = document[op.newParentId];
  if (newParent === undefined) {
    return fail({
      code: "target_not_found",
      message: `Destination parent "${op.newParentId}" does not exist in the document.`,
      blockId: op.newParentId,
    });
  }
  if (getSubtreeIds(document, op.blockId).includes(op.newParentId)) {
    return fail({
      code: "nesting_violation",
      message: `Cannot move "${op.blockId}" into "${op.newParentId}": that would place the block inside its own subtree, creating a cycle.`,
      blockId: op.blockId,
      relatedBlockId: op.newParentId,
    });
  }
  const allowedChildTypes = ALLOWED_CHILD_TYPES[newParent.type];
  if (!allowedChildTypes.includes(block.type)) {
    return fail({
      code: "nesting_violation",
      message: `A ${block.type} block cannot be a child of a ${newParent.type} block ("${op.newParentId}"). Allowed children of ${newParent.type}: ${
        allowedChildTypes.length > 0 ? allowedChildTypes.join(", ") : "none"
      }.`,
      blockId: op.blockId,
      relatedBlockId: op.newParentId,
    });
  }
  const oldParentId = block.parentId as BlockId;
  const oldParent = document[oldParentId];
  if (oldParent === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.blockId}" has a missing parent ("${oldParentId}"); the document is structurally unsound.`,
      blockId: op.blockId,
      relatedBlockId: oldParentId,
    });
  }
  const oldIndex = (oldParent.childrenIds as BlockId[]).indexOf(op.blockId);
  if (oldIndex === -1) {
    return fail({
      code: "target_not_found",
      message: `Parent "${oldParentId}" does not list "${op.blockId}" as a child; the document is structurally unsound.`,
      blockId: op.blockId,
      relatedBlockId: oldParentId,
    });
  }
  const isSameParent = oldParentId === op.newParentId;
  const detachedOldChildren = (oldParent.childrenIds as BlockId[]).filter(
    (childId) => childId !== op.blockId,
  );
  const destinationChildren = isSameParent
    ? detachedOldChildren
    : (newParent.childrenIds as BlockId[]);
  if (op.index > destinationChildren.length) {
    return fail({
      code: "index_out_of_range",
      message: `Index ${op.index} is out of range: destination "${op.newParentId}" would have ${destinationChildren.length} other children (valid: 0–${destinationChildren.length}).`,
      blockId: op.newParentId,
    });
  }
  const movedBlock = { ...block, parentId: op.newParentId } as Block;
  const nextDocument: EmailDocument = { ...document, [op.blockId]: movedBlock };
  if (isSameParent) {
    nextDocument[oldParentId] = {
      ...oldParent,
      childrenIds: insertAt({ items: detachedOldChildren, index: op.index, item: op.blockId }),
    } as Block;
  } else {
    nextDocument[oldParentId] = { ...oldParent, childrenIds: detachedOldChildren } as Block;
    nextDocument[op.newParentId] = {
      ...newParent,
      childrenIds: insertAt({ items: newParent.childrenIds as BlockId[], index: op.index, item: op.blockId }),
    } as Block;
  }
  return ok(nextDocument, {
    name: "moveBlock",
    blockId: op.blockId,
    newParentId: oldParentId,
    index: oldIndex,
  });
}

function applyReorderChildren(
  document: EmailDocument,
  op: ReorderChildrenOperation,
): PerOpResult {
  const parent = document[op.parentId];
  if (parent === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.parentId}" does not exist in the document.`,
      blockId: op.parentId,
    });
  }
  const currentChildIds = parent.childrenIds as BlockId[];
  const currentIdSet = new Set(currentChildIds);
  const orderedIdSet = new Set(op.orderedChildIds);
  const isPermutation =
    op.orderedChildIds.length === currentChildIds.length &&
    orderedIdSet.size === op.orderedChildIds.length &&
    currentChildIds.every((childId) => orderedIdSet.has(childId));
  if (!isPermutation) {
    const missingIds = currentChildIds.filter((childId) => !orderedIdSet.has(childId));
    const unknownIds = op.orderedChildIds.filter((childId) => !currentIdSet.has(childId));
    const details = [
      missingIds.length > 0 ? `missing: ${missingIds.join(", ")}` : undefined,
      unknownIds.length > 0 ? `not children of this parent: ${unknownIds.join(", ")}` : undefined,
      orderedIdSet.size !== op.orderedChildIds.length ? "contains duplicates" : undefined,
    ]
      .filter((detail) => detail !== undefined)
      .join("; ");
    return fail({
      code: "children_not_permutation",
      message: `orderedChildIds must be an exact permutation of "${op.parentId}"'s current children [${currentChildIds.join(", ")}]${details.length > 0 ? ` — ${details}` : ""}.`,
      blockId: op.parentId,
    });
  }
  const nextDocument: EmailDocument = {
    ...document,
    [op.parentId]: { ...parent, childrenIds: [...op.orderedChildIds] } as Block,
  };
  return ok(nextDocument, {
    name: "reorderChildren",
    parentId: op.parentId,
    orderedChildIds: [...currentChildIds],
  });
}

function applyUpdateText(document: EmailDocument, op: UpdateTextOperation): PerOpResult {
  const block = document[op.blockId];
  if (block === undefined) {
    return fail({
      code: "target_not_found",
      message: `Text block "${op.blockId}" does not exist in the document.`,
      blockId: op.blockId,
    });
  }
  if (block.type !== "text") {
    return fail({
      code: "wrong_block_type",
      message: `Block "${op.blockId}" is a ${block.type} block; updateText only applies to text blocks.`,
      blockId: op.blockId,
    });
  }
  const previousText = block.properties.text;
  const nextDocument: EmailDocument = {
    ...document,
    [op.blockId]: { ...block, properties: { ...block.properties, text: op.text } },
  };
  return ok(nextDocument, {
    name: "updateText",
    blockId: op.blockId,
    text: structuredClone(previousText),
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function applyParsedOperation(document: EmailDocument, op: Operation): PerOpResult {
  switch (op.name) {
    case "updateBlockProperties":
      return applyUpdateBlockProperties(document, op);
    case "replaceBlockProperties":
      return applyReplaceBlockProperties(document, op);
    case "updateDocumentSettings":
    case "applyTheme":
      return applyGlobalsChange(document, op);
    case "addBlock":
      return applyAddBlock(document, op);
    case "addSection":
      return applyAddSection(document, op);
    case "restoreBlocks":
      return applyRestoreBlocks(document, op);
    case "removeBlock":
      return applyRemoveBlock(document, op);
    case "moveBlock":
      return applyMoveBlock(document, op);
    case "reorderChildren":
      return applyReorderChildren(document, op);
    case "updateText":
      return applyUpdateText(document, op);
  }
}

/**
 * Apply one operation to a document. Pure: the input document is never
 * mutated. On success, returns the new document and the exact inverse
 * operation. On failure, returns structured errors and the input document
 * remains the source of truth.
 *
 * The operation envelope is re-validated at runtime (so unvalidated
 * LLM/network payloads are safe to pass), and every successful application
 * re-validates the RESULTING document against the full document schema and
 * the referential integrity checker before it is returned.
 */
export function applyOperation(document: EmailDocument, operation: Operation): ApplyOperationResult {
  const parsedOperation = operationSchema.safeParse(operation);
  if (!parsedOperation.success) {
    return fail({
      code: "op_validation_failed",
      message: `Operation failed validation: ${formatZodIssues(parsedOperation.error)}`,
    });
  }
  const outcome = applyParsedOperation(document, parsedOperation.data);
  if (!outcome.isOk) {
    return outcome;
  }

  // Non-negotiable invariant: re-validate schema + integrity of the result.
  const documentCheck = emailDocumentSchema.safeParse(outcome.doc);
  if (!documentCheck.success) {
    return fail({
      code: "schema_validation_failed",
      message: `Resulting document failed schema validation: ${formatZodIssues(documentCheck.error)}`,
    });
  }
  const integrity = checkDocumentIntegrity(outcome.doc);
  if (!integrity.isValid) {
    return fail(
      ...integrity.errors.map(
        (error): OperationError => ({
          code: "integrity_check_failed",
          message: `Integrity violation (${error.code}): ${error.message}`,
          blockId: error.blockId,
          relatedBlockId: error.relatedBlockId,
        }),
      ),
    );
  }
  return outcome;
}

/**
 * Apply a batch of operations sequentially, all-or-nothing. If any operation
 * fails, the failure (with the failing operation's index) is returned and the
 * input document is unchanged — no partial application ever escapes.
 *
 * On success, `inverses` holds each operation's inverse in REVERSE order, so
 * applying `inverses` front-to-back (e.g. via another applyOperations call)
 * undoes the entire batch.
 */
export function applyOperations(
  document: EmailDocument,
  operations: readonly Operation[],
): ApplyOperationsResult {
  let currentDocument = document;
  const inverses: Operation[] = [];
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const result = applyOperation(currentDocument, operations[operationIndex]!);
    if (!result.isOk) {
      return { isOk: false, errors: result.errors, failedOperationIndex: operationIndex };
    }
    currentDocument = result.doc;
    inverses.unshift(result.inverse);
  }
  return { isOk: true, doc: currentDocument, inverses };
}
