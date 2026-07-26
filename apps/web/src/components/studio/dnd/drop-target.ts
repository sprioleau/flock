"use client";

import {
  ALLOWED_CHILD_TYPES,
  type Block,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@tandem/email-sdk";
import type { DropIndicatorLine, DropTarget } from "./drag-drop-store";

/**
 * Drop-target resolution for canvas drag-and-drop, driven by the flat block
 * map plus live DOM rects (every canvas block renders with `data-block-id`,
 * and the email surface carries `data-dnd-canvas-root`). The dragged block
 * stays mounted (ghosted) during a drag, so all ids resolve to elements.
 *
 * Semantics (SDK nesting rules, ALLOWED_CHILD_TYPES): only leaf blocks are
 * draggable, and they target the innermost section/column on the pointer's
 * hit chain. Outside any accepting container (e.g. root-level gaps between
 * sections) the position is invalid and resolves to null: no indicator, and
 * release dispatches nothing. Sections reorder via the action-row buttons
 * only.
 */

/** Viewport coordinates of the pointer during a drag. */
export interface PointerPosition {
  x: number;
  y: number;
}

const CANVAS_ROOT_SELECTOR = "[data-dnd-canvas-root]";

function getBlockElement(blockId: BlockId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
}

/** The innermost canvas block under the pointer (null off-block/off-canvas). */
function findBlockUnderPointer(pointer: PointerPosition): {
  hitBlockId: BlockId | null;
  isInsideCanvas: boolean;
} {
  const element = document.elementFromPoint(pointer.x, pointer.y);
  if (element === null) {
    return { hitBlockId: null, isInsideCanvas: false };
  }
  const isInsideCanvas = element.closest(CANVAS_ROOT_SELECTOR) !== null;
  const blockElement = element.closest<HTMLElement>("[data-block-id]");
  return { hitBlockId: (blockElement?.dataset.blockId ?? null) as BlockId | null, isInsideCanvas };
}

/**
 * The container that would receive `draggedBlock` with the pointer resting
 * on `hitBlockId`, or null when nothing on the hit chain may accept it.
 */
function resolveContainerId(args: {
  doc: EmailDocument;
  draggedBlock: Block;
  hitBlockId: BlockId | null;
}): BlockId | null {
  const { doc, draggedBlock, hitBlockId } = args;

  // Walk up the hit chain to the first container whose type accepts the
  // dragged type (for a leaf: section or column; rows and leaves are
  // skipped, and the walk dead-ends at root, which accepts no leaf).
  for (let id: BlockId | null = hitBlockId; id !== null; ) {
    const block: Block | undefined = doc[id];
    if (block === undefined) {
      return null;
    }
    if (ALLOWED_CHILD_TYPES[block.type].includes(draggedBlock.type)) {
      return block.id;
    }
    id = block.parentId;
  }
  return null;
}

/**
 * The child the pointer sits above (by vertical midpoint) — the drop lands
 * before it. Null appends at the container's end. Children stack vertically
 * in every droppable container (root, section, column).
 */
function resolveBeforeChildId(args: {
  childIds: readonly BlockId[];
  pointer: PointerPosition;
}): BlockId | null {
  for (const childId of args.childIds) {
    const rect = getBlockElement(childId)?.getBoundingClientRect();
    if (rect !== undefined && args.pointer.y < rect.top + rect.height / 2) {
      return childId;
    }
  }
  return null;
}

/** `childIds` with `draggedBlockId` moved before `beforeChildId` (null = end). */
export function computeReorderedChildIds(args: {
  childIds: readonly BlockId[];
  draggedBlockId: BlockId;
  beforeChildId: BlockId | null;
}): BlockId[] {
  const { childIds, draggedBlockId, beforeChildId } = args;
  if (beforeChildId === draggedBlockId) {
    return [...childIds];
  }
  const withoutDragged = childIds.filter((id) => id !== draggedBlockId);
  const referenceIndex = beforeChildId === null ? -1 : withoutDragged.indexOf(beforeChildId);
  const insertAt = referenceIndex === -1 ? withoutDragged.length : referenceIndex;
  return [...withoutDragged.slice(0, insertAt), draggedBlockId, ...withoutDragged.slice(insertAt)];
}

/**
 * Indicator geometry for a resolved drop.
 *
 * Stack positions get a HORIZONTAL line (top edge of the reference child, or
 * bottom of the last child). Entering a DIFFERENT column at column level —
 * an empty column, or the start/end of its stack rather than strictly
 * between two stacked blocks — gets a VERTICAL line along the column edge
 * being crossed, so a cross-column drag reads as changing columns.
 */
function resolveIndicatorLine(args: {
  container: Block;
  draggedBlock: Block;
  childIds: readonly BlockId[];
  beforeChildId: BlockId | null;
}): DropIndicatorLine | null {
  const { container, draggedBlock, childIds, beforeChildId } = args;
  const insertionIndex = beforeChildId === null ? childIds.length : childIds.indexOf(beforeChildId);
  const isBetweenStackedBlocks = insertionIndex > 0 && insertionIndex < childIds.length;
  const isEnteringOtherColumn =
    container.type === "column" && draggedBlock.parentId !== container.id;

  if (isEnteringOtherColumn && !isBetweenStackedBlocks) {
    const columnRect = getBlockElement(container.id)?.getBoundingClientRect();
    if (columnRect === undefined) {
      return null;
    }
    // Draw along the column edge nearest the block's current home, i.e. the
    // boundary the drag is crossing.
    const sourceRect =
      draggedBlock.parentId === null
        ? undefined
        : getBlockElement(draggedBlock.parentId)?.getBoundingClientRect();
    const isComingFromTheRight =
      sourceRect !== undefined && sourceRect.left + sourceRect.width / 2 > columnRect.right;
    const inset = 3;
    return {
      orientation: "vertical",
      left: isComingFromTheRight ? columnRect.right - inset : columnRect.left + inset,
      top: columnRect.top + inset,
      length: Math.max(24, columnRect.height - inset * 2),
    };
  }

  if (beforeChildId !== null) {
    const rect = getBlockElement(beforeChildId)?.getBoundingClientRect();
    return rect === undefined
      ? null
      : { orientation: "horizontal", left: rect.left, top: rect.top, length: rect.width };
  }
  const lastChildId = childIds[childIds.length - 1];
  if (lastChildId !== undefined) {
    const rect = getBlockElement(lastChildId)?.getBoundingClientRect();
    return rect === undefined
      ? null
      : { orientation: "horizontal", left: rect.left, top: rect.bottom, length: rect.width };
  }
  const rect = getBlockElement(container.id)?.getBoundingClientRect();
  return rect === undefined
    ? null
    : {
        orientation: "horizontal",
        left: rect.left + 8,
        top: rect.top + Math.min(12, rect.height / 2),
        length: rect.width - 16,
      };
}

function areSameIds(a: readonly BlockId[], b: readonly BlockId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Resolve the pointer to a drop target, or null when the position is invalid
 * for the dragged block. A target whose drop would not change the document
 * comes back with `isNoop: true` and no indicator rect.
 */
export function resolveDropTarget(args: {
  doc: EmailDocument;
  draggedBlockId: BlockId;
  pointer: PointerPosition;
}): DropTarget | null {
  const { doc, draggedBlockId, pointer } = args;
  const draggedBlock = doc[draggedBlockId];
  if (draggedBlock === undefined) {
    return null;
  }
  const { hitBlockId, isInsideCanvas } = findBlockUnderPointer(pointer);
  if (!isInsideCanvas) {
    return null;
  }
  const containerId = resolveContainerId({ doc, draggedBlock, hitBlockId });
  const container = containerId === null ? undefined : doc[containerId];
  if (containerId === null || container === undefined) {
    return null;
  }
  const childIds: readonly BlockId[] = container.childrenIds;
  const beforeChildId = resolveBeforeChildId({ childIds, pointer });
  const isSameParent = draggedBlock.parentId === containerId;
  const isNoop =
    isSameParent &&
    areSameIds(computeReorderedChildIds({ childIds, draggedBlockId, beforeChildId }), childIds);
  return {
    parentId: containerId,
    beforeChildId,
    isNoop,
    indicatorLine: isNoop
      ? null
      : resolveIndicatorLine({ container, draggedBlock, childIds, beforeChildId }),
  };
}

/**
 * The single operation a completed drag dispatches, or null for a no-op:
 * same-parent drops become one reorderChildren, cross-parent drops one
 * moveBlock (index is the position after detaching, which for a different
 * parent is simply the position among its current children).
 */
export function buildDropOperation(args: {
  doc: EmailDocument;
  draggedBlockId: BlockId;
  dropTarget: DropTarget;
}): Operation | null {
  const { doc, draggedBlockId, dropTarget } = args;
  if (dropTarget.isNoop) {
    return null;
  }
  const draggedBlock = doc[draggedBlockId];
  const container = doc[dropTarget.parentId];
  if (draggedBlock === undefined || container === undefined) {
    return null;
  }
  const childIds: readonly BlockId[] = container.childrenIds;
  if (draggedBlock.parentId === dropTarget.parentId) {
    return {
      name: "reorderChildren",
      parentId: dropTarget.parentId,
      orderedChildIds: computeReorderedChildIds({
        childIds,
        draggedBlockId,
        beforeChildId: dropTarget.beforeChildId,
      }),
    };
  }
  const referenceIndex =
    dropTarget.beforeChildId === null ? -1 : childIds.indexOf(dropTarget.beforeChildId);
  return {
    name: "moveBlock",
    blockId: draggedBlockId,
    newParentId: dropTarget.parentId,
    index: referenceIndex === -1 ? childIds.length : referenceIndex,
  };
}
