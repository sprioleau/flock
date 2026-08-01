"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useMutation } from "convex/react";
import { MessageSquarePlusIcon, XIcon } from "lucide-react";
import type { BlockId, EmailDocument } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useEditorStore, useEditorStoreApi } from "@/lib/editor-store";
import { resolvePointerPosition } from "../presence/PointerPresenceOverlay";
import { getLocalCommentAuthorName } from "./comment-author";
import {
  buildCommentAnchorContext,
  toAnchorFraction,
  type CommentAnchor,
} from "./comment-context";
import { useCommentsModeStore, type PendingCommentPin } from "./comments-mode-store";

/**
 * Comments-mode CAPTURE layer: while the mode is on, this overlay covers the
 * whole canvas root (crosshair cursor, all normal canvas interaction
 * suspended) and turns any click into a comment pin:
 *
 * - The click is hit-tested through the overlay (elementsFromPoint) to the
 *   innermost `[data-block-id]` under the pointer — the SAME anchor family
 *   as pointer presence: block-anchored pins store 0..1 fractions of the
 *   block rect; clicks on gutters/empty canvas anchor to the canvas root
 *   (`blockId: null`) as a DRAFT-level comment.
 * - The pin's context (breadcrumb, type, visible text) is frozen from the
 *   store's doc at click time; the server adds draftName/canvasId.
 * - One pending pin at a time: the inline composer opens at the pin; Escape
 *   or an outside click abandons it; Escape with no pin exits the mode.
 *
 * Mounted inside `[data-dnd-canvas-root]` (the overlay idiom) so pins live
 * in content space and scroll with the email.
 */
export function CommentsModeOverlay() {
  const isCommentsModeActive = useCommentsModeStore((state) => state.isCommentsModeActive);
  if (!isCommentsModeActive) {
    return null;
  }
  return <CommentsCaptureLayer />;
}

function CommentsCaptureLayer() {
  // The FRAME's store instance: with multi-frame editing this overlay mounts
  // in EVERY live frame's canvas, so pin context must come from the document
  // the overlay actually covers (frames may share block ids across forks).
  const editorStoreApi = useEditorStoreApi();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const pendingPin = useCommentsModeStore((state) => state.pendingPin);
  const setPendingPin = useCommentsModeStore((state) => state.setPendingPin);

  // Escape walks back one step at a time: open composer → armed mode → off.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      // An Escape pressed inside an open dialog/popover (the review modal,
      // a pin's thread popover) belongs to THAT surface — closing it must
      // not also disarm the mode underneath (verified quirk: the review
      // dialog's close-Escape used to exit the mode too).
      if (
        event.target instanceof Element &&
        event.target.closest('[data-slot="dialog-content"], [data-slot="popover-content"], [role="dialog"]') !== null
      ) {
        return;
      }
      const commentsMode = useCommentsModeStore.getState();
      if (commentsMode.pendingPin !== null) {
        commentsMode.setPendingPin(null);
      } else {
        commentsMode.setIsCommentsModeActive(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleOverlayClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    // Never bubble to the canvas shell (its click clears the selection).
    event.stopPropagation();
    // First click after an open composer just closes it (composer clicks
    // stop propagation, so reaching here means "clicked elsewhere").
    if (useCommentsModeStore.getState().pendingPin !== null) {
      setPendingPin(null);
      return;
    }
    const overlayElement = overlayRef.current;
    const canvasRoot = overlayElement?.parentElement ?? null;
    if (overlayElement === null || canvasRoot === null) {
      return;
    }
    setPendingPin(
      resolveClickToPendingPin({
        clientX: event.clientX,
        clientY: event.clientY,
        overlayElement,
        canvasRoot,
        doc: editorStoreApi.getState().doc,
      }),
    );
  };

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-40 cursor-crosshair"
      onClick={handleOverlayClick}
      data-testid="comments-mode-overlay"
    >
      {pendingPin !== null && (
        <PendingPinComposer pendingPin={pendingPin} onClose={() => setPendingPin(null)} />
      )}
    </div>
  );
}

/**
 * Click → pending pin: hit-test beneath the overlay for the innermost block,
 * fall back to a canvas-root (draft-level) anchor. Context comes from the
 * FRAME's own doc (the overlay mounts per live frame under multi-frame
 * editing).
 */
function resolveClickToPendingPin({
  clientX,
  clientY,
  overlayElement,
  canvasRoot,
  doc,
}: {
  clientX: number;
  clientY: number;
  overlayElement: HTMLDivElement;
  canvasRoot: HTMLElement;
  doc: EmailDocument;
}): PendingCommentPin {
  // Topmost-first hit list; skip our own layers (capture overlay + pins).
  const hitElements = document.elementsFromPoint(clientX, clientY);
  const contentElement =
    hitElements.find(
      (element) =>
        !overlayElement.contains(element) && element.closest("[data-comments-pins-layer]") === null,
    ) ?? null;
  const blockElement =
    contentElement !== null
      ? (() => {
          const candidate = contentElement.closest<HTMLElement>("[data-block-id]");
          return candidate !== null && canvasRoot.contains(candidate) ? candidate : null;
        })()
      : null;

  const blockId = blockElement?.dataset.blockId;
  const blockContext =
    blockId !== undefined
      ? buildCommentAnchorContext({ doc, blockId: blockId as BlockId })
      : null;

  // A DOM block missing from the store doc (mid-apply flicker) degrades to a
  // draft-level anchor rather than storing an id the doc can't explain.
  const anchorElement = blockContext !== null && blockElement !== null ? blockElement : canvasRoot;
  const anchorRect = anchorElement.getBoundingClientRect();
  const anchor: CommentAnchor = {
    blockId: blockContext !== null && blockId !== undefined ? blockId : null,
    x: toAnchorFraction({ pointerCoordinate: clientX, rectStart: anchorRect.left, rectSize: anchorRect.width }),
    y: toAnchorFraction({ pointerCoordinate: clientY, rectStart: anchorRect.top, rectSize: anchorRect.height }),
  };
  return { anchor, context: blockContext ?? { breadcrumb: "" } };
}

/** Composer card width — used for edge clamping inside the overlay. */
const COMPOSER_WIDTH_PX = 264;

/**
 * The inline first-comment composer at the pending pin. Position resolves
 * through the SAME anchor→layout resolution the pins and remote cursors use,
 * clamped so the card never clips at the frame's overflow-hidden edges.
 */
function PendingPinComposer({
  pendingPin,
  onClose,
}: {
  pendingPin: PendingCommentPin;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const createComment = useMutation(api.comments.createComment);
  const documentId = useEditorStore((state) => state.documentId);
  const sessionId = useEditorStore((state) => state.authorId);

  useLayoutEffect(() => {
    const containerElement = containerRef.current;
    const overlayElement = containerElement?.parentElement ?? null;
    if (containerElement === null || overlayElement === null) {
      return;
    }
    const position = resolvePointerPosition({
      pointer: pendingPin.anchor,
      overlayElement,
    });
    if (position === null) {
      return;
    }
    const overlayRect = overlayElement.getBoundingClientRect();
    const left = Math.min(Math.max(position.left, 8), overlayRect.width - COMPOSER_WIDTH_PX - 8);
    const top = Math.min(Math.max(position.top, 8), Math.max(overlayRect.height - 160, 8));
    containerElement.style.left = `${left}px`;
    containerElement.style.top = `${top}px`;
  }, [pendingPin]);

  const submitComment = (): void => {
    const trimmedText = text.trim();
    if (trimmedText.length === 0 || documentId === null || sessionId === null || isSaving) {
      return;
    }
    setIsSaving(true);
    createComment({
      documentId,
      sessionId,
      authorName: getLocalCommentAuthorName(sessionId),
      anchor: pendingPin.anchor,
      context: pendingPin.context,
      text: trimmedText,
    })
      .then(() => onClose())
      .catch((error: unknown) => {
        console.error("createComment failed", error);
        setIsSaving(false);
      });
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-50 flex flex-col gap-2 rounded-xl border bg-popover p-2.5 text-popover-foreground shadow-lg"
      style={{ width: COMPOSER_WIDTH_PX }}
      onClick={(event) => event.stopPropagation()}
      data-testid="comment-composer"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageSquarePlusIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {pendingPin.context.blockType !== undefined
            ? `Comment on this ${pendingPin.context.blockType.toLowerCase()}`
            : "Comment on the email"}
        </span>
        <button
          type="button"
          aria-label="Discard comment"
          onClick={onClose}
          className="ml-auto cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitComment();
          }
        }}
        autoFocus
        placeholder="What should change here?"
        className="min-h-16 resize-none text-sm"
        aria-label="New comment"
        data-testid="comment-composer-input"
      />
      <Button
        size="sm"
        className="self-end"
        disabled={text.trim().length === 0 || isSaving}
        onClick={submitComment}
        data-testid="comment-composer-submit"
      >
        Comment
      </Button>
    </div>
  );
}
