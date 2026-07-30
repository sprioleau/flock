"use client";

import { useEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import {
  ArrowDownIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  SquareTerminalIcon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { useAppSettings } from "../demo/app-settings";
import {
  buildHistoryGroups,
  formatRelativeTime,
  type HistoryGroup,
  type OperationEntry,
} from "../history/history-grouping";
import {
  deriveOpAuthor,
  describeEntryHuman,
  type DescribeEntryContext,
} from "../history/op-author";
import { BeforeAfterChip } from "../history/BeforeAfterChip";
import { describeValueTransition } from "../history/value-transition";

/** Rows fetched per "load earlier" step (and the initial window). */
const INSPECTOR_PAGE_SIZE = 100;

/**
 * Size of the reactive head window (getOperations clamps to 200). Unlike the
 * History panel, the inspector RE-ANCHORS when the window saturates (see the
 * effect below), so it keeps streaming through arbitrarily long agent storms.
 */
const HEAD_WINDOW_LIMIT = 200;

/** Scrolling up further than this from the bottom pauses auto-follow. */
const FOLLOW_PAUSE_THRESHOLD_PX = 48;

/**
 * The "Op log" toolbar toggle + bottom console: the document's operation log,
 * live and technical. Oldest at top, newest at bottom, auto-following like a
 * terminal; scrolling up pauses the follow and new rows accrue behind a
 * "resume" pill. Rows are author-colored (agent / demo agent / suggestion /
 * ghost / per-user hues — the same identity hash presence uses) and clustered
 * by batchId; expanding a row reveals the raw op + inverse JSON. Read-only:
 * one reactive `getOperations` subscription, zero mutations.
 */
export function OpInspector() {
  const { isOpInspectorEnabled } = useAppSettings();
  const convexClient = useConvex();
  const documentId = useEditorStore((state) => state.documentId);
  const authorId = useEditorStore((state) => state.authorId);
  const serverHeadVersion = useEditorStore((state) => state.serverHeadVersion);

  const [isOpen, setIsOpen] = useState(false);
  /** Lower bound of the reactive head window (re-anchored on saturation). */
  const [anchorSinceVersion, setAnchorSinceVersion] = useState<number | null>(null);
  /** Accumulated rows below the anchor (ascending): paged-back + re-anchored. */
  const [olderOperations, setOlderOperations] = useState<OperationEntry[]>([]);
  /** The version cursor "load earlier" pages back from. */
  const [oldestSinceVersion, setOldestSinceVersion] = useState(0);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastSeenVersionRef = useRef(0);
  /** Newest version already moved out of the head window (re-anchor guard). */
  const lastReanchoredVersionRef = useRef(0);

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
      const anchor = Math.max(0, serverHeadVersion - INSPECTOR_PAGE_SIZE);
      setAnchorSinceVersion(anchor);
      setOlderOperations([]);
      setOldestSinceVersion(anchor);
      setIsFollowing(true);
      setUnseenCount(0);
      lastSeenVersionRef.current = 0;
      lastReanchoredVersionRef.current = 0;
      setNowMs(Date.now());
    }
  };

  // The live feed: fixed lower bound, reactive — new ops stream in.
  const headPage = useQuery(
    api.documents.getOperations,
    isOpen && documentId !== null && anchorSinceVersion !== null
      ? { documentId, sinceVersion: anchorSinceVersion, limit: HEAD_WINDOW_LIMIT }
      : "skip",
  );

  // Saturation re-anchor: when the head window fills its 200-row clamp, move
  // its rows into the accumulated list and re-anchor at the newest version,
  // so a long-running storm keeps streaming instead of silently capping.
  useEffect(() => {
    if (headPage === undefined || headPage.operations.length < HEAD_WINDOW_LIMIT) {
      return;
    }
    if (headPage.nextSinceVersion <= lastReanchoredVersionRef.current) {
      return;
    }
    lastReanchoredVersionRef.current = headPage.nextSinceVersion;
    setOlderOperations((current) => [...current, ...headPage.operations]);
    setAnchorSinceVersion(headPage.nextSinceVersion);
  }, [headPage]);

  const hasOlder = oldestSinceVersion > 0;

  const loadOlder = async (): Promise<void> => {
    if (documentId === null || !hasOlder || isLoadingOlder) {
      return;
    }
    setIsLoadingOlder(true);
    try {
      const nextSinceVersion = Math.max(0, oldestSinceVersion - INSPECTOR_PAGE_SIZE);
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

  const isListLoading = headPage === undefined && olderOperations.length === 0;
  const operationsAscending = [...olderOperations, ...(headPage?.operations ?? [])];
  const latestVersion =
    operationsAscending.length > 0
      ? operationsAscending[operationsAscending.length - 1]!.version
      : 0;

  // Console follow: when a newer version lands, stick to the bottom if
  // following, otherwise count it behind the resume pill. Keyed on the
  // newest VERSION (not row count) so "load earlier" prepends never scroll.
  useEffect(() => {
    if (!isOpen || latestVersion <= lastSeenVersionRef.current) {
      return;
    }
    const previousSeenVersion = lastSeenVersionRef.current;
    lastSeenVersionRef.current = latestVersion;
    if (isFollowing) {
      const container = scrollContainerRef.current;
      if (container !== null) {
        container.scrollTop = container.scrollHeight;
      }
    } else if (previousSeenVersion > 0) {
      setUnseenCount((count) => count + (latestVersion - previousSeenVersion));
    }
  }, [isOpen, latestVersion, isFollowing]);

  const handleScroll = (): void => {
    const container = scrollContainerRef.current;
    if (container === null) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom > FOLLOW_PAUSE_THRESHOLD_PX) {
      setIsFollowing(false);
    } else {
      setIsFollowing(true);
      setUnseenCount(0);
    }
  };

  const resumeFollowing = (): void => {
    const container = scrollContainerRef.current;
    if (container !== null) {
      container.scrollTop = container.scrollHeight;
    }
    setIsFollowing(true);
    setUnseenCount(0);
  };

  // buildHistoryGroups returns newest-first; the console reads oldest → newest.
  const groupsAscending = buildHistoryGroups(operationsAscending)
    .reverse()
    .map((group) => ({ ...group, entries: [...group.entries].reverse() }));
  // Version lookup so undo/redo row labels can name the change they reversed.
  const entryByVersion = new Map(operationsAscending.map((entry) => [entry.version, entry]));
  const describeContext: DescribeEntryContext = {
    getEntryByVersion: (version) => entryByVersion.get(version),
  };

  // Hidden unless enabled via the settings FAB (after the hooks above, per
  // the rules of hooks). Unmounting also closes an open console on disable.
  if (!isOpInspectorEnabled) {
    return null;
  }

  return (
    // disablePointerDismissal: a console should keep streaming while the
    // user edits the canvas — close is the header chevron or Escape.
    <Sheet open={isOpen} onOpenChange={handleOpenChange} modal={false} disablePointerDismissal>
      <SheetTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Op inspector" />}
        data-testid="inspector-open-button"
      >
        <SquareTerminalIcon />
      </SheetTrigger>
      <SheetContent
        side="bottom"
        hasOverlay={false}
        showCloseButton={false}
        className="z-40 h-[320px] gap-0 p-0"
        data-testid="op-inspector-panel"
      >
        {/* Content is centered in a max-w column so it stays readable in the
            gap between the (z-50) side sheets when those are open too. */}
        <div className="border-b px-3 py-1.5">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
          <SquareTerminalIcon className="size-3.5 text-muted-foreground" />
          <SheetTitle className="font-mono text-xs font-medium">op log</SheetTitle>
          <SheetDescription className="sr-only">
            Live operation log for this document: every edit as an op with its
            stored inverse.
          </SheetDescription>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium",
              isFollowing
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : "border-border bg-muted text-muted-foreground",
            )}
            data-testid="inspector-follow-state"
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                isFollowing ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
            />
            {isFollowing ? "live" : "paused"}
          </span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
            head v{serverHeadVersion}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close op inspector"
            onClick={() => handleOpenChange(false)}
          >
            <ChevronDownIcon />
          </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto px-2 py-1.5 font-mono text-xs"
            data-testid="inspector-list"
          >
            {isListLoading ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
              </div>
            ) : (
              <div className="mx-auto w-full max-w-3xl">
                {hasOlder && (
                  <div className="flex justify-center py-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void loadOlder()}
                      disabled={isLoadingOlder}
                      data-testid="inspector-load-older"
                    >
                      {isLoadingOlder && <Loader2Icon className="size-3.5 animate-spin" />}
                      Load earlier ops
                    </Button>
                  </div>
                )}
                {!hasOlder && (
                  <p className="px-2 py-1 text-[10px] text-muted-foreground">
                    v0 · document created
                  </p>
                )}
                {groupsAscending.map((group) => (
                  <InspectorGroup
                    key={group.latestVersion}
                    group={group}
                    describeContext={describeContext}
                    viewerAuthorId={authorId}
                    nowMs={nowMs}
                  />
                ))}
                {groupsAscending.length === 0 && (
                  <p className="px-2 py-2 text-muted-foreground">
                    No ops yet — edits will stream in here as they land.
                  </p>
                )}
              </div>
            )}
          </div>

          {!isFollowing && (
            <div className="absolute inset-x-0 bottom-2 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 rounded-full bg-background/95 px-2.5 text-[10px] shadow-md"
                onClick={resumeFollowing}
                data-testid="inspector-resume-follow"
              >
                <ArrowDownIcon className="size-3" />
                {unseenCount > 0
                  ? `${unseenCount} new op${unseenCount === 1 ? "" : "s"} — resume`
                  : "Resume following"}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * One batch cluster (or a single unbatched op): batched groups get a colored
 * left rail + a tiny header naming the batch kind and row count.
 */
function InspectorGroup({
  group,
  describeContext,
  viewerAuthorId,
  nowMs,
}: {
  group: HistoryGroup;
  describeContext: DescribeEntryContext;
  viewerAuthorId: string | null;
  nowMs: number;
}) {
  const isBatch = group.entries.length > 1;
  const oldestEntry = group.entries[0]!;
  const groupAuthor = deriveOpAuthor({
    author: oldestEntry.author,
    authorId: oldestEntry.authorId,
    viewerAuthorId,
  });

  if (!isBatch) {
    return (
      <InspectorRow
        entry={oldestEntry}
        describeContext={describeContext}
        viewerAuthorId={viewerAuthorId}
        nowMs={nowMs}
      />
    );
  }

  return (
    <div
      className="my-0.5 rounded-sm border-l-2 bg-muted/40 pl-1"
      style={{ borderLeftColor: groupAuthor.color }}
      data-testid="inspector-batch-group"
    >
      <p className="px-1.5 pt-1 text-[10px] text-muted-foreground">
        <span className="font-medium" style={{ color: groupAuthor.color }}>
          {groupAuthor.label}
        </span>{" "}
        batch · {group.entries.length} ops
      </p>
      {group.entries.map((entry) => (
        <InspectorRow
          key={entry.version}
          entry={entry}
          describeContext={describeContext}
          viewerAuthorId={viewerAuthorId}
          nowMs={nowMs}
        />
      ))}
    </div>
  );
}

/** One op row: human label collapsed, raw op + inverse JSON when expanded. */
function InspectorRow({
  entry,
  describeContext,
  viewerAuthorId,
  nowMs,
}: {
  entry: OperationEntry;
  describeContext: DescribeEntryContext;
  viewerAuthorId: string | null;
  nowMs: number;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const author = deriveOpAuthor({
    author: entry.author,
    authorId: entry.authorId,
    viewerAuthorId,
  });
  const transition = describeValueTransition({ op: entry.op, inverse: entry.inverse });

  return (
    <div data-testid="inspector-row" data-inspector-version={entry.version}>
      <button
        type="button"
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-left hover:bg-muted"
        aria-expanded={isExpanded}
      >
        {isExpanded ? (
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: author.color }}
        />
        <span
          className="shrink-0 truncate font-medium"
          style={{ color: author.color }}
        >
          {author.label}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            entry.isUndone === true && "text-muted-foreground line-through",
          )}
        >
          {describeEntryHuman(entry, describeContext)}
        </span>
        {transition !== null && <BeforeAfterChip transition={transition} />}
        <span className="shrink-0 tabular-nums text-muted-foreground">
          v{entry.version}
        </span>
        <span className="w-14 shrink-0 text-right text-[10px] text-muted-foreground">
          {formatRelativeTime(entry.createdAtMs, nowMs)}
        </span>
      </button>
      {isExpanded && (
        <div
          className="mx-1.5 mb-1 grid grid-cols-1 gap-1.5 rounded-sm border bg-muted/30 p-2 md:grid-cols-2"
          data-testid="inspector-row-detail"
        >
          <div className="min-w-0">
            <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">op</p>
            <pre className="max-h-48 overflow-auto rounded-sm bg-background p-1.5 text-[10px] leading-snug">
              {JSON.stringify(entry.op, null, 2)}
            </pre>
          </div>
          <div className="min-w-0">
            <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">inverse</p>
            <pre className="max-h-48 overflow-auto rounded-sm bg-background p-1.5 text-[10px] leading-snug">
              {JSON.stringify(entry.inverse, null, 2)}
            </pre>
          </div>
          <p className="text-[10px] text-muted-foreground md:col-span-2">
            authorId {entry.authorId} · caller {entry.caller} · kind {entry.kind}
            {entry.batchId !== undefined ? ` · batch ${entry.batchId}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
