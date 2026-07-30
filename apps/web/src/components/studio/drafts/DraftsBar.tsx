"use client";

import { useState } from "react";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, CopyIcon, LinkIcon, PencilLineIcon, PlusIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getOrCreateSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * §10.2 drafts-on-a-canvas v1 — the Figma-pages-style bar under the studio
 * toolbar: one chip per draft on the current canvas (ordered by fractional
 * `orderIndex`), fed by the reactive `listDocumentsByCanvas` subscription so
 * renames/duplicates/new drafts from ANY tab or the agent appear live.
 *
 * Dual naming (§10.2 addendum): the chip shows the USER-FACING `name`
 * (rename = double-click or menu → writes `documents.name`); the
 * agent-authored `agentName` is surfaced read-only in the chip's tooltip and
 * is never editable here. Fork lineage ("Forked from …") rides the same
 * tooltip off `forkedFromDocumentId`.
 *
 * Switching is delegated to the shell via `onSwitchDraft` (shallow ?doc=
 * pushState — each draft stays an independently shareable capability URL).
 */

type DraftListEntry = FunctionReturnType<typeof api.documents.listDocumentsByCanvas>[number];

/** Smallest unused "Draft N" so new-draft names stay unique per canvas. */
function computeNextDraftName(drafts: DraftListEntry[]): string {
  const takenNames = new Set(drafts.map((draft) => draft.name));
  for (let candidate = drafts.length + 1; ; candidate++) {
    const name = `Draft ${candidate}`;
    if (!takenNames.has(name)) {
      return name;
    }
  }
}

export function DraftsBar({
  canvasId,
  activeDocumentKey,
  onSwitchDraft,
}: {
  canvasId: Id<"canvases">;
  /** The ?doc= value currently in the URL (highlight tracks the URL for instant feedback). */
  activeDocumentKey: string | null;
  onSwitchDraft: (documentId: Id<"documents">) => void;
}) {
  const convexClient = useConvex();
  const drafts = useQuery(api.documents.listDocumentsByCanvas, { canvasId });
  const [isCreatePending, setIsCreatePending] = useState(false);

  if (drafts === undefined) {
    // Subscription warming up — keep the bar's slot so the canvas doesn't jump.
    return <div className="h-9 shrink-0 border-b bg-background" aria-hidden />;
  }

  const draftNamesById = new Map(drafts.map((draft) => [draft._id, draft.name]));

  const createDraft = (): void => {
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
        onSwitchDraft(documentId);
      })
      .catch((error: unknown) => {
        console.error("createDocument (new draft) failed", error);
      })
      .finally(() => {
        setIsCreatePending(false);
      });
  };

  const duplicateDraft = (documentId: Id<"documents">): void => {
    convexClient
      .mutation(api.documents.duplicateDocument, { documentId })
      .then((newDocumentId) => {
        if (newDocumentId !== null) {
          onSwitchDraft(newDocumentId);
        }
      })
      .catch((error: unknown) => {
        console.error("duplicateDocument failed", error);
      });
  };

  return (
    <TooltipProvider>
      <div
        className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background px-2"
        role="tablist"
        aria-label="Drafts on this canvas"
        data-testid="drafts-bar"
      >
        {drafts.map((draft) => (
          <DraftTab
            key={draft._id}
            draft={draft}
            isActive={draft._id === activeDocumentKey}
            forkedFromName={
              draft.forkedFromDocumentId !== undefined
                ? (draftNamesById.get(draft.forkedFromDocumentId) ?? "a removed draft")
                : null
            }
            onSwitch={() => onSwitchDraft(draft._id)}
            onDuplicate={() => duplicateDraft(draft._id)}
          />
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label="New draft"
          disabled={isCreatePending}
          onClick={createDraft}
          data-testid="drafts-bar-new"
        >
          <PlusIcon />
        </Button>
      </div>
    </TooltipProvider>
  );
}

/**
 * One draft chip: click switches, double-click renames inline, the chevron
 * menu offers rename / duplicate / copy-link. The tooltip carries the
 * read-only secondary identity: agentName + fork lineage.
 */
function DraftTab({
  draft,
  isActive,
  forkedFromName,
  onSwitch,
  onDuplicate,
}: {
  draft: DraftListEntry;
  isActive: boolean;
  forkedFromName: string | null;
  onSwitch: () => void;
  onDuplicate: () => void;
}) {
  const convexClient = useConvex();
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");

  const beginRename = (): void => {
    setNameInput(draft.name);
    setIsRenaming(true);
  };

  const commitRename = (): void => {
    setIsRenaming(false);
    const name = nameInput.trim();
    if (name.length === 0 || name === draft.name) {
      return;
    }
    convexClient
      .mutation(api.documents.renameDocument, { documentId: draft._id, name })
      .catch((error: unknown) => {
        console.error("renameDocument failed", error);
      });
  };

  const copyDraftLink = (): void => {
    const url = `${window.location.origin}/studio?doc=${draft._id}`;
    navigator.clipboard.writeText(url).catch((error: unknown) => {
      console.error("copy draft link failed", error);
    });
  };

  if (isRenaming) {
    return (
      <div
        className="flex h-7 shrink-0 items-center rounded-md bg-accent px-1"
        data-testid="draft-tab-rename"
      >
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
          className="h-5 rounded-sm bg-background px-1.5 text-xs outline-none ring-1 ring-ring"
          style={{ width: `${Math.max(nameInput.length + 2, 8)}ch` }}
          aria-label={`Rename ${draft.name}`}
        />
      </div>
    );
  }

  const hasTooltipDetails = draft.agentName !== undefined || forkedFromName !== null;

  const nameButton = (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onSwitch}
      onDoubleClick={beginRename}
      className="h-full max-w-48 truncate px-2.5 text-left"
      data-testid="draft-tab-name"
    >
      {draft.name}
    </button>
  );

  return (
    <div
      className={cn(
        "group flex h-7 shrink-0 items-center rounded-md text-xs font-medium transition-colors",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      data-testid="draft-tab"
      data-active={isActive}
      data-document-id={draft._id}
    >
      {hasTooltipDetails ? (
        <Tooltip>
          <TooltipTrigger render={nameButton} />
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-0.5 text-left">
              {draft.agentName !== undefined && (
                <span className="italic opacity-80">{draft.agentName}</span>
              )}
              {forkedFromName !== null && <span>Forked from {forkedFromName}</span>}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : (
        nameButton
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex h-full items-center rounded-r-md pr-1.5 pl-0.5 opacity-0 outline-none transition-opacity group-hover:opacity-100 data-popup-open:opacity-100",
            isActive && "opacity-100",
          )}
          aria-label={`Draft actions for ${draft.name}`}
          data-testid="draft-tab-menu"
        >
          <ChevronDownIcon className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40">
          <DropdownMenuItem
            onClick={() => {
              // Defer past the menu's close/focus-return so the rename input
              // keeps focus once it mounts.
              setTimeout(beginRename, 0);
            }}
          >
            <PencilLineIcon /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}>
            <CopyIcon /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onClick={copyDraftLink}>
            <LinkIcon /> Copy link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
