"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ReadOnlyEmailPreview } from "../studio/history/ReadOnlyEmailPreview";
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

/*
  One email's card on the dashboard.

  The whole card is the link, with the actions menu layered on top — clicking
  anywhere in the body opens the work, which is what someone scanning a grid
  of their own drafts is nearly always trying to do. The menu is a real
  sibling of the link rather than a nested button, because a button inside an
  anchor is invalid HTML and browsers resolve the ambiguity inconsistently.

  `nowMs` is passed in rather than read here so every card on a render shares
  one clock (and so the page has a single place to decide how fresh the
  timestamps are).
*/
export function CanvasCard({
  entry,
  nowMs,
  onRename,
  onDelete,
  sessionId,
}: {
  entry: CanvasCardEntry;
  nowMs: number;
  onRename: (entry: CanvasCardEntry) => void;
  onDelete: (entry: CanvasCardEntry) => void;
  sessionId: string;
}) {
  const href = buildCanvasHref({
    canvasId: entry.canvasId,
    entryDocumentId: entry.entryDocumentId,
  });
  const hiddenDraftLabel = formatHiddenDraftCount({
    draftCount: entry.draftCount,
    shownCount: entry.draftPreviews.length,
  });
  const thumbnailDocuments = useQuery(api.canvases.getCanvasThumbnailDocuments, {
    canvasId: entry.canvasId,
    sessionId,
  });

  return (
    <div
      className="group relative flex h-[26rem] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors focus-within:border-ring hover:border-ring/60"
      data-testid="canvas-card"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl p-4">
        {/*
          pr-8 keeps a long title from sliding under the actions menu.
        */}
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
          Every draft is rendered through the same read-only block views used
          by Studio. The fixed viewport keeps card geometry stable even when
          a canvas gains more drafts or longer content.
        */}
        <CanvasThumbnail
          documents={thumbnailDocuments}
          draftCount={entry.draftCount}
        />
        <p className="sr-only" data-testid="canvas-card-draft-summary">
          {entry.draftPreviews.map((draft) => draft.name).join(", ")}
          {hiddenDraftLabel !== null ? ` ${hiddenDraftLabel}` : ""}
        </p>
      </div>

      <Link
        href={href}
        aria-label={`Open ${entry.title}`}
        className="absolute inset-0 z-10 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        data-testid="canvas-card-link"
      >
        <span className="sr-only">Open {entry.title}</span>
      </Link>

      <div className="absolute top-3 right-3 z-20">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${entry.title}`}
                /*
                  Hidden until hover/focus so a grid of cards stays calm, but
                  never hidden from keyboards or touch (no hover there):
                  focus-visible and the open state both force it back.
                */
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

type ThumbnailDocuments = ReadonlyArray<{
  documentId: Id<"documents">;
  name: string;
  doc: Parameters<typeof ReadOnlyEmailPreview>[0]["doc"];
}>;

export function CanvasThumbnail({
  documents,
  draftCount,
}: {
  documents: ThumbnailDocuments | undefined;
  draftCount: number;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center gap-2 overflow-hidden rounded-lg border border-border/70 bg-muted/20 p-3"
      aria-hidden="true"
      aria-busy={documents === undefined}
      inert
      data-testid="canvas-card-thumbnail"
    >
      {documents === undefined ? (
        <span className="sr-only">Loading {draftCount} draft previews</span>
      ) : documents.length === 0 ? (
        <span className="self-center text-xs text-muted-foreground">No drafts yet.</span>
      ) : (
        documents.map((document) => (
          <div
            key={document.documentId}
            className="h-full min-w-0 flex-1 overflow-hidden rounded-sm bg-background shadow-sm"
            data-draft-id={document.documentId}
            data-draft-name={document.name}
          >
            <ThumbnailEmailPreview doc={document.doc} />
          </div>
        ))
      )}
    </div>
  );
}

function ThumbnailEmailPreview({
  doc,
}: {
  doc: Parameters<typeof ReadOnlyEmailPreview>[0]["doc"];
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    function measure(element: HTMLDivElement): void {
      const preview = element.querySelector<HTMLElement>('[data-testid="history-version-preview"]');
      if (preview === null || preview.scrollHeight === 0 || element.clientHeight === 0) {
        return;
      }
      setScale(Math.min(1, element.clientHeight / preview.scrollHeight));
    }
    measure(viewport);
    const observer = new ResizeObserver(() => measure(viewport));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={viewportRef} className="flex h-full justify-center overflow-hidden">
      <div
        className="h-fit w-full origin-top"
        style={{ transform: `scale(${scale})` }}
      >
        <ReadOnlyEmailPreview doc={doc} />
      </div>
    </div>
  );
}
