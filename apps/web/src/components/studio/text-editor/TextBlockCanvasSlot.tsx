"use client";

import { useQuery } from "convex/react";
import {
  TextBlockView,
  type ResolvedTextStyles,
  type TextBlock,
} from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
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
 *
 * Snapshot prewarm (Phase 6.2b click-to-editable latency fix): the editor's
 * mount gate is the `getSnapshot` query, which used to start loading only
 * when InlineTextEditor mounted (~960ms cold / ~520ms warm click→editable).
 * Selecting a text block is the universal precursor to editing it, so while
 * a block is selected-but-not-editing we hold the exact `getSnapshot`
 * subscription the editor will ask for. By the time editing starts, the
 * result is already in the Convex client cache and `useTiptapSync` resolves
 * on its very first render (it also captures the snapshot in a ref during
 * that render, so the subscription handoff has no gap). Selection-scoped
 * and dropped while editing — nothing rides the keystroke path, and no
 * debounce anywhere.
 */
export function TextBlockCanvasSlot({ block, resolvedStyles }: TextBlockCanvasSlotProps) {
  const isEditing = useEditorStore((state) => state.editingBlockId === block.id);
  const isSelected = useEditorStore((state) => state.selectedBlockId === block.id);
  const documentId = useEditorStore((state) => state.documentId);

  const shouldPrewarmSnapshot = isSelected && !isEditing && documentId !== null;
  useQuery(
    api.prosemirror.getSnapshot,
    // Same document-scoped composite id InlineTextEditor builds.
    shouldPrewarmSnapshot ? { id: `${documentId}:${block.id}` } : "skip",
  );

  return isEditing ? (
    <InlineTextEditor block={block} resolvedStyles={resolvedStyles} />
  ) : (
    <TextBlockView block={block} resolvedStyles={resolvedStyles} />
  );
}
