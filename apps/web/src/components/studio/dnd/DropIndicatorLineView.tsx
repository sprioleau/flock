"use client";

import { cn } from "@/lib/utils";
import type { DropIndicatorLine } from "./drag-drop-store";

/*
  The drop-position indicator line, viewport-fixed (callers portal it to the
  body so canvas overflow never clips it). ONE visual for every insertion
  affordance — canvas drag-and-drop (CanvasDndContext) and the hold-A
  quick-add menu render this same component, so "where the block will land"
  always reads identically.
*/
export function DropIndicatorLineView({ line }: { line: DropIndicatorLine }) {
  const isVertical = line.orientation === "vertical";
  return (
    <div
      className={cn(
        /*
          The 1px halo separates the line from busy content beneath; the
          background token keeps it chrome-colored in both themes.
        */
        "pointer-events-none fixed z-50 rounded-full bg-sky-500 shadow-[0_0_0_1px_var(--background)]",
        isVertical ? "w-1 -translate-x-1/2" : "h-1 -translate-y-1/2",
      )}
      style={{
        left: line.left,
        top: line.top,
        ...(isVertical ? { height: line.length } : { width: line.length }),
      }}
      data-testid="drop-indicator"
      data-orientation={line.orientation}
    />
  );
}
