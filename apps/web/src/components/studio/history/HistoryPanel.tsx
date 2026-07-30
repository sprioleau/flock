"use client";

import { useEffect, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { ClockIcon, Loader2Icon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import {
  buildHistoryGroups,
  describeGroup,
  formatRelativeTime,
  getGroupAuthorLabel,
  type HistoryGroup,
  type OperationEntry,
} from "./history-grouping";
import { describeEntryHuman, type DescribeEntryContext } from "./op-author";
import { VersionPreview } from "./VersionPreview";

/** Rows fetched per "load older" step (and the size of the initial window). */
const HISTORY_PAGE_SIZE = 50;

/**
 * Headroom the reactive head window keeps above the page size, so edits made
 * while the panel is open keep streaming into the SAME query (its
 * sinceVersion anchor is fixed at open time; getOperations clamps limit to
 * 200).
 */
const HEAD_WINDOW_LIMIT = 200;

/**
 * The "History" toolbar button + right-side drawer: the document's version
 * log, newest first, grouped by batchId (agent turns / reverts / rollbacks
 * collapse into one row). Non-modal on purpose — the canvas and chat stay
 * interactive, and because the newest window is a live `useQuery`, an edit
 * made while the drawer is open appears at the top in real time.
 *
 * Paging: the reactive head window is anchored at (head - page) when the
 * drawer opens; older rows are pulled on demand with one-off queries using
 * the version cursor (`sinceVersion`), exploiting that versions are dense.
 * Clicking a row swaps the drawer body to a read-only preview of that
 * version (VersionPreview) with the restore affordance.
 */
export function HistoryPanel() {
  const convexClient = useConvex();
  const documentId = useEditorStore((state) => state.documentId);
  const authorId = useEditorStore((state) => state.authorId);
  const serverHeadVersion = useEditorStore((state) => state.serverHeadVersion);

  const [isOpen, setIsOpen] = useState(false);
  /** Fixed lower bound of the reactive head window (set when the drawer opens). */
  const [anchorSinceVersion, setAnchorSinceVersion] = useState<number | null>(null);
  /** Accumulated older rows (ascending), fetched imperatively below the anchor. */
  const [olderOperations, setOlderOperations] = useState<OperationEntry[]>([]);
  /** The version cursor the next "load older" pages back from. */
  const [oldestSinceVersion, setOldestSinceVersion] = useState(0);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // Keep relative timestamps fresh while the drawer sits open.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const timerId = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timerId);
  }, [isOpen]);

  const handleOpenChange = (nextIsOpen: boolean): void => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      const anchor = Math.max(0, serverHeadVersion - HISTORY_PAGE_SIZE);
      setAnchorSinceVersion(anchor);
      setOlderOperations([]);
      setOldestSinceVersion(anchor);
      setSelectedVersion(null);
      setNowMs(Date.now());
    }
  };

  // The live newest-first feed: fixed anchor, reactive — new ops stream in.
  const headPage = useQuery(
    api.documents.getOperations,
    isOpen && documentId !== null && anchorSinceVersion !== null
      ? { documentId, sinceVersion: anchorSinceVersion, limit: HEAD_WINDOW_LIMIT }
      : "skip",
  );

  const hasOlder = oldestSinceVersion > 0;

  const loadOlder = async (): Promise<void> => {
    if (documentId === null || !hasOlder || isLoadingOlder) {
      return;
    }
    setIsLoadingOlder(true);
    try {
      const nextSinceVersion = Math.max(0, oldestSinceVersion - HISTORY_PAGE_SIZE);
      // Versions are dense, so this exact limit returns precisely the rows
      // (nextSinceVersion, oldestSinceVersion] — no overlap with what's loaded.
      const page = await convexClient.query(api.documents.getOperations, {
        documentId,
        sinceVersion: nextSinceVersion,
        limit: oldestSinceVersion - nextSinceVersion,
      });
      setOlderOperations((current) => [...page.operations, ...current]);
      setOldestSinceVersion(nextSinceVersion);
    } finally {
      setIsLoadingOlder(false);
    }
  };

  const isListLoading = headPage === undefined;
  const operationsAscending = [...olderOperations, ...(headPage?.operations ?? [])];
  const groups = buildHistoryGroups(operationsAscending);
  // Version lookup so undo/redo rows can name the change they reversed.
  const entryByVersion = new Map(operationsAscending.map((entry) => [entry.version, entry]));
  const describeContext: DescribeEntryContext = {
    getEntryByVersion: (version) => entryByVersion.get(version),
  };

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange} modal={false}>
      <SheetTrigger
        render={<Button variant="outline" size="sm" className="gap-1.5" />}
        data-testid="history-open-button"
      >
        <ClockIcon className="size-4" />
        History
      </SheetTrigger>
      <SheetContent
        side="right"
        hasOverlay={false}
        className="w-[420px] max-w-[calc(100vw-2rem)]"
        data-testid="history-panel"
      >
        <SheetHeader>
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription>
            Every change is a version. Click one to preview or restore it.
          </SheetDescription>
        </SheetHeader>

        {documentId === null ? null : selectedVersion !== null ? (
          <VersionPreview
            documentId={documentId}
            version={selectedVersion}
            onBack={() => setSelectedVersion(null)}
          />
        ) : isListLoading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" />
          </div>
        ) : (
          <HistoryList
            groups={groups}
            describeContext={describeContext}
            viewerAuthorId={authorId}
            serverHeadVersion={serverHeadVersion}
            nowMs={nowMs}
            hasOlder={hasOlder}
            isLoadingOlder={isLoadingOlder}
            onLoadOlder={() => void loadOlder()}
            onSelectVersion={setSelectedVersion}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function AuthorBadge({ label }: { label: "Agent" | "You" | "User" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium",
        label === "Agent"
          ? "border-violet-300 bg-violet-50 text-violet-700"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function HistoryGroupRow({
  group,
  describeContext,
  viewerAuthorId,
  isCurrentHead,
  nowMs,
  onSelect,
}: {
  group: HistoryGroup;
  describeContext: DescribeEntryContext;
  viewerAuthorId: string | null;
  isCurrentHead: boolean;
  nowMs: number;
  onSelect: () => void;
}) {
  const newestEntry = group.entries[0]!;
  const authorLabel = getGroupAuthorLabel({ group, viewerAuthorId });
  const isBatch = group.entries.length > 1;
  const isFullyUndone = group.entries.every((entry) => entry.isUndone === true);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
        data-testid="history-row"
        data-history-version={group.latestVersion}
      >
        <span className="flex items-center gap-1.5">
          <AuthorBadge label={authorLabel} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              isFullyUndone && !isCurrentHead && "text-muted-foreground line-through",
            )}
          >
            {describeGroup({ group, context: describeContext })}
          </span>
          {isCurrentHead && (
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
              Current
            </span>
          )}
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            v{group.latestVersion}
          </span>
        </span>
        <span className="flex items-baseline gap-1.5 pl-0.5">
          {isBatch && (
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
              {group.entries
                .slice(0, 3)
                .map((entry) => describeEntryHuman(entry, describeContext))
                .join(", ")}
              {group.entries.length > 3 ? ", …" : ""}
            </span>
          )}
          <span
            className={cn(
              "text-[10px] text-muted-foreground",
              !isBatch && "min-w-0 flex-1",
            )}
          >
            {formatRelativeTime(newestEntry.createdAtMs, nowMs)}
          </span>
        </span>
      </button>
    </li>
  );
}

function HistoryList({
  groups,
  describeContext,
  viewerAuthorId,
  serverHeadVersion,
  nowMs,
  hasOlder,
  isLoadingOlder,
  onLoadOlder,
  onSelectVersion,
}: {
  groups: HistoryGroup[];
  describeContext: DescribeEntryContext;
  viewerAuthorId: string | null;
  serverHeadVersion: number;
  nowMs: number;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  onSelectVersion: (version: number) => void;
}) {
  if (groups.length === 0 && serverHeadVersion === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <ClockIcon className="size-6 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">
          No edits yet — changes you and the agent make will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="history-list">
      <ul className="flex flex-col gap-0.5">
        {groups.map((group) => (
          <HistoryGroupRow
            key={group.latestVersion}
            group={group}
            describeContext={describeContext}
            viewerAuthorId={viewerAuthorId}
            isCurrentHead={group.latestVersion === serverHeadVersion}
            nowMs={nowMs}
            onSelect={() => onSelectVersion(group.latestVersion)}
          />
        ))}
        {!hasOlder && (
          <li>
            <button
              type="button"
              onClick={() => onSelectVersion(0)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              data-testid="history-row"
              data-history-version={0}
            >
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                Document created
              </span>
              {serverHeadVersion === 0 && (
                <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                  Current
                </span>
              )}
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                v0
              </span>
            </button>
          </li>
        )}
      </ul>
      {hasOlder && (
        <div className="flex justify-center py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadOlder}
            disabled={isLoadingOlder}
            data-testid="history-load-older"
          >
            {isLoadingOlder && <Loader2Icon className="size-4 animate-spin" />}
            Load older changes
          </Button>
        </div>
      )}
    </div>
  );
}
