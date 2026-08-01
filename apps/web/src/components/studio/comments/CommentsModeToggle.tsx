"use client";

import { MessageSquarePlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useCommentsModeStore } from "./comments-mode-store";

/**
 * The comments-mode toggle (header, beside the presence cluster): arms/
 * disarms the canvas capture overlay. While armed the canvas cursor is a
 * crosshair and every click drops a comment pin; Escape (or clicking this
 * again) leaves the mode. The pressed state is visible chrome — the mode
 * suspends normal canvas editing, so it must read at a glance.
 */
export function CommentsModeToggle() {
  const isCommentsModeActive = useCommentsModeStore((state) => state.isCommentsModeActive);
  const setIsCommentsModeActive = useCommentsModeStore((state) => state.setIsCommentsModeActive);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={isCommentsModeActive ? "Turn off comment mode" : "Turn on comment mode"}
              aria-pressed={isCommentsModeActive}
              onClick={() => setIsCommentsModeActive(!isCommentsModeActive)}
              className={cn(
                isCommentsModeActive &&
                  "bg-sky-500/15 text-sky-600 hover:bg-sky-500/25 hover:text-sky-600 dark:text-sky-400",
              )}
              data-testid="comments-mode-toggle"
            />
          }
        >
          <MessageSquarePlusIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isCommentsModeActive
            ? "Turn off comment mode (Esc)"
            : "Comment mode — click anywhere on the email to leave a comment"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
