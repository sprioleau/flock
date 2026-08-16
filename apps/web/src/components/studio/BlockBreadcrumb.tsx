"use client";

import type { MouseEvent } from "react";
import type { BlockId } from "@flock/email-sdk";
import { getBlockDisplayLabel } from "@/lib/block-display-label";
import { getBlockLevelAccent } from "@/lib/block-level-accent";
import { useEditorStore } from "@/lib/editor-store";
import { getAncestorIds } from "@/lib/get-ancestor-ids";
import { cn } from "@/lib/utils";

export interface BlockBreadcrumbProps {
  /** The selected block — the stack's FIRST (top) chip. */
  blockId: BlockId;
}

/*
  Shape and typography every chip shares; the level accent supplies the
  border, fill and text colour on top (block-level-accent).
*/
const CHIP_CLASS_NAME =
  "select-none rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none tracking-wide shadow-sm transition-colors";

/**
 * Ancestor-selection stack on the selected block: a vertical column of
 * compact chips, the SELECTED block's type first (it is the primary "what's
 * selected" cue — the action toolbar carries no type badge), then its
 * ancestors in ascending order up to the section (root excluded; schema
 * caps depth at section › row › column › leaf, so at most 4 chips: BUTTON /
 * COLUMN / ROW / SECTION). Every ancestor chip is clickable and selects
 * that ancestor — this is THE mouse path to rows and columns, whose
 * children tile them completely so canvas clicks always land innermost.
 *
 * Anchored OUTSIDE the block, against the LEFT of its left edge (chips
 * right-aligned, growing downward from the block's top) so it never covers
 * the selected block's own content, and never collides with the rest of
 * the selection chrome: the action row (with drag handle) floats ABOVE the
 * block on the right, the text bubble menu floats at the text selection,
 * and the canvas top edge's ~40px headroom is never needed (the stack
 * grows down, not up). Nested blocks put the stack over parent padding or
 * the canvas gutter; the one clipped case is a full-bleed section at the
 * desktop viewport (its left edge IS the canvas edge), whose stack is a
 * single non-interactive chip duplicating the action row's type label.
 *
 * Every chip is painted in ITS OWN nesting level's colour (block-level-accent
 * — content blue, column violet, row orange, section magenta), the same hue
 * the shell draws that block's outline in, so the stack reads as a legend for
 * what is on the canvas. Pointing at an ancestor chip arms the shared
 * hover-preview: that ancestor's shell outlines itself DASHED in the chip's
 * colour, and clicking turns the same line solid by making it the selection.
 */
export function BlockBreadcrumb({ blockId }: BlockBreadcrumbProps) {
  const doc = useEditorStore((state) => state.doc);
  const selectBlock = useEditorStore((state) => state.selectBlock);
  const setHoverPreviewBlock = useEditorStore((state) => state.setHoverPreviewBlock);

  // Selected block first, then ancestors ascending (column, row, section).
  const trailIds = [blockId, ...getAncestorIds({ doc, blockId }).reverse()];

  const selectAncestor = (ancestorId: BlockId) => (event: MouseEvent) => {
    // Never bubble into the shell (its click would re-select this block).
    event.stopPropagation();
    selectBlock(ancestorId);
  };

  /*
    Pointer AND keyboard arm the preview: these are real buttons, so a
    Tab-through must show the same dashed outline a mouse-over does.
  */
  const previewAncestor = (ancestorId: BlockId) => () => setHoverPreviewBlock(ancestorId);
  const clearPreview = () => setHoverPreviewBlock(null);

  return (
    <nav
      aria-label="Selected block ancestors"
      className="absolute right-full top-0 z-30 mr-1 flex w-fit flex-col items-end gap-0.5"
      data-testid={`block-breadcrumb-${blockId}`}
      // A fast double-click on a chip must not reach the shell's
      // double-click-to-edit-text handler.
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {trailIds.map((trailId) => {
        const trailBlock = doc[trailId];
        if (trailBlock === undefined) {
          return null;
        }
        const isCurrent = trailId === blockId;
        const accent = getBlockLevelAccent({ block: trailBlock });
        return isCurrent ? (
          <span
            key={trailId}
            aria-current="true"
            data-testid={`block-breadcrumb-chip-${trailId}`}
            data-block-level={accent.level}
            className={cn(CHIP_CLASS_NAME, "font-semibold", accent.selectedChipClassName)}
          >
            {getBlockDisplayLabel({ block: trailBlock })}
          </span>
        ) : (
          <button
            key={trailId}
            type="button"
            data-testid={`block-breadcrumb-chip-${trailId}`}
            data-block-level={accent.level}
            onClick={selectAncestor(trailId)}
            onMouseEnter={previewAncestor(trailId)}
            onMouseLeave={clearPreview}
            onFocus={previewAncestor(trailId)}
            onBlur={clearPreview}
            className={cn(
              CHIP_CLASS_NAME,
              "cursor-pointer font-medium",
              accent.ancestorChipClassName,
            )}
          >
            {getBlockDisplayLabel({ block: trailBlock })}
          </button>
        );
      })}
    </nav>
  );
}
