"use client";

import { MessageSquarePlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ShortcutKbd } from "../shortcuts/ShortcutKbd";
import { useCommentsModeStore } from "./comments-mode-store";
import { CommentsReviewDialog } from "./CommentsReviewDialog";

/*
  The header's ONE comments control (owner decrowding request, item 31): a
  compact split button collapsing the two former standalone buttons —
  comment-mode toggle on the left, review-dialog trigger (with its
  open-count badge) on the right — into a single bordered group. Both
  functions stay one click away.

  The toggle arms/disarms the canvas capture overlay: while armed the canvas
  cursor is a crosshair and every click drops a comment pin; Escape, the "c"
  shortcut, or clicking the toggle again leaves the mode. The pressed state
  is visible chrome — the mode suspends normal canvas editing, so it must
  read at a glance.
*/
export function CommentsControl() {
  const isCommentsModeActive = useCommentsModeStore((state) => state.isCommentsModeActive);
  const setIsCommentsModeActive = useCommentsModeStore((state) => state.setIsCommentsModeActive);

  return (
    /*
      No overflow-hidden: the review segment's open-count badge overhangs
      the group's top-right corner (per-segment radii keep the pill shape).
    */
    <div className="flex shrink-0 items-center rounded-md border" data-testid="comments-control">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  isCommentsModeActive ? "Turn off comment mode" : "Turn on comment mode"
                }
                aria-pressed={isCommentsModeActive}
                onClick={() => setIsCommentsModeActive(!isCommentsModeActive)}
                className={cn(
                  "rounded-none rounded-l-[5px]",
                  isCommentsModeActive &&
                    "bg-sky-500/15 text-sky-600 hover:bg-sky-500/25 hover:text-sky-600 dark:text-sky-400",
                )}
                data-testid="comments-mode-toggle"
              />
            }
          >
            <MessageSquarePlusIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex items-center gap-1.5">
            {isCommentsModeActive
              ? "Turn off comment mode (Esc)"
              : "Comment mode — click anywhere on the email to leave a comment"}
            <ShortcutKbd shortcutId="toggleCommentsMode" />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div className="h-4 w-px shrink-0 bg-border" aria-hidden />
      <CommentsReviewDialog triggerClassName="rounded-none rounded-r-[5px]" />
    </div>
  );
}
