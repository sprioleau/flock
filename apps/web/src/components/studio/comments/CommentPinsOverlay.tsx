"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { MessageCircleIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEditorStore } from "@/lib/editor-store";
import { resolvePointerPosition } from "../presence/PointerPresenceOverlay";
import { getLocalCommentAuthorName } from "./comment-author";
import type { CommentThread } from "./comment-context";
import { useCommentsModeStore } from "./comments-mode-store";
import { CommentThreadView } from "./CommentThreadView";
import { useCommentFixDispatch } from "./use-comment-fix-dispatch";

/**
 * The comment PINS layer: every OPEN comment on this document as a pin on
 * the canvas, resolved against the LOCAL layout through the same
 * anchor-resolution as remote cursors (block-anchored pins ride their block;
 * draft-level pins hold canvas fractions). Pins whose anchor block is gone
 * simply don't resolve and stay hidden here — the thread survives in the
 * review panel with its frozen context (orphaned-but-readable).
 *
 * Shared rows: the pins feed is a reactive Convex query, so pins placed in
 * any tab/by any collaborator appear everywhere. Clicking a pin opens the
 * thread popover (respond / fix / resolve / dismiss). The layer itself is
 * pointer-events-none; only pins are interactive — and they stay clickable
 * WHILE comments mode is armed (the layer sits above the capture overlay).
 */
export function CommentPinsOverlay() {
  const documentId = useEditorStore((state) => state.documentId);
  const activeDoc = useEditorStore((state) => state.doc);
  const comments = useQuery(
    api.comments.listOpenCommentsForDocument,
    documentId !== null ? { documentId } : "skip",
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [positionsByCommentId, setPositionsByCommentId] = useState<
    Map<string, { left: number; top: number }>
  >(new Map());

  const openThreadCommentId = useCommentsModeStore((state) => state.openThreadCommentId);
  const setOpenThreadCommentId = useCommentsModeStore((state) => state.setOpenThreadCommentId);

  // Re-anchor pins on local layout shifts (viewport toggle, reflow) — the
  // canvas root resizes with its content, so one ResizeObserver covers them.
  useEffect(() => {
    const canvasRoot = containerRef.current?.parentElement ?? null;
    if (canvasRoot === null) {
      return;
    }
    const observer = new ResizeObserver(() => setLayoutVersion((version) => version + 1));
    observer.observe(canvasRoot);
    return () => observer.disconnect();
  }, []);

  // Resolve every pin's anchor against the local layout. `activeDoc` is a
  // dependency on purpose: block edits can move anchors without resizing the
  // canvas root (e.g. equal-height swaps).
  useLayoutEffect(() => {
    const overlayElement = containerRef.current;
    if (overlayElement === null || comments === undefined) {
      return;
    }
    const nextPositions = new Map<string, { left: number; top: number }>();
    for (const comment of comments) {
      const position = resolvePointerPosition({ pointer: comment.anchor, overlayElement });
      if (position !== null) {
        nextPositions.set(comment.commentId, position);
      }
    }
    setPositionsByCommentId(nextPositions);
  }, [comments, layoutVersion, activeDoc]);

  if (comments === undefined || comments.length === 0) {
    return (
      <div
        ref={containerRef}
        className="pointer-events-none absolute inset-0 z-50"
        data-comments-pins-layer
        data-testid="comment-pins-overlay"
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 z-50"
      data-comments-pins-layer
      data-testid="comment-pins-overlay"
    >
      {comments.map((comment) => {
        const position = positionsByCommentId.get(comment.commentId);
        if (position === undefined) {
          return null; // unresolvable anchor (block gone locally) — review panel only
        }
        return (
          <CommentPin
            key={comment.commentId}
            comment={comment}
            position={position}
            isThreadOpen={openThreadCommentId === comment.commentId}
            onThreadOpenChange={(isOpen) =>
              setOpenThreadCommentId(isOpen ? comment.commentId : null)
            }
          />
        );
      })}
    </div>
  );
}

/** One pin + its thread popover. */
function CommentPin({
  comment,
  position,
  isThreadOpen,
  onThreadOpenChange,
}: {
  comment: CommentThread;
  position: { left: number; top: number };
  isThreadOpen: boolean;
  onThreadOpenChange: (isOpen: boolean) => void;
}) {
  const sessionId = useEditorStore((state) => state.authorId);
  const addThreadEntry = useMutation(api.comments.addThreadEntry);
  const resolveComment = useMutation(api.comments.resolveComment);
  const dismissComment = useMutation(api.comments.dismissComment);
  const { dispatchFix } = useCommentFixDispatch();

  const replyCount = comment.thread.length - 1;

  return (
    <Popover open={isThreadOpen} onOpenChange={onThreadOpenChange}>
      <PopoverTrigger
        aria-label={`Open comment thread${
          comment.context.blockType !== undefined ? ` on ${comment.context.blockType}` : ""
        }`}
        className={
          "pointer-events-auto absolute flex h-6 min-w-6 -translate-y-full cursor-pointer items-center " +
          "justify-center gap-0.5 rounded-full rounded-bl-none border border-background bg-sky-500 px-1 " +
          "text-[10px] font-semibold text-white shadow-md transition-transform hover:scale-110 " +
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        }
        style={{ left: position.left, top: position.top }}
        data-testid={`comment-pin-${comment.commentId}`}
      >
        <MessageCircleIcon className="size-3.5" aria-hidden />
        {replyCount > 0 && <span>{replyCount + 1}</span>}
      </PopoverTrigger>
      <PopoverContent className="w-80" data-testid="comment-thread-popover">
        <CommentThreadView
          comment={comment}
          // A rendered pin's anchor resolved against the live layout, so the
          // block exists here by construction.
          isOrphaned={false}
          isDispatchEnabled
          onFix={() => {
            dispatchFix([{ comment, isOrphaned: false }]);
            onThreadOpenChange(false);
          }}
          onResolve={() => {
            if (sessionId !== null) {
              void resolveComment({ commentId: comment.commentId, sessionId });
            }
            onThreadOpenChange(false);
          }}
          onDismiss={() => {
            if (sessionId !== null) {
              void dismissComment({ commentId: comment.commentId, sessionId });
            }
            onThreadOpenChange(false);
          }}
          onRespond={(text) => {
            if (sessionId !== null) {
              void addThreadEntry({
                commentId: comment.commentId,
                authorKind: "user",
                authorSessionId: sessionId,
                authorName: getLocalCommentAuthorName(sessionId),
                text,
              });
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
