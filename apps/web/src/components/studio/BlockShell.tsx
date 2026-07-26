"use client";

import type { MouseEvent, ReactNode } from "react";
import type { Block } from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { BlockActionRow } from "./BlockActionRow";

export interface BlockShellProps {
  block: Block;
  children: ReactNode;
  /** Extra classes on the wrapper (e.g. h-full for column fill). */
  className?: string;
}

/**
 * The interactive wrapper every canvas block renders inside: hover outline,
 * click-to-select, selection ring + block-type label, and the floating
 * move-up / move-down / delete action row for the selected block.
 *
 * Wave-2 seam: inline text editing mounts inside the shell of text blocks;
 * drag-and-drop attaches its handles here.
 */
export function BlockShell({ block, children, className }: BlockShellProps) {
  const isSelected = useEditorStore((state) => state.selectedBlockId === block.id);
  const isEditingText = useEditorStore((state) => state.editingBlockId === block.id);
  const selectBlock = useEditorStore((state) => state.selectBlock);
  const startTextEditing = useEditorStore((state) => state.startTextEditing);

  const isTextBlock = block.type === "text";

  const handleClick = (event: MouseEvent) => {
    // Never let clicks bubble to the canvas (which clears the selection) —
    // including clicks inside an open inline text editor.
    event.stopPropagation();
    if (isEditingText) {
      return;
    }
    // Canvas clicks select; they never follow block links (button/image href).
    event.preventDefault();
    if (isTextBlock && isSelected) {
      // Click-when-already-selected opens the inline editor (this also makes
      // the second click of a double-click start the editing session).
      startTextEditing(block.id);
      return;
    }
    selectBlock(block.id);
  };

  const handleDoubleClick = (event: MouseEvent) => {
    if (!isTextBlock || isEditingText) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    startTextEditing(block.id);
  };

  return (
    <div
      data-block-id={block.id}
      data-block-type={block.type}
      data-selected={isSelected || undefined}
      data-editing={isEditingText || undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className={cn(
        "relative transition-shadow",
        isEditingText ? "cursor-auto" : "cursor-pointer",
        isSelected
          ? "z-10 ring-2 ring-sky-500"
          : "hover:ring-1 hover:ring-sky-300",
        className,
      )}
    >
      {isSelected && <BlockActionRow blockId={block.id} blockType={block.type} />}
      {children}
    </div>
  );
}
