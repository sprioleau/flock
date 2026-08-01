"use client";

import type { BlockId } from "@tandem/email-sdk";
import { create } from "zustand";
import type { Id } from "@convex/_generated/dataModel";
import type { PaletteItem } from "../add-blocks/palette-items";

/**
 * What is being dragged: an existing canvas block being moved/reordered, or
 * a palette item from the Blocks tab about to be inserted with defaults.
 * Everything downstream (drop resolution, indicator, overlay, the sibling-
 * frame reject affordance) branches on this union instead of assuming the
 * dragged thing already lives in the document.
 *
 * Existing-block sources carry the DOCUMENT the block belongs to (multi-frame
 * editing: several sibling drafts render live canvases at once, and forked
 * drafts share block ids, so a bare block id is ambiguous). Drop resolution
 * and the completed-drag dispatch are scoped to that document's frame — a
 * drag can never cross frames. Null only for a source whose frame carried no
 * connected document (boot edge), which resolves as the active document.
 */
export type DragSource =
  | { kind: "existing-block"; blockId: BlockId; documentId: Id<"documents"> | null }
  | { kind: "palette"; item: PaletteItem };

/**
 * @dnd-kit draggable ids must be unique per DndContext, and ONE context spans
 * every live frame — so canvas draggables register with a document-qualified
 * composite id (same `${documentId}:${blockId}` convention as the text-sync
 * doc ids; Convex ids never contain ":", so the first ":" splits safely).
 */
export function buildCanvasDraggableId({
  documentId,
  blockId,
}: {
  documentId: Id<"documents"> | null;
  blockId: BlockId;
}): string {
  return `${documentId ?? "detached"}:${blockId}`;
}

/** Inverse of {@link buildCanvasDraggableId}. */
export function parseCanvasDraggableId(draggableId: string): {
  documentId: Id<"documents"> | null;
  blockId: BlockId;
} {
  const separatorIndex = draggableId.indexOf(":");
  const documentKey = draggableId.slice(0, separatorIndex);
  return {
    documentId: documentKey === "detached" ? null : (documentKey as Id<"documents">),
    blockId: draggableId.slice(separatorIndex + 1) as BlockId,
  };
}

/**
 * The drop-indicator line in viewport coordinates. Horizontal lines mark a
 * position in a vertical stack (length = width); vertical lines mark a
 * column-boundary crossing (length = height) so entering a different column
 * reads as a column change, not a vertical reorder.
 */
export interface DropIndicatorLine {
  orientation: "horizontal" | "vertical";
  left: number;
  top: number;
  length: number;
}

/** Fields every resolved drop position carries (see resolveDropTarget). */
interface DropTargetBase {
  /**
   * The document whose frame the drop resolves in (existing blocks: the
   * source's own document; palette items: the active document). Disambiguates
   * block ids across frames — forked drafts share them.
   */
  documentId: Id<"documents"> | null;
  /** True when dropping here would leave the document unchanged. */
  isNoop: boolean;
  /** Where to draw the indicator line; null when isNoop (no line shown). */
  indicatorLine: DropIndicatorLine | null;
}

/** A stack position inside a container: insert before a sibling / append. */
export interface InsertDropTarget extends DropTargetBase {
  kind: "insert";
  /** Container that would receive the dragged block. */
  parentId: BlockId;
  /** Sibling the dragged block would be inserted before; null = append. */
  beforeChildId: BlockId | null;
}

/**
 * A drop on a leaf block's left/right EDGE: the dragged block becomes that
 * leaf's side-by-side neighbor (drag-to-create columns). Resolves to ONE
 * placeBlockBeside op — wrapping the target in a new 2-column row when it
 * sits directly in a section, or adding a sibling column when it already
 * sits in a column (rows cap at 4 columns; at the cap edge zones go dead).
 */
export interface ColumnSplitDropTarget extends DropTargetBase {
  kind: "column-split";
  /** The leaf block whose edge the pointer is on. */
  targetBlockId: BlockId;
  /** Which side of that leaf the dragged block would land on. */
  side: "left" | "right";
}

/** A resolved drop position under the pointer (see resolveDropTarget). */
export type DropTarget = InsertDropTarget | ColumnSplitDropTarget;

interface CanvasDragState {
  /** The live drag's source, or null when no drag is active. */
  dragSource: DragSource | null;
  /** Valid drop position under the pointer, or null (invalid target). */
  dropTarget: DropTarget | null;
  startDrag: (source: DragSource) => void;
  setDropTarget: (dropTarget: DropTarget | null) => void;
  endDrag: () => void;
}

/**
 * Ephemeral drag-gesture UI state, deliberately separate from the document
 * store (it is never persisted or undoable). BlockShell subscribes for
 * ghost/valid-container styling, the drag layer reads the indicator line
 * position, and the draft frames read the source for the "drops go to the
 * active draft" affordance — no React context, so pointer moves never
 * rerender the canvas tree wholesale.
 */
export const useCanvasDragStore = create<CanvasDragState>()((set) => ({
  dragSource: null,
  dropTarget: null,
  startDrag: (source) => set({ dragSource: source, dropTarget: null }),
  setDropTarget: (dropTarget) => set({ dropTarget }),
  endDrag: () => set({ dragSource: null, dropTarget: null }),
}));
