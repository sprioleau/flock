"use client";

import { useState } from "react";
import { CheckIcon, Loader2Icon, SparklesIcon, Undo2Icon } from "lucide-react";
import { applyOperations } from "@flock/email-sdk";
import type { EditSuggestionsDataPart } from "@/lib/chat-contract";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";

/**
 * The apply-able suggestions list (generative UI): 1-4 improvement cards from
 * proposeEdits, each carrying ops the SERVER already dry-ran against the
 * request document. Apply re-dry-runs against the LIVE document first (the
 * persona-findings pattern — the user may have edited since), then dispatches
 * through the normal store spine with agent provenance and one batchId per
 * card, so History shows the change and Revert undoes it in one step. A card
 * whose ops no longer fit degrades to a quiet "no longer matches" note —
 * never a half-applied edit.
 */

type SuggestionPhase =
  | { name: "idle" }
  | { name: "applied"; batchId: string; revertErrorMessage: string | null }
  | { name: "reverting"; batchId: string }
  | { name: "stale" };

const quietButtonClassName = cn(
  "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs",
  "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50",
);

export function EditSuggestionsWidget({ data }: { data: EditSuggestionsDataPart }) {
  const [phasesBySuggestionId, setPhasesBySuggestionId] = useState<
    Record<string, SuggestionPhase>
  >({});
  const revertAgentBatch = useEditorStore((state) => state.revertAgentBatch);

  const setPhase = (suggestionId: string, phase: SuggestionPhase): void => {
    setPhasesBySuggestionId((current) => ({ ...current, [suggestionId]: phase }));
  };

  const handleApply = (suggestion: EditSuggestionsDataPart["suggestions"][number]): void => {
    const store = useEditorStore.getState();
    // Re-dry-run against the LIVE document — the server validated against the
    // request-time document, and the user may have edited since.
    if (!applyOperations(store.doc, suggestion.ops).isOk) {
      setPhase(suggestion.id, { name: "stale" });
      return;
    }
    const batchId = `widget:edit-suggestion:${crypto.randomUUID()}`;
    for (const op of suggestion.ops) {
      const result = store.dispatch(op, {
        caller: "frontend",
        author: "agent",
        authorId: "widget:edit-suggestions",
        batchId,
      });
      if (!result.isOk) {
        // Unreachable after the dry-run; a partial batch stays revertable in
        // History — the card just reports the mismatch.
        setPhase(suggestion.id, { name: "stale" });
        return;
      }
    }
    setPhase(suggestion.id, { name: "applied", batchId, revertErrorMessage: null });
  };

  const handleRevert = async (suggestionId: string, batchId: string): Promise<void> => {
    setPhase(suggestionId, { name: "reverting", batchId });
    const result = await revertAgentBatch(batchId);
    if (result.isOk) {
      setPhase(suggestionId, { name: "idle" });
    } else {
      setPhase(suggestionId, { name: "applied", batchId, revertErrorMessage: result.message });
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-widget="edit-suggestions">
      {data.suggestions.map((suggestion) => {
        const phase = phasesBySuggestionId[suggestion.id] ?? { name: "idle" as const };
        return (
          <div
            key={suggestion.id}
            className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-2.5 py-2"
            data-edit-suggestion={suggestion.id}
            data-edit-suggestion-phase={phase.name}
          >
            <div className="flex items-start gap-2">
              <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">{suggestion.title}</p>
                {suggestion.description !== undefined && (
                  <p className="text-[11px] text-muted-foreground">{suggestion.description}</p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pl-5.5">
              {phase.name === "idle" && (
                <button
                  type="button"
                  onClick={() => handleApply(suggestion)}
                  className={quietButtonClassName}
                  data-edit-suggestion-apply={suggestion.id}
                >
                  <CheckIcon className="size-3" />
                  Apply
                </button>
              )}
              {(phase.name === "applied" || phase.name === "reverting") && (
                <>
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    data-edit-suggestion-applied={suggestion.id}
                  >
                    <CheckIcon className="size-3" />
                    Applied
                  </span>
                  <button
                    type="button"
                    disabled={phase.name === "reverting"}
                    onClick={() => void handleRevert(suggestion.id, phase.batchId)}
                    className={quietButtonClassName}
                    data-edit-suggestion-revert={suggestion.id}
                  >
                    {phase.name === "reverting" ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <Undo2Icon className="size-3" />
                    )}
                    Revert
                  </button>
                </>
              )}
              {phase.name === "stale" && (
                <span className="text-[11px] text-muted-foreground">
                  This suggestion no longer matches your email.
                </span>
              )}
              {phase.name === "applied" && phase.revertErrorMessage !== null && (
                <span className="text-[11px] text-destructive">{phase.revertErrorMessage}</span>
              )}
            </div>
          </div>
        );
      })}
      {data.droppedCount > 0 && (
        <p className="text-[11px] text-muted-foreground" data-edit-suggestions-dropped>
          {data.droppedCount === 1
            ? "One more idea was left out because it no longer matched your email."
            : `${data.droppedCount} more ideas were left out because they no longer matched your email.`}
        </p>
      )}
    </div>
  );
}
