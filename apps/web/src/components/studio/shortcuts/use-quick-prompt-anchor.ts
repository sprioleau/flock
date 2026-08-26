"use client";

import { useCallback, useEffect, useRef } from "react";
import type { BlockId } from "@flock/email-sdk";
import { getActiveEditorStore, type EditorStoreApi } from "@/lib/editor-store";
import { buildCommentAnchorContext } from "../comments/comment-context";
import { useCommentsModeStore } from "../comments/comments-mode-store";
import type { PointerPosition } from "../dnd/drop-target";

/**
 * The quick prompt's CURSOR BINDING: where the "/" card opens, and which block
 * the prompt it carries is about.
 *
 * The binding is one line of substance and no new plumbing. Selecting the
 * block through the editor store is the WHOLE transport — use-flock-chat
 * already puts `selectedBlockId` on every turn — so "make this bigger" typed
 * over a button resolves against that button with nothing new on the wire.
 *
 * The card then SHOWS the block it resolved to (the ancestor trail comments
 * mode already builds), because a prompt silently bound to the wrong block is
 * worse than one bound to nothing: the user can see what "this" means before
 * they commit a turn to it.
 *
 * No block under the pointer — off-canvas, over the page chrome, over the
 * email's own background between sections (the root renders no
 * `[data-block-id]` wrapper) — resolves to null, and null is the CENTERED card
 * exactly as before. Unbound is the honest state there: there is nothing for
 * "this" to mean.
 */

/** Viewport rect of the bound block — only the edges placement reads. */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** An open quick prompt bound to the block that was under the pointer. */
export interface QuickPromptAnchor {
  /** Where "/" was pressed — the card's horizontal anchor. */
  pointer: PointerPosition;
  /** The bound block's rect, which the card dodges rather than covers. */
  blockRect: AnchorRect;
  blockId: BlockId;
  /** "Section › Row › Button" — the trail shown as the resolved target. */
  breadcrumb: string;
  /** Full-word type label ("Button"), for the placeholder copy. */
  blockType: string | undefined;
  /** The block's visible text, when it has any. */
  textSnippet: string | undefined;
}

/** Card width the owner asked for; also what the placement maths reserves. */
export const QUICK_PROMPT_CARD_WIDTH_PX = 450;

/*
  Placement reserves the card's MAXIMUM height, never its current one. The
  textarea grows as the user types, so a position computed from a short card
  would walk off the bottom of the screen mid-sentence. Reserving the fully
  grown height up front makes the position correct at every size — computed
  once when the card opens, and never moved again while typing.
*/
export const QUICK_PROMPT_CARD_MAX_HEIGHT_PX = 240;

/** Keep-on-screen inset, and the breathing room left around the block. */
const VIEWPORT_MARGIN_PX = 8;
const BLOCK_GAP_PX = 10;

/**
 * Where the anchored card sits, in viewport coordinates — or null when there
 * is no anchor, which is the caller's signal to render the centered card.
 *
 * Horizontally the card centres on the pointer, so it reads as "at my
 * cursor", clamped to stay fully on screen. Vertically it prefers the gutter
 * BELOW the bound block, then the gutter above: the block the prompt is about
 * has to stay visible while the user describes it. When the block fills the
 * viewport so that neither gutter can hold the card, it falls back to the
 * pointer and accepts the overlap — at that point covering some of the block
 * is unavoidable, and being on screen matters more.
 */
export function computeQuickPromptPlacement({
  anchor,
  cardWidth,
  cardHeight,
  viewportWidth,
  viewportHeight,
}: {
  anchor: Pick<QuickPromptAnchor, "pointer" | "blockRect"> | null;
  cardWidth: number;
  cardHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): { left: number; top: number } | null {
  if (anchor === null) {
    return null;
  }
  const { pointer, blockRect } = anchor;
  /*
    Math.min then Math.max, in that order: a viewport too narrow for the card
    leaves `maxLeft` below the margin, and the outer Math.max is what keeps
    the card's left edge on screen instead of pushing it off the other side.
  */
  const maxLeft = viewportWidth - cardWidth - VIEWPORT_MARGIN_PX;
  const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(pointer.x - cardWidth / 2, maxLeft));
  const maxTop = viewportHeight - cardHeight - VIEWPORT_MARGIN_PX;

  const belowTop = blockRect.bottom + BLOCK_GAP_PX;
  if (belowTop >= VIEWPORT_MARGIN_PX && belowTop <= maxTop) {
    return { left, top: belowTop };
  }
  const aboveTop = blockRect.top - BLOCK_GAP_PX - cardHeight;
  if (aboveTop >= VIEWPORT_MARGIN_PX && aboveTop <= maxTop) {
    return { left, top: aboveTop };
  }
  return {
    left,
    top: Math.max(VIEWPORT_MARGIN_PX, Math.min(pointer.y + BLOCK_GAP_PX, maxTop)),
  };
}

/**
 * Bind the prompt to `blockId` and describe it for the card.
 *
 * Selecting is the binding: nothing else has to carry the block to the model.
 * Null when the id is not in that store's doc — a DOM block the store has
 * already dropped (mid-apply) — and the caller then opens the centered card
 * unbound rather than binding to an id the document cannot explain.
 */
export function bindQuickPromptToBlock({
  blockId,
  blockRect,
  pointer,
  editorStore,
}: {
  blockId: BlockId;
  blockRect: AnchorRect;
  pointer: PointerPosition;
  editorStore: EditorStoreApi;
}): QuickPromptAnchor | null {
  const context = buildCommentAnchorContext({ doc: editorStore.getState().doc, blockId });
  if (context === null) {
    return null;
  }
  /*
    The selection OUTLIVES the card, deliberately. It is the same selection a
    click on the block would have made, and the outline the canvas draws
    around it is the user's second confirmation — beyond the breadcrumb — that
    "this" landed where they were pointing. Restoring the previous selection
    on dismiss would take that feedback back for no gain.
  */
  editorStore.getState().selectBlock(blockId);
  return {
    pointer,
    blockRect,
    blockId,
    breadcrumb: context.breadcrumb,
    blockType: context.blockType,
    textSnippet: context.textSnippet,
  };
}

const CANVAS_ROOT_SELECTOR = "[data-dnd-canvas-root]";

/**
 * Pointer → the innermost canvas block under it, scoped to the ACTIVE frame's
 * canvas — the same rule drop resolution uses. Under multi-frame editing block
 * ids repeat across forked sibling drafts while the chat turn carries the
 * ACTIVE store's document, so a block sitting in another frame's canvas must
 * never become "this".
 */
function findBlockAtPointer({
  pointer,
  documentId,
}: {
  pointer: PointerPosition;
  documentId: string | null;
}): { blockId: BlockId; blockRect: AnchorRect } | null {
  const blockElement =
    document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>("[data-block-id]") ??
    null;
  const blockId = blockElement?.dataset.blockId;
  if (blockElement === null || blockId === undefined) {
    return null;
  }
  const canvasRoot = blockElement.closest<HTMLElement>(CANVAS_ROOT_SELECTOR);
  if (canvasRoot === null) {
    return null;
  }
  /* Before the store connects there is no id to scope by — any canvas will do. */
  if (documentId !== null && canvasRoot.dataset.canvasDocumentId !== documentId) {
    return null;
  }
  const rect = blockElement.getBoundingClientRect();
  return {
    blockId,
    blockRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
  };
}

/**
 * Tracks the pointer over the app and returns the resolver the "/" binding
 * calls at press time. Kept as a callback rather than state: the pointer moves
 * constantly and nothing renders from it until a key is pressed.
 */
export function useQuickPromptAnchor(): () => QuickPromptAnchor | null {
  const pointerRef = useRef<PointerPosition | null>(null);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", handlePointerMove);
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, []);

  return useCallback((): QuickPromptAnchor | null => {
    const pointer = pointerRef.current;
    if (pointer === null) {
      return null;
    }
    /*
      Comments mode WINS the canvas outright. While it is armed the user has
      deliberately turned the draft into a comment target — crosshair cursor,
      every click drops a pin — and its capture layer already owns the
      pointer. Hit-testing through that layer to plant a second cursor-anchored
      composer on the same pixel would put two floating textareas in one spot
      with different destinations: one writes a comment row, one sends a chat
      turn. So "/" yields and opens the centered card instead, which keeps the
      quick prompt reachable without contesting the canvas.
    */
    if (useCommentsModeStore.getState().isCommentsModeActive) {
      return null;
    }
    const editorStore = getActiveEditorStore();
    const hit = findBlockAtPointer({ pointer, documentId: editorStore.getState().documentId });
    if (hit === null) {
      return null;
    }
    return bindQuickPromptToBlock({ ...hit, pointer, editorStore });
  }, []);
}
