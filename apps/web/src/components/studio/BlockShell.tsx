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
  const selectBlock = useEditorStore((state) => state.selectBlock);

  const handleClick = (event: MouseEvent) => {
    // Canvas clicks select; they never follow block links (button/image href).
    event.preventDefault();
    event.stopPropagation();
    selectBlock(block.id);
  };

  return (
    <div
      data-block-id={block.id}
      data-block-type={block.type}
      data-selected={isSelected || undefined}
      onClick={handleClick}
      className={cn(
        "relative cursor-pointer transition-shadow",
        isSelected
          ? "z-10 ring-2 ring-sky-500"
          : "hover:ring-1 hover:ring-sky-300",
        className,
      )}
    >
      {isSelected && (
        <>
          <span className="pointer-events-none absolute -top-5 left-0 z-20 rounded-t-sm bg-sky-500 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wide text-white">
            {block.type}
          </span>
          <BlockActionRow blockId={block.id} />
        </>
      )}
      {children}
    </div>
  );
}
