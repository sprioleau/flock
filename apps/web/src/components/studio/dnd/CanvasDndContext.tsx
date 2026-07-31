"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ROOT_BLOCK_ID, type BlockId } from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import type { PaletteItem } from "../add-blocks/palette-items";
import { scrollBlockIntoView } from "../add-blocks/scroll-block-into-view";
import { useCanvasDragStore, type DragSource } from "./drag-drop-store";
import { DragGhost } from "./DragGhost";
import { DropIndicatorLineView } from "./DropIndicatorLineView";
import {
  buildDropOperation,
  buildPaletteDropInsertion,
  resolveDropTarget,
  type PointerPosition,
} from "./drop-target";

export interface CanvasDndContextProps {
  children: ReactNode;
}

/**
 * Drag-and-drop for the studio. Mounted at the StudioShell level (NOT inside
 * the active frame's EditorCanvas) so the Blocks-tab palette in the right
 * rail and the canvas blocks share ONE DndContext. @dnd-kit provides the
 * pointer sensor (4px activation so handle/tile clicks stay clicks), the
 * lifted DragOverlay, and auto-scroll for existing-block drags; drop-target
 * resolution is our own, computed on the flat block map from the pointer's
 * DOM hit chain (see ./drop-target) so SDK nesting rules decide validity and
 * a completed drag dispatches exactly ONE store op:
 * - existing blocks → reorderChildren / moveBlock (unchanged behavior);
 * - palette items → addBlock / restoreBlocks / addSection with defaults,
 *   after which the new block is selected and scrolled into view.
 * Leaf blocks AND sections register via useDraggable in BlockShell with the
 * grab handle in the block action row as activator (sections resolve to
 * root-level gaps only — one root reorder per drop; the up/down arrows stay
 * as the keyboard path); palette tiles register whole-tile in PaletteTile.
 */
export function CanvasDndContext({ children }: CanvasDndContextProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const isDragActive = useCanvasDragStore((state) => state.dragSource !== null);
  const pointerRef = useRef<PointerPosition | null>(null);
  const frameRef = useRef<number | null>(null);

  const resolveAtPointer = useCallback(() => {
    frameRef.current = null;
    const pointer = pointerRef.current;
    const dragStore = useCanvasDragStore.getState();
    if (pointer === null || dragStore.dragSource === null) {
      return;
    }
    // Palette tiles live outside the frames scroller, so dnd-kit's own
    // auto-scroll (which walks the ACTIVE NODE's scroll ancestors) never
    // reaches it for palette drags — nudge it ourselves. The resulting
    // scroll event re-schedules this resolver, so holding the pointer at an
    // edge keeps scrolling at rAF pace.
    if (dragStore.dragSource.kind === "palette") {
      autoScrollFramesSurface(pointer);
    }
    dragStore.setDropTarget(
      resolveDropTarget({
        doc: useEditorStore.getState().doc,
        source: dragStore.dragSource,
        pointer,
      }),
    );
  }, []);

  const scheduleResolve = useCallback(() => {
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(resolveAtPointer);
    }
  }, [resolveAtPointer]);

  // Track the pointer ourselves (dnd-kit's move delta drifts from the real
  // pointer once auto-scroll kicks in) and re-resolve on scroll so the
  // indicator tracks auto-scrolling under a stationary pointer.
  useEffect(() => {
    if (!isDragActive) {
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      scheduleResolve();
    };
    const handleScroll = () => scheduleResolve();
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("scroll", handleScroll, true);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [isDragActive, scheduleResolve]);

  const handleDragStart = (event: DragStartEvent) => {
    const { activatorEvent } = event;
    if (activatorEvent instanceof MouseEvent) {
      pointerRef.current = { x: activatorEvent.clientX, y: activatorEvent.clientY };
    }
    const paletteItem = (event.active.data.current as { paletteItem?: PaletteItem } | undefined)
      ?.paletteItem;
    const source: DragSource =
      paletteItem !== undefined
        ? { kind: "palette", item: paletteItem }
        : { kind: "existing-block", blockId: event.active.id as BlockId };
    useCanvasDragStore.getState().startDrag(source);
    scheduleResolve();
  };

  const handleDragEnd = () => {
    const dragStore = useCanvasDragStore.getState();
    const { dragSource, dropTarget } = dragStore;
    // End the gesture BEFORE dispatch/select: the right rail's Blocks tab is
    // sticky only while a drag is live, so the post-drop selection is what
    // switches it to Properties (the add-then-tweak loop).
    dragStore.endDrag();
    pointerRef.current = null;
    if (dragSource === null || dropTarget === null) {
      return;
    }
    const editorStore = useEditorStore.getState();
    if (dragSource.kind === "existing-block") {
      const op = buildDropOperation({
        doc: editorStore.doc,
        draggedBlockId: dragSource.blockId,
        dropTarget,
      });
      if (op !== null) {
        editorStore.dispatch(op);
      }
      return;
    }
    const insertion = buildPaletteDropInsertion({
      doc: editorStore.doc,
      item: dragSource.item,
      dropTarget,
    });
    if (insertion === null) {
      return;
    }
    const result = editorStore.dispatch(insertion.op);
    if (result.isOk) {
      editorStore.selectBlock(insertion.newBlockId);
      scrollBlockIntoView(insertion.newBlockId);
    }
  };

  const handleDragCancel = () => {
    useCanvasDragStore.getState().endDrag();
    pointerRef.current = null;
  };

  return (
    <DndContext
      sensors={sensors}
      // Never auto-scroll the right rail: for palette drags dnd-kit would
      // walk the TILE's scroll ancestors (the panel), which is useless and
      // disorienting mid-drag. The frames surface is handled above.
      autoScroll={{ canScroll: (element) => element.closest('[data-slot="right-rail"]') === null }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      <CanvasDragLayer />
    </DndContext>
  );
}

const FRAMES_SCROLLER_SELECTOR = "[data-frames-scroller]";
/** Distance from a frames-surface edge that starts edge-scrolling (px). */
const AUTO_SCROLL_EDGE_PX = 56;
/** Scroll step per resolver pass while inside an edge zone (px). */
const AUTO_SCROLL_STEP_PX = 14;

/** Edge-scroll the frames surface toward the pointer during palette drags. */
function autoScrollFramesSurface(pointer: PointerPosition): void {
  const scroller = document.querySelector<HTMLElement>(FRAMES_SCROLLER_SELECTOR);
  if (scroller === null) {
    return;
  }
  const rect = scroller.getBoundingClientRect();
  const isPointerInside =
    pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
  if (!isPointerInside) {
    return;
  }
  if (pointer.y < rect.top + AUTO_SCROLL_EDGE_PX) {
    scroller.scrollTop -= AUTO_SCROLL_STEP_PX;
  } else if (pointer.y > rect.bottom - AUTO_SCROLL_EDGE_PX) {
    scroller.scrollTop += AUTO_SCROLL_STEP_PX;
  }
  if (pointer.x < rect.left + AUTO_SCROLL_EDGE_PX) {
    scroller.scrollLeft -= AUTO_SCROLL_STEP_PX;
  } else if (pointer.x > rect.right - AUTO_SCROLL_EDGE_PX) {
    scroller.scrollLeft += AUTO_SCROLL_STEP_PX;
  }
}

/**
 * Body-portaled drag chrome: the lifted DragOverlay copy of the dragged
 * subtree (or the palette tile's chip) and the drop-position indicator line.
 * Portaled so the canvas's overflow/scroll clipping never cuts them off;
 * both ignore pointer events so document.elementFromPoint hit-testing sees
 * the canvas beneath.
 */
const emptySubscribe = () => () => {};
const getIsClientSnapshot = () => true;
const getIsServerSnapshot = () => false;

function CanvasDragLayer() {
  // Hydration-safe "is mounted on the client" — false on the server pass,
  // true once React takes over — without an effect-driven setState.
  const isClientMounted = useSyncExternalStore(
    emptySubscribe,
    getIsClientSnapshot,
    getIsServerSnapshot,
  );
  if (!isClientMounted) {
    return null;
  }
  return createPortal(
    <>
      <CanvasDragOverlay />
      <DropIndicatorLine />
    </>,
    document.body,
  );
}

function CanvasDragOverlay() {
  const dragSource = useCanvasDragStore((state) => state.dragSource);
  const doc = useEditorStore((state) => state.doc);
  const root = doc[ROOT_BLOCK_ID];
  const globals = root?.type === "root" ? root.properties.globals : undefined;

  return (
    <DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
      {dragSource === null ? null : dragSource.kind === "palette" ? (
        <PaletteDragChip item={dragSource.item} />
      ) : doc[dragSource.blockId] !== undefined ? (
        <div
          className="email-canvas cursor-grabbing overflow-hidden rounded-sm bg-background/95 opacity-90 shadow-2xl ring-2 ring-sky-400"
          data-testid="drag-overlay-ghost"
        >
          <DragGhost blockId={dragSource.blockId} doc={doc} globals={globals} />
        </div>
      ) : null}
    </DragOverlay>
  );
}

/**
 * The lifted copy of a dragged palette tile: a compact icon+label chip. The
 * drop indicator line — not the chip — communicates placement; the chip only
 * says what is being carried.
 */
function PaletteDragChip({ item }: { item: PaletteItem }) {
  return (
    <div
      className="inline-flex w-fit cursor-grabbing items-center gap-2 rounded-md border bg-background px-3 py-2 text-xs font-medium text-foreground shadow-lg"
      data-testid="palette-drag-chip"
    >
      <item.Icon className="size-4 text-muted-foreground" aria-hidden />
      {item.label}
    </div>
  );
}

function DropIndicatorLine() {
  const indicatorLine = useCanvasDragStore((state) => state.dropTarget?.indicatorLine ?? null);
  if (indicatorLine === null) {
    return null;
  }
  return <DropIndicatorLineView line={indicatorLine} />;
}
