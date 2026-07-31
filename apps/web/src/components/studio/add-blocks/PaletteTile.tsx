"use client";

import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { getPaletteDragBlockType, type PaletteItem } from "./palette-items";

export interface PaletteTileProps {
  item: PaletteItem;
  onAdd: (item: PaletteItem) => void;
  /**
   * Rendered tile body replacing the icon+label pair (the section gallery's
   * preview mode). Preview markup contains inert links/buttons, which must
   * not nest inside a real <button> (invalid interactive-content nesting) —
   * a preview tile therefore renders as div-with-button-semantics, keeping
   * the same drag source and click/keyboard add behavior.
   */
  previewBody?: ReactNode;
}

/**
 * One palette tile: the WHOLE tile is the drag activator (dnd-kit's 4px
 * activation constraint disambiguates), and a plain click adds the block at
 * the current selection. EVERY tile is a drag source — including section
 * templates (owner decision 2026-07-31, reversing the v1 click-only rule).
 * Keyboard: tiles are buttons (real or semantic) — Enter/Space click-to-add.
 */
export function PaletteTile({ item, onAdd, previewBody }: PaletteTileProps) {
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

  if (previewBody !== undefined) {
    // The semantic-button variant has no native key activation — mirror it.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onAdd(item);
      }
    };
    return (
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        role="button"
        tabIndex={0}
        onPointerDownCapture={handlePointerDownCapture}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        title={item.description}
        aria-label={`Add ${item.label}`}
        className={cn(
          "flex flex-col gap-1.5 rounded-md border bg-background p-1.5 transition-colors",
          "hover:border-ring/60 hover:bg-muted/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isDraggableItem ? "cursor-grab" : "cursor-pointer",
          isDragging && "opacity-50",
        )}
        data-testid={`palette-tile-${item.id}`}
      >
        {previewBody}
        <span className="flex items-center gap-1.5 px-0.5 pb-0.5 text-xs font-medium leading-none text-foreground">
          <item.Icon className="size-3.5 text-muted-foreground" aria-hidden />
          {item.label}
        </span>
      </div>
    );
  }

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
        // Fixed min-height + single-line label clamp: every tile in a palette
        // grid renders the same height, so one long label can never break the
        // group's row alignment (the full label stays in the title tooltip).
        "flex min-h-[3.75rem] flex-col items-center justify-center gap-1.5 rounded-md border bg-background p-3 text-center transition-colors",
        "hover:border-ring/60 hover:bg-muted/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDraggableItem ? "cursor-grab" : "cursor-pointer",
        isDragging && "opacity-50",
      )}
      data-testid={`palette-tile-${item.id}`}
    >
      <item.Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="line-clamp-1 max-w-full text-xs font-medium leading-tight text-foreground">
        {item.label}
      </span>
    </button>
  );
}
