"use client";

import type { MouseEvent } from "react";
import type { BlockId, BlockType } from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { getAncestorIds } from "@/lib/get-ancestor-ids";

/** Chip labels — always full words, never abbreviated or truncated. */
const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  root: "Email",
  section: "Section",
  row: "Row",
  column: "Column",
  text: "Text",
  button: "Button",
  image: "Image",
  divider: "Divider",
};

export interface BlockBreadcrumbProps {
  /** The selected block — the stack's FIRST (top) chip. */
  blockId: BlockId;
}

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
 */
export function BlockBreadcrumb({ blockId }: BlockBreadcrumbProps) {
  const doc = useEditorStore((state) => state.doc);
  const selectBlock = useEditorStore((state) => state.selectBlock);

  // Selected block first, then ancestors ascending (column, row, section).
  const trailIds = [blockId, ...getAncestorIds({ doc, blockId }).reverse()];

  const selectAncestor = (ancestorId: BlockId) => (event: MouseEvent) => {
    // Never bubble into the shell (its click would re-select this block).
    event.stopPropagation();
    selectBlock(ancestorId);
  };

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
        const blockType = doc[trailId]?.type;
        if (blockType === undefined) {
          return null;
        }
        const isCurrent = trailId === blockId;
        return isCurrent ? (
          <span
            key={trailId}
            aria-current="true"
            className="select-none rounded border border-sky-500 bg-sky-500 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wide text-white shadow-sm"
          >
            {BLOCK_TYPE_LABELS[blockType]}
          </span>
        ) : (
          <button
            key={trailId}
            type="button"
            onClick={selectAncestor(trailId)}
            className="cursor-pointer rounded border bg-background/95 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-wide text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
          >
            {BLOCK_TYPE_LABELS[blockType]}
          </button>
        );
      })}
    </nav>
  );
}
