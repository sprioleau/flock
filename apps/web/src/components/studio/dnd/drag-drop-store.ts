"use client";

import type { BlockId } from "@tandem/email-sdk";
import { create } from "zustand";
import type { PaletteItem } from "../add-blocks/palette-items";

/**
 * What is being dragged: an existing canvas block being moved/reordered, or
 * a palette item from the Blocks tab about to be inserted with defaults.
 * Everything downstream (drop resolution, indicator, overlay, the sibling-
 * frame reject affordance) branches on this union instead of assuming the
 * dragged thing already lives in the document.
 */
export type DragSource =
  | { kind: "existing-block"; blockId: BlockId }
  | { kind: "palette"; item: PaletteItem };

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

/** A resolved drop position under the pointer (see resolveDropTarget). */
export interface DropTarget {
  /** Container that would receive the dragged block. */
  parentId: BlockId;
  /** Sibling the dragged block would be inserted before; null = append. */
  beforeChildId: BlockId | null;
  /** True when dropping here would leave the document unchanged. */
  isNoop: boolean;
  /** Where to draw the indicator line; null when isNoop (no line shown). */
  indicatorLine: DropIndicatorLine | null;
}

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
