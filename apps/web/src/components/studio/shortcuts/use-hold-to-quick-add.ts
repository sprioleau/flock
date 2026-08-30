"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/lib/editor-store";
import { PALETTE_GROUPS, type PaletteItem } from "../add-blocks/palette-items";
import { scrollBlockIntoView } from "../add-blocks/scroll-block-into-view";
import { useCanvasDragStore, type DropTarget } from "../dnd/drag-drop-store";
import {
  buildPaletteDropInsertion,
  resolveDropTarget,
  type PointerPosition,
} from "../dnd/drop-target";
import { getIsEditableEventTarget } from "./keyboard-guards";

/*
  Hold-A quick-add: holding "a" while hovering the ACTIVE draft pops a
  floating content-blocks menu at the pointer with the drag-and-drop
  machinery's own indicator line marking where the block would land; clicking
  an item inserts it there — one op, one undo.

  Everything downstream is REUSE, not a parallel path: position → target via
  resolveDropTarget (the dnd resolver, so nesting legality and "before which
  sibling" match a real drag exactly), insertion via
  buildPaletteDropInsertion (the palette-drop op builder), and the indicator
  is the same DropIndicatorLineView the drag layer renders.

  Gesture: KEYDOWN "a" (guarded: never while typing in inputs or the inline
  editor, never with modifiers, never mid-drag) starts TRACKING — the target
  and menu follow the pointer. KEYUP with a valid target PINS the session:
  the menu freezes and becomes clickable, so "hold a, hover, release, click"
  works one-handed. Escape, an outside click, an off-canvas release, or a
  scroll while pinned (stale geometry) dismisses.
*/

export type QuickAddLeafItem = Extract<PaletteItem, { kind: "leaf" }>;

/*
  The quick-add menu's items: every LEAF item the Blocks palette declares,
  derived (never hardcoded) so new block types added to palette-items.ts
  appear here for free.
*/
export const QUICK_ADD_ITEMS: readonly QuickAddLeafItem[] = PALETTE_GROUPS.flatMap(
  (group) => group.items,
).filter((item): item is QuickAddLeafItem => item.kind === "leaf");

export interface QuickAddSession {
  /*
    "tracking" = key held, following the pointer; "pinned" = clickable.
  */
  phase: "tracking" | "pinned";
  pointer: PointerPosition;
  /*
    Resolved landing position; null while hovering off-canvas (menu hidden).
  */
  dropTarget: DropTarget | null;
}

export interface HoldToQuickAdd {
  session: QuickAddSession | null;
  insertItem: (item: QuickAddLeafItem) => void;
  dismiss: () => void;
}

/*
  All leaf types resolve to the same containers — any leaf works as proxy.
*/
function resolveQuickAddTarget(pointer: PointerPosition): DropTarget | null {
  const proxyItem = QUICK_ADD_ITEMS[0];
  if (proxyItem === undefined) {
    return null;
  }
  const { doc, documentId } = useEditorStore.getState();
  return resolveDropTarget({
    doc,
    /*
      Quick-add always inserts into the ACTIVE frame (same rule as palette
      drops) — the resolver scopes its DOM lookups to that frame's canvas.
    */
    documentId,
    source: { kind: "palette", item: proxyItem },
    pointer,
  });
}

export function useHoldToQuickAdd(): HoldToQuickAdd {
  const [session, setSession] = useState<QuickAddSession | null>(null);
  /*
    Event handlers (registered once) read these mirrors instead of stale state.
  */
  const sessionRef = useRef<QuickAddSession | null>(null);
  const pointerRef = useRef<PointerPosition | null>(null);
  const frameRef = useRef<number | null>(null);

  const applySession = useCallback((next: QuickAddSession | null): void => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  useEffect(() => {
    /*
      rAF-throttled re-resolution while tracking (the CanvasDndContext
      pattern): pointer moves and canvas scrolls both funnel through here.
    */
    const scheduleResolve = (): void => {
      if (frameRef.current !== null) {
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const pointer = pointerRef.current;
        if (sessionRef.current?.phase !== "tracking" || pointer === null) {
          return;
        }
        /*
          A real drag starting mid-hold takes over the indicator — bow out.
        */
        if (useCanvasDragStore.getState().dragSource !== null) {
          applySession(null);
          return;
        }
        applySession({
          phase: "tracking",
          pointer,
          dropTarget: resolveQuickAddTarget(pointer),
        });
      });
    };

    const handlePointerMove = (event: PointerEvent): void => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (sessionRef.current?.phase === "tracking") {
        scheduleResolve();
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && sessionRef.current !== null) {
        applySession(null);
        return;
      }
      if (event.key !== "a") {
        return;
      }
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (getIsEditableEventTarget(event.target)) {
        return;
      }
      if (useCanvasDragStore.getState().dragSource !== null) {
        return;
      }
      const pointer = pointerRef.current;
      if (pointer === null || QUICK_ADD_ITEMS.length === 0) {
        return;
      }
      applySession({ phase: "tracking", pointer, dropTarget: resolveQuickAddTarget(pointer) });
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "a") {
        return;
      }
      const current = sessionRef.current;
      if (current === null || current.phase !== "tracking") {
        return;
      }
      /*
        Released with a valid landing spot → pin the menu for clicking;
        released off-canvas → nothing was shown, nothing to keep.
      */
      applySession(current.dropTarget === null ? null : { ...current, phase: "pinned" });
    };

    const handlePointerDown = (event: PointerEvent): void => {
      if (sessionRef.current === null) {
        return;
      }
      /*
        Clicks INSIDE the menu insert (the item's own onClick); anywhere else
        is a normal canvas interaction and dismisses the session.
      */
      const isInsideMenu =
        event.target instanceof Element && event.target.closest("[data-quick-add-menu]") !== null;
      if (!isInsideMenu) {
        applySession(null);
      }
    };

    const handleScroll = (): void => {
      const current = sessionRef.current;
      if (current === null) {
        return;
      }
      if (current.phase === "tracking") {
        scheduleResolve();
      } else {
        /*
          A pinned menu's frozen target geometry is stale after any scroll.
        */
        applySession(null);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll, true);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [applySession]);

  const insertItem = useCallback(
    (item: QuickAddLeafItem): void => {
      const dropTarget = sessionRef.current?.dropTarget;
      applySession(null);
      if (dropTarget === null || dropTarget === undefined) {
        return;
      }
      const editorStore = useEditorStore.getState();
      /*
        Fresh doc at click time: agent/collaborator ops may have landed since
        the target was pinned; the builder returns null if the container is
        gone, and the store validates the op regardless.
      */
      const insertion = buildPaletteDropInsertion({ doc: editorStore.doc, item, dropTarget });
      if (insertion === null) {
        return;
      }
      const result = editorStore.dispatch(insertion.op);
      /*
        Quick-add items are all leaves, whose insertions always carry the new
        id (null is the section-template contract and never occurs here).
      */
      if (result.isOk && insertion.newBlockId !== null) {
        editorStore.selectBlock(insertion.newBlockId);
        scrollBlockIntoView(insertion.newBlockId);
      }
    },
    [applySession],
  );

  const dismiss = useCallback((): void => {
    applySession(null);
  }, [applySession]);

  return { session, insertItem, dismiss };
}

/*
  Where the floating menu sits relative to the pointer: offset toward the
  bottom-right, flipped to the other side of the pointer when it would
  overflow the viewport (8px margin). Pure for tests.
*/
export function computeQuickAddMenuPosition(args: {
  pointer: PointerPosition;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): { left: number; top: number } {
  const { pointer, menuWidth, menuHeight, viewportWidth, viewportHeight } = args;
  const OFFSET_PX = 14;
  const MARGIN_PX = 8;
  let left = pointer.x + OFFSET_PX;
  let top = pointer.y + OFFSET_PX;
  if (left + menuWidth > viewportWidth - MARGIN_PX) {
    left = Math.max(MARGIN_PX, pointer.x - OFFSET_PX - menuWidth);
  }
  if (top + menuHeight > viewportHeight - MARGIN_PX) {
    top = Math.max(MARGIN_PX, pointer.y - OFFSET_PX - menuHeight);
  }
  return { left, top };
}
