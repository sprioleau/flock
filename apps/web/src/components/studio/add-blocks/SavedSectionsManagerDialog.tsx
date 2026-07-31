"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { Block, BlockId } from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useEditorStore } from "@/lib/editor-store";
import { buildInsertSavedSectionPlan } from "@/lib/saved-sections";
import { formatRelativeTime } from "../history/history-grouping";
import { SavedSectionPreview } from "./SavedSectionPreview";
import { scrollBlockIntoView } from "./scroll-block-into-view";

/**
 * The saved-sections MANAGER (owner V2 item 1) — the "home" for the
 * session's saved sections: themed rendered previews, checkbox multi-select
 * with one "Add to draft" confirmation, inline rename, delete, and the
 * usage stat (subtle, in the meta line).
 *
 * Bulk insert = ONE restoreBlocks op PER selected section, dispatched
 * sequentially in the ORDER THE USER CHECKED them (each op is its own undo
 * step — undo peels the stack back one section at a time, matching every
 * other editor gesture; a combined mega-op would make one bookmarking
 * gesture undo differently from three palette clicks). The first insert
 * follows the palette placement rules (after the selection's ancestor
 * section, else bottom); each subsequent one chains directly after the
 * previous, so checked order IS reading order.
 *
 * Controlled open state: entry points (the palette group's "Manage…", the
 * action row's just-saved bookmark) each own an instance.
 */
export function SavedSectionsManagerDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const sessionId = useEditorStore((state) => state.authorId);
  const savedSections = useQuery(
    api.savedSections.listForSession,
    sessionId === null || !isOpen ? "skip" : { sessionId },
  );
  const removeSavedSection = useMutation(api.savedSections.remove);
  const renameSavedSection = useMutation(api.savedSections.rename);
  const recordUse = useMutation(api.savedSections.recordUse);

  // Selection preserves CHECK ORDER (it becomes the insert order).
  const [selectedIds, setSelectedIds] = useState<Id<"savedSections">[]>([]);
  const [renamingId, setRenamingId] = useState<Id<"savedSections"> | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const toggleSelected = (savedSectionId: Id<"savedSections">): void => {
    setSelectedIds((currentIds) =>
      currentIds.includes(savedSectionId)
        ? currentIds.filter((id) => id !== savedSectionId)
        : [...currentIds, savedSectionId],
    );
  };

  const commitRename = (row: Doc<"savedSections">): void => {
    setRenamingId(null);
    const trimmedName = renameDraft.trim();
    if (sessionId === null || trimmedName.length === 0 || trimmedName === row.name) {
      return;
    }
    void renameSavedSection({ sessionId, savedSectionId: row._id, name: trimmedName });
  };

  const deleteRow = (event: MouseEvent, row: Doc<"savedSections">): void => {
    event.stopPropagation();
    if (sessionId === null) {
      return;
    }
    setSelectedIds((currentIds) => currentIds.filter((id) => id !== row._id));
    void removeSavedSection({ sessionId, savedSectionId: row._id });
  };

  /** One op per checked section, chained in check order (see the header). */
  const addSelectedToDraft = (): void => {
    const rows = savedSections ?? [];
    let anchorBlockId = useEditorStore.getState().selectedBlockId;
    let lastInsertedSectionId: BlockId | null = null;
    for (const savedSectionId of selectedIds) {
      const row = rows.find((candidate) => candidate._id === savedSectionId);
      if (row === undefined) {
        continue; // deleted while selected
      }
      const editorState = useEditorStore.getState(); // fresh doc per insert
      const plan = buildInsertSavedSectionPlan({
        doc: editorState.doc,
        savedBlocks: row.blocks as Block[],
        selectedBlockId: anchorBlockId,
      });
      if (plan === null) {
        continue;
      }
      const result = editorState.dispatch(plan.op);
      if (!result.isOk) {
        continue;
      }
      anchorBlockId = plan.sectionId;
      lastInsertedSectionId = plan.sectionId;
      if (sessionId !== null) {
        void recordUse({ sessionId, savedSectionId }).catch(() => {});
      }
    }
    if (lastInsertedSectionId !== null) {
      useEditorStore.getState().selectBlock(lastInsertedSectionId);
      scrollBlockIntoView(lastInsertedSectionId);
    }
    setSelectedIds([]);
    onOpenChange(false);
  };

  const handleOpenChange = (nextIsOpen: boolean): void => {
    if (!nextIsOpen) {
      setSelectedIds([]);
      setRenamingId(null);
    }
    onOpenChange(nextIsOpen);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="saved-sections-manager">
        <DialogHeader>
          <DialogTitle>Saved sections</DialogTitle>
          <DialogDescription>
            Sections you saved from any draft, rendered in this email&apos;s style. Check some and
            add them to the current draft in one go.
          </DialogDescription>
        </DialogHeader>

        {savedSections !== undefined && savedSections.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing saved yet — select a section on the canvas and click its bookmark button.
          </p>
        ) : (
          <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto pr-1">
            {(savedSections ?? []).map((row) => (
              <SavedSectionManagerRow
                key={row._id}
                row={row}
                isSelected={selectedIds.includes(row._id)}
                isRenaming={renamingId === row._id}
                renameDraft={renameDraft}
                onToggleSelected={() => toggleSelected(row._id)}
                onStartRename={() => {
                  setRenamingId(row._id);
                  setRenameDraft(row.name);
                }}
                onRenameDraftChange={setRenameDraft}
                onCommitRename={() => commitRename(row)}
                onCancelRename={() => setRenamingId(null)}
                onDelete={(event) => deleteRow(event, row)}
              />
            ))}
          </div>
        )}

        <DialogFooter>
          <Button
            onClick={addSelectedToDraft}
            disabled={selectedIds.length === 0}
            data-testid="saved-sections-add-to-draft"
          >
            Add to draft
            {selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SavedSectionManagerRow({
  row,
  isSelected,
  isRenaming,
  renameDraft,
  onToggleSelected,
  onStartRename,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  row: Doc<"savedSections">;
  isSelected: boolean;
  isRenaming: boolean;
  renameDraft: string;
  onToggleSelected: () => void;
  onStartRename: () => void;
  onRenameDraftChange: (draft: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: (event: MouseEvent) => void;
}) {
  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      onCommitRename();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancelRename();
    }
  };

  const usageMeta = [
    row.blockCount === 1 ? "1 block" : `${row.blockCount} blocks`,
    ...(row.useCount !== undefined && row.useCount > 0 ? [`used ${row.useCount}×`] : []),
    `saved ${formatRelativeTime(row.createdAtMs)}`,
  ].join(" · ");

  return (
    <div
      className="flex items-start gap-3 rounded-md border p-2.5"
      data-testid={`saved-section-row-${row._id}`}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggleSelected}
        aria-label={`Select saved section ${row.name}`}
        className="mt-1 size-4 shrink-0 cursor-pointer accent-primary"
        data-testid={`saved-section-checkbox-${row._id}`}
      />
      <div className="w-36 shrink-0 overflow-hidden rounded border bg-background">
        <SavedSectionPreview blocks={row.blocks as Block[]} />
      </div>
      <div className="min-w-0 flex-1">
        {isRenaming ? (
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              value={renameDraft}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={onCommitRename}
              aria-label="Saved section name"
              className="h-7 text-sm"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Save name"
              // onMouseDown so the click wins over the input's blur-commit.
              onMouseDown={(event) => {
                event.preventDefault();
                onCommitRename();
              }}
            >
              <CheckIcon />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-medium">{row.name}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Rename saved section ${row.name}`}
              className="shrink-0 opacity-60 hover:opacity-100"
              onClick={onStartRename}
            >
              <PencilIcon />
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{usageMeta}</p>
        {row.useWhen !== undefined && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/80">{row.useWhen}</p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete saved section ${row.name}`}
        className="shrink-0 text-destructive hover:text-destructive"
        onClick={onDelete}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
