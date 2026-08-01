"use client";

import type { MouseEvent, ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { LEAF_BLOCK_TYPES, type Block, type BlockType } from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { BlockActionRow } from "./BlockActionRow";
import { BlockBreadcrumb } from "./BlockBreadcrumb";
import { buildCanvasDraggableId, useCanvasDragStore } from "./dnd/drag-drop-store";
import { BlockPresenceIndicator } from "./presence/BlockPresenceIndicator";

export interface BlockShellProps {
  block: Block;
  children: ReactNode;
  /** Extra classes on the wrapper (e.g. h-full for column fill). */
  className?: string;
}

/**
 * Block types that can be picked up on the canvas: leaves move within and
 * across sections/columns, and sections reorder among the root's children
 * (owner decision 2026-07-31, reversing the Phase 2 arrows-only rule — the
 * move up/down buttons stay as the keyboard-accessible path). Rows and
 * columns remain non-draggable structure; sections and columns remain drop
 * targets for leaves.
 */
const DRAGGABLE_BLOCK_TYPES: readonly BlockType[] = [...LEAF_BLOCK_TYPES, "section"];

/**
 * The interactive wrapper every canvas block renders inside: hover outline,
 * click-to-select, selection ring + block-type label, and the floating
 * move-up / move-down / delete action row for the selected block.
 *
 * Drag-and-drop attaches here: the shell registers as a @dnd-kit draggable
 * (activated from the grab handle in the action row), fades to a ghost while
 * it is being dragged, and highlights when it is the container a valid drop
 * would land in. Dragging is disabled while the block's inline text editor
 * is open.
 */
export function BlockShell({ block, children, className }: BlockShellProps) {
  const isSelected = useEditorStore((state) => state.selectedBlockId === block.id);
  const isEditingText = useEditorStore((state) => state.editingBlockId === block.id);
  const selectBlock = useEditorStore((state) => state.selectBlock);
  const startTextEditing = useEditorStore((state) => state.startTextEditing);
  const documentId = useEditorStore((state) => state.documentId);

  const isDraggableType = DRAGGABLE_BLOCK_TYPES.includes(block.type);
  // Document-qualified id: several frames render live canvases in one
  // DndContext, and forked sibling drafts share block ids (see
  // buildCanvasDraggableId).
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: buildCanvasDraggableId({ documentId, blockId: block.id }),
    disabled: !isDraggableType || isEditingText,
  });
  const isValidDropContainer = useCanvasDragStore(
    (state) =>
      state.dragSource !== null &&
      state.dropTarget !== null &&
      !state.dropTarget.isNoop &&
      // Only stack-insert targets highlight their receiving container; a
      // column-split target communicates through the vertical edge indicator
      // (the "container" it creates doesn't exist yet).
      state.dropTarget.kind === "insert" &&
      state.dropTarget.parentId === block.id &&
      // Same id in a DIFFERENT frame (forked drafts share block ids) must
      // not light up.
      state.dropTarget.documentId === documentId,
  );

  // Blocks with an in-place content editor: text (rich-text Tiptap session)
  // and button (single-line label editor). Same gesture for both.
  const isInlineEditableBlock = block.type === "text" || block.type === "button";

  const handleClick = (event: MouseEvent) => {
    // Never let clicks bubble to the canvas (which clears the selection) —
    // including clicks inside an open inline text editor.
    event.stopPropagation();
    if (isEditingText) {
      return;
    }
    // Canvas clicks select; they never follow block links (button/image href).
    event.preventDefault();
    if (isInlineEditableBlock && isSelected) {
      // Click-when-already-selected opens the inline editor (this also makes
      // the second click of a double-click start the editing session).
      startTextEditing(block.id);
      return;
    }
    selectBlock(block.id);
  };

  const handleDoubleClick = (event: MouseEvent) => {
    if (!isInlineEditableBlock || isEditingText) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    startTextEditing(block.id);
  };

  return (
    <div
      ref={setNodeRef}
      data-block-id={block.id}
      data-block-type={block.type}
      data-selected={isSelected || undefined}
      data-editing={isEditingText || undefined}
      data-dragging={isDragging || undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className={cn(
        "relative",
        isEditingText ? "cursor-auto" : "cursor-pointer",
        // Selection/hover indicator as an INSIDE-the-bounds ::after overlay
        // (item 25): the active draft frame clips its content
        // (overflow-hidden for the rounded email corners), so an OUTSIDE
        // ring vanished wherever a block touched the email's edges —
        // full-width sections lost their left/right/bottom borders. An inset
        // box-shadow doesn't work either (it paints beneath the block's own
        // opaque background). The pseudo-element draws the border within the
        // block bounds, ABOVE the content, unclippable — all four sides
        // visible for every block type, zero layout shift.
        "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:transition-colors",
        isSelected
          ? "z-10 after:border-2 after:border-sky-500"
          : "after:border-sky-300 hover:after:border",
        // The source block ghosts while its lifted copy rides the overlay.
        isDragging && "opacity-40",
        // Subtle highlight on the container a valid drop would land in.
        isValidDropContainer && "bg-sky-400/10 after:border-2 after:border-sky-300",
        className,
      )}
    >
      {isSelected && (
        // Selection chrome in two non-colliding zones: the ancestor chip
        // stack outside the block's left edge (grows downward from its top),
        // the action row floating above the block's top-right.
        <>
          <BlockBreadcrumb blockId={block.id} />
          <BlockActionRow
            blockId={block.id}
            dragHandleRef={isDraggableType && !isEditingText ? setActivatorNodeRef : null}
            dragListeners={listeners}
            dragAttributes={attributes}
          />
        </>
      )}
      {/* Presence chrome (merge-notify): who ELSE is editing this block. */}
      <BlockPresenceIndicator blockId={block.id} isLocallySelected={isSelected} />
      {children}
    </div>
  );
}
