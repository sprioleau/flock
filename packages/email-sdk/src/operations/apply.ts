import { z } from "zod";
import { blockSchema, type Block } from "../schema/blocks";
import { LEAF_BLOCK_TYPES, ROOT_BLOCK_ID, type BlockId, type BlockType } from "../schema/ids";
import { emailDocumentSchema, type EmailDocument } from "../store/document";
import { ALLOWED_CHILD_TYPES, checkDocumentIntegrity } from "../store/integrity";
import {
  operationSchema,
  type Operation,
  type AddBlockOperation,
  type AddSectionOperation,
  type ApplyThemeOperation,
  type MoveBlockOperation,
  type PlaceBlockBesideOperation,
  type PreviousColumnWidth,
  type RemoveBlockOperation,
  type ReorderChildrenOperation,
  type ReplaceBlockPropertiesOperation,
  type RestoreBlocksOperation,
  type UnplaceBlockBesideOperation,
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
 * updateDocumentSettings inverse strategy: snapshot the root's ENTIRE
 * properties object and restore it with replaceBlockProperties. A merge
 * cannot generally be undone by another merge, and a whole-properties restore
 * also round-trips the "globals key absent" case exactly.
 */
function applyUpdateDocumentSettings(
  document: EmailDocument,
  op: UpdateDocumentSettingsOperation,
): PerOpResult {
  const root = document[ROOT_BLOCK_ID];
  if (root === undefined || root.type !== "root") {
    return fail({
      code: "target_not_found",
      message: 'Document has no root block; cannot update document settings.',
      blockId: ROOT_BLOCK_ID,
    });
  }
  const nextGlobals = mergeProperties(
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

/** The two section properties a theme owns (stripped by applyTheme). */
const THEME_SECTION_OVERRIDE_KEYS = ["innerBackgroundColor", "outerBackgroundColor"] as const;

/**
 * applyTheme: wholesale-replace `root.properties.globals` AND strip the
 * theme-scoped background overrides (innerBackgroundColor /
 * outerBackgroundColor) from every section, then set the overrides listed in
 * `op.sectionOverrides` (if any). Padding/layout section overrides survive.
 *
 * Inverse design: when no section carried either override, the inverse is the
 * classic root-properties snapshot (replaceBlockProperties — exact, including
 * the "globals key absent" case). When sections DID carry overrides, the
 * inverse is another applyTheme whose `globals` is the previous raw globals
 * and whose `sectionOverrides` re-sets every removed override — one op, one
 * undo step restoring both. (Corner: a root with NO globals key AND section
 * overrides round-trips its globals as `{}` — render- and theme-detection-
 * identical, and unreachable through the SDK's own document constructors.)
 */
function applyApplyTheme(document: EmailDocument, op: ApplyThemeOperation): PerOpResult {
  const root = document[ROOT_BLOCK_ID];
  if (root === undefined || root.type !== "root") {
    return fail({
      code: "target_not_found",
      message: 'Document has no root block; cannot apply a theme.',
      blockId: ROOT_BLOCK_ID,
    });
  }

  // 1. Strip the theme-scoped overrides from every section, remembering what
  //    was removed (the inverse's restore payload).
  const nextDocument: EmailDocument = { ...document };
  const removedOverrides: NonNullable<ApplyThemeOperation["sectionOverrides"]> = [];
  for (const block of Object.values(document)) {
    if (block.type !== "section") {
      continue;
    }
    const { innerBackgroundColor, outerBackgroundColor } = block.properties;
    if (innerBackgroundColor === undefined && outerBackgroundColor === undefined) {
      continue;
    }
    removedOverrides.push({
      blockId: block.id,
      ...(innerBackgroundColor !== undefined ? { innerBackgroundColor } : {}),
      ...(outerBackgroundColor !== undefined ? { outerBackgroundColor } : {}),
    });
    const strippedProperties = { ...block.properties };
    for (const key of THEME_SECTION_OVERRIDE_KEYS) {
      delete strippedProperties[key];
    }
    nextDocument[block.id] = { ...block, properties: strippedProperties };
  }

  // 2. Set the overrides carried on the op (inverse restores; direct callers may too).
  for (const override of op.sectionOverrides ?? []) {
    const section = nextDocument[override.blockId];
    if (section === undefined) {
      return fail({
        code: "target_not_found",
        message: `Section "${override.blockId}" in sectionOverrides does not exist in the document.`,
        blockId: override.blockId,
      });
    }
    if (section.type !== "section") {
      return fail({
        code: "wrong_block_type",
        message: `Block "${override.blockId}" in sectionOverrides is a ${section.type} block; only sections carry theme background overrides.`,
        blockId: override.blockId,
      });
    }
    const overriddenProperties = { ...section.properties };
    if (override.innerBackgroundColor !== undefined) {
      overriddenProperties.innerBackgroundColor = override.innerBackgroundColor;
    }
    if (override.outerBackgroundColor !== undefined) {
      overriddenProperties.outerBackgroundColor = override.outerBackgroundColor;
    }
    const parsedSection = parseBlock(
      { ...section, properties: overriddenProperties },
      override.blockId,
    );
    if ("isOk" in parsedSection) {
      return parsedSection;
    }
    nextDocument[override.blockId] = parsedSection.block;
  }

  // 3. Replace the globals wholesale.
  const parsedRoot = parseBlock(
    { ...root, properties: { ...root.properties, globals: op.globals } },
    ROOT_BLOCK_ID,
  );
  if ("isOk" in parsedRoot) {
    return parsedRoot;
  }
  nextDocument[ROOT_BLOCK_ID] = parsedRoot.block;

  // The classic root-snapshot inverse is only correct when this apply neither
  // removed nor set any section override (a replaceBlockProperties on the
  // root cannot re-strip overrides this op set — e.g. redo after undo).
  const hasSetOverrides = (op.sectionOverrides ?? []).some(
    (override) =>
      override.innerBackgroundColor !== undefined || override.outerBackgroundColor !== undefined,
  );
  const inverse: Operation =
    removedOverrides.length === 0 && !hasSetOverrides
      ? {
          name: "replaceBlockProperties",
          blockId: ROOT_BLOCK_ID,
          properties: structuredClone(root.properties) as Record<string, unknown>,
        }
      : {
          name: "applyTheme",
          globals: structuredClone(root.properties.globals ?? {}),
          sectionOverrides: removedOverrides,
        };
  return ok(nextDocument, inverse);
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
  previousWidths,
}: {
  document: EmailDocument;
  blocks: Block[];
  parentId: BlockId;
  index: number;
  /** Sibling column widths to re-set after the insert (restoreBlocks only). */
  previousWidths?: PreviousColumnWidth[];
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
  // Re-set the sibling column widths a cascading removal stripped, so ONE
  // restoreBlocks (one undo step) puts back the subtree AND the row's exact
  // previous width split.
  for (const { columnId, widthPercent } of previousWidths ?? []) {
    const column = nextDocument[columnId];
    if (column === undefined || column.type !== "column") {
      return fail({
        code: "target_not_found",
        message: `Column "${columnId}" in previousWidths does not exist in the document (or is not a column).`,
        blockId: columnId,
      });
    }
    nextDocument[columnId] = {
      ...column,
      properties: { ...(column.properties as Record<string, unknown>), widthPercent },
    } as Block;
  }
  const hasRestoredWidths = previousWidths !== undefined && previousWidths.length > 0;
  return ok(nextDocument, {
    name: "removeBlock",
    blockId: subtreeRoot.id,
    // Redo must re-strip the widths this restore put back, so the redo
    // document stays deep-equal to the original cascading removal's result.
    ...(hasRestoredWidths ? { shouldRemoveEmptyAncestors: true } : {}),
  });
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
  return applyInsertSubtree({
    document,
    blocks: op.blocks,
    parentId: op.parentId,
    index: op.index,
    previousWidths: op.previousWidths,
  });
}

/**
 * removeBlock — cascading delete of one subtree.
 *
 * With `shouldRemoveEmptyAncestors` (set on every live removal path via
 * withRemoveBlockCascadeDefault; absent on historical logged ops so their
 * replay is byte-identical), empty containers never persist: the removal
 * root ESCALATES while it is its parent column's or row's only child — so
 * deleting a column's last block deletes the column, and deleting a row's
 * last column deletes the whole row. When a column leaves a row that still
 * has other columns, those survivors' explicit widthPercent values are
 * stripped (the placeBlockBeside equal-split convention: no widths = equal
 * shares) and ride on the inverse. The inverse stays ONE restoreBlocks — one
 * delete gesture, one history row, one undo restoring the block, its
 * containers, their position, and the row's exact previous widths.
 */
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

  // Escalate the removal root while removing it would leave an empty column
  // (then an empty row). Sections and the root never collapse.
  let removalRootId = op.blockId;
  if (op.shouldRemoveEmptyAncestors === true) {
    let current: Block = block;
    while (current.parentId !== null && current.parentId !== undefined) {
      const ancestor = document[current.parentId as BlockId];
      if (ancestor === undefined) {
        break;
      }
      const isCollapsibleContainer = ancestor.type === "column" || ancestor.type === "row";
      const isOnlyChild =
        ancestor.childrenIds.length === 1 && ancestor.childrenIds[0] === current.id;
      if (!isCollapsibleContainer || !isOnlyChild) {
        break;
      }
      removalRootId = ancestor.id;
      current = ancestor;
    }
  }

  const removalRoot = document[removalRootId]!;
  const parentId = removalRoot.parentId as BlockId | null;
  const parent = parentId === null ? undefined : document[parentId];
  if (parentId === null || parent === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${removalRootId}" has no existing parent ("${String(parentId)}"); the document is structurally unsound.`,
      blockId: removalRootId,
    });
  }
  const removedIndex = (parent.childrenIds as BlockId[]).indexOf(removalRootId);
  if (removedIndex === -1) {
    return fail({
      code: "target_not_found",
      message: `Parent "${parentId}" does not list "${removalRootId}" as a child; the document is structurally unsound.`,
      blockId: removalRootId,
      relatedBlockId: parentId,
    });
  }
  const removedIds = getSubtreeIds(document, removalRootId);
  const removedBlocks = removedIds.map((removedId) => document[removedId]!);
  const nextDocument: EmailDocument = { ...document };
  for (const removedId of removedIds) {
    delete nextDocument[removedId];
  }
  nextDocument[parentId] = {
    ...parent,
    childrenIds: (parent.childrenIds as BlockId[]).filter((childId) => childId !== removalRootId),
  } as Block;

  // Equal-split redistribution: a column leaving a row resets the survivors
  // to the no-explicit-widths equal split. Stripped values ride on the
  // inverse so one undo restores the exact previous layout.
  const previousWidths: PreviousColumnWidth[] = [];
  if (
    op.shouldRemoveEmptyAncestors === true &&
    removalRoot.type === "column" &&
    parent.type === "row"
  ) {
    for (const columnId of parent.childrenIds as BlockId[]) {
      if (columnId === removalRootId) {
        continue;
      }
      const column = nextDocument[columnId];
      if (column === undefined || column.type !== "column") {
        continue; // unreachable in a sound document; integrity re-checks anyway
      }
      const { widthPercent } = column.properties as { widthPercent?: number };
      if (widthPercent === undefined) {
        continue;
      }
      previousWidths.push({ columnId, widthPercent });
      const strippedProperties = { ...(column.properties as Record<string, unknown>) };
      delete strippedProperties.widthPercent;
      nextDocument[columnId] = { ...column, properties: strippedProperties } as Block;
    }
  }

  return ok(nextDocument, {
    name: "restoreBlocks",
    blocks: structuredClone(removedBlocks),
    parentId,
    index: removedIndex,
    ...(previousWidths.length > 0 ? { previousWidths } : {}),
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

// ---------------------------------------------------------------------------
// placeBlockBeside / unplaceBlockBeside (drag-to-create columns)
// ---------------------------------------------------------------------------

/**
 * The most columns a row may hold. placeBlockBeside enforces it, and the
 * editor's edge-drop zones deactivate at this count.
 */
export const MAX_COLUMNS_PER_ROW = 4;

function isLeafBlockType(type: BlockType): boolean {
  return (LEAF_BLOCK_TYPES as readonly BlockType[]).includes(type);
}

/**
 * placeBlockBeside — ONE undoable step for the "drop a block on another
 * block's edge" gesture. Two structural cases, decided by the target leaf's
 * current parent:
 *
 * - WRAP (target directly in a section): the target's slot in the section is
 *   replaced by a new row of two fresh columns — target in one, the placed
 *   content in the other, ordered by `side`. Both columns omit widthPercent,
 *   which renders as an equal 50/50 split.
 * - INSERT (target inside a column): a new column carrying the content is
 *   inserted beside the target's column (capped at MAX_COLUMNS_PER_ROW), and
 *   every column in the row has its explicit widthPercent stripped so the row
 *   renders as an equal split. The stripped widths ride on the inverse.
 *
 * Content is either a brand-new leaf (palette drop) or an existing leaf moved
 * from anywhere in the document (canvas drag). The inverse is exactly one
 * unplaceBlockBeside carrying everything needed to restore the original
 * document — which is the entire reason this is one operation instead of a
 * composition (one gesture = one history row = one undo).
 */
function applyPlaceBlockBeside(
  document: EmailDocument,
  op: PlaceBlockBesideOperation,
): PerOpResult {
  const target = document[op.targetBlockId];
  if (target === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.targetBlockId}" does not exist in the document.`,
      blockId: op.targetBlockId,
    });
  }
  if (!isLeafBlockType(target.type)) {
    return fail({
      code: "wrong_block_type",
      message: `Block "${op.targetBlockId}" is a ${target.type} block; placeBlockBeside targets leaf blocks only.`,
      blockId: op.targetBlockId,
    });
  }
  const targetParentId = target.parentId as BlockId | null;
  const targetParent = targetParentId === null ? undefined : document[targetParentId];
  if (targetParentId === null || targetParent === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.targetBlockId}" has no existing parent ("${String(targetParentId)}"); the document is structurally unsound.`,
      blockId: op.targetBlockId,
    });
  }

  // Validate the content leaf.
  if (op.content.kind === "existing-block") {
    if (op.content.blockId === op.targetBlockId) {
      return fail({
        code: "op_validation_failed",
        message: `Cannot place block "${op.targetBlockId}" beside itself.`,
        blockId: op.targetBlockId,
      });
    }
    const contentBlock = document[op.content.blockId];
    if (contentBlock === undefined) {
      return fail({
        code: "target_not_found",
        message: `Block "${op.content.blockId}" does not exist in the document.`,
        blockId: op.content.blockId,
      });
    }
    if (!isLeafBlockType(contentBlock.type)) {
      return fail({
        code: "wrong_block_type",
        message: `Block "${op.content.blockId}" is a ${contentBlock.type} block; only leaf blocks can be placed beside another block.`,
        blockId: op.content.blockId,
      });
    }
  } else {
    if (!isLeafBlockType(op.content.block.type)) {
      return fail({
        code: "nesting_violation",
        message: `A ${op.content.block.type} block cannot be placed beside another block; only leaf blocks can.`,
        blockId: op.content.block.id,
      });
    }
    if (document[op.content.block.id] !== undefined) {
      return fail({
        code: "duplicate_block_id",
        message: `A block with id "${op.content.block.id}" already exists; generate a fresh id before placing.`,
        blockId: op.content.block.id,
      });
    }
  }
  const contentBlockId = op.content.kind === "existing-block" ? op.content.blockId : op.content.block.id;

  // Validate the scaffolding ids: present where required, fresh, and distinct.
  const isWrapCase = targetParent.type === "section";
  if (isWrapCase && (op.newRowId === undefined || op.newTargetColumnId === undefined)) {
    return fail({
      code: "op_validation_failed",
      message: `Target "${op.targetBlockId}" sits directly in a section, so placeBlockBeside must wrap it in a row: provide newRowId and newTargetColumnId.`,
      blockId: op.targetBlockId,
    });
  }
  if (!isWrapCase && targetParent.type !== "column") {
    return fail({
      code: "wrong_block_type",
      message: `Block "${op.targetBlockId}" sits in a ${targetParent.type} block; leaves live in sections or columns.`,
      blockId: op.targetBlockId,
      relatedBlockId: targetParentId,
    });
  }
  const scaffoldingIds: BlockId[] = isWrapCase
    ? [op.newRowId!, op.newTargetColumnId!, op.newColumnId]
    : [op.newColumnId];
  const seenIds = new Set<BlockId>([contentBlockId]);
  for (const scaffoldingId of scaffoldingIds) {
    if (document[scaffoldingId] !== undefined || seenIds.has(scaffoldingId)) {
      return fail({
        code: "duplicate_block_id",
        message: `A block with id "${scaffoldingId}" already exists (or repeats in the operation); generate fresh scaffolding ids.`,
        blockId: scaffoldingId,
      });
    }
    seenIds.add(scaffoldingId);
  }

  const nextDocument: EmailDocument = { ...document };

  // 1. Stage the content leaf under the new column (detaching it first when
  //    it comes from elsewhere in the document).
  let inverseContent: UnplaceBlockBesideOperation["content"];
  if (op.content.kind === "existing-block") {
    const movedBlockId = op.content.blockId;
    const contentBlock = document[movedBlockId]!;
    const contentParentId = contentBlock.parentId as BlockId;
    const contentParent = document[contentParentId];
    const contentIndex =
      contentParent === undefined
        ? -1
        : (contentParent.childrenIds as BlockId[]).indexOf(movedBlockId);
    if (contentParent === undefined || contentIndex === -1) {
      return fail({
        code: "target_not_found",
        message: `Block "${movedBlockId}" has no existing parent listing it as a child; the document is structurally unsound.`,
        blockId: movedBlockId,
      });
    }
    nextDocument[contentParentId] = {
      ...contentParent,
      childrenIds: (contentParent.childrenIds as BlockId[]).filter(
        (childId) => childId !== movedBlockId,
      ),
    } as Block;
    nextDocument[movedBlockId] = { ...contentBlock, parentId: op.newColumnId } as Block;
    inverseContent = {
      kind: "existing-block",
      blockId: movedBlockId,
      previousParentId: contentParentId,
      previousIndex: contentIndex,
    };
  } else {
    const parsed = parseBlock({ ...op.content.block, parentId: op.newColumnId }, op.content.block.id);
    if ("isOk" in parsed) {
      return parsed;
    }
    nextDocument[op.content.block.id] = parsed.block;
    inverseContent = { kind: "new-block", blockId: op.content.block.id };
  }

  if (isWrapCase) {
    // 2a. WRAP: the row takes the target's slot in the section.
    const newRowId = op.newRowId!;
    const newTargetColumnId = op.newTargetColumnId!;
    const sectionNow = nextDocument[targetParentId]!;
    if (!(sectionNow.childrenIds as BlockId[]).includes(op.targetBlockId)) {
      return fail({
        code: "target_not_found",
        message: `Section "${targetParentId}" does not list "${op.targetBlockId}" as a child; the document is structurally unsound.`,
        blockId: op.targetBlockId,
        relatedBlockId: targetParentId,
      });
    }
    nextDocument[newRowId] = {
      id: newRowId,
      type: "row",
      parentId: targetParentId,
      childrenIds:
        op.side === "left" ? [op.newColumnId, newTargetColumnId] : [newTargetColumnId, op.newColumnId],
      properties: {},
    } as Block;
    nextDocument[newTargetColumnId] = {
      id: newTargetColumnId,
      type: "column",
      parentId: newRowId,
      childrenIds: [op.targetBlockId],
      properties: {},
    } as Block;
    nextDocument[op.newColumnId] = {
      id: op.newColumnId,
      type: "column",
      parentId: newRowId,
      childrenIds: [contentBlockId],
      properties: {},
    } as Block;
    nextDocument[op.targetBlockId] = { ...target, parentId: newTargetColumnId } as Block;
    nextDocument[targetParentId] = {
      ...sectionNow,
      childrenIds: (sectionNow.childrenIds as BlockId[]).map((childId) =>
        childId === op.targetBlockId ? newRowId : childId,
      ),
    } as Block;
    return ok(nextDocument, {
      name: "unplaceBlockBeside",
      targetBlockId: op.targetBlockId,
      side: op.side,
      newColumnId: op.newColumnId,
      content: inverseContent,
      unwrapRowId: newRowId,
    });
  }

  // 2b. INSERT: a new column beside the target's column, row reset to an
  //     equal split (explicit widths stripped; the inverse restores them).
  const anchorColumnId = targetParentId;
  const rowId = targetParent.parentId as BlockId;
  const row = document[rowId];
  if (row === undefined || row.type !== "row") {
    return fail({
      code: "target_not_found",
      message: `Column "${anchorColumnId}" has no existing row parent ("${rowId}"); the document is structurally unsound.`,
      blockId: anchorColumnId,
      relatedBlockId: rowId,
    });
  }
  if (row.childrenIds.length >= MAX_COLUMNS_PER_ROW) {
    return fail({
      code: "nesting_violation",
      message: `Row "${rowId}" already has ${row.childrenIds.length} columns — the maximum is ${MAX_COLUMNS_PER_ROW}. Place the block elsewhere instead.`,
      blockId: rowId,
    });
  }
  const anchorIndex = (row.childrenIds as BlockId[]).indexOf(anchorColumnId);
  if (anchorIndex === -1) {
    return fail({
      code: "target_not_found",
      message: `Row "${rowId}" does not list "${anchorColumnId}" as a child; the document is structurally unsound.`,
      blockId: anchorColumnId,
      relatedBlockId: rowId,
    });
  }
  const previousWidths: PreviousColumnWidth[] = [];
  for (const columnId of row.childrenIds as BlockId[]) {
    const column = nextDocument[columnId];
    if (column === undefined || column.type !== "column") {
      continue; // unreachable in a sound document; integrity re-checks anyway
    }
    const { widthPercent } = column.properties as { widthPercent?: number };
    if (widthPercent === undefined) {
      continue;
    }
    previousWidths.push({ columnId, widthPercent });
    const strippedProperties = { ...(column.properties as Record<string, unknown>) };
    delete strippedProperties.widthPercent;
    nextDocument[columnId] = { ...column, properties: strippedProperties } as Block;
  }
  nextDocument[op.newColumnId] = {
    id: op.newColumnId,
    type: "column",
    parentId: rowId,
    childrenIds: [contentBlockId],
    properties: {},
  } as Block;
  nextDocument[rowId] = {
    ...row,
    childrenIds: insertAt({
      items: row.childrenIds as BlockId[],
      index: op.side === "right" ? anchorIndex + 1 : anchorIndex,
      item: op.newColumnId,
    }),
  } as Block;
  return ok(nextDocument, {
    name: "unplaceBlockBeside",
    targetBlockId: op.targetBlockId,
    side: op.side,
    newColumnId: op.newColumnId,
    content: inverseContent,
    ...(previousWidths.length > 0 ? { previousWidths } : {}),
  });
}

/**
 * unplaceBlockBeside — the exact inverse of placeBlockBeside. Dissolves the
 * placed column: brand-new content is removed with it, moved content returns
 * to its previous parent and index; the wrap case additionally moves the
 * target back into the section at the row's slot and removes the row with
 * both columns; the insert case restores the stripped column widths.
 *
 * Deliberately strict about the structure it unwinds (the created column must
 * hold exactly the placed block, a wrapped row exactly its two columns): if a
 * newer concurrent edit landed inside the created layout, dissolving it would
 * destroy that edit, so the operation fails instead — surfacing as the
 * standard cross-user undo conflict.
 */
function applyUnplaceBlockBeside(
  document: EmailDocument,
  op: UnplaceBlockBesideOperation,
): PerOpResult {
  const newColumn = document[op.newColumnId];
  if (newColumn === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.newColumnId}" does not exist in the document.`,
      blockId: op.newColumnId,
    });
  }
  if (newColumn.type !== "column") {
    return fail({
      code: "wrong_block_type",
      message: `Block "${op.newColumnId}" is a ${newColumn.type} block; unplaceBlockBeside dissolves columns.`,
      blockId: op.newColumnId,
    });
  }
  const contentBlockId = op.content.blockId;
  const contentBlock = document[contentBlockId];
  if (contentBlock === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${contentBlockId}" does not exist in the document.`,
      blockId: contentBlockId,
    });
  }
  const holdsExactlyContent =
    newColumn.childrenIds.length === 1 && newColumn.childrenIds[0] === contentBlockId;
  if (!holdsExactlyContent) {
    return fail({
      code: "op_validation_failed",
      message: `Column "${op.newColumnId}" no longer holds exactly the placed block "${contentBlockId}"; a newer change landed inside it, so it cannot be dissolved.`,
      blockId: op.newColumnId,
      relatedBlockId: contentBlockId,
    });
  }
  const target = document[op.targetBlockId];
  if (target === undefined) {
    return fail({
      code: "target_not_found",
      message: `Block "${op.targetBlockId}" does not exist in the document.`,
      blockId: op.targetBlockId,
    });
  }

  const nextDocument: EmailDocument = { ...document };
  // Snapshot before any removal — the redo op re-inserts this exact block.
  const contentClone = structuredClone(contentBlock);
  // 1. Empty the created column so removing it never cascades into content.
  nextDocument[op.newColumnId] = { ...newColumn, childrenIds: [] } as Block;

  let redoTargetColumnId: BlockId | null = null;
  if (op.unwrapRowId !== undefined) {
    // 2a. UNWRAP: the target goes back to the section at the row's slot.
    const row = document[op.unwrapRowId];
    if (row === undefined || row.type !== "row") {
      return fail({
        code: "target_not_found",
        message: `Row "${op.unwrapRowId}" does not exist in the document (or is not a row).`,
        blockId: op.unwrapRowId,
      });
    }
    const sectionId = row.parentId as BlockId;
    const section = document[sectionId];
    if (section === undefined || !(section.childrenIds as BlockId[]).includes(op.unwrapRowId)) {
      return fail({
        code: "target_not_found",
        message: `Row "${op.unwrapRowId}" has no section parent listing it as a child; the document is structurally unsound.`,
        blockId: op.unwrapRowId,
      });
    }
    const targetColumnId = target.parentId as BlockId;
    const targetColumn = document[targetColumnId];
    const isTargetInRow =
      targetColumn !== undefined &&
      targetColumn.type === "column" &&
      targetColumn.parentId === op.unwrapRowId;
    const rowChildIds = row.childrenIds as BlockId[];
    const hasExactColumns =
      rowChildIds.length === 2 &&
      rowChildIds.includes(op.newColumnId) &&
      rowChildIds.includes(targetColumnId);
    const targetColumnHoldsExactlyTarget =
      isTargetInRow &&
      targetColumn.childrenIds.length === 1 &&
      targetColumn.childrenIds[0] === op.targetBlockId;
    if (!isTargetInRow || !hasExactColumns || !targetColumnHoldsExactlyTarget) {
      return fail({
        code: "op_validation_failed",
        message: `Row "${op.unwrapRowId}" no longer holds exactly the two columns of the original placement (target "${op.targetBlockId}" alone in one, the placed block alone in the other); a newer change altered it, so it cannot be unwrapped.`,
        blockId: op.unwrapRowId,
        relatedBlockId: op.targetBlockId,
      });
    }
    nextDocument[op.targetBlockId] = { ...target, parentId: sectionId } as Block;
    nextDocument[sectionId] = {
      ...section,
      childrenIds: (section.childrenIds as BlockId[]).map((childId) =>
        childId === op.unwrapRowId ? op.targetBlockId : childId,
      ),
    } as Block;
    delete nextDocument[op.unwrapRowId];
    delete nextDocument[targetColumnId];
    delete nextDocument[op.newColumnId];
    redoTargetColumnId = targetColumnId;
  } else {
    // 2b. Remove the created column from its row; restore stripped widths.
    const rowId = newColumn.parentId as BlockId;
    const row = document[rowId];
    if (row === undefined || row.type !== "row") {
      return fail({
        code: "target_not_found",
        message: `Column "${op.newColumnId}" has no existing row parent ("${rowId}"); the document is structurally unsound.`,
        blockId: op.newColumnId,
        relatedBlockId: rowId,
      });
    }
    nextDocument[rowId] = {
      ...row,
      childrenIds: (row.childrenIds as BlockId[]).filter((childId) => childId !== op.newColumnId),
    } as Block;
    delete nextDocument[op.newColumnId];
    for (const { columnId, widthPercent } of op.previousWidths ?? []) {
      const column = nextDocument[columnId];
      if (column === undefined || column.type !== "column") {
        return fail({
          code: "target_not_found",
          message: `Column "${columnId}" in previousWidths does not exist in the document.`,
          blockId: columnId,
        });
      }
      nextDocument[columnId] = {
        ...column,
        properties: { ...(column.properties as Record<string, unknown>), widthPercent },
      } as Block;
    }
  }

  // 3. The placed block: brand-new content is removed; moved content returns
  //    to its previous parent at its previous index.
  if (op.content.kind === "new-block") {
    delete nextDocument[contentBlockId];
  } else {
    const previousParent = nextDocument[op.content.previousParentId];
    if (previousParent === undefined) {
      return fail({
        code: "target_not_found",
        message: `Previous parent "${op.content.previousParentId}" does not exist in the document.`,
        blockId: op.content.previousParentId,
        relatedBlockId: contentBlockId,
      });
    }
    if (!ALLOWED_CHILD_TYPES[previousParent.type].includes(contentBlock.type)) {
      return fail({
        code: "nesting_violation",
        message: `A ${contentBlock.type} block cannot return to a ${previousParent.type} block ("${op.content.previousParentId}").`,
        blockId: contentBlockId,
        relatedBlockId: op.content.previousParentId,
      });
    }
    if (op.content.previousIndex > previousParent.childrenIds.length) {
      return fail({
        code: "index_out_of_range",
        message: `previousIndex ${op.content.previousIndex} is out of range: parent "${op.content.previousParentId}" has ${previousParent.childrenIds.length} children.`,
        blockId: op.content.previousParentId,
      });
    }
    nextDocument[contentBlockId] = {
      ...contentBlock,
      parentId: op.content.previousParentId,
    } as Block;
    nextDocument[op.content.previousParentId] = {
      ...previousParent,
      childrenIds: insertAt({
        items: previousParent.childrenIds as BlockId[],
        index: op.content.previousIndex,
        item: contentBlockId,
      }),
    } as Block;
  }

  return ok(nextDocument, {
    name: "placeBlockBeside",
    targetBlockId: op.targetBlockId,
    side: op.side,
    content:
      op.content.kind === "new-block"
        ? { kind: "new-block", block: contentClone }
        : { kind: "existing-block", blockId: contentBlockId },
    newColumnId: op.newColumnId,
    ...(op.unwrapRowId !== undefined && redoTargetColumnId !== null
      ? { newRowId: op.unwrapRowId, newTargetColumnId: redoTargetColumnId }
      : {}),
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
      return applyUpdateDocumentSettings(document, op);
    case "applyTheme":
      return applyApplyTheme(document, op);
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
    case "placeBlockBeside":
      return applyPlaceBlockBeside(document, op);
    case "unplaceBlockBeside":
      return applyUnplaceBlockBeside(document, op);
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
