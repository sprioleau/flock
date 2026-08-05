"use client";

import { useState } from "react";
import { EraserIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/lib/editor-store";
import {
  clearContent,
  createClearContentBatchId,
  CLEAR_CONTENT_BLURB,
  CLEAR_CONTENT_BUTTON_LABEL,
  CLEAR_CONTENT_CANCEL_ACTION,
  CLEAR_CONTENT_CONFIRM_ACTION,
  CLEAR_CONTENT_CONFIRM_BODY,
  CLEAR_CONTENT_CONFIRM_TITLE,
  CLEAR_CONTENT_DONE_MESSAGE,
  CLEAR_CONTENT_NOTHING_MESSAGE,
  CLEAR_CONTENT_UNDO_ACTION,
} from "./clear-content-client";

/**
 * "Clear the content" — one click that turns the email you designed into a
 * skeleton you can write again: every heading, paragraph, button, link, code
 * snippet and image becomes placeholder content, while the layout, the theme
 * and the brand logo stay exactly where they are.
 *
 * WHERE IT LIVES: the bottom of the Blocks panel, under its own heading. The
 * Blocks panel is the "what is this email made of" surface — the same rail the
 * user reaches for to add a heading or an image — so the control that empties
 * all of them belongs there rather than in the toolbar, whose right-hand
 * cluster is strictly presence / agent / history groupings.
 *
 * WHY IT CONFIRMS: it throws work away in one gesture. Undo alone is not a
 * safety net for that — the user has to already know it happened to reach for
 * it — so the dialog states plainly what goes and what stays before anything
 * is dispatched.
 *
 * AFTERWARDS: a "put my content back" affordance stays on screen until it is
 * used or the panel is left. It reverts the clear's whole batch in one call
 * (the same history.revertBatch the chat panel's turn-revert uses), so taking
 * a clear back is ONE action rather than one undo per rewritten block.
 */
export function ClearContentAction() {
  // The one piece of store state worth subscribing to: a boolean that flips
  // once. Reading `doc` here instead would re-render this on every keystroke
  // in the email — the plan is computed on click, from getState(), instead.
  const isDocumentReady = useEditorStore((state) => state.isDocumentReady);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [clearedBatchId, setClearedBatchId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isRevertPending, setIsRevertPending] = useState(false);

  const runClear = () => {
    const store = useEditorStore.getState();
    const outcome = clearContent({ store, batchId: createClearContentBatchId() });
    setIsConfirmOpen(false);
    if (outcome.kind === "cleared") {
      setClearedBatchId(outcome.batchId);
      setMessage(CLEAR_CONTENT_DONE_MESSAGE);
      return;
    }
    setClearedBatchId(null);
    setMessage(
      outcome.kind === "nothing-to-clear" ? CLEAR_CONTENT_NOTHING_MESSAGE : outcome.message,
    );
  };

  const undoClear = async () => {
    if (clearedBatchId === null || isRevertPending) {
      return;
    }
    setIsRevertPending(true);
    const result = await useEditorStore.getState().revertAgentBatch(clearedBatchId);
    setIsRevertPending(false);
    if (result.isOk) {
      setClearedBatchId(null);
      setMessage(null);
      return;
    }
    setMessage(result.message);
  };

  return (
    <section className="flex flex-col gap-1.5" data-testid="clear-content-area">
      <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Start over
      </h3>
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        {CLEAR_CONTENT_BLURB}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="justify-start"
        disabled={!isDocumentReady}
        onClick={() => {
          // Close any open inline text editor FIRST: its session commit must
          // land before the clear, not on top of it. Clicking here is already
          // an outside-pointerdown for that editor; this makes it explicit.
          useEditorStore.getState().stopTextEditing();
          setMessage(null);
          setIsConfirmOpen(true);
        }}
        data-testid="clear-content-open"
      >
        <EraserIcon />
        {CLEAR_CONTENT_BUTTON_LABEL}
      </Button>

      {message !== null && (
        <div className="flex flex-col gap-1.5 px-1" data-testid="clear-content-result">
          <p className="text-xs leading-relaxed text-muted-foreground">{message}</p>
          {clearedBatchId !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start self-start"
              disabled={isRevertPending}
              onClick={() => void undoClear()}
              data-testid="clear-content-undo"
            >
              <Undo2Icon />
              {CLEAR_CONTENT_UNDO_ACTION}
            </Button>
          )}
        </div>
      )}

      <Dialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <DialogContent className="max-w-sm" data-testid="clear-content-dialog">
          <DialogHeader>
            <DialogTitle>{CLEAR_CONTENT_CONFIRM_TITLE}</DialogTitle>
            <DialogDescription>{CLEAR_CONTENT_CONFIRM_BODY}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {/* render target is our own Button, which IS a native <button> —
                so no nativeButton={false} here (that is only needed when the
                render target is something else, e.g. a Link's <a>). */}
            <DialogClose render={<Button variant="outline" size="sm" />}>
              {CLEAR_CONTENT_CANCEL_ACTION}
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={runClear}
              data-testid="clear-content-confirm"
            >
              {CLEAR_CONTENT_CONFIRM_ACTION}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
