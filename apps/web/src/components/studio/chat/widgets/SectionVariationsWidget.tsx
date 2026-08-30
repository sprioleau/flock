"use client";

import { useState } from "react";
import { CheckIcon, Loader2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SectionVariationsDataPart } from "@/lib/chat-contract";
import { useEditorStore } from "@/lib/editor-store";
import { buildInsertSavedSectionPlan } from "@/lib/saved-sections";
import { cn } from "@/lib/utils";
import { SavedSectionPreview } from "../../add-blocks/SavedSectionPreview";
import { scrollBlockIntoView } from "../../add-blocks/scroll-block-into-view";

/*
  The section-variations picker (generative UI): click-through themed
  previews of 2-4 takes on a section, each insertable with "Use this one".

  - Previews render through SavedSectionPreview — the same SDK block views +
    active-theme globals the saved-sections palette uses, so what's shown is
    what an insert produces.
  - "Use this one" applies ONE restoreBlocks op (fresh ids minted against the
    live document via buildInsertSavedSectionPlan — the saved-section insert
    seam) through the normal store dispatch spine with agent provenance and
    its own batchId, so History shows it as an agent change and Revert undoes
    the whole insert in one step.
  - Each variation can be inserted at most once from this widget (the button
    flips to Added + Revert); other variations stay available for comparison.
*/
export function SectionVariationsWidget({ data }: { data: SectionVariationsDataPart }) {
  const [activeVariationId, setActiveVariationId] = useState(data.variations[0]?.id ?? "");
  /*
    variation id → the batchId its insert dispatched under (for Revert).
  */
  const [appliedBatchIds, setAppliedBatchIds] = useState<Record<string, string>>({});
  const [revertingVariationId, setRevertingVariationId] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const revertAgentBatch = useEditorStore((state) => state.revertAgentBatch);

  const activeVariation =
    data.variations.find((variation) => variation.id === activeVariationId) ?? data.variations[0];
  if (activeVariation === undefined) {
    return null;
  }
  const appliedBatchId = appliedBatchIds[activeVariation.id];

  const handleUseVariation = (): void => {
    if (appliedBatchIds[activeVariation.id] !== undefined) {
      return;
    }
    setNoticeMessage(null);
    const store = useEditorStore.getState();
    const plan = buildInsertSavedSectionPlan({
      doc: store.doc,
      savedBlocks: activeVariation.blocks,
      selectedBlockId: store.selectedBlockId,
    });
    if (plan === null) {
      setNoticeMessage("This option couldn't be added to the email.");
      return;
    }
    const batchId = `widget:section-variation:${crypto.randomUUID()}`;
    const result = store.dispatch(plan.op, {
      caller: "frontend",
      author: "agent",
      authorId: "widget:section-variations",
      batchId,
    });
    if (!result.isOk) {
      setNoticeMessage("This option couldn't be added to the email.");
      return;
    }
    scrollBlockIntoView(plan.sectionId);
    setAppliedBatchIds((current) => ({ ...current, [activeVariation.id]: batchId }));
  };

  const handleRevert = async (): Promise<void> => {
    if (appliedBatchId === undefined || revertingVariationId !== null) {
      return;
    }
    setNoticeMessage(null);
    setRevertingVariationId(activeVariation.id);
    const result = await revertAgentBatch(appliedBatchId);
    setRevertingVariationId(null);
    if (result.isOk) {
      setAppliedBatchIds((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== activeVariation.id)),
      );
    } else {
      setNoticeMessage(result.message);
    }
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2"
      data-widget="section-variations"
    >
      <p className="text-xs font-medium">{data.intent ?? "Pick the version you like"}</p>
      <div className="flex flex-wrap gap-1.5">
        {data.variations.map((variation) => {
          const isActiveVariation = variation.id === activeVariation.id;
          const isAppliedVariation = appliedBatchIds[variation.id] !== undefined;
          return (
            <button
              key={variation.id}
              type="button"
              onClick={() => setActiveVariationId(variation.id)}
              aria-pressed={isActiveVariation}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs",
                isActiveVariation
                  ? "border-primary text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              data-variation-tab={variation.id}
            >
              {isAppliedVariation && <CheckIcon className="size-3" />}
              {variation.title}
            </button>
          );
        })}
      </div>
      <div
        className="max-h-56 overflow-hidden rounded-md border bg-background"
        data-variation-preview={activeVariation.id}
      >
        <SavedSectionPreview blocks={activeVariation.blocks} />
      </div>
      <div className="flex items-center gap-2">
        {appliedBatchId === undefined ? (
          <Button size="xs" onClick={handleUseVariation} data-variation-use={activeVariation.id}>
            Use this one
          </Button>
        ) : (
          <>
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              data-variation-applied={activeVariation.id}
            >
              <CheckIcon className="size-3" />
              Added to your email
            </span>
            <button
              type="button"
              onClick={() => void handleRevert()}
              disabled={revertingVariationId !== null}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs",
                "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50",
              )}
              data-variation-revert={activeVariation.id}
            >
              {revertingVariationId !== null ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <Undo2Icon className="size-3" />
              )}
              Revert
            </button>
          </>
        )}
      </div>
      {noticeMessage !== null && (
        <p className="text-xs text-destructive" data-variation-notice>
          {noticeMessage}
        </p>
      )}
    </div>
  );
}
