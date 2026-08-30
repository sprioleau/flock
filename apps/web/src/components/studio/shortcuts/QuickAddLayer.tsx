"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { DropIndicatorLineView } from "../dnd/DropIndicatorLineView";
import { Kbd } from "@/components/ui/kbd";
import {
  computeQuickAddMenuPosition,
  QUICK_ADD_ITEMS,
  type HoldToQuickAdd,
} from "./use-hold-to-quick-add";

/*
  The hold-A quick-add chrome, body-portaled like the drag layer so canvas
  clipping never cuts it off: the SAME indicator line the dnd layer draws
  (where the block will land) plus a floating menu of the palette's leaf
  blocks at the pointer. While TRACKING (key held) the menu ignores pointer
  events — document.elementFromPoint must see the canvas through it; once
  PINNED (key released over a valid spot) it becomes clickable.
*/
export function QuickAddLayer({ quickAdd }: { quickAdd: HoldToQuickAdd }) {
  const { session, insertItem } = quickAdd;
  const menuRef = useRef<HTMLDivElement | null>(null);
  /*
    Measured once mounted; estimates cover the very first frame.
  */
  const [menuSize, setMenuSize] = useState({ width: 176, height: 160 });

  const isVisible = session !== null && session.dropTarget !== null;
  useLayoutEffect(() => {
    if (!isVisible) {
      return;
    }
    const menuElement = menuRef.current;
    if (menuElement !== null) {
      const rect = menuElement.getBoundingClientRect();
      setMenuSize((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    }
  }, [isVisible]);

  if (!isVisible || session.dropTarget === null) {
    return null;
  }

  const { left, top } = computeQuickAddMenuPosition({
    pointer: session.pointer,
    menuWidth: menuSize.width,
    menuHeight: menuSize.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  const isPinned = session.phase === "pinned";

  return createPortal(
    <>
      {session.dropTarget.indicatorLine !== null && (
        <DropIndicatorLineView line={session.dropTarget.indicatorLine} />
      )}
      <div
        ref={menuRef}
        role="menu"
        aria-label="Quick-add a block"
        data-quick-add-menu
        data-testid="quick-add-menu"
        data-pinned={isPinned || undefined}
        className={cn(
          "fixed z-50 w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md",
          !isPinned && "pointer-events-none",
        )}
        style={{ left, top }}
      >
        <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Add block
          </span>
          <Kbd>A</Kbd>
        </div>
        {QUICK_ADD_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            title={item.description}
            onClick={() => insertItem(item)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
              "hover:bg-accent hover:text-accent-foreground",
            )}
            data-testid={`quick-add-item-${item.id}`}
          >
            <item.Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {item.label}
          </button>
        ))}
        <p className="px-2 pt-1 pb-0.5 text-[10px] text-muted-foreground">
          Lands at the marked line
        </p>
      </div>
    </>,
    document.body,
  );
}
