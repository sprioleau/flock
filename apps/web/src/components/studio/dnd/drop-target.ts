"use client";

import {
  ALLOWED_CHILD_TYPES,
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type BlockType,
  type EmailDocument,
  type Operation,
} from "@tandem/email-sdk";
import type { DispatchableOp } from "@/lib/editor-store";
import {
  createDefaultColumnsPreset,
  createDefaultLeafBlock,
  createDefaultSection,
  generateUniqueBlockId,
} from "../block-defaults";
import { getPaletteDragBlockType, type PaletteItem } from "../add-blocks/palette-items";
import type { DragSource, DropIndicatorLine, DropTarget } from "./drag-drop-store";

/**
 * Drop-target resolution for canvas drag-and-drop, driven by the flat block
 * map plus live DOM rects (every canvas block renders with `data-block-id`,
 * and the email surface carries `data-dnd-canvas-root`). A dragged existing
 * block stays mounted (ghosted) during a drag, so all ids resolve to
 * elements.
 *
 * Semantics (SDK nesting rules, ALLOWED_CHILD_TYPES), by drag source:
 * - EXISTING leaf blocks target the innermost section/column on the
 *   pointer's hit chain.
 * - EXISTING sections resolve like palette sections: only the root accepts
 *   a section, so wherever the pointer rests the hit chain walks up to a
 *   root-level gap — a section can never land inside another section or a
 *   column, and the drop is always ONE root reorder (the action-row arrows
 *   coexist as the keyboard path).
 * - PALETTE items resolve with the type they stand in for: leaves →
 *   section/column, column presets (rows) → sections, the Empty Section and
 *   every section-template tile → root-level gaps between sections.
 * Outside any accepting container the position is invalid and resolves to
 * null: no indicator, and release dispatches nothing. Only the ACTIVE
 * draft's editor carries `data-dnd-canvas-root`, so sibling preview frames
 * are inert drop targets structurally.
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
 * What the drag source contributes to resolution: the block type driving the
 * ALLOWED_CHILD_TYPES walk, plus (for existing blocks only) the dragged id
 * and its current parent for noop/column-crossing logic. Null when the
 * source cannot be dragged at all (unknown block, click-only palette item).
 */
interface DraggedDescriptor {
  type: BlockType;
  /** The existing block being moved, or null for palette items. */
  existingBlockId: BlockId | null;
  /** Current parent of an existing block; null for palette items. */
  parentId: BlockId | null;
}

function resolveDraggedDescriptor(args: {
  doc: EmailDocument;
  source: DragSource;
}): DraggedDescriptor | null {
  const { doc, source } = args;
  if (source.kind === "existing-block") {
    const block = doc[source.blockId];
    return block === undefined
      ? null
      : { type: block.type, existingBlockId: block.id, parentId: block.parentId };
  }
  const blockType = getPaletteDragBlockType(source.item);
  return blockType === null ? null : { type: blockType, existingBlockId: null, parentId: null };
}

/**
 * The container that would receive a block of `draggedType` with the pointer
 * resting on `hitBlockId`, or null when nothing on the hit chain may accept
 * it. Pure (doc walk only) — exported so the nesting-legality seam is unit
 * testable without live DOM rects.
 */
export function resolveContainerId(args: {
  doc: EmailDocument;
  draggedType: BlockType;
  hitBlockId: BlockId | null;
}): BlockId | null {
  const { doc, draggedType, hitBlockId } = args;

  // Walk up the hit chain to the first container whose type accepts the
  // dragged type (for a leaf: section or column; for a section — existing
  // or palette — the root, so hovering anywhere in any section resolves to
  // a root-level position and never inside another container).
  for (let id: BlockId | null = hitBlockId; id !== null; ) {
    const block: Block | undefined = doc[id];
    if (block === undefined) {
      return null;
    }
    if (ALLOWED_CHILD_TYPES[block.type].includes(draggedType)) {
      return block.id;
    }
    id = block.parentId;
  }
  // Pointer inside the canvas but over no block (the top padding or the
  // add-section footer): root-accepted types (sections, palette or
  // existing) still land under the root; everything else stays invalid
  // there.
  if (hitBlockId === null && ALLOWED_CHILD_TYPES.root.includes(draggedType)) {
    return ROOT_BLOCK_ID;
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

/** Insertion index for `beforeChildId` among `childIds` (null = append). */
function resolveInsertionIndex(childIds: readonly BlockId[], beforeChildId: BlockId | null): number {
  const referenceIndex = beforeChildId === null ? -1 : childIds.indexOf(beforeChildId);
  return referenceIndex === -1 ? childIds.length : referenceIndex;
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
  dragged: DraggedDescriptor;
  childIds: readonly BlockId[];
  beforeChildId: BlockId | null;
}): DropIndicatorLine | null {
  const { container, dragged, childIds, beforeChildId } = args;
  const insertionIndex = beforeChildId === null ? childIds.length : childIds.indexOf(beforeChildId);
  const isBetweenStackedBlocks = insertionIndex > 0 && insertionIndex < childIds.length;
  const isEnteringOtherColumn =
    container.type === "column" && dragged.parentId !== container.id;

  if (isEnteringOtherColumn && !isBetweenStackedBlocks) {
    const columnRect = getBlockElement(container.id)?.getBoundingClientRect();
    if (columnRect === undefined) {
      return null;
    }
    // Draw along the column edge nearest the block's current home, i.e. the
    // boundary the drag is crossing. Palette items come from the right rail,
    // so a parentless source always enters from the right.
    const sourceRect =
      dragged.parentId === null
        ? undefined
        : getBlockElement(dragged.parentId)?.getBoundingClientRect();
    const isComingFromTheRight =
      dragged.existingBlockId === null ||
      (sourceRect !== undefined && sourceRect.left + sourceRect.width / 2 > columnRect.right);
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
    if (rect === undefined) {
      return null;
    }
    const span = resolveHorizontalIndicatorSpan({ container, referenceRect: rect });
    return { orientation: "horizontal", left: span.left, top: rect.top, length: span.length };
  }
  const lastChildId = childIds[childIds.length - 1];
  if (lastChildId !== undefined) {
    const rect = getBlockElement(lastChildId)?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const span = resolveHorizontalIndicatorSpan({ container, referenceRect: rect });
    return { orientation: "horizontal", left: span.left, top: rect.bottom, length: span.length };
  }
  const rect = getContainerElement(container)?.getBoundingClientRect();
  return rect === undefined
    ? null
    : {
        orientation: "horizontal",
        left: rect.left + 8,
        top: rect.top + Math.min(12, rect.height / 2),
        length: rect.width - 16,
      };
}

/**
 * The container's live DOM element. The ROOT has no `data-block-id` wrapper —
 * it IS the email surface, marked `data-dnd-canvas-root` (only the active
 * frame carries the marker, so this never resolves to a sibling preview).
 */
function getContainerElement(container: Block): HTMLElement | null {
  return container.type === "root"
    ? document.querySelector<HTMLElement>(CANVAS_ROOT_SELECTOR)
    : getBlockElement(container.id);
}

/**
 * Horizontal extent of a stack-position indicator line. Root-level gaps are
 * SECTION boundaries, so the line spans the full email surface width (the
 * canvas root's rect) — matching how block indicators span their container —
 * instead of inheriting whatever width the reference child happens to render
 * at. Non-root containers keep the reference child's own extent.
 */
function resolveHorizontalIndicatorSpan(args: {
  container: Block;
  referenceRect: DOMRect;
}): { left: number; length: number } {
  const { container, referenceRect } = args;
  if (container.type === "root") {
    const rootRect = getContainerElement(container)?.getBoundingClientRect();
    if (rootRect !== undefined) {
      return { left: rootRect.left, length: rootRect.width };
    }
  }
  return { left: referenceRect.left, length: referenceRect.width };
}

function areSameIds(a: readonly BlockId[], b: readonly BlockId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Resolve the pointer to a drop target, or null when the position is invalid
 * for the drag source. A target whose drop would not change the document
 * (only possible for existing-block sources) comes back with `isNoop: true`
 * and no indicator rect.
 */
export function resolveDropTarget(args: {
  doc: EmailDocument;
  source: DragSource;
  pointer: PointerPosition;
}): DropTarget | null {
  const { doc, source, pointer } = args;
  const dragged = resolveDraggedDescriptor({ doc, source });
  if (dragged === null) {
    return null;
  }
  const { hitBlockId, isInsideCanvas } = findBlockUnderPointer(pointer);
  if (!isInsideCanvas) {
    return null;
  }
  const containerId = resolveContainerId({ doc, draggedType: dragged.type, hitBlockId });
  const container = containerId === null ? undefined : doc[containerId];
  if (containerId === null || container === undefined) {
    return null;
  }
  const childIds: readonly BlockId[] = container.childrenIds;
  const beforeChildId = resolveBeforeChildId({ childIds, pointer });
  const isSameParent = dragged.existingBlockId !== null && dragged.parentId === containerId;
  const isNoop =
    isSameParent &&
    areSameIds(
      computeReorderedChildIds({
        childIds,
        draggedBlockId: dragged.existingBlockId as BlockId,
        beforeChildId,
      }),
      childIds,
    );
  return {
    parentId: containerId,
    beforeChildId,
    isNoop,
    indicatorLine: isNoop
      ? null
      : resolveIndicatorLine({ container, dragged, childIds, beforeChildId }),
  };
}

/**
 * The single operation a completed EXISTING-BLOCK drag dispatches, or null
 * for a no-op: same-parent drops become one reorderChildren, cross-parent
 * drops one moveBlock (index is the position after detaching, which for a
 * different parent is simply the position among its current children).
 * Sections always take the reorderChildren branch — their only legal parent
 * is the root, so a section drop is ONE root reorder (single undo).
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
  return {
    name: "moveBlock",
    blockId: draggedBlockId,
    newParentId: dropTarget.parentId,
    index: resolveInsertionIndex(childIds, dropTarget.beforeChildId),
  };
}

/** A palette drop's single op plus the id to select once it applies. */
export interface PaletteInsertion {
  op: DispatchableOp;
  /**
   * The inserted subtree's root (leaf, row, or section) — select + reveal it.
   * Null when the id is only known after dispatch (scaffoldSection resolves
   * server-shaped: read the resulting addSection op's section id from the
   * dispatch result, exactly like the click path in use-click-to-add).
   */
  newBlockId: BlockId | null;
}

/**
 * The single operation a completed PALETTE drag dispatches (one drop = one
 * op = one undo), composed from the shared block-defaults factories:
 * - leaf tiles → `addBlock` with that type's defaults;
 * - column presets → `restoreBlocks` carrying the prebuilt row+columns
 *   subtree (the duplicate button's pattern);
 * - Empty Section → `addSection` at the resolved root position;
 * - section templates → ONE `scaffoldSection` intent at the resolved root
 *   gap, which dispatch resolves to a single canonical `addSection` (so a
 *   template drop is one undo step, same as the click path).
 */
export function buildPaletteDropInsertion(args: {
  doc: EmailDocument;
  item: PaletteItem;
  dropTarget: DropTarget;
}): PaletteInsertion | null {
  const { doc, item, dropTarget } = args;
  const container = doc[dropTarget.parentId];
  if (container === undefined) {
    return null;
  }
  const index = resolveInsertionIndex(container.childrenIds, dropTarget.beforeChildId);
  switch (item.kind) {
    case "leaf": {
      const id = generateUniqueBlockId({ type: item.blockType, doc });
      return {
        op: {
          name: "addBlock",
          block: createDefaultLeafBlock({
            type: item.blockType,
            variant: item.variant,
            id,
            parentId: dropTarget.parentId,
            doc,
          }),
          parentId: dropTarget.parentId,
          index,
        },
        newBlockId: id,
      };
    }
    case "columns": {
      const preset = createDefaultColumnsPreset({
        columnCount: item.columnCount,
        sectionId: dropTarget.parentId,
        doc,
      });
      return {
        op: { name: "restoreBlocks", blocks: preset.blocks, parentId: dropTarget.parentId, index },
        newBlockId: preset.rowId,
      };
    }
    case "empty-section": {
      const id = generateUniqueBlockId({ type: "section", doc });
      return {
        op: { name: "addSection", section: createDefaultSection(id), index },
        newBlockId: id,
      };
    }
    case "section-template":
      // Templates only resolve to root-level gaps (getPaletteDragBlockType
      // stands them in for a section), so beforeChildId is always a
      // top-level section id — exactly scaffoldSection's anchor shape.
      return {
        op: {
          name: "scaffoldSection",
          templateId: item.templateId,
          position:
            dropTarget.beforeChildId === null
              ? "bottom"
              : { beforeSectionId: dropTarget.beforeChildId },
        },
        newBlockId: null,
      };
  }
}
