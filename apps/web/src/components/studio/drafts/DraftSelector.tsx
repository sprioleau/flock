"use client";

import { useState } from "react";
import { useConvex } from "convex/react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FrameIcon,
  Link2Icon,
  LinkIcon,
  PencilLineIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditorStore } from "@/lib/editor-store";
import { getOrCreateSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";
import { computeNextDraftName, useCanvasDrafts, type DraftListEntry } from "./use-canvas-drafts";

/**
 * §10.2 frames UX — the compact toolbar control that replaced the v1 chip
 * row: [prev] [current draft name ▾] [next]. The menu lists every draft on
 * the canvas (click = activate; dual naming surfaced as a read-only secondary
 * line: agent-authored `agentName` + fork lineage) and keeps all v1
 * management actions — rename (inline, swaps the trigger for an input),
 * duplicate, copy link, new blank draft. Activation is delegated upward
 * (shallow ?doc= pushState in StudioShell).
 */
export function DraftSelector({
  onActivateDraft,
}: {
  onActivateDraft: (documentId: Id<"documents">) => void;
}) {
  const convexClient = useConvex();
  const { drafts, activeDocumentId, activeIndex } = useCanvasDrafts();
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [isCreatePending, setIsCreatePending] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [isPromotePending, setIsPromotePending] = useState(false);

  if (drafts === undefined || drafts.length === 0) {
    return null;
  }

  const activeDraft = activeIndex >= 0 ? drafts[activeIndex]! : null;
  const previousDraft = activeIndex > 0 ? drafts[activeIndex - 1]! : null;
  const nextDraft =
    activeIndex >= 0 && activeIndex < drafts.length - 1 ? drafts[activeIndex + 1]! : null;
  /** Delete and promote both need a sibling: a canvas always keeps ≥ 1 draft. */
  const hasSiblingDrafts = drafts.length > 1;

  const beginRename = (): void => {
    if (activeDraft === null) {
      return;
    }
    setNameInput(activeDraft.name);
    setIsRenaming(true);
  };

  const commitRename = (): void => {
    setIsRenaming(false);
    if (activeDraft === null) {
      return;
    }
    const name = nameInput.trim();
    if (name.length === 0 || name === activeDraft.name) {
      return;
    }
    convexClient
      .mutation(api.documents.renameDocument, { documentId: activeDraft._id, name })
      .catch((error: unknown) => {
        console.error("renameDocument failed", error);
      });
  };

  const duplicateActiveDraft = (): void => {
    if (activeDraft === null) {
      return;
    }
    convexClient
      .mutation(api.documents.duplicateDocument, { documentId: activeDraft._id })
      .then((newDocumentId) => {
        if (newDocumentId !== null) {
          onActivateDraft(newDocumentId);
        }
      })
      .catch((error: unknown) => {
        console.error("duplicateDocument failed", error);
      });
  };

  const copyActiveDraftLink = (): void => {
    if (activeDraft === null) {
      return;
    }
    const url = `${window.location.origin}/studio?doc=${activeDraft._id}`;
    navigator.clipboard.writeText(url).catch((error: unknown) => {
      console.error("copy draft link failed", error);
    });
  };

  /** Whole-canvas share link: opens the canvas's latest draft, drafts bar shows all. */
  const copyCanvasLink = (): void => {
    if (activeDraft === null) {
      return;
    }
    const url = `${window.location.origin}/studio?canvas=${activeDraft.canvasId}`;
    navigator.clipboard.writeText(url).catch((error: unknown) => {
      console.error("copy canvas link failed", error);
    });
  };

  /** §10.2 promote: MOVE the active draft to a freshly created canvas of its own. */
  const promoteActiveDraft = (): void => {
    if (activeDraft === null || isPromotePending) {
      return;
    }
    setIsPromotePending(true);
    convexClient
      .mutation(api.documents.promoteDocumentToNewCanvas, { documentId: activeDraft._id })
      .then((result) => {
        const store = useEditorStore.getState();
        if (!result.isOk) {
          store.showNotice(
            result.reason === "already_alone"
              ? "This draft is already on its own canvas."
              : "This draft no longer exists.",
          );
          return;
        }
        // Same document id, new canvas: re-point the store's canvas so the
        // drafts bar and canvas link follow the move. The ?doc= URL is
        // unchanged and stays authoritative.
        if (store.documentId === activeDraft._id) {
          store.connectDocument({
            convexClient,
            documentId: activeDraft._id,
            canvasId: result.canvasId,
            authorId: getOrCreateSessionId(),
          });
        }
        store.showNotice(`"${activeDraft.name}" now lives on its own canvas.`);
      })
      .catch((error: unknown) => {
        console.error("promoteDocumentToNewCanvas failed", error);
        useEditorStore.getState().showNotice("Couldn't promote the draft (connection error).");
      })
      .finally(() => {
        setIsPromotePending(false);
      });
  };

  /**
   * Confirmed delete of the ACTIVE draft: hand the frame to a sibling first
   * (so the live subscription never lands on a deleted document), then run
   * the server-side cascade.
   */
  const confirmDeleteActiveDraft = (): void => {
    if (activeDraft === null || isDeletePending) {
      return;
    }
    const fallbackDraft = nextDraft ?? previousDraft;
    if (fallbackDraft === null) {
      // Last draft on the canvas — the menu item is disabled; backstop only.
      setIsDeleteDialogOpen(false);
      return;
    }
    setIsDeletePending(true);
    onActivateDraft(fallbackDraft._id);
    convexClient
      .mutation(api.documents.deleteDocument, { documentId: activeDraft._id })
      .then((result) => {
        if (!result.isOk) {
          useEditorStore
            .getState()
            .showNotice(
              result.reason === "last_draft"
                ? "A canvas needs at least one draft — this one can't be deleted."
                : "This draft was already deleted.",
            );
        }
      })
      .catch((error: unknown) => {
        console.error("deleteDocument failed", error);
        useEditorStore.getState().showNotice("Couldn't delete the draft (connection error).");
      })
      .finally(() => {
        setIsDeletePending(false);
        setIsDeleteDialogOpen(false);
      });
  };

  const createDraft = (): void => {
    const canvasId = activeDraft?.canvasId ?? drafts[0]!.canvasId;
    if (isCreatePending) {
      return;
    }
    setIsCreatePending(true);
    convexClient
      .mutation(api.documents.createDocument, {
        sessionId: getOrCreateSessionId(),
        canvasId,
        name: computeNextDraftName(drafts),
      })
      .then(({ documentId }) => {
        onActivateDraft(documentId);
      })
      .catch((error: unknown) => {
        console.error("createDocument (new draft) failed", error);
      })
      .finally(() => {
        setIsCreatePending(false);
      });
  };

  return (
    <div className="flex items-center gap-0.5" data-testid="draft-selector">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous draft"
        disabled={previousDraft === null}
        // On the first draft this must READ disabled at a glance (owner
        // emphasis) — the base button's 50%-opacity alone is too subtle for
        // a bare ghost chevron, so drop to washed-out muted (same below).
        className="disabled:text-muted-foreground disabled:opacity-30"
        onClick={() => previousDraft !== null && onActivateDraft(previousDraft._id)}
        data-testid="draft-selector-prev"
      >
        <ChevronLeftIcon />
      </Button>

      {isRenaming ? (
        <input
          value={nameInput}
          onChange={(event) => setNameInput(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitRename();
            } else if (event.key === "Escape") {
              setIsRenaming(false);
            }
          }}
          autoFocus
          onFocus={(event) => event.target.select()}
          maxLength={80}
          className="h-7 rounded-md bg-background px-2 text-xs font-medium outline-none ring-1 ring-ring"
          style={{ width: `${Math.max(nameInput.length + 2, 10)}ch` }}
          aria-label={`Rename ${activeDraft?.name ?? "draft"}`}
          data-testid="draft-selector-rename-input"
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "flex h-7 max-w-56 items-center gap-1 rounded-md px-2 text-xs font-medium",
              "outline-none hover:bg-accent data-popup-open:bg-accent",
            )}
            aria-label="Drafts on this canvas"
            data-testid="draft-selector-trigger"
          >
            <span className="truncate">{activeDraft?.name ?? "…"}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-[10px] tracking-wide text-muted-foreground uppercase">
                Drafts on this canvas
              </DropdownMenuLabel>
              {drafts.map((draft) => (
                <DraftMenuEntry
                  key={draft._id}
                  draft={draft}
                  isActive={draft._id === activeDocumentId}
                  forkedFromName={
                    draft.forkedFromDocumentId !== undefined
                      ? (drafts.find((row) => row._id === draft.forkedFromDocumentId)?.name ??
                        "a removed draft")
                      : null
                  }
                  onActivate={() => onActivateDraft(draft._id)}
                />
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                // Defer past the menu's close/focus-return so the rename
                // input keeps focus once it mounts.
                setTimeout(beginRename, 0);
              }}
            >
              <PencilLineIcon /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={duplicateActiveDraft}>
              <CopyIcon /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyActiveDraftLink}>
              <LinkIcon /> Copy draft link
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyCanvasLink}>
              <Link2Icon /> Copy canvas link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <TooltipProvider>
              <MaybeDisabledTooltip
                isDisabled={!hasSiblingDrafts}
                message="This draft is already on its own canvas."
              >
                <DropdownMenuItem
                  disabled={!hasSiblingDrafts || isPromotePending}
                  onClick={promoteActiveDraft}
                  data-testid="draft-menu-promote"
                >
                  <FrameIcon /> Promote to new canvas
                </DropdownMenuItem>
              </MaybeDisabledTooltip>
              <MaybeDisabledTooltip
                isDisabled={!hasSiblingDrafts}
                message="A canvas needs at least one draft."
              >
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!hasSiblingDrafts}
                  onClick={() => {
                    // Defer past the menu's close/focus-return, same as rename.
                    setTimeout(() => setIsDeleteDialogOpen(true), 0);
                  }}
                  data-testid="draft-menu-delete"
                >
                  <Trash2Icon /> Delete draft
                </DropdownMenuItem>
              </MaybeDisabledTooltip>
            </TooltipProvider>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={isCreatePending} onClick={createDraft}>
              <PlusIcon /> New draft
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next draft"
        disabled={nextDraft === null}
        className="disabled:text-muted-foreground disabled:opacity-30"
        onClick={() => nextDraft !== null && onActivateDraft(nextDraft._id)}
        data-testid="draft-selector-next"
      >
        <ChevronRightIcon />
      </Button>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="max-w-sm" data-testid="draft-delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete this draft?</DialogTitle>
            <DialogDescription>
              “{activeDraft?.name ?? "This draft"}” and its entire edit history will be
              permanently deleted. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={isDeletePending}
              onClick={confirmDeleteActiveDraft}
              data-testid="draft-delete-confirm"
            >
              Delete draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Wraps a disabled menu item in a tooltip explaining WHY it is disabled
 * (disabled items are pointer-events-none, so the wrapping span catches the
 * hover). Enabled items render bare — no tooltip noise on the happy path.
 */
function MaybeDisabledTooltip({
  isDisabled,
  message,
  children,
}: {
  isDisabled: boolean;
  message: string;
  children: React.ReactNode;
}) {
  if (!isDisabled) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{children}</TooltipTrigger>
      <TooltipContent side="right">{message}</TooltipContent>
    </Tooltip>
  );
}

/** One draft row in the menu: name + read-only dual-naming/lineage secondary line. */
function DraftMenuEntry({
  draft,
  isActive,
  forkedFromName,
  onActivate,
}: {
  draft: DraftListEntry;
  isActive: boolean;
  forkedFromName: string | null;
  onActivate: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onActivate}
      data-testid="draft-menu-entry"
      data-active={isActive}
      data-document-id={draft._id}
    >
      <CheckIcon className={cn("size-3.5", !isActive && "invisible")} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{draft.name}</span>
        {(draft.agentName !== undefined || forkedFromName !== null) && (
          <span className="truncate text-[10px] text-muted-foreground">
            {draft.agentName !== undefined && <em>{draft.agentName}</em>}
            {draft.agentName !== undefined && forkedFromName !== null && " · "}
            {forkedFromName !== null && <>Forked from {forkedFromName}</>}
          </span>
        )}
      </div>
    </DropdownMenuItem>
  );
}
