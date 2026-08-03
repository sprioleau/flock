"use client";

import type { Id } from "@convex/_generated/dataModel";
import { FileTextIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildCanvasHref,
  formatDraftCount,
  formatHiddenDraftCount,
  formatRelativeTime,
} from "./canvas-summary";

export interface CanvasCardEntry {
  canvasId: Id<"canvases">;
  title: string;
  isTitleDerived: boolean;
  draftCount: number;
  entryDocumentId: Id<"documents"> | null;
  draftPreviews: Array<{
    documentId: Id<"documents">;
    name: string;
    agentName?: string;
  }>;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * One email's card on the dashboard.
 *
 * The whole card is the link, with the actions menu layered on top — clicking
 * anywhere in the body opens the work, which is what someone scanning a grid
 * of their own drafts is nearly always trying to do. The menu is a real
 * sibling of the link rather than a nested button, because a button inside an
 * anchor is invalid HTML and browsers resolve the ambiguity inconsistently.
 *
 * `nowMs` is passed in rather than read here so every card on a render shares
 * one clock (and so the page has a single place to decide how fresh the
 * timestamps are).
 */
export function CanvasCard({
  entry,
  nowMs,
  onRename,
  onDelete,
}: {
  entry: CanvasCardEntry;
  nowMs: number;
  onRename: (entry: CanvasCardEntry) => void;
  onDelete: (entry: CanvasCardEntry) => void;
}) {
  const href = buildCanvasHref({
    canvasId: entry.canvasId,
    entryDocumentId: entry.entryDocumentId,
  });
  const hiddenDraftLabel = formatHiddenDraftCount({
    draftCount: entry.draftCount,
    shownCount: entry.draftPreviews.length,
  });

  return (
    <div
      className="group relative flex flex-col rounded-xl border border-border bg-card transition-colors focus-within:border-ring hover:border-ring/60"
      data-testid="canvas-card"
    >
      <Link
        href={href}
        className="flex flex-1 flex-col gap-3 rounded-xl p-4 outline-none"
        data-testid="canvas-card-link"
      >
        {/* pr-8 keeps a long title from sliding under the actions menu. */}
        <div className="flex flex-col gap-1 pr-8">
          <h2
            className="truncate text-sm font-semibold text-foreground"
            title={entry.title}
            data-testid="canvas-card-title"
          >
            {entry.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {formatDraftCount(entry.draftCount)}
            {" · "}
            {formatRelativeTime({ timestampMs: entry.updatedAtMs, nowMs })}
          </p>
        </div>

        {/*
         * The drafts inside, named. Not thumbnails — rendering a real preview
         * of an email needs the whole canvas pipeline, and a fake grey
         * rectangle would tell the reader strictly less than the name they
         * chose. Names are what people search by when they come back.
         */}
        {entry.draftPreviews.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="canvas-card-drafts">
            {entry.draftPreviews.map((draft) => (
              <li
                key={draft.documentId}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <FileTextIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate" title={draft.agentName ?? draft.name}>
                  {draft.name}
                </span>
              </li>
            ))}
            {hiddenDraftLabel !== null ? (
              <li className="pl-4.5 text-xs text-muted-foreground/80">{hiddenDraftLabel}</li>
            ) : null}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No drafts yet.</p>
        )}
      </Link>

      <div className="absolute top-3 right-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${entry.title}`}
                // Hidden until hover/focus so a grid of cards stays calm, but
                // never hidden from keyboards or touch (no hover there):
                // focus-visible and the open state both force it back.
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                data-testid="canvas-card-menu-trigger"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="w-44">
            <DropdownMenuItem onClick={() => onRename(entry)}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(entry)}>
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
