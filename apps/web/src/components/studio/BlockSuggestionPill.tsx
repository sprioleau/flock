"use client";

import { useEffect, type MouseEvent } from "react";
import { SparklesIcon, XIcon } from "lucide-react";
import type { BlockId } from "@flock/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import {
  useAnchoredBlockSuggestion,
  useBlockSuggestionSurfaceStore,
} from "@/lib/suggestions/suggestion-surface-store";
import { cn } from "@/lib/utils";

/*
  The suggestion, where the user is actually looking.

  The chat card was correct and invisible: it rendered at the bottom of the
  chat panel, ~1400px from the block being edited, and not at all when the
  panel was collapsed. This pill puts the SAME suggestion — same controller,
  same pre-validated ops — under the block that produced it, at the moment
  the change lands. The card stays exactly as it was; both surfaces show the
  one live suggestion and either can act on it.

  V1 SCOPE. One primary action: the DEFAULT rung, which is the smallest-scope
  rung and never the confirm-gated whole-email re-theme (shortcuts.ts picks
  it, this component does not choose). The rest of the escalation ladder, the
  re-theme confirm, and the post-apply "Applied — Revert" state all stay in
  the chat card; applying here simply makes the pill go away.

  PLACEMENT — below the block, left-aligned (`top-full left-0`). A selected
  block already carries chrome in two zones: the action row floats above its
  top-right (`-top-9 right-0`) and the ancestor breadcrumb sits outside its
  left edge (`right-full top-0`). Above-left is NOT free, because the action
  row is ~160px wide and a button block is narrower than that — the owner's
  exact case — so an "above" pill would land under the action row. Below the
  block is unoccupied by construction, and it is the one zone whose width is
  not bounded by the block's own width, which is what a narrow button needs.
  It paints over the top of whatever follows; that is the same trade the
  action row already makes upward, and it lasts only as long as the
  suggestion. Pure CSS inside the shell's relative wrapper, so canvas
  scrolling, panel collapse, and block reflow are handled for free.

  Z-INDEX — z-30, matching the action row, inside the selected shell's z-10
  stacking context. That is the documented rung for "controls on the selected
  block": above outlines (6) and cursors (20), below the bubble menu and drag
  chrome (50). Deliberately NOT a portalled popover, which would jump to 50
  and escape the canvas clip.

  CLICKS — every handler stops propagation before doing anything. The shell
  around it turns a click into "select", and a click on an ALREADY-selected
  text or button block into "open the inline editor"; without the guard,
  clicking Apply would also start editing the button's label.
*/
export interface BlockSuggestionPillProps {
  blockId: BlockId;
}

export function BlockSuggestionPill({ blockId }: BlockSuggestionPillProps) {
  /*
    This frame's document and viewport — BlockShell renders inside the draft
    frame's EditorStoreProvider, so both are that FRAME's, not the app's.
  */
  const documentId = useEditorStore((state) => state.documentId);
  const isMobilePreview = useEditorStore((state) => state.viewport === "mobile");
  const anchor = useAnchoredBlockSuggestion({ blockId, documentId, isMobilePreview });
  const hideAnchoredSuggestion = useBlockSuggestionSurfaceStore(
    (state) => state.hideAnchoredSuggestion,
  );
  const registerMountedPill = useBlockSuggestionSurfaceStore((state) => state.registerMountedPill);

  /*
    Tell the keyboard path this suggestion is visible even with the chat
    panel collapsed (shortcuts.ts, getIsSuggestionReachable). Reported from
    the real mount rather than inferred, so it can never claim ⌥A for a pill
    that is not on screen.
  */
  const isVisible = anchor !== null;
  useEffect(() => {
    if (!isVisible) {
      return;
    }
    return registerMountedPill();
  }, [isVisible, registerMountedPill]);

  if (anchor === null) {
    return null;
  }

  const stopThen = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    action();
  };

  return (
    <div
      className={cn(
        "absolute top-full left-0 z-30 mt-1.5 flex max-w-lg flex-wrap items-center gap-2",
        /*
          This box's own `absolute` is what the corner × positions against —
          no `relative` here, which would fight it. pr-7 keeps the corner
          empty: the × is out of flow, so without reserved padding a long
          title or a wrapped Apply would slide underneath it.
        */
        "rounded-md border bg-background py-1 pr-7 pl-2 shadow-md",
      )}
      data-testid={`block-suggestion-${blockId}`}
    >
      <div className="flex items-center gap-2">
        <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-xs font-medium" data-testid="block-suggestion-title">
          {anchor.title}
        </p>
      </div>
      <button
        type="button"
        onClick={stopThen(anchor.applyDefaultRung)}
        className={cn(
          "inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-2",
          "text-[11px] text-primary-foreground hover:bg-primary/90",
        )}
        data-testid="block-suggestion-apply"
      >
        {anchor.defaultRungLabel}
      </button>
      <button
        type="button"
        /*
          "Hide", not "Dismiss": this only takes the pill off the canvas for
          this one suggestion. Dismissing the PATTERN for the document is the
          chat card's × and stays there — a reflexive click on something that
          just appeared under the cursor must not silence a whole class of
          suggestion for ever.
        */
        aria-label="Hide this suggestion"
        onClick={stopThen(hideAnchoredSuggestion)}
        /*
          Cornered, not in the content row: in flow it inherited the row's
          height and dropped BELOW Apply the moment a narrow block — a button
          in a column — made the pill wrap. Out of flow it stays put whatever
          the title's length does, and Apply keeps its natural place next to
          the title. Same treatment as the chat card's ×, so the two read as
          the same control.
        */
        className={cn(
          "absolute top-1 right-1 cursor-pointer rounded-sm",
          "text-muted-foreground hover:text-foreground",
        )}
        data-testid="block-suggestion-hide"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
