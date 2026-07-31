"use client";

import type { BlockId } from "@tandem/email-sdk";

/**
 * Reveal a just-inserted block: wait one frame so the dispatch's local apply
 * has rendered the block's element, then scroll the frames surface to it.
 * Shared by the palette's click-to-add and drop paths.
 */
export function scrollBlockIntoView(blockId: BlockId): void {
  requestAnimationFrame(() => {
    document
      .querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });
}
