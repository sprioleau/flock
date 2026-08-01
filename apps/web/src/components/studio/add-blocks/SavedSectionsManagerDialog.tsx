"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
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
import { cn } from "@/lib/utils";
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
      <DialogContent className="sm:max-w-2xl" data-testid="saved-sections-manager">
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
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {(savedSections ?? []).map((row) => (
                <SavedSectionManagerCard
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

/**
 * One saved section as a uniform grid card: 1:1 muted preview square on top
 * (contain-fit — see SquareSavedSectionPreview), then name (+ rename pencil),
 * the usage meta line, and the clamped description. The checkbox and delete
 * button overlay the square's corners so every card body lines up; clicking
 * the square itself also toggles selection (the checkbox stays the
 * accessible control and the visible state).
 */
function SavedSectionManagerCard({
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
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border transition-colors",
        isSelected && "border-primary ring-1 ring-primary",
      )}
      data-testid={`saved-section-row-${row._id}`}
    >
      <div className="relative cursor-pointer" onClick={onToggleSelected}>
        <SquareSavedSectionPreview blocks={row.blocks as Block[]} />
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelected}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select saved section ${row.name}`}
          className="absolute top-2 left-2 z-10 size-4 cursor-pointer accent-primary"
          data-testid={`saved-section-checkbox-${row._id}`}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete saved section ${row.name}`}
          className="absolute top-1 right-1 z-10 bg-background/70 text-destructive backdrop-blur-sm hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 border-t p-2.5">
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
            <span className="truncate text-sm font-medium" title={row.name}>
              {row.name}
            </span>
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
        <p className="truncate text-xs text-muted-foreground" title={usageMeta}>
          {usageMeta}
        </p>
        {row.useWhen !== undefined && <ClampedDescription text={row.useWhen} />}
      </div>
    </div>
  );
}

/**
 * Natural layout width the preview composes at inside the square (matches
 * ReadOnlyEmailPreview's PREVIEW_LAYOUT_WIDTH_PX, so its internal fit-zoom
 * resolves to exactly 1 and never scales).
 */
const SQUARE_PREVIEW_NATURAL_WIDTH_PX = 640;

/**
 * The card's 1:1 preview square: a muted stage with the themed section
 * miniature contain-fit inside — taller-than-wide sections touch the top
 * and bottom edges, wider-than-tall ones touch the left and right edges.
 *
 * Contain-fit is a `transform: scale()` — NOT conditional width/height
 * styling. The miniature renders at its natural 640px layout width (flex
 * centering keeps its center on the square's center), and one scale factor
 * min(square/naturalWidth, square/naturalHeight) shrinks it into view.
 * Because transforms never affect layout, the measured inputs (the square's
 * size from the grid, the content's natural offset size) are independent of
 * the applied style — no measure→style→measure feedback, no flicker. (An
 * earlier version sized the zoomed wrapper from its own rect, which raced
 * the preview's fit-zoom observer and oscillated.)
 */
function SquareSavedSectionPreview({ blocks }: { blocks: Block[] }) {
  const squareRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [squareSizePx, setSquareSizePx] = useState<number | null>(null);
  const [naturalHeightPx, setNaturalHeightPx] = useState<number | null>(null);

  // useLayoutEffect: measure before paint so the first frame never flashes
  // an unscaled 640px-wide miniature. offset sizes are layout units — the
  // transform applied below does not change them.
  useLayoutEffect(() => {
    const square = squareRef.current;
    const content = contentRef.current;
    if (square === null || content === null) {
      return;
    }
    const measure = (): void => {
      if (square.offsetWidth > 0) {
        setSquareSizePx(square.offsetWidth);
      }
      if (content.offsetHeight > 0) {
        setNaturalHeightPx(content.offsetHeight);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(square);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const scale =
    squareSizePx !== null && naturalHeightPx !== null
      ? Math.min(
          squareSizePx / SQUARE_PREVIEW_NATURAL_WIDTH_PX,
          squareSizePx / naturalHeightPx,
        )
      : null;

  return (
    <div
      ref={squareRef}
      className="flex aspect-square items-center justify-center overflow-hidden bg-muted"
      data-testid="saved-section-preview-square"
    >
      <div
        ref={contentRef}
        className={cn("shrink-0 origin-center", scale === null && "invisible")}
        style={{
          width: SQUARE_PREVIEW_NATURAL_WIDTH_PX,
          ...(scale === null ? {} : { transform: `scale(${scale})` }),
        }}
      >
        <SavedSectionPreview blocks={blocks} />
      </div>
    </div>
  );
}

/**
 * The per-card description, clamped to two lines with a "More" affordance
 * only when the text actually overflows; "Less" folds it back. Expansion
 * grows the card (its grid row stretches) — simple and predictable.
 */
function ClampedDescription({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (element === null || isExpanded) {
      return;
    }
    setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, [text, isExpanded]);

  return (
    <div className="mt-0.5">
      <p
        ref={textRef}
        className={cn("text-xs text-muted-foreground/80", !isExpanded && "line-clamp-2")}
      >
        {text}
      </p>
      {(isOverflowing || isExpanded) && (
        <button
          type="button"
          onClick={() => setIsExpanded((wasExpanded) => !wasExpanded)}
          className="cursor-pointer text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isExpanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}
