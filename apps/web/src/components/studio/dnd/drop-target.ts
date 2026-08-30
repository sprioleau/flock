"use client";

import {
  ALLOWED_CHILD_TYPES,
  generateBlockId,
  LEAF_BLOCK_TYPES,
  MAX_COLUMNS_PER_ROW,
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type BlockType,
  type EmailDocument,
  type Operation,
  type PlaceBlockBesideOperation,
} from "@flock/email-sdk";
import type { DispatchableOp } from "@/lib/editor-store";
import {
  createDefaultColumnsPreset,
  createDefaultLeafBlock,
  createDefaultSection,
  generateUniqueBlockId,
  type BrandLogoSource,
} from "../block-defaults";
import { getPaletteDragBlockType, type PaletteItem } from "../add-blocks/palette-items";
import type { DragSource, DropIndicatorLine, DropTarget } from "./drag-drop-store";

/*
  Drop-target resolution for canvas drag-and-drop, driven by the flat block
  map plus live DOM rects (every canvas block renders with `data-block-id`,
  and the email surface carries `data-dnd-canvas-root`). A dragged existing
  block stays mounted (ghosted) during a drag, so all ids resolve to
  elements.

  Semantics (SDK nesting rules, ALLOWED_CHILD_TYPES), by drag source:
  - EXISTING leaf blocks target the innermost section/column on the
    pointer's hit chain. A column's whole table CELL counts as the column
    (resolveColumnCellHitBlockId) — an empty column's shell is only a thin
    strip, but hovering anywhere in its cell still drops into the column.
  - EXISTING sections resolve like palette sections: only the root accepts
    a section, so wherever the pointer rests the hit chain walks up to a
    root-level gap — a section can never land inside another section or a
    column, and the drop is always ONE root reorder (the action-row arrows
    coexist as the keyboard path).
  - PALETTE items resolve with the type they stand in for: leaves →
    section/column, column presets (rows) → sections, the Empty Section and
    every section-template tile → root-level gaps between sections.
  Outside any accepting container the position is invalid and resolves to
  null: no indicator, and release dispatches nothing. Resolution is scoped
  to ONE frame's canvas root (existing blocks: their own document's frame;
  palette items: the active frame) — every other frame, live editor or
  preview, is an inert drop target structurally.
*/

/*
  Viewport coordinates of the pointer during a drag.
*/
export interface PointerPosition {
  x: number;
  y: number;
}

const CANVAS_ROOT_SELECTOR = "[data-dnd-canvas-root]";

/*
  THE frame-scoping seam (multi-frame editing): every live frame's email
  surface carries `data-dnd-canvas-root` + `data-canvas-document-id`, block
  ids repeat across forked sibling drafts, and drags are legal only within
  ONE document's frame — so all block-element lookups resolve inside that
  document's canvas root. Null when the frame isn't mounted.
*/
function getCanvasRootElement(documentId: string | null): HTMLElement | null {
  return documentId === null
    ? document.querySelector<HTMLElement>(CANVAS_ROOT_SELECTOR)
    : document.querySelector<HTMLElement>(
        `${CANVAS_ROOT_SELECTOR}[data-canvas-document-id="${CSS.escape(documentId)}"]`,
      );
}

function getBlockElement(canvasRoot: HTMLElement, blockId: BlockId): HTMLElement | null {
  return canvasRoot.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
}

/*
  The innermost canvas block under the pointer (null off-block/off-canvas).
  "Inside the canvas" means inside THIS drag's target frame: hovering another
  frame's canvas — even one rendering the same block ids — resolves as
  outside, which is what structurally rejects cross-frame drags.
*/
function findBlockUnderPointer(args: {
  pointer: PointerPosition;
  canvasRoot: HTMLElement;
}): {
  hitBlockId: BlockId | null;
  isInsideCanvas: boolean;
} {
  const element = document.elementFromPoint(args.pointer.x, args.pointer.y);
  if (element === null) {
    return { hitBlockId: null, isInsideCanvas: false };
  }
  const isInsideCanvas = element.closest(CANVAS_ROOT_SELECTOR) === args.canvasRoot;
  const blockElement = element.closest<HTMLElement>("[data-block-id]");
  return { hitBlockId: (blockElement?.dataset.blockId ?? null) as BlockId | null, isInsideCanvas };
}

/*
  What the drag source contributes to resolution: the block type driving the
  ALLOWED_CHILD_TYPES walk, plus (for existing blocks only) the dragged id
  and its current parent for noop/column-crossing logic. Null when the
  source cannot be dragged at all (unknown block, click-only palette item).
*/
interface DraggedDescriptor {
  type: BlockType;
  /*
    The existing block being moved, or null for palette items.
  */
  existingBlockId: BlockId | null;
  /*
    Current parent of an existing block; null for palette items.
  */
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

/*
  The container that would receive a block of `draggedType` with the pointer
  resting on `hitBlockId`, or null when nothing on the hit chain may accept
  it. Pure (doc walk only) — exported so the nesting-legality seam is unit
  testable without live DOM rects.
*/
export function resolveContainerId(args: {
  doc: EmailDocument;
  draggedType: BlockType;
  hitBlockId: BlockId | null;
}): BlockId | null {
  const { doc, draggedType, hitBlockId } = args;

  /*
    Walk up the hit chain to the first container whose type accepts the
    dragged type (for a leaf: section or column; for a section — existing
    or palette — the root, so hovering anywhere in any section resolves to
    a root-level position and never inside another container).
  */
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
  /*
    Pointer inside the canvas but over no block (the top padding or the
    add-section footer): root-accepted types (sections, palette or
    existing) still land under the root; everything else stays invalid
    there.
  */
  if (hitBlockId === null && ALLOWED_CHILD_TYPES.root.includes(draggedType)) {
    return ROOT_BLOCK_ID;
  }
  return null;
}

/*
  The child the pointer sits above (by vertical midpoint) — the drop lands
  before it. Null appends at the container's end. Children stack vertically
  in every droppable container (root, section, column).
*/
function resolveBeforeChildId(args: {
  childIds: readonly BlockId[];
  pointer: PointerPosition;
  canvasRoot: HTMLElement;
}): BlockId | null {
  for (const childId of args.childIds) {
    const rect = getBlockElement(args.canvasRoot, childId)?.getBoundingClientRect();
    if (rect !== undefined && args.pointer.y < rect.top + rect.height / 2) {
      return childId;
    }
  }
  return null;
}

/*
  Refine a ROW hit to the column CELL under the pointer. A column's shell
  only spans its rendered content (empty columns: just BlockShell's
  min-height strip at the cell's top), while its table cell stretches to the
  row's full height — so a pointer inside a column's cell but below its
  shell hit-tests to the ROW and would otherwise resolve past the column to
  the section. Cells tile the row's width, so the column whose horizontal
  span contains the pointer is the cell being hovered; that column is the
  real target. Pure over an injected span reader so the seam is unit
  testable without live DOM rects.
*/
export function resolveColumnCellHitBlockId(args: {
  doc: EmailDocument;
  hitBlockId: BlockId | null;
  pointerX: number;
  /*
    Live horizontal extent of a column's shell; null when not mounted.
  */
  getColumnSpan: (columnId: BlockId) => { left: number; right: number } | null;
}): BlockId | null {
  const { doc, hitBlockId, pointerX, getColumnSpan } = args;
  const hitBlock = hitBlockId === null ? undefined : doc[hitBlockId];
  if (hitBlock === undefined || hitBlock.type !== "row") {
    return hitBlockId;
  }
  for (const columnId of hitBlock.childrenIds) {
    const span = getColumnSpan(columnId);
    if (span !== null && pointerX >= span.left && pointerX <= span.right) {
      return columnId;
    }
  }
  return hitBlockId;
}

/*
  `childIds` with `draggedBlockId` moved before `beforeChildId` (null = end).
*/
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

/*
  Insertion index for `beforeChildId` among `childIds` (null = append).
*/
function resolveInsertionIndex(childIds: readonly BlockId[], beforeChildId: BlockId | null): number {
  const referenceIndex = beforeChildId === null ? -1 : childIds.indexOf(beforeChildId);
  return referenceIndex === -1 ? childIds.length : referenceIndex;
}

/*
  Indicator geometry for a resolved drop.

  Stack positions get a HORIZONTAL line (top edge of the reference child, or
  bottom of the last child). Entering a DIFFERENT non-empty column at column
  level — the start/end of its stack rather than strictly between two
  stacked blocks — gets a VERTICAL line along the column edge being crossed,
  so a cross-column drag reads as changing columns. An EMPTY column keeps
  the horizontal insert line INSIDE the column (the drop becomes its first
  child — a vertical line there would read as the column-split affordance).
*/
function resolveIndicatorLine(args: {
  container: Block;
  dragged: DraggedDescriptor;
  childIds: readonly BlockId[];
  beforeChildId: BlockId | null;
  canvasRoot: HTMLElement;
}): DropIndicatorLine | null {
  const { container, dragged, childIds, beforeChildId, canvasRoot } = args;
  const insertionIndex = beforeChildId === null ? childIds.length : childIds.indexOf(beforeChildId);
  const isBetweenStackedBlocks = insertionIndex > 0 && insertionIndex < childIds.length;
  const isEnteringOtherColumn =
    container.type === "column" && dragged.parentId !== container.id && childIds.length > 0;

  if (isEnteringOtherColumn && !isBetweenStackedBlocks) {
    const columnRect = getBlockElement(canvasRoot, container.id)?.getBoundingClientRect();
    if (columnRect === undefined) {
      return null;
    }
    /*
      Draw along the column edge nearest the block's current home, i.e. the
      boundary the drag is crossing. Palette items come from the right rail,
      so a parentless source always enters from the right.
    */
    const sourceRect =
      dragged.parentId === null
        ? undefined
        : getBlockElement(canvasRoot, dragged.parentId)?.getBoundingClientRect();
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
    const rect = getBlockElement(canvasRoot, beforeChildId)?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const span = resolveHorizontalIndicatorSpan({ container, referenceRect: rect, canvasRoot });
    return { orientation: "horizontal", left: span.left, top: rect.top, length: span.length };
  }
  const lastChildId = childIds[childIds.length - 1];
  if (lastChildId !== undefined) {
    const rect = getBlockElement(canvasRoot, lastChildId)?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const span = resolveHorizontalIndicatorSpan({ container, referenceRect: rect, canvasRoot });
    return { orientation: "horizontal", left: span.left, top: rect.bottom, length: span.length };
  }
  const rect = getContainerElement({ container, canvasRoot })?.getBoundingClientRect();
  return rect === undefined
    ? null
    : {
        orientation: "horizontal",
        left: rect.left + 8,
        top: rect.top + Math.min(12, rect.height / 2),
        length: rect.width - 16,
      };
}

/*
  The container's live DOM element. The ROOT has no `data-block-id` wrapper —
  it IS the email surface: the frame's canvas root itself.
*/
function getContainerElement(args: {
  container: Block;
  canvasRoot: HTMLElement;
}): HTMLElement | null {
  return args.container.type === "root"
    ? args.canvasRoot
    : getBlockElement(args.canvasRoot, args.container.id);
}

/*
  Horizontal extent of a stack-position indicator line. Root-level gaps are
  SECTION boundaries, so the line spans the full email surface width (the
  canvas root's rect) — matching how block indicators span their container —
  instead of inheriting whatever width the reference child happens to render
  at. Non-root containers keep the reference child's own extent.
*/
function resolveHorizontalIndicatorSpan(args: {
  container: Block;
  referenceRect: DOMRect;
  canvasRoot: HTMLElement;
}): { left: number; length: number } {
  const { container, referenceRect, canvasRoot } = args;
  if (container.type === "root") {
    const rootRect = canvasRoot.getBoundingClientRect();
    return { left: rootRect.left, length: rootRect.width };
  }
  return { left: referenceRect.left, length: referenceRect.width };
}

function areSameIds(a: readonly BlockId[], b: readonly BlockId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/*
  ---------------------------------------------------------------------------
  Column-split edge zones (drag-to-create columns)
  ---------------------------------------------------------------------------
*/

/*
  Edge band width as a share of the hovered leaf's rendered width…
*/
const COLUMN_SPLIT_EDGE_RATIO = 0.22;
/*
  …clamped so tiny blocks stay hittable and wide blocks keep a center.
*/
const COLUMN_SPLIT_EDGE_MIN_PX = 12;
const COLUMN_SPLIT_EDGE_MAX_PX = 56;

function isLeafBlockType(type: BlockType): boolean {
  return (LEAF_BLOCK_TYPES as readonly BlockType[]).includes(type);
}

/*
  Structural eligibility for a column-split drop, pure (no DOM): the hovered
  block must be a LEAF a leaf-type drag can sit beside. Pointer geometry (is
  the pointer actually in an edge band?) is layered on top by
  resolveColumnSplitDropTarget. Null when a split is impossible here:
  - the dragged thing is not a leaf (sections, rows, column presets);
  - the hovered block is not a leaf (sections/rows/columns have no edges);
  - the leaf is the dragged block itself;
  - the leaf sits in a column whose row is at MAX_COLUMNS_PER_ROW.
*/
export function resolveColumnSplitCandidate(args: {
  doc: EmailDocument;
  draggedType: BlockType;
  /*
    The dragged existing block, or null for palette items.
  */
  draggedBlockId: BlockId | null;
  hitBlockId: BlockId | null;
}): { targetBlockId: BlockId } | null {
  const { doc, draggedType, draggedBlockId, hitBlockId } = args;
  if (hitBlockId === null || !isLeafBlockType(draggedType) || hitBlockId === draggedBlockId) {
    return null;
  }
  const hitBlock = doc[hitBlockId];
  if (hitBlock === undefined || !isLeafBlockType(hitBlock.type)) {
    return null;
  }
  const parent = hitBlock.parentId === null ? undefined : doc[hitBlock.parentId];
  if (parent === undefined) {
    return null;
  }
  if (parent.type === "section") {
    return { targetBlockId: hitBlock.id };
  }
  if (parent.type !== "column") {
    return null;
  }
  const row = parent.parentId === null ? undefined : doc[parent.parentId];
  if (row === undefined || row.type !== "row" || row.childrenIds.length >= MAX_COLUMNS_PER_ROW) {
    return null;
  }
  return { targetBlockId: hitBlock.id };
}

/*
  The column-split drop target under the pointer, or null when the pointer
  is not in an eligible leaf's left/right edge band. Checked BEFORE the
  stack-position resolution, so the edge bands win over "insert above/below"
  there; the leaf's center keeps the normal stacking behavior. The indicator
  is a VERTICAL line hugging the leaf's edge — inside the leaf's own rect,
  visually distinct from both the horizontal stack lines and the
  column-boundary line (which spans the column, not the leaf).
*/
function resolveColumnSplitDropTarget(args: {
  doc: EmailDocument;
  documentId: string | null;
  dragged: DraggedDescriptor;
  hitBlockId: BlockId | null;
  pointer: PointerPosition;
  canvasRoot: HTMLElement;
}): DropTarget | null {
  const { doc, documentId, dragged, hitBlockId, pointer, canvasRoot } = args;
  const candidate = resolveColumnSplitCandidate({
    doc,
    draggedType: dragged.type,
    draggedBlockId: dragged.existingBlockId,
    hitBlockId,
  });
  if (candidate === null) {
    return null;
  }
  const rect = getBlockElement(canvasRoot, candidate.targetBlockId)?.getBoundingClientRect();
  if (rect === undefined) {
    return null;
  }
  const bandWidth = Math.min(
    COLUMN_SPLIT_EDGE_MAX_PX,
    Math.max(COLUMN_SPLIT_EDGE_MIN_PX, rect.width * COLUMN_SPLIT_EDGE_RATIO),
  );
  const side =
    pointer.x <= rect.left + bandWidth
      ? ("left" as const)
      : pointer.x >= rect.right - bandWidth
        ? ("right" as const)
        : null;
  if (side === null) {
    return null;
  }
  const inset = 2;
  return {
    kind: "column-split",
    documentId: documentId as DropTarget["documentId"],
    targetBlockId: candidate.targetBlockId,
    side,
    isNoop: false,
    indicatorLine: {
      orientation: "vertical",
      left: side === "left" ? rect.left + inset : rect.right - inset,
      top: rect.top + inset,
      length: Math.max(16, rect.height - inset * 2),
    },
  };
}

/*
  Fresh, mutually-distinct block ids for one op's scaffolding (a lone
  generateUniqueBlockId call only checks the doc, not its own siblings).
*/
function generateFreshBlockIds({
  doc,
  types,
}: {
  doc: EmailDocument;
  types: readonly BlockType[];
}): BlockId[] {
  const usedIds = new Set<string>(Object.keys(doc));
  return types.map((type) => {
    let id: string = generateBlockId(type);
    while (usedIds.has(id)) {
      id = generateBlockId(type);
    }
    usedIds.add(id);
    return id as BlockId;
  });
}

/*
  The single placeBlockBeside op for a completed column-split drop. The op
  decides wrap-vs-insert from the document, but the SCAFFOLDING ids are
  caller-generated (ops must be replayable data), so this builder inspects
  the target's parent to know which ids to mint.
*/
function buildColumnSplitOperation(args: {
  doc: EmailDocument;
  dropTarget: Extract<DropTarget, { kind: "column-split" }>;
  content: PlaceBlockBesideOperation["content"];
}): PlaceBlockBesideOperation | null {
  const { doc, dropTarget, content } = args;
  const target = doc[dropTarget.targetBlockId];
  const targetParent = target?.parentId == null ? undefined : doc[target.parentId];
  if (target === undefined || targetParent === undefined) {
    return null;
  }
  if (targetParent.type === "section") {
    const [newColumnId, newRowId, newTargetColumnId] = generateFreshBlockIds({
      doc,
      types: ["column", "row", "column"],
    });
    return {
      name: "placeBlockBeside",
      targetBlockId: dropTarget.targetBlockId,
      side: dropTarget.side,
      content,
      newColumnId: newColumnId!,
      newRowId: newRowId!,
      newTargetColumnId: newTargetColumnId!,
    };
  }
  const [newColumnId] = generateFreshBlockIds({ doc, types: ["column"] });
  return {
    name: "placeBlockBeside",
    targetBlockId: dropTarget.targetBlockId,
    side: dropTarget.side,
    content,
    newColumnId: newColumnId!,
  };
}

/*
  Resolve the pointer to a drop target, or null when the position is invalid
  for the drag source. A target whose drop would not change the document
  (only possible for existing-block sources) comes back with `isNoop: true`
  and no indicator rect.
*/
export function resolveDropTarget(args: {
  /*
    The TARGET document's doc (existing blocks: the source frame's; palette: the active).
  */
  doc: EmailDocument;
  /*
    The target document id — scopes every DOM lookup to that frame.
  */
  documentId: string | null;
  source: DragSource;
  pointer: PointerPosition;
}): DropTarget | null {
  const { doc, documentId, source, pointer } = args;
  const dragged = resolveDraggedDescriptor({ doc, source });
  if (dragged === null) {
    return null;
  }
  const canvasRoot = getCanvasRootElement(documentId);
  if (canvasRoot === null) {
    return null;
  }
  const { hitBlockId: rawHitBlockId, isInsideCanvas } = findBlockUnderPointer({
    pointer,
    canvasRoot,
  });
  if (!isInsideCanvas) {
    return null;
  }
  /*
    A raw ROW hit means the pointer is in a column's cell but off that
    column's shell (empty or short columns) — resolve it to the cell's
    column so empty columns are first-class drop targets.
  */
  const hitBlockId = resolveColumnCellHitBlockId({
    doc,
    hitBlockId: rawHitBlockId,
    pointerX: pointer.x,
    getColumnSpan: (columnId) => {
      const rect = getBlockElement(canvasRoot, columnId)?.getBoundingClientRect();
      return rect === undefined ? null : { left: rect.left, right: rect.right };
    },
  });
  /*
    Edge bands first: a leaf-type drag hovering a leaf's left/right edge is a
    column-split; everywhere else (including the leaf's center) falls through
    to the normal stack-position resolution.
  */
  const columnSplitTarget = resolveColumnSplitDropTarget({
    doc,
    documentId,
    dragged,
    hitBlockId,
    pointer,
    canvasRoot,
  });
  if (columnSplitTarget !== null) {
    return columnSplitTarget;
  }
  const containerId = resolveContainerId({ doc, draggedType: dragged.type, hitBlockId });
  const container = containerId === null ? undefined : doc[containerId];
  if (containerId === null || container === undefined) {
    return null;
  }
  const childIds: readonly BlockId[] = container.childrenIds;
  const beforeChildId = resolveBeforeChildId({ childIds, pointer, canvasRoot });
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
    kind: "insert",
    documentId: documentId as DropTarget["documentId"],
    parentId: containerId,
    beforeChildId,
    isNoop,
    indicatorLine: isNoop
      ? null
      : resolveIndicatorLine({ container, dragged, childIds, beforeChildId, canvasRoot }),
  };
}

/*
  The single operation a completed EXISTING-BLOCK drag dispatches, or null
  for a no-op: same-parent drops become one reorderChildren, cross-parent
  drops one moveBlock (index is the position after detaching, which for a
  different parent is simply the position among its current children), and
  edge drops one placeBlockBeside (the dragged leaf moves into the new
  column). Sections always take the reorderChildren branch — their only
  legal parent is the root, so a section drop is ONE root reorder (single
  undo). Every branch is one op = one undo step.
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
  if (dropTarget.kind === "column-split") {
    return buildColumnSplitOperation({
      doc,
      dropTarget,
      content: { kind: "existing-block", blockId: draggedBlockId },
    });
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

/*
  A palette drop's single op plus the id to select once it applies.
*/
export interface PaletteInsertion {
  op: DispatchableOp;
  /*
    The inserted subtree's root (leaf, row, or section) — select + reveal it.
    Null when the id is only known after dispatch (scaffoldSection resolves
    server-shaped: read the resulting addSection op's section id from the
    dispatch result, exactly like the click path in use-click-to-add).
  */
  newBlockId: BlockId | null;
}

/*
  The single operation a completed PALETTE drag dispatches (one drop = one
  op = one undo), composed from the shared block-defaults factories:
  - leaf tiles → `addBlock` with that type's defaults — or ONE
    `placeBlockBeside` when the drop resolved to a leaf's edge band (the new
    default-built leaf lands in the freshly created column);
  - column presets → `restoreBlocks` carrying the prebuilt row+columns
    subtree (the duplicate button's pattern);
  - Empty Section → `addSection` at the resolved root position;
  - section templates → ONE `scaffoldSection` intent at the resolved root
    gap, which dispatch resolves to a single canonical `addSection` (so a
    template drop is one undo step, same as the click path).
*/
export function buildPaletteDropInsertion(args: {
  doc: EmailDocument;
  item: PaletteItem;
  dropTarget: DropTarget;
  /*
    The confirmed brand logo for the Logo preset (null = placeholder).
  */
  brandLogo?: BrandLogoSource | null;
}): PaletteInsertion | null {
  const { doc, item, dropTarget, brandLogo } = args;
  if (dropTarget.kind === "column-split") {
    /*
      Only leaf tiles ever resolve to an edge band (resolveColumnSplitCandidate
      gates on the dragged type); the guard is belt-and-suspenders.
    */
    if (item.kind !== "leaf") {
      return null;
    }
    /*
      Overwritten with the op's newColumnId on apply, but the op schema still
      validates it as a leaf's legal parent — so borrow the TARGET's parent
      (a section or column by construction of the drop target).
    */
    const stagingParentId = doc[dropTarget.targetBlockId]?.parentId;
    if (stagingParentId == null) {
      return null;
    }
    const [newLeafId] = generateFreshBlockIds({ doc, types: [item.blockType] });
    const operation = buildColumnSplitOperation({
      doc,
      dropTarget,
      content: {
        kind: "new-block",
        block: createDefaultLeafBlock({
          type: item.blockType,
          variant: item.variant,
          id: newLeafId!,
          parentId: stagingParentId,
          doc,
          brandLogo,
        }),
      },
    });
    return operation === null ? null : { op: operation, newBlockId: newLeafId! };
  }
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
            brandLogo,
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
      /*
        Templates only resolve to root-level gaps (getPaletteDragBlockType
        stands them in for a section), so beforeChildId is always a
        top-level section id — exactly scaffoldSection's anchor shape.
      */
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
