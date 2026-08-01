"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { MessagesSquareIcon, SparklesIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { getLocalCommentAuthorName } from "./comment-author";
import { getIsCommentOrphaned, type CommentThread } from "./comment-context";
import type { DispatchableComment } from "./comment-dispatch";
import { CommentThreadView } from "./CommentThreadView";
import { useCommentFixDispatch } from "./use-comment-fix-dispatch";

/**
 * The review panel (header trigger + modal): every comment thread on the
 * CANVAS — open first, newest first — with the full review workflow per
 * comment (respond / resolve / dismiss / "Fix this") and the ONE-TRIP batch
 * affordance: "Fix all open" packs every open comment on the ACTIVE draft
 * into a single numbered prompt (one model trip). Fix dispatch is scoped to
 * the active draft because chat turns edit the active document — comments on
 * sibling drafts stay readable here and say so on their disabled button.
 *
 * Both fix affordances close the modal: the turn runs VISIBLY in chat and
 * on the canvas (transparency), and the threads gain their "agent
 * responded" entry when it settles — still open, awaiting the human's
 * resolve.
 */
export function CommentsReviewDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const canvasId = useEditorStore((state) => state.canvasId);
  const activeDocumentId = useEditorStore((state) => state.documentId);
  const activeDoc = useEditorStore((state) => state.doc);
  const sessionId = useEditorStore((state) => state.authorId);

  const comments = useQuery(
    api.comments.listCommentsForCanvas,
    canvasId !== null ? { canvasId } : "skip",
  );

  const addThreadEntry = useMutation(api.comments.addThreadEntry);
  const resolveComment = useMutation(api.comments.resolveComment);
  const dismissComment = useMutation(api.comments.dismissComment);
  const { dispatchFix } = useCommentFixDispatch();

  const openComments = (comments ?? []).filter((comment) => comment.status === "open");

  /** Orphan check is only decidable against the active draft's rendered doc. */
  const getIsOrphanedHere = (comment: CommentThread): boolean =>
    comment.documentId === activeDocumentId && getIsCommentOrphaned({ comment, doc: activeDoc });

  const activeDraftDispatchables: DispatchableComment[] = openComments
    .filter((comment) => comment.documentId === activeDocumentId)
    .map((comment) => ({ comment, isOrphaned: getIsOrphanedHere(comment) }));

  const runFix = (dispatchables: readonly DispatchableComment[]): void => {
    if (dispatchFix(dispatchables)) {
      setIsOpen(false); // the turn runs visibly in chat + on the canvas
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              openComments.length > 0
                ? `Review comments (${openComments.length} open)`
                : "Review comments"
            }
            className="relative"
            data-testid="comments-review-trigger"
          />
        }
      >
        <MessagesSquareIcon />
        {openComments.length > 0 && (
          <span
            className={cn(
              "absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center",
              "rounded-full bg-sky-500 px-1 text-[10px] font-medium text-white",
            )}
            data-testid="comments-open-count-badge"
            aria-hidden
          >
            {openComments.length > 9 ? "9+" : openComments.length}
          </span>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" data-testid="comments-review-dialog">
        <DialogHeader>
          <DialogTitle>Comments</DialogTitle>
          <DialogDescription>
            Review feedback on this canvas — reply, resolve, dismiss, or send comments to the AI
            to fix.
          </DialogDescription>
        </DialogHeader>

        {activeDraftDispatchables.length > 0 && (
          <Button
            size="sm"
            className="gap-1.5 self-start"
            onClick={() => runFix(activeDraftDispatchables)}
            data-testid="comments-fix-all-button"
          >
            <SparklesIcon className="size-3.5" />
            Fix all open comments ({activeDraftDispatchables.length})
          </Button>
        )}

        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
          {(comments ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No comments yet — turn on comment mode and click anywhere on the email to leave
              one.
            </p>
          )}
          {(comments ?? []).map((comment) => {
            const isOnActiveDraft = comment.documentId === activeDocumentId;
            const isOrphaned = getIsOrphanedHere(comment);
            return (
              <div
                key={comment.commentId}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3",
                  comment.status !== "open" && "opacity-70",
                )}
                data-testid="comments-review-item"
              >
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 font-medium">
                    {comment.context.draftName}
                  </span>
                  {isOnActiveDraft && <span>(current draft)</span>}
                </div>
                <CommentThreadView
                  comment={comment}
                  isOrphaned={isOrphaned}
                  isDispatchEnabled={isOnActiveDraft}
                  dispatchDisabledReason="Open this draft to run AI fixes on it"
                  onFix={() => runFix([{ comment, isOrphaned }])}
                  onResolve={() => {
                    if (sessionId !== null) {
                      void resolveComment({ commentId: comment.commentId, sessionId });
                    }
                  }}
                  onDismiss={() => {
                    if (sessionId !== null) {
                      void dismissComment({ commentId: comment.commentId, sessionId });
                    }
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
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
