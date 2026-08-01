"use client";

import type { BlockId } from "@tandem/email-sdk";
import { getActiveEditorStore } from "@/lib/editor-store";

/**
 * Reveal a just-inserted block: wait one frame so the dispatch's local apply
 * has rendered the block's element, then scroll the frames surface to it.
 * Shared by the palette's click-to-add and drop paths.
 *
 * Frame scoping (multi-frame editing): forked sibling drafts share block ids
 * and several frames render live canvases, so a bare `data-block-id` query
 * could land on another frame's copy. The lookup is scoped to one document's
 * canvas root — the ACTIVE document for the bare-id form (every legacy caller
 * targets the active frame), or an explicit `documentId` via the object form.
 */
export function scrollBlockIntoView(
  input: BlockId | { blockId: BlockId; documentId: string | null },
): void {
  const blockId = typeof input === "string" ? input : input.blockId;
  const documentId =
    typeof input === "string"
      ? getActiveEditorStore().getState().documentId
      : input.documentId;
  requestAnimationFrame(() => {
    const scope =
      documentId === null
        ? document
        : (document.querySelector(
            `[data-canvas-document-id="${CSS.escape(documentId)}"]`,
          ) ?? document);
    scope
      .querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });
}
