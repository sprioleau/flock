"use client";

import type { MouseEvent } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon, Trash2Icon } from "lucide-react";
import type { BlockId, BlockType } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";

export interface BlockActionRowProps {
  blockId: BlockId;
  blockType: BlockType;
  /**
   * Grab-handle activator ref from the shell's useDraggable, or null when
   * the block cannot be dragged (rows and columns, or a text block whose
   * inline editor is open) — null hides the handle. The move up/down buttons
   * stay as the keyboard-accessible reorder path.
   */
  dragHandleRef: ((element: HTMLElement | null) => void) | null;
  /** Activator listeners from the shell's useDraggable. */
  dragListeners: DraggableSyntheticListeners;
  /** Accessibility attributes from the shell's useDraggable. */
  dragAttributes: DraggableAttributes | undefined;
}

/**
 * Floating action bar on the selected block: block-type label, grab handle
 * (pointer drag), move up / move down / delete. Move = a reorderChildren op
 * on the parent (adjacent swap); delete = a removeBlock op. Both flow
 * through the store's dispatch (§7 invariant); drops dispatch their single
 * op from CanvasDndContext.
 */
export function BlockActionRow({
  blockId,
  blockType,
  dragHandleRef,
  dragListeners,
  dragAttributes,
}: BlockActionRowProps) {
  const doc = useEditorStore((state) => state.doc);
  const dispatch = useEditorStore((state) => state.dispatch);

  const block = doc[blockId];
  const parent = block?.parentId != null ? doc[block.parentId] : undefined;
  if (block === undefined || parent === undefined) {
    return null;
  }

  const siblingIds: BlockId[] = [...parent.childrenIds];
  const index = siblingIds.indexOf(blockId);
  const canMoveUp = index > 0;
  const canMoveDown = index >= 0 && index < siblingIds.length - 1;

  const moveBy = (offset: -1 | 1) => {
    const orderedChildIds = [...siblingIds];
    const swapIndex = index + offset;
    [orderedChildIds[index], orderedChildIds[swapIndex]] = [
      orderedChildIds[swapIndex]!,
      orderedChildIds[index]!,
    ];
    dispatch({ name: "reorderChildren", parentId: parent.id, orderedChildIds });
  };

  const stopThen = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    action();
  };

  return (
    <div
      className="absolute -top-9 right-0 z-30 flex items-center gap-0.5 rounded-md border bg-background p-0.5 shadow-md"
      data-testid={`block-actions-${blockId}`}
    >
      {/* ml-1 matches the visual whitespace the ghost icon buttons give the right edge. */}
      <span className="pointer-events-none ml-1 select-none rounded-sm bg-sky-500 px-1.5 py-1 font-mono text-[10px] font-semibold uppercase leading-none tracking-wide text-white">
        {blockType}
      </span>
      {dragHandleRef !== null && (
        <Button
          ref={dragHandleRef}
          variant="ghost"
          size="icon-sm"
          aria-label="Drag to move block"
          className="touch-none cursor-grab active:cursor-grabbing"
          data-testid={`drag-handle-${blockId}`}
          {...dragAttributes}
          {...dragListeners}
          // A click on the handle (pointer never crossed the 4px activation
          // distance) must not bubble into the shell's click-to-edit.
          onClick={(event) => event.stopPropagation()}
        >
          <GripVerticalIcon />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Move block up"
        disabled={!canMoveUp}
        onClick={stopThen(() => moveBy(-1))}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Move block down"
        disabled={!canMoveDown}
        onClick={stopThen(() => moveBy(1))}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Delete block"
        className="text-destructive hover:text-destructive"
        onClick={stopThen(() => dispatch({ name: "removeBlock", blockId }))}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
