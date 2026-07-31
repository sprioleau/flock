"use client";

import { useRef, type MouseEvent, type PointerEvent } from "react";
import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { getPaletteDragBlockType, type PaletteItem } from "./palette-items";

export interface PaletteTileProps {
  item: PaletteItem;
  onAdd: (item: PaletteItem) => void;
}

/**
 * One palette tile: the WHOLE tile is the drag activator (dnd-kit's 4px
 * activation constraint disambiguates), and a plain click adds the block at
 * the current selection. Section templates are click-to-add only in v1, so
 * their tiles don't register as drag sources. Keyboard: tiles are real
 * buttons — Enter/Space click-to-add.
 */
export function PaletteTile({ item, onAdd }: PaletteTileProps) {
  const isDraggableItem = getPaletteDragBlockType(item) !== null;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${item.id}`,
    data: { paletteItem: item },
    disabled: !isDraggableItem,
  });

  // A drag that ends back over the tile still fires a click on release —
  // compare against the press position so only true clicks add.
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const handlePointerDownCapture = (event: PointerEvent) => {
    pointerDownPositionRef.current = { x: event.clientX, y: event.clientY };
  };
  const handleClick = (event: MouseEvent) => {
    const pressedAt = pointerDownPositionRef.current;
    pointerDownPositionRef.current = null;
    const isDragRelease =
      pressedAt !== null &&
      event.detail > 0 && // keyboard "clicks" have detail 0 and no press position
      Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > 4;
    if (isDragRelease) {
      return;
    }
    onAdd(item);
  };

  return (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onPointerDownCapture={handlePointerDownCapture}
      onClick={handleClick}
      title={item.description}
      aria-label={`Add ${item.label}`}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-md border bg-background p-3 text-center transition-colors",
        "hover:border-ring/60 hover:bg-muted/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDraggableItem ? "cursor-grab" : "cursor-pointer",
        isDragging && "opacity-50",
      )}
      data-testid={`palette-tile-${item.id}`}
    >
      <item.Icon className="size-4 text-muted-foreground" aria-hidden />
      <span className="text-xs font-medium leading-none text-foreground">{item.label}</span>
    </button>
  );
}
