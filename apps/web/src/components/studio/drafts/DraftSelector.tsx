"use client";

import { useState } from "react";
import { useConvex } from "convex/react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  LinkIcon,
  PencilLineIcon,
  PlusIcon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

  if (drafts === undefined || drafts.length === 0) {
    return null;
  }

  const activeDraft = activeIndex >= 0 ? drafts[activeIndex]! : null;
  const previousDraft = activeIndex > 0 ? drafts[activeIndex - 1]! : null;
  const nextDraft =
    activeIndex >= 0 && activeIndex < drafts.length - 1 ? drafts[activeIndex + 1]! : null;

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
              <LinkIcon /> Copy link
            </DropdownMenuItem>
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
        onClick={() => nextDraft !== null && onActivateDraft(nextDraft._id)}
        data-testid="draft-selector-next"
      >
        <ChevronRightIcon />
      </Button>
    </div>
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
