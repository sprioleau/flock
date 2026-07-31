"use client";

import { useMemo } from "react";
import { ROOT_BLOCK_ID, type Block } from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { buildStandaloneSectionDoc } from "@/lib/saved-sections";
import { ReadOnlyEmailPreview } from "../history/ReadOnlyEmailPreview";

/**
 * A rendered miniature of one SAVED section — the saved-subtree analogue of
 * SectionTemplatePreview: the stored blocks become a minimal one-section
 * EmailDocument whose root carries the ACTIVE document's globals, rendered
 * through ReadOnlyEmailPreview (same SDK block views + measured fit-zoom, so
 * the miniature is visually what an insert would produce under the current
 * theme).
 *
 * Memoized per blocks + globals reference: saved rows are immutable Convex
 * payloads (a rename patches name only, never blocks), so the doc rebuilds
 * only on a theme change.
 */
export function SavedSectionPreview({ blocks }: { blocks: Block[] }) {
  const globals = useEditorStore((state) => {
    const root = state.doc[ROOT_BLOCK_ID];
    return root !== undefined && root.type === "root" ? root.properties.globals : undefined;
  });
  const previewDoc = useMemo(
    () => buildStandaloneSectionDoc({ blocks, globals }),
    [blocks, globals],
  );
  if (previewDoc === null) {
    return null;
  }
  return (
    <div data-testid="saved-section-preview">
      <ReadOnlyEmailPreview doc={previewDoc} />
    </div>
  );
}
