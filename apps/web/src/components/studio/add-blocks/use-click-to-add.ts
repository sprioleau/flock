"use client";

import { useCallback } from "react";
import type { BlockId } from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { useConfirmedBrandLogo } from "../brand-kit/useConfirmedBrandLogo";
import { buildClickToAddPlan } from "./click-to-add-placement";
import type { PaletteItem } from "./palette-items";
import { scrollBlockIntoView } from "./scroll-block-into-view";

/**
 * The palette's click path: plan a selection-aware insertion (see
 * click-to-add-placement), dispatch its ONE op, then select and reveal the
 * new block — the add-then-tweak loop (selection flips the right rail to
 * the Properties tab).
 */
export function useClickToAdd(): (item: PaletteItem) => void {
  // The Logo preset's source: the canvas brand's CONFIRMED logo, or null
  // (placeholder) — owner decision 4 keeps unconfirmed URLs out of documents.
  const brandLogo = useConfirmedBrandLogo();
  return useCallback((item) => {
    const editorStore = useEditorStore.getState();
    const plan = buildClickToAddPlan({
      doc: editorStore.doc,
      item,
      selectedBlockId: editorStore.selectedBlockId,
      brandLogo,
    });
    if (plan === null) {
      return;
    }
    const result = editorStore.dispatch(plan.op);
    if (!result.isOk) {
      return;
    }
    // scaffoldSection resolves to an addSection op inside dispatch — the new
    // section's id is only known from the applied op in the result.
    const appliedOp = result.logEntry.op;
    const newBlockId =
      plan.newBlockId ?? (appliedOp.name === "addSection" ? (appliedOp.section.id as BlockId) : null);
    if (newBlockId !== null) {
      editorStore.selectBlock(newBlockId);
      scrollBlockIntoView(newBlockId);
    }
  }, [brandLogo]);
}
