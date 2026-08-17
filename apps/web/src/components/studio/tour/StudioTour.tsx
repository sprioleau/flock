"use client";

import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Button } from "@/components/ui/button";
import { openTourStopSurface, prepareTourStop } from "@/lib/tour/tour-intents";
import {
  advanceTour,
  completeTour,
  dismissTour,
  rewindTour,
  selectActiveTourStopId,
  useTourProgress,
} from "@/lib/tour/tour-progress";
import {
  findTourStop,
  getPreviousTourStopId,
  getTourStopNumber,
  TOUR_STOP_COUNT,
  type TourStop,
  type TourStopId,
} from "@/lib/tour/tour-stops";
import { cn } from "@/lib/utils";

/*
  The walkthrough's one visible piece: a card anchored to the CLOSED trigger for
  whatever surface the current stop is about, with an arrow pointing at it.

  Mounted as a sibling of <StudioShortcuts /> inside StudioShell's studioLayout —
  inside the isDocumentReady gate, so no card ever points at a toolbar that has
  not rendered yet, and inside the client boundary those shortcuts already
  established for a non-visual behavioural layer.

  WHY THIS IS A POPOVER AND NOT A TOUR LIBRARY. Base UI's positioner takes an
  arbitrary `anchor` element, which is the one genuinely hard part of a tour —
  anchored positioning with real collision handling — already installed, already
  wearing this app's design system. What a package would add on top of that is
  step ordering and progress, which is lib/tour/. Every candidate was also
  either AGPL (shepherd.js, intro.js), the wrong category (OnboardJS is a
  headless wizard state machine with no element targeting), or shipped unlayered
  global CSS that fights Tailwind v4 (driver.js).

  `modal={false}`, and it is the most important line in this file. The card must
  never take the page hostage, because the entire point of the design is that
  the user can reach past it and click the very trigger the arrow is pointing
  at. It is also why nothing here ever renders while one of the app's own modal
  dialogs is open: those trap focus and disable outside pointer events, and a
  card in a body-level portal is an outside element to them. The stops point at
  closed doors; opening one ENDS the tour.
*/

/*
  Anchor resolution budget. A stop's preparation (expanding the chat panel) has
  to commit through React and, for the panel, ride out a 300ms width transition
  before the element is where it will finally sit. Polling briefly is cheaper
  and far less fragile than a MutationObserver over the whole studio, and the
  common case — a toolbar button that is already mounted — resolves on the very
  first attempt with no timer ever firing twice.
*/
const ANCHOR_RETRY_INTERVAL_MS = 80;
const ANCHOR_RESOLVE_ATTEMPTS = 25;

export function StudioTour() {
  const progress = useTourProgress();
  /*
    Stable object identity: TOUR_STOPS is a module constant, so `stop` is the
    same reference across renders of the same step and the effect below runs
    once per STOP rather than once per render.
  */
  const stop = findTourStop(selectActiveTourStopId(progress));

  /*
    The resolved anchor is TAGGED with the stop it was resolved for, rather
    than being cleared when the stop changes. Two reasons, and the first is the
    one that matters: it means there is no render in which the previous stop's
    element is paired with the new stop's copy, so a card can never briefly
    point at the wrong icon. It also keeps every setState inside an async
    callback rather than the effect body, which is what React wants.
  */
  const [resolvedAnchor, setResolvedAnchor] = useState<{
    stopId: TourStopId;
    element: Element;
  } | null>(null);

  useEffect(() => {
    if (stop === undefined) {
      return;
    }
    /*
      Drive the app into the state this stop needs BEFORE looking for the
      anchor — for the chat stop that is expanding the panel, without which the
      composer is a clipped element inside a hidden 48px rail.
    */
    prepareTourStop(stop);

    const selector = `[data-testid="${stop.anchorTestId}"]`;
    let isCancelled = false;
    let timerId: number | undefined;
    let attemptsRemaining = ANCHOR_RESOLVE_ATTEMPTS;

    const attemptToResolveAnchor = (): void => {
      if (isCancelled) {
        return;
      }
      const found = document.querySelector(selector);
      if (found !== null) {
        setResolvedAnchor({ stopId: stop.id, element: found });
        return;
      }
      attemptsRemaining -= 1;
      if (attemptsRemaining > 0) {
        timerId = window.setTimeout(attemptToResolveAnchor, ANCHOR_RETRY_INTERVAL_MS);
        return;
      }
      /*
        FAIL LOUDLY, THEN GET OUT OF THE WAY. A missing anchor means a
        data-testid was renamed or a surface was restructured, which is a real
        bug and belongs in the console (and in dev, in Next's error overlay)
        rather than being swallowed. But it must not strand a user on a step
        that can never render, so the tour skips the stop — one broken anchor
        costs one card, and a tour whose anchors have all rotted completes
        itself instead of hanging.
      */
      console.error(
        `[tour] stop "${stop.id}" has no anchor: nothing matched ${selector}. Skipping it.`,
      );
      advanceTour();
    };

    timerId = window.setTimeout(attemptToResolveAnchor, 0);
    return () => {
      isCancelled = true;
      window.clearTimeout(timerId);
    };
  }, [stop]);

  if (stop === undefined || resolvedAnchor === null || resolvedAnchor.stopId !== stop.id) {
    return null;
  }
  const anchorElement = resolvedAnchor.element;

  return (
    <Popover.Root
      open
      /*
        Never modal — see the file comment. The user has to be able to click
        through to the trigger the arrow points at.
      */
      modal={false}
      onOpenChange={(isOpen, eventDetails) => {
        if (isOpen) {
          return;
        }
        /*
          Escape skips the tour, which is the gesture people already expect for
          "get this off my screen". Every other close reason — outside press
          above all — is IGNORED on purpose: `open` is hard-coded true, so
          declining to act here leaves the card up. An outside press is usually
          the user reaching for the very trigger this card is pointing at, and
          treating that as a permanent dismissal would punish them for doing
          exactly what they were just told to do.
        */
        if (eventDetails.reason === "escape-key") {
          dismissTour();
        }
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchorElement}
          side={stop.side}
          align={stop.align}
          sideOffset={10}
          /*
            Above the studio chrome and the settings FAB (z-40), below the app's
            own dialogs and sheets (z-50 with their own backdrop) — so if the
            user does open a surface mid-stop, the real thing is on top.
          */
          className="z-[45]"
        >
          <Popover.Popup
            data-testid="studio-tour-card"
            className={cn(
              "w-72 rounded-xl bg-popover p-4 text-popover-foreground shadow-lg",
              "ring-1 ring-foreground/10 outline-none",
              "duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            )}
          >
            {/* The "arrow indicating where you would click" — the rotated
                square the tooltip already uses, in the card's own surface
                color so it reads as a tail rather than a second shape. */}
            <Popover.Arrow
              className={cn(
                "z-[45] size-3 rotate-45 rounded-[2px] bg-popover ring-1 ring-foreground/10",
                "data-[side=bottom]:top-1.5 data-[side=top]:-bottom-1.5",
                "data-[side=left]:top-1/2! data-[side=left]:-right-1.5 data-[side=left]:-translate-y-1/2",
                "data-[side=right]:top-1/2! data-[side=right]:-left-1.5 data-[side=right]:-translate-y-1/2",
              )}
            />
            <TourCard
              stop={stop}
              onBack={rewindTour}
              onNext={advanceTour}
              onSkip={dismissTour}
              onOpenSurface={() => {
                /*
                  Only end the tour if something actually opened. A stop with no
                  named surface does not render this button at all, but a false
                  return here would otherwise finish the tour AND show nothing.
                */
                if (openTourStopSurface(stop)) {
                  completeTour();
                }
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export interface TourCardProps {
  stop: TourStop;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onOpenSurface: () => void;
}

/*
  The card's contents, deliberately hook-free.

  That is what makes it testable: vitest.config.ts pins `environment: "node"`,
  so this app checks components by CALLING them and walking the returned tree
  (BlockSuggestionPill.test.tsx, PresenceFacepile.test.tsx are the precedent).
  A component with no hooks and no context needs no stubbing at all to do that,
  so every decision about what the card offers is checked directly, and the
  positioning that genuinely needs a browser stays in StudioTour above it.
*/
export function TourCard({ stop, onBack, onNext, onSkip, onOpenSurface }: TourCardProps) {
  const stopNumber = getTourStopNumber(stop.id);
  const hasPreviousStop = getPreviousTourStopId(stop.id) !== null;
  const isLastStop = stopNumber === TOUR_STOP_COUNT;

  return (
    <div className="flex flex-col gap-3">
      {/* Not built yet — see TourStopPreview in tour-stops.ts. Every stop
          omits `preview` today, so this branch is dormant until the images
          land and the card is arrow-and-copy in the meantime. */}
      {stop.preview !== undefined && (
        /* eslint-disable-next-line @next/next/no-img-element -- the source is a
           remote storage URL resolved at runtime, not a build-time asset. */
        <img
          src={stop.preview.src}
          alt={stop.preview.alt}
          data-testid="studio-tour-preview"
          className="w-full rounded-md border object-cover"
        />
      )}

      <div className="flex flex-col gap-1.5">
        <p className="font-heading text-sm font-semibold">{stop.title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{stop.body}</p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground" data-testid="studio-tour-progress">
          {stopNumber} of {TOUR_STOP_COUNT}
        </span>
        <div className="flex items-center gap-1">
          {/* Skip stays reachable on EVERY stop, not just the first — the
              proposal's §3.3 rule, and the difference between a tour and a
              hostage situation. */}
          <Button variant="ghost" size="sm" onClick={onSkip} data-testid="studio-tour-skip">
            Skip
          </Button>
          {hasPreviousStop && (
            <Button variant="ghost" size="sm" onClick={onBack} data-testid="studio-tour-back">
              Back
            </Button>
          )}
          {/* The exit: open the real surface and finish. Absent when the stop
              has no named panel behind it (chat, comments). */}
          {stop.surface !== undefined && (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenSurface}
              data-testid="studio-tour-open"
            >
              Open it
            </Button>
          )}
          <Button size="sm" onClick={onNext} data-testid="studio-tour-next">
            {isLastStop ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
