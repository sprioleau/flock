"use client";

import { useState, type MouseEvent } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { useMutation } from "convex/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkCheckIcon,
  BookmarkIcon,
  CopyIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  Trash2Icon,
} from "lucide-react";
import type { BlockId } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { buildDuplicateBlockOperation } from "@/lib/duplicate-block";
import { useEditorStore } from "@/lib/editor-store";
import { collectSectionSubtree, seedNameFromSectionSubtree } from "@/lib/saved-sections";
import { SavedSectionsManagerDialog } from "./add-blocks/SavedSectionsManagerDialog";

export interface BlockActionRowProps {
  blockId: BlockId;
  /*
    Grab-handle activator ref from the shell's useDraggable, or null when
    the block cannot be dragged (rows and columns, or a text block whose
    inline editor is open) — null hides the handle. The move up/down buttons
    stay as the keyboard-accessible reorder path.
  */
  dragHandleRef: ((element: HTMLElement | null) => void) | null;
  /*
    Activator listeners from the shell's useDraggable.
  */
  dragListeners: DraggableSyntheticListeners;
  /*
    Accessibility attributes from the shell's useDraggable.
  */
  dragAttributes: DraggableAttributes | undefined;
}

/*
  Floating action bar on the selected block: grab handle (pointer drag),
  move up / move down / duplicate / save (sections) / delete. No block-type
  badge here — the left-edge BlockBreadcrumb chip stack is the "what's
  selected" cue (owner decision). Move = a reorderChildren op on the parent
  (adjacent swap); duplicate = a restoreBlocks op carrying a fresh-id clone
  of the subtree (see lib/duplicate-block.ts); delete = a removeBlock op.
  All flow through the store's dispatch (§7 invariant); drops dispatch
  their single op from CanvasDndContext.

  Save (sections only): bookmarks the section's subtree VERBATIM into the
  session's saved-sections list (convex/savedSections.ts — the asset-library
  scoping), reusable from the Blocks palette's Saved card. Not a document
  op — nothing on the history spine changes; the icon spins while the save
  is in flight, flips to a check, and a toast confirms it.
*/
export function BlockActionRow({
  blockId,
  dragHandleRef,
  dragListeners,
  dragAttributes,
}: BlockActionRowProps) {
  const doc = useEditorStore((state) => state.doc);
  const dispatch = useEditorStore((state) => state.dispatch);
  const sessionId = useEditorStore((state) => state.authorId);
  const saveSavedSection = useMutation(api.savedSections.save);
  /*
    Instant save feedback: the bookmark becomes a spinner the moment the
    click lands (never an unacknowledged click), then flips to a check
    briefly; clicking the check answers "where did it go?" by opening the
    manager modal. A toast confirms the save (or reports a failure).
  */
  const [isSaving, setIsSaving] = useState(false);
  const [isJustSaved, setIsJustSaved] = useState(false);
  const [isManagerOpen, setIsManagerOpen] = useState(false);

  const block = doc[blockId];
  const parent = block?.parentId != null ? doc[block.parentId] : undefined;
  if (block === undefined || parent === undefined) {
    return null;
  }

  const siblingIds: BlockId[] = [...parent.childrenIds];
  const index = siblingIds.indexOf(blockId);
  const canMoveUp = index > 0;
  const canMoveDown = index >= 0 && index < siblingIds.length - 1;

  const moveBy = (offset: -1 | 1) => {
    const orderedChildIds = [...siblingIds];
    const swapIndex = index + offset;
    [orderedChildIds[index], orderedChildIds[swapIndex]] = [
      orderedChildIds[swapIndex]!,
      orderedChildIds[index]!,
    ];
    dispatch({ name: "reorderChildren", parentId: parent.id, orderedChildIds });
  };

  const stopThen = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    action();
  };

  const duplicateBlock = (): void => {
    const operation = buildDuplicateBlockOperation({ doc, blockId });
    if (operation !== null) {
      dispatch(operation);
    }
  };

  const isSaveableSection = block.type === "section";

  const saveSection = (): void => {
    if (sessionId === null || isSaving) {
      return;
    }
    if (isJustSaved) {
      /*
        Second click while the check shows = "take me to my saved sections".
      */
      setIsManagerOpen(true);
      return;
    }
    const subtreeBlocks = collectSectionSubtree({ doc, sectionId: blockId });
    if (subtreeBlocks === null) {
      return;
    }
    setIsSaving(true); /* spinner NOW — before any async work. */
    const seededName = seedNameFromSectionSubtree(subtreeBlocks);
    void saveSavedSection({
      sessionId,
      ...(seededName.length === 0 ? {} : { name: seededName }),
      blocks: subtreeBlocks,
    })
      .then(({ savedSectionId }) => {
        setIsJustSaved(true);
        toast.success("Section saved");
        window.setTimeout(() => setIsJustSaved(false), 2000);
        /*
          ASYNC enrichment (fails-soft): a small LLM call authors the row's
          useWhen/description for the compose agent. Fire-and-forget — the
          save UX never waits, and any failure just leaves the row unenriched.
        */
        void fetch("/api/saved-sections/enrich", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ savedSectionId }),
          keepalive: true,
        }).catch(() => {});
      })
      .catch(() => {
        toast.error("Couldn't save the section", {
          description: "Something went wrong. Please try again.",
        });
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  return (
    <div
      className="absolute -top-9 right-0 z-30 flex items-center gap-0.5 rounded-md border bg-background p-0.5 shadow-md"
      data-testid={`block-actions-${blockId}`}
    >
      {dragHandleRef !== null && (
        <Button
          ref={dragHandleRef}
          variant="ghost"
          size="icon-sm"
          aria-label="Drag to move block"
          className="touch-none cursor-grab active:cursor-grabbing"
          data-testid={`drag-handle-${blockId}`}
          {...dragAttributes}
          {...dragListeners}
          /*
            A click on the handle (pointer never crossed the 4px activation
            distance) must not bubble into the shell's click-to-edit.
          */
          onClick={(event) => event.stopPropagation()}
        >
          <GripVerticalIcon />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Move block up"
        disabled={!canMoveUp}
        onClick={stopThen(() => moveBy(-1))}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Move block down"
        disabled={!canMoveDown}
        onClick={stopThen(() => moveBy(1))}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Duplicate block"
        onClick={stopThen(duplicateBlock)}
      >
        <CopyIcon />
      </Button>
      {isSaveableSection && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              isSaving
                ? "Saving section…"
                : isJustSaved
                  ? "Section saved — open saved sections"
                  : "Save section for reuse"
            }
            data-testid={`save-section-${blockId}`}
            onClick={stopThen(saveSection)}
          >
            {isSaving ? (
              <LoaderCircleIcon className="animate-spin" data-testid="save-section-spinner" />
            ) : isJustSaved ? (
              <BookmarkCheckIcon className="text-primary" />
            ) : (
              <BookmarkIcon />
            )}
          </Button>
          <SavedSectionsManagerDialog isOpen={isManagerOpen} onOpenChange={setIsManagerOpen} />
        </>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Delete block"
        className="text-destructive hover:text-destructive"
        onClick={stopThen(() => dispatch({ name: "removeBlock", blockId }))}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
