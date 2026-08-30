"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2Icon, PauseIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { useAppSettings } from "../demo/app-settings";
import { BeforeAfterChip } from "../history/BeforeAfterChip";
import { ReadOnlyEmailPreview } from "../history/ReadOnlyEmailPreview";
import { deriveOpAuthor, describeEntryHuman } from "../history/op-author";
import { describeValueTransition } from "../history/value-transition";
import { registerReplayPanelOpener } from "./replay-handoff";
import { useReplayTimeline } from "./use-replay-timeline";

/*
  Playback rate: versions advanced per second at 1x.
*/
const BASE_VERSIONS_PER_SECOND = 2;

type PlaybackSpeed = 1 | 2;

/*
  The "Replay" toolbar button + left-side drawer: the document's history
  played back as a movie. A scrubber (0..head) drives a reconstructed
  read-only preview via `getDocumentAtVersion` — the SAME path the History
  panel's VersionPreview uses — so the live canvas underneath is never
  touched and nothing here ever mutates.

  Scrubbing is intentionally un-debounced: every pointer move sets the
  playhead immediately and renders from a warmed cache (useReplayTimeline
  prefetches around the playhead; small histories are fully warmed at open).
  On a cache miss the previous frame holds — the version label still tracks
  the thumb — and the frame swaps in when the fetch lands.

  Playback walks version-by-version to head at ~2/sec (1x) or ~4/sec (2x),
  stalling (not skipping) on an unwarmed frame, and stops at head.
*/
export function ReplayPanel() {
  const { isTimeTravelReplayEnabled } = useAppSettings();
  const documentId = useEditorStore((state) => state.documentId);
  const authorId = useEditorStore((state) => state.authorId);
  const serverHeadVersion = useEditorStore((state) => state.serverHeadVersion);

  const [isOpen, setIsOpen] = useState(false);
  /*
    Scrubber upper bound, frozen when the panel opens.
  */
  const [headVersionAtOpen, setHeadVersionAtOpen] = useState(0);
  const [playheadVersion, setPlayheadVersion] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);

  const { getDocAtVersion, hasVersion, ensureVersion, prefetchAround, operationsByVersion } =
    useReplayTimeline({
      documentId,
      headVersion: headVersionAtOpen,
      isOpen,
    });

  const playheadVersionRef = useRef(playheadVersion);
  useEffect(() => {
    playheadVersionRef.current = playheadVersion;
  }, [playheadVersion]);

  const handleOpenChange = (nextIsOpen: boolean): void => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      setHeadVersionAtOpen(serverHeadVersion);
      setPlayheadVersion(serverHeadVersion);
      setIsPlaying(false);
      setPlaybackSpeed(1);
    } else {
      setIsPlaying(false);
    }
  };

  /*
    The far-away-surface entry point (replay-handoff.ts): the /demo narration
    opens this drawer for a visitor who has no idea the toolbar icon exists.
    Routed through handleOpenChange, not setIsOpen, so an externally opened
    panel gets the same freshly-frozen head version and reset playhead a
    clicked one does.
  */
  const handleOpenChangeRef = useRef(handleOpenChange);
  /*
    Synced in an effect, never during render (the React Compiler contract).
  */
  useEffect(() => {
    handleOpenChangeRef.current = handleOpenChange;
  });
  useEffect(() => registerReplayPanelOpener(() => handleOpenChangeRef.current(true)), []);

  /*
    Warm the prefetch window around the playhead on every move.
  */
  useEffect(() => {
    if (isOpen) {
      prefetchAround(playheadVersion);
    }
  }, [isOpen, playheadVersion, prefetchAround]);

  /*
    The playback clock: advance one version per tick, but only when the next
    frame is already cached — stall (and warm it) instead of skipping.
  */
  useEffect(() => {
    if (!isOpen || !isPlaying) {
      return;
    }
    const tickMs = 1000 / (BASE_VERSIONS_PER_SECOND * playbackSpeed);
    const timerId = setInterval(() => {
      const nextVersion = playheadVersionRef.current + 1;
      if (nextVersion > headVersionAtOpen) {
        setIsPlaying(false);
        return;
      }
      if (!hasVersion(nextVersion)) {
        ensureVersion(nextVersion);
        return;
      }
      setPlayheadVersion(nextVersion);
      if (nextVersion >= headVersionAtOpen) {
        setIsPlaying(false);
      }
    }, tickMs);
    return () => clearInterval(timerId);
  }, [isOpen, isPlaying, playbackSpeed, headVersionAtOpen, hasVersion, ensureVersion]);

  const handlePlayPause = (): void => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    /*
      Play from the top when already at the end (standard media behavior).
    */
    if (playheadVersion >= headVersionAtOpen) {
      setPlayheadVersion(0);
    }
    setIsPlaying(true);
  };

  const handleScrub = (nextVersion: number): void => {
    setIsPlaying(false);
    setPlayheadVersion(nextVersion);
  };

  /*
    Render the exact frame when cached; otherwise hold the previous frame
    (the version label still tracks the thumb) until the fetch lands.
    Render-time setState is the sanctioned "adjust state from props" shape.
  */
  const exactDoc = getDocAtVersion(playheadVersion);
  const [lastShownDoc, setLastShownDoc] = useState<typeof exactDoc>(null);
  if (exactDoc !== null && exactDoc !== lastShownDoc) {
    setLastShownDoc(exactDoc);
  }
  const displayedDoc = exactDoc ?? lastShownDoc;

  const currentEntry = operationsByVersion?.get(playheadVersion);
  const currentAuthor =
    currentEntry !== undefined
      ? deriveOpAuthor({
          author: currentEntry.author,
          authorId: currentEntry.authorId,
          viewerAuthorId: authorId,
        })
      : null;
  const captionText =
    playheadVersion === 0
      ? "Document created"
      : currentEntry !== undefined
        ? describeEntryHuman(currentEntry, {
            getEntryByVersion: (version) => operationsByVersion?.get(version),
          })
        : null;
  /*
    The frame's before → after glance ("what just changed"), when it has one.
  */
  const captionTransition =
    playheadVersion > 0 && currentEntry !== undefined
      ? describeValueTransition({ op: currentEntry.op, inverse: currentEntry.inverse })
      : null;

  /*
    Hidden unless enabled via the settings FAB (after the hooks above, per
    the rules of hooks). Unmounting also closes an open panel on disable.
  */
  if (!isTimeTravelReplayEnabled) {
    return null;
  }

  return (
    /*
      disablePointerDismissal: replaying continues while the user clicks
      around the live canvas (and other panels) — close is the X or Escape.
    */
    <Sheet open={isOpen} onOpenChange={handleOpenChange} modal={false} disablePointerDismissal>
      {/*
        Tooltip + sheet trigger on ONE element (base-ui render composition)
        — icon-only, so hover must say what it opens.
      */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <SheetTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="Time-travel replay" />}
                data-testid="replay-open-button"
              >
                <PlayIcon />
              </SheetTrigger>
            }
          />
          <TooltipContent side="bottom">Time-travel replay</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <SheetContent
        side="left"
        hasOverlay={false}
        className="w-[440px] max-w-[calc(100vw-2rem)]"
        data-testid="replay-panel"
      >
        <SheetHeader>
          <SheetTitle>Time-travel replay</SheetTitle>
          <SheetDescription>
            Watch the document rebuild itself, version by version. Read-only —
            the live draft is untouched.
          </SheetDescription>
        </SheetHeader>

        {/*
          scrollbar-visible: match the History preview pane — a tall email
          must LOOK scrollable; draws nothing when it fits.
        */}
        <div
          className="scrollbar-visible min-h-0 flex-1 overflow-y-auto p-3"
          data-testid="replay-preview"
        >
          {displayedDoc !== null ? (
            <ReadOnlyEmailPreview doc={displayedDoc} />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2Icon className="size-5 animate-spin" />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t p-3">
          <div className="flex min-h-5 items-center gap-1.5 text-xs" data-testid="replay-caption">
            <span className="shrink-0 font-medium tabular-nums">
              v{playheadVersion}
              <span className="text-muted-foreground"> / {headVersionAtOpen}</span>
            </span>
            {captionText !== null && (
              <>
                {currentAuthor !== null && (
                  <span
                    className="min-w-0 shrink truncate font-medium"
                    style={{ color: currentAuthor.color }}
                  >
                    {currentAuthor.label}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {captionText}
                </span>
                {captionTransition !== null && (
                  <BeforeAfterChip transition={captionTransition} />
                )}
              </>
            )}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(headVersionAtOpen, 0)}
            step={1}
            value={playheadVersion}
            onChange={(event) => handleScrub(Number(event.target.value))}
            disabled={headVersionAtOpen === 0}
            className="w-full accent-primary"
            aria-label="Replay version scrubber"
            data-testid="replay-scrubber"
          />
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={isPlaying ? "Pause replay" : "Play replay"}
              onClick={handlePlayPause}
              disabled={headVersionAtOpen === 0}
              data-testid="replay-play-button"
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("tabular-nums", playbackSpeed === 2 && "font-semibold")}
              aria-label={`Playback speed ${playbackSpeed}x — click to toggle`}
              onClick={() => setPlaybackSpeed((speed) => (speed === 1 ? 2 : 1))}
              data-testid="replay-speed-button"
            >
              {playbackSpeed}x
            </Button>
            {headVersionAtOpen === 0 && (
              <span className="text-xs text-muted-foreground">
                No edits yet — make a change and reopen.
              </span>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
