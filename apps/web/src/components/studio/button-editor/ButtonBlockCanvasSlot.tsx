"use client";

import {
  ButtonBlockView,
  type ButtonBlock,
  type ResolvedButtonStyles,
} from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { InlineButtonLabelEditor } from "./InlineButtonLabelEditor";

export interface ButtonBlockCanvasSlotProps {
  block: ButtonBlock;
  resolvedStyles: ResolvedButtonStyles;
}

/**
 * The canvas face of a button block: the SDK's static ButtonBlockView,
 * swapped for the single-line label editor while this block is being edited
 * (same swap pattern as TextBlockCanvasSlot). No snapshot prewarm here —
 * the label session is local-only and needs no sync doc.
 */
export function ButtonBlockCanvasSlot({ block, resolvedStyles }: ButtonBlockCanvasSlotProps) {
  const isEditing = useEditorStore((state) => state.editingBlockId === block.id);

  return isEditing ? (
    <InlineButtonLabelEditor block={block} resolvedStyles={resolvedStyles} />
  ) : (
    <ButtonBlockView block={block} resolvedStyles={resolvedStyles} />
  );
}
