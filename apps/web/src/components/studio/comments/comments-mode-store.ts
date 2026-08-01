"use client";

import { create } from "zustand";
import type { CommentAnchor, CommentAnchorContext } from "./comment-context";

/**
 * Comments-mode UI state — ephemeral and app-local, deliberately separate
 * from the document store (never persisted or undoable; the drag-drop-store
 * pattern). The toolbar toggle flips the mode; the canvas capture overlay
 * reads it and writes the pending pin; the pins overlay reads the open
 * thread id. Comment DATA lives in Convex (shared rows) — this store holds
 * only what is inherently per-tab: which surface is armed and what's open.
 */

/** A placed-but-unsaved pin: the click's resolved anchor awaiting its first text. */
export interface PendingCommentPin {
  anchor: CommentAnchor;
  context: CommentAnchorContext;
}

interface CommentsModeState {
  /** True while the canvas is a comment target (crosshair, clicks drop pins). */
  isCommentsModeActive: boolean;
  /** The in-progress pin + composer, or null. At most one at a time. */
  pendingPin: PendingCommentPin | null;
  /** Comment thread popover currently open on the canvas, or null. */
  openThreadCommentId: string | null;
  setIsCommentsModeActive: (isActive: boolean) => void;
  setPendingPin: (pendingPin: PendingCommentPin | null) => void;
  setOpenThreadCommentId: (commentId: string | null) => void;
}

export const useCommentsModeStore = create<CommentsModeState>((set) => ({
  isCommentsModeActive: false,
  pendingPin: null,
  openThreadCommentId: null,
  setIsCommentsModeActive: (isActive) =>
    set(
      isActive
        ? { isCommentsModeActive: true }
        : // Leaving the mode abandons the unsaved pin (saved threads persist).
          { isCommentsModeActive: false, pendingPin: null },
    ),
  setPendingPin: (pendingPin) => set({ pendingPin }),
  setOpenThreadCommentId: (commentId) => set({ openThreadCommentId: commentId }),
}));
