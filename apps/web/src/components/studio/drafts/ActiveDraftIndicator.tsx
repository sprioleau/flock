"use client";

import { FrameIcon } from "lucide-react";
import { useCanvasDrafts } from "./use-canvas-drafts";

/*
  §10.2 frames UX — the chat panel's activation cue: chat ops always target
  the store-connected document, so activating a frame IS retargeting the
  agent; this makes it visible ("Editing: Spring promo" above the composer,
  updating reactively on activation and on renames). Renders nothing until
  the draft list is known.
*/
export function ActiveDraftIndicator() {
  const { drafts, activeIndex } = useCanvasDrafts();
  const activeDraft = drafts !== undefined && activeIndex >= 0 ? drafts[activeIndex]! : null;
  if (activeDraft === null) {
    return null;
  }
  return (
    <div
      className="flex shrink-0 items-center gap-1 px-4 pb-1.5 text-[10px] text-muted-foreground"
      data-testid="chat-active-draft"
    >
      <FrameIcon className="size-2.5" aria-hidden />
      <span className="truncate">
        Editing: <span className="font-medium text-foreground/80">{activeDraft.name}</span>
      </span>
    </div>
  );
}
