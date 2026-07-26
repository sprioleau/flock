"use client";

import {
  TextBlockView,
  type ResolvedTextStyles,
  type TextBlock,
} from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { InlineTextEditor } from "./InlineTextEditor";

export interface TextBlockCanvasSlotProps {
  block: TextBlock;
  resolvedStyles: ResolvedTextStyles;
}

/**
 * The canvas face of a text block: the SDK's static TextBlockView, swapped
 * for the inline Tiptap editor while this block is being edited. Both render
 * from the same resolved styles, so the swap is visually seamless.
 */
export function TextBlockCanvasSlot({ block, resolvedStyles }: TextBlockCanvasSlotProps) {
  const isEditing = useEditorStore((state) => state.editingBlockId === block.id);

  return isEditing ? (
    <InlineTextEditor block={block} resolvedStyles={resolvedStyles} />
  ) : (
    <TextBlockView block={block} resolvedStyles={resolvedStyles} />
  );
}
