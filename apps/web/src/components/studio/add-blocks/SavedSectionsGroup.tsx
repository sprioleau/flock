"use client";

import { useState, type MouseEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { BookmarkIcon, XIcon } from "lucide-react";
import type { Block } from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";
import { buildInsertSavedSectionPlan } from "@/lib/saved-sections";
import { formatRelativeTime } from "../history/history-grouping";
import { SavedSectionsManagerDialog } from "./SavedSectionsManagerDialog";
import { scrollBlockIntoView } from "./scroll-block-into-view";

/**
 * The "Saved" group for the Blocks palette's Sections area: the session's
 * saved reusable sections (a customized footer, a header with the user's
 * logo — bookmarked from the section action row), newest first. Session-
 * scoped like the asset library, so a section saved in one draft or canvas
 * is insertable in every other one.
 *
 * Click = insert as ONE restoreBlocks op with FRESH ids minted against the
 * current document (lib/saved-sections.ts — the duplicate-block pattern):
 * one op, one undo step, insertable any number of times. Placement follows
 * the palette's section rule (after the selection's ancestor section, else
 * bottom), then the new section is selected and revealed.
 *
 * Renders nothing while the session has no saved sections — the palette
 * stays clean until the feature is used.
 */
export function SavedSectionsGroup() {
  const sessionId = useEditorStore((state) => state.authorId);
  const savedSections = useQuery(
    api.savedSections.listForSession,
    sessionId === null ? "skip" : { sessionId },
  );
  const removeSavedSection = useMutation(api.savedSections.remove);
  const recordUse = useMutation(api.savedSections.recordUse);
  const [isManagerOpen, setIsManagerOpen] = useState(false);

  if (sessionId === null || savedSections === undefined || savedSections.length === 0) {
    return null;
  }

  const insertSavedSection = (row: Doc<"savedSections">): void => {
    const editorStore = useEditorStore.getState();
    // The stored payload was SDK-validated on save; the dispatch's
    // applyOperations gate re-validates the composed op at insert time.
    const plan = buildInsertSavedSectionPlan({
      doc: editorStore.doc,
      savedBlocks: row.blocks as Block[],
      selectedBlockId: editorStore.selectedBlockId,
    });
    if (plan === null) {
      return;
    }
    const result = editorStore.dispatch(plan.op);
    if (!result.isOk) {
      return;
    }
    editorStore.selectBlock(plan.sectionId);
    scrollBlockIntoView(plan.sectionId);
    // Usage stat (owner V2 item 4): a tiebreaker signal for the compose
    // agent, bumped on EVERY insert path. Fails soft.
    void recordUse({ sessionId, savedSectionId: row._id }).catch(() => {});
  };

  const deleteSavedSection = (event: MouseEvent, row: Doc<"savedSections">): void => {
    // The delete affordance sits inside the insert tile — never insert too.
    event.stopPropagation();
    void removeSavedSection({ sessionId, savedSectionId: row._id });
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="saved-sections-group">
      <div className="flex items-baseline justify-between">
        <h4 className="px-1 pt-1.5 text-[11px] font-medium text-muted-foreground/80">Saved</h4>
        <button
          type="button"
          onClick={() => setIsManagerOpen(true)}
          className="cursor-pointer px-1 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="open-saved-sections-manager"
        >
          Manage…
        </button>
      </div>
      <SavedSectionsManagerDialog isOpen={isManagerOpen} onOpenChange={setIsManagerOpen} />
      <div className="flex flex-col gap-1.5">
        {savedSections.map((row) => (
          <div
            key={row._id}
            role="button"
            tabIndex={0}
            onClick={() => insertSavedSection(row)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                insertSavedSection(row);
              }
            }}
            aria-label={`Add saved section ${row.name}`}
            className="group flex cursor-pointer items-center gap-2 rounded-md border bg-background p-2 text-left transition-colors hover:border-ring/60 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`saved-section-${row._id}`}
          >
            <BookmarkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium leading-tight text-foreground">
                {row.name}
              </span>
              <span className="block text-[11px] leading-tight text-muted-foreground">
                {row.blockCount === 1 ? "1 block" : `${row.blockCount} blocks`} ·{" "}
                {formatRelativeTime(row.createdAtMs)}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete saved section ${row.name}`}
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => deleteSavedSection(event, row)}
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
