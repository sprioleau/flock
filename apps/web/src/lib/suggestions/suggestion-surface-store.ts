"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { BlockId } from "@flock/email-sdk";
import type { Id } from "@convex/_generated/dataModel";
import { useEditorStore } from "@/lib/editor-store";
import { getDefaultRung } from "./shortcuts";
import type { SuggestionRungId } from "./types";
import type { SuggestionsController } from "./use-suggestions";

/*
  The bridge between the ONE suggestion controller and the canvas.

  WHY THIS EXISTS. `useSuggestions()` must mount exactly once, and it mounts
  in ChatPanel (the collapsed rail needs the pending count, and the sibling
  persona hook hosts the presence heartbeat). The canvas pill renders in a
  completely different subtree — EditorCanvas → CanvasNode → BlockShell —
  with no shared context between them. A tiny module store carries the live
  suggestion across, the same way drag-drop-store carries a drag across the
  canvas and comments-mode-store carries the armed mode: ephemeral, app-local
  UI state that has no business in the document store.

  ONE CONTROLLER, TWO SURFACES. Nothing here decides anything about the
  suggestion — it republishes what the controller already decided, and the
  pill's Apply calls straight back into that controller. So the chat card and
  the pill can never disagree, and apply/revert/staleness keep their single
  implementation.

  MULTI-FRAME SAFETY. Forked sibling drafts share block ids and several
  frames render live canvases at once (EditorCanvas, PointerPresenceOverlay,
  scroll-block-into-view all document this). So the published anchor carries
  the DOCUMENT the suggestion was generated for, and a shell only shows the
  pill when its own frame's document matches — otherwise every fork of the
  draft would sprout the same pill.
*/

/*
  The live suggestion, reduced to what one canvas pill needs.
*/
export interface BlockSuggestionAnchor {
  /*
    The document the suggestion belongs to (the ACTIVE one — that is the
    store `useSuggestions` watches). Frames whose document differs ignore it.
  */
  documentId: Id<"documents"> | null;
  /*
    The block the user just edited; the pill renders in ITS shell.
  */
  blockId: BlockId;
  /*
    Suggestion instance id — a fresh suggestion un-hides the pill.
  */
  suggestionId: string;
  /*
    The question, verbatim from the suggestion (no canvas-only copy).
  */
  title: string;
  /*
    The default rung: smallest scope, never confirm-gated (shortcuts.ts).
  */
  defaultRungId: SuggestionRungId;
  /*
    That rung's label, verbatim — the pill's primary action.
  */
  defaultRungLabel: string;
  /*
    Applies the default rung through ChatPanel's single controller.
  */
  applyDefaultRung: () => void;
}

interface BlockSuggestionSurfaceState {
  /*
    What the controller is currently offering, or null.
  */
  anchor: BlockSuggestionAnchor | null;
  /*
    The suggestion the user waved off ON THE CANVAS. Session-only and
    instance-scoped BY DESIGN: the chat card's × writes a permanent
    per-document pattern dismissal to localStorage, which is far too heavy a
    consequence for a reflexive click on a pill that just appeared under the
    cursor. Hiding the pill leaves the chat card — and the pattern — intact.
  */
  hiddenSuggestionId: string | null;
  /*
    How many pills are actually on screen (0 or 1 in practice).
  */
  mountedPillCount: number;
  publishAnchor: (anchor: BlockSuggestionAnchor | null) => void;
  hideAnchoredSuggestion: () => void;
  registerMountedPill: () => () => void;
}

/*
  Do two anchors describe the same offer? (Callbacks are excluded.)
*/
function areAnchorsEquivalent({
  a,
  b,
}: {
  a: BlockSuggestionAnchor | null;
  b: BlockSuggestionAnchor | null;
}): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.documentId === b.documentId &&
    a.blockId === b.blockId &&
    a.suggestionId === b.suggestionId &&
    a.title === b.title &&
    a.defaultRungId === b.defaultRungId &&
    a.defaultRungLabel === b.defaultRungLabel
  );
}

export const useBlockSuggestionSurfaceStore = create<BlockSuggestionSurfaceState>()((set) => ({
  anchor: null,
  hiddenSuggestionId: null,
  mountedPillCount: 0,
  publishAnchor: (anchor) =>
    set((state) => {
      /*
        Republishing an equivalent offer keeps the EXISTING object, so the
        pill's selector stays referentially stable across ChatPanel's very
        frequent re-renders (chat streaming) and never rerenders the canvas.
      */
      if (areAnchorsEquivalent({ a: state.anchor, b: anchor })) {
        return state;
      }
      /*
        A different suggestion is a different offer — it deserves its own
        chance to be seen, so the canvas-local hide does not carry over.
      */
      return { anchor, hiddenSuggestionId: null };
    }),
  hideAnchoredSuggestion: () =>
    set((state) => ({ hiddenSuggestionId: state.anchor?.suggestionId ?? null })),
  registerMountedPill: () => {
    set((state) => ({ mountedPillCount: state.mountedPillCount + 1 }));
    return () => set((state) => ({ mountedPillCount: Math.max(0, state.mountedPillCount - 1) }));
  },
}));

/*
  The anchor a given shell should render, or null. Pure so the whole
  visibility decision — right block, right frame, not hidden, not the mobile
  preview — is unit-testable without a DOM.
*/
export function selectAnchoredSuggestion({
  state,
  blockId,
  documentId,
  isMobilePreview,
}: {
  state: Pick<BlockSuggestionSurfaceState, "anchor" | "hiddenSuggestionId">;
  blockId: BlockId;
  /*
    The document THIS frame renders (BlockShell reads its own store).
  */
  documentId: Id<"documents"> | null;
  /*
    v1 places nothing in the 375px preview — the chat card still has it.
  */
  isMobilePreview: boolean;
}): BlockSuggestionAnchor | null {
  const { anchor } = state;
  if (anchor === null || isMobilePreview) {
    return null;
  }
  if (anchor.suggestionId === state.hiddenSuggestionId) {
    return null;
  }
  if (anchor.blockId !== blockId || anchor.documentId !== documentId) {
    return null;
  }
  return anchor;
}

/*
  The anchor for one block's shell, live. Null for every other block.
*/
export function useAnchoredBlockSuggestion({
  blockId,
  documentId,
  isMobilePreview,
}: {
  blockId: BlockId;
  documentId: Id<"documents"> | null;
  isMobilePreview: boolean;
}): BlockSuggestionAnchor | null {
  return useBlockSuggestionSurfaceStore((state) =>
    selectAnchoredSuggestion({ state, blockId, documentId, isMobilePreview }),
  );
}

/*
  Is a canvas pill on screen right now? The chat card asks, because a pill
  makes the suggestion reachable even when the chat panel is collapsed — and
  ⌥A must then work (see shortcuts.ts, `getIsSuggestionReachable`).
*/
export function useIsBlockSuggestionPillMounted(): boolean {
  return useBlockSuggestionSurfaceStore((state) => state.mountedPillCount > 0);
}

/*
  Mirror the live suggestion onto the canvas. Called ONCE, next to the
  `useSuggestions()` that owns it.

  The published Apply goes through a ref rather than the render's own
  closure: the anchor is republished only when the SUGGESTION changes (the
  chat panel re-renders far more often than that), and a click must always
  reach the controller as it exists at click time.
*/
export function usePublishBlockSuggestion(suggestions: SuggestionsController): void {
  const documentId = useEditorStore((state) => state.documentId);
  const { visibleSuggestion } = suggestions;

  /*
    Declared FIRST so it has already refreshed by the time the publishing
    effect below runs in the same commit.
  */
  const controllerRef = useRef(suggestions);
  useEffect(() => {
    controllerRef.current = suggestions;
  });

  useEffect(() => {
    const { publishAnchor } = useBlockSuggestionSurfaceStore.getState();
    const defaultRung = visibleSuggestion === null ? null : getDefaultRung(visibleSuggestion);
    if (visibleSuggestion === null || defaultRung === null) {
      /*
        No suggestion, or a ladder whose only rung is confirm-gated: the
        canvas deliberately carries no gated action (v1 scope).
      */
      publishAnchor(null);
      return;
    }
    publishAnchor({
      documentId,
      blockId: visibleSuggestion.anchorBlockId,
      suggestionId: visibleSuggestion.id,
      title: visibleSuggestion.title,
      defaultRungId: defaultRung.id,
      defaultRungLabel: defaultRung.label,
      applyDefaultRung: () => controllerRef.current.applyRung(defaultRung.id),
    });
  }, [visibleSuggestion, documentId]);

  /*
    Leaving the studio takes the pill with it.
  */
  useEffect(
    () => () => {
      useBlockSuggestionSurfaceStore.getState().publishAnchor(null);
    },
    [],
  );
}
