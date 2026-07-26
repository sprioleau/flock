"use client";

import type { MouseEvent } from "react";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import type { BlockId } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";

export interface BlockActionRowProps {
  blockId: BlockId;
}

/**
 * Floating action row on the selected block: move up / move down / delete.
 * Move = a reorderChildren op on the parent (adjacent swap); delete = a
 * removeBlock op. Both flow through the store's dispatch (§7 invariant).
 */
export function BlockActionRow({ blockId }: BlockActionRowProps) {
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
