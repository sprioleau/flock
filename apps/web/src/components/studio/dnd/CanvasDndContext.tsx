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
import { cn } from "@/lib/utils";
import { useCanvasDragStore } from "./drag-drop-store";
import { DragGhost } from "./DragGhost";
import { buildDropOperation, resolveDropTarget, type PointerPosition } from "./drop-target";

export interface CanvasDndContextProps {
  children: ReactNode;
}

/**
 * Drag-and-drop for the studio canvas. @dnd-kit provides the pointer sensor
 * (4px activation so handle clicks stay clicks), the lifted DragOverlay, and
 * auto-scroll; drop-target resolution is our own, computed on the flat block
 * map from the pointer's DOM hit chain (see ./drop-target) so SDK nesting
 * rules decide validity and a completed drag dispatches exactly ONE store op
 * — reorderChildren within a parent, moveBlock across parents, nothing for
 * invalid or unchanged positions. Leaf blocks register via useDraggable in
 * BlockShell with the grab handle in the block action row as activator;
 * sections reorder through the action-row buttons only.
 */
export function CanvasDndContext({ children }: CanvasDndContextProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const activeBlockId = useCanvasDragStore((state) => state.activeBlockId);
  const pointerRef = useRef<PointerPosition | null>(null);
  const frameRef = useRef<number | null>(null);

  const resolveAtPointer = useCallback(() => {
    frameRef.current = null;
    const pointer = pointerRef.current;
    const dragStore = useCanvasDragStore.getState();
    if (pointer === null || dragStore.activeBlockId === null) {
      return;
    }
    dragStore.setDropTarget(
      resolveDropTarget({
        doc: useEditorStore.getState().doc,
        draggedBlockId: dragStore.activeBlockId,
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
    if (activeBlockId === null) {
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
  }, [activeBlockId, scheduleResolve]);

  const handleDragStart = (event: DragStartEvent) => {
    const { activatorEvent } = event;
    if (activatorEvent instanceof MouseEvent) {
      pointerRef.current = { x: activatorEvent.clientX, y: activatorEvent.clientY };
    }
    useCanvasDragStore.getState().startDrag(event.active.id as BlockId);
    scheduleResolve();
  };

  const handleDragEnd = () => {
    const dragStore = useCanvasDragStore.getState();
    const { activeBlockId: draggedBlockId, dropTarget } = dragStore;
    if (draggedBlockId !== null && dropTarget !== null) {
      const editorStore = useEditorStore.getState();
      const op = buildDropOperation({ doc: editorStore.doc, draggedBlockId, dropTarget });
      if (op !== null) {
        editorStore.dispatch(op);
      }
    }
    dragStore.endDrag();
    pointerRef.current = null;
  };

  const handleDragCancel = () => {
    useCanvasDragStore.getState().endDrag();
    pointerRef.current = null;
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      <CanvasDragLayer />
    </DndContext>
  );
}

/**
 * Body-portaled drag chrome: the lifted DragOverlay copy of the dragged
 * subtree and the drop-position indicator line. Portaled so the canvas's
 * overflow/scroll clipping never cuts them off; both ignore pointer events
 * so document.elementFromPoint hit-testing sees the canvas beneath.
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
  const activeBlockId = useCanvasDragStore((state) => state.activeBlockId);
  const doc = useEditorStore((state) => state.doc);
  const root = doc[ROOT_BLOCK_ID];
  const globals = root?.type === "root" ? root.properties.globals : undefined;
  const activeBlock = activeBlockId === null ? undefined : doc[activeBlockId];

  return (
    <DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
      {activeBlockId !== null && activeBlock !== undefined ? (
        <div
          className="email-canvas cursor-grabbing overflow-hidden rounded-sm bg-white/95 opacity-90 shadow-2xl ring-2 ring-sky-400"
          data-testid="drag-overlay-ghost"
        >
          <DragGhost blockId={activeBlockId} doc={doc} globals={globals} />
        </div>
      ) : null}
    </DragOverlay>
  );
}

function DropIndicatorLine() {
  const indicatorLine = useCanvasDragStore((state) => state.dropTarget?.indicatorLine ?? null);
  if (indicatorLine === null) {
    return null;
  }
  const isVertical = indicatorLine.orientation === "vertical";
  return (
    <div
      className={cn(
        "pointer-events-none fixed z-50 rounded-full bg-sky-500 shadow-[0_0_0_1px_rgba(255,255,255,0.8)]",
        isVertical ? "w-1 -translate-x-1/2" : "h-1 -translate-y-1/2",
      )}
      style={{
        left: indicatorLine.left,
        top: indicatorLine.top,
        ...(isVertical ? { height: indicatorLine.length } : { width: indicatorLine.length }),
      }}
      data-testid="drop-indicator"
      data-orientation={indicatorLine.orientation}
    />
  );
}
