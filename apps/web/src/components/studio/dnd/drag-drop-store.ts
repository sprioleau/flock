"use client";

import type { BlockId } from "@tandem/email-sdk";
import { create } from "zustand";

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
  /** Block currently being dragged, or null when no drag is active. */
  activeBlockId: BlockId | null;
  /** Valid drop position under the pointer, or null (invalid target). */
  dropTarget: DropTarget | null;
  startDrag: (blockId: BlockId) => void;
  setDropTarget: (dropTarget: DropTarget | null) => void;
  endDrag: () => void;
}

/**
 * Ephemeral drag-gesture UI state, deliberately separate from the document
 * store (it is never persisted or undoable). BlockShell subscribes for
 * ghost/valid-container styling and the drag layer reads the indicator line
 * position — no React context, so pointer moves never rerender the canvas
 * tree wholesale.
 */
export const useCanvasDragStore = create<CanvasDragState>()((set) => ({
  activeBlockId: null,
  dropTarget: null,
  startDrag: (blockId) => set({ activeBlockId: blockId, dropTarget: null }),
  setDropTarget: (dropTarget) => set({ dropTarget }),
  endDrag: () => set({ activeBlockId: null, dropTarget: null }),
}));
