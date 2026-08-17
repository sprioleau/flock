"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Popover } from "@base-ui/react/popover";
import { Button } from "@/components/ui/button";
import { openTourStopSurface, prepareTourStop } from "@/lib/tour/tour-intents";
import {
  buildTourScrimPanels,
  buildTourSpotlight,
  type TourRect,
  type TourViewport,
} from "@/lib/tour/tour-scrim";
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

/*
  Minimum distance the arrow keeps from the card's corners.

  It has to clear the card's own 12px corner radius, or the triangle's base
  lands on the curve and the "fused to the card" illusion breaks. Floating UI
  clamps the arrow's CROSS-AXIS BOX with this, and the box is 20x10 — so on a
  left/right stop, where the box is rotated a quarter turn, the visible
  triangle reaches 5px further than the clamp accounts for. 18 leaves room for
  that on every side rather than only the two that are measured.
*/
const ARROW_PADDING = 18;

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

  const anchorElement =
    stop !== undefined && resolvedAnchor !== null && resolvedAnchor.stopId === stop.id
      ? resolvedAnchor.element
      : null;
  /*
    Called unconditionally, above the bail-out below, because it is a hook —
    it takes `null` for "no anchor yet" rather than being skipped.
  */
  const anchorGeometry = useAnchorGeometry(anchorElement);

  if (stop === undefined || anchorElement === null) {
    return null;
  }

  return (
    <>
      {anchorGeometry !== null && <TourScrim anchor={anchorGeometry} />}
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
            Escape skips the tour, which is the gesture people already expect
            for "get this off my screen". Every other close reason — outside
            press above all — is IGNORED on purpose: `open` is hard-coded true,
            so declining to act here leaves the card up. An outside press is
            usually the user reaching for the very trigger this card is
            pointing at, and treating that as a permanent dismissal would
            punish them for doing exactly what they were just told to do.
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
            arrowPadding={ARROW_PADDING}
            /*
              Above the studio chrome, the settings FAB (z-40) and the scrim
              (z-44), below the app's own dialogs and sheets (z-50 with their
              own backdrop) — so if the user does open a surface mid-stop, the
              real thing is on top.
            */
            className="z-[45]"
          >
            <Popover.Popup
              data-testid="studio-tour-card"
              className={cn(
                "w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl bg-popover p-4",
                "text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none",
                "duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
              )}
            >
              <TourArrow />
              <TourCard
                stop={stop}
                onBack={rewindTour}
                onNext={advanceTour}
                onSkip={dismissTour}
                onOpenSurface={() => {
                  /*
                    Only end the tour if something actually opened. A stop with
                    no named surface does not render this button at all, but a
                    false return here would otherwise finish the tour AND show
                    nothing.
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
    </>
  );
}

/*
  The tail, drawn as a TRIANGLE FUSED TO THE CARD rather than a diamond parked
  in front of it.

  What was wrong before: a 12px square turned 45°, rounded, and outlined with
  `ring-1` on ALL FOUR edges — including the edge that is supposed to disappear
  into the card — sitting at `top: 6px`, which is INSIDE the card's padding
  box. The result read as a second shape floating over the copy, not as a tail.

  What replaces it, and why each piece is there:

  - The shape is an SVG, because a triangle is a triangle at every angle,
    whereas a rotated square is only a triangle where the card hides half of
    it. Base UI's `Popover.Arrow` renders a plain `<div>` and accepts
    arbitrary children, so nothing is fought here.
  - The FILL path's base spans the full 20px at y=0, and the element is
    positioned to overlap the card's edge by one pixel. That single pixel of
    overlap is what erases the seam: the card's `ring-1` is a box-shadow
    painted just outside its border box, and the arrow is a CHILD of the card,
    so the fill paints over the ring exactly where the triangle meets it.
  - The STROKE path is OPEN — two slanted edges, no third side — so the card's
    outline continues down one flank of the triangle and back up the other,
    and no line is ever drawn across the shared edge. Drawing the base too, or
    closing the path, is what would put a visible bar between arrow and card.
    Its endpoints sit on the ring's own centre line so the two meet flush.
  - It is a single shape rotated per side, so `top`/`bottom`/`left`/`right`
    stops all get the same fused triangle. Rotation is about the element's
    centre, and that centre is exactly what Floating UI aligns to the anchor,
    so a quarter turn leaves the arrow pointing at the same place. The offsets
    below (-9px on the flat sides, -14px on the turned ones) are the distances
    that put the triangle's BASE one pixel inside the card's edge in each case,
    given a 20x10 box that becomes 10x20 once rotated.
*/
function TourArrow() {
  return (
    <Popover.Arrow
      className={cn(
        "pointer-events-none h-2.5 w-5",
        "data-[side=top]:-bottom-[9px]",
        "data-[side=bottom]:-top-[9px] data-[side=bottom]:rotate-180",
        "data-[side=left]:-right-[14px] data-[side=left]:-rotate-90",
        "data-[side=right]:-left-[14px] data-[side=right]:rotate-90",
      )}
    >
      <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden="true" className="block">
        <path d="M0 0 H20 L10 10 Z" className="fill-popover" />
        <path
          d="M1.5 1.5 L10 9.5 L18.5 1.5"
          fill="none"
          strokeWidth="1"
          strokeLinejoin="round"
          className="stroke-foreground/10"
        />
      </svg>
    </Popover.Arrow>
  );
}

/*
  The anchor's box and the viewport's, remeasured every frame the tour is up.

  A frame loop rather than a ResizeObserver, and the reason is the chat stop:
  expanding the panel animates a 300ms width transition that MOVES the
  composer without resizing it, and moves the toolbar buttons without resizing
  those either — neither of which a ResizeObserver on the anchor would ever
  hear about. Base UI's positioner already tracks the same anchor the same way
  for the card itself, so this only puts the scrim on the footing the card is
  already on. It costs one getBoundingClientRect per frame on one element,
  only while a card is on screen, and it re-renders solely when a number
  actually moves.
*/
function useAnchorGeometry(
  element: Element | null,
): { anchor: TourRect; viewport: TourViewport } | null {
  const [geometry, setGeometry] = useState<{ anchor: TourRect; viewport: TourViewport } | null>(
    null,
  );

  useEffect(() => {
    if (element === null) {
      setGeometry(null);
      return;
    }
    let frameId = 0;
    let lastKey = "";

    const measure = (): void => {
      const box = element.getBoundingClientRect();
      const next = {
        anchor: { top: box.top, left: box.left, width: box.width, height: box.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
      const key = [
        next.anchor.top,
        next.anchor.left,
        next.anchor.width,
        next.anchor.height,
        next.viewport.width,
        next.viewport.height,
      ].join(",");
      if (key !== lastKey) {
        lastKey = key;
        setGeometry(next);
      }
      frameId = window.requestAnimationFrame(measure);
    };

    measure();
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [element]);

  return geometry;
}

/*
  The dim, in four panels with a hole cut for the control the card points at.

  See tour-scrim.ts for WHY this is hand-rolled instead of `modal={true}` —
  short version, Base UI's modality disables pointer events on outside
  elements, and every stop of this tour ends in "click that control", which is
  an outside element. This layer dims and swallows clicks EVERYWHERE ELSE
  while leaving the anchor untouched, which is the half of modality the tour
  wants without the half that would make it impossible to follow.

  Nothing here is focusable and nothing here moves focus, so tab order still
  runs straight into the card's own buttons and Escape still reaches the
  popover's dismiss handler.

  It disappears with the rest of the tour: this whole component tree is gated
  on there being an active stop, so Skip, Done and the "Open it" exit all take
  the scrim down in the same commit that ends the tour — which is what keeps
  "Open it" safe, since the dialog it opens arrives with the scrim already
  gone rather than behind it.
*/
function TourScrim({ anchor }: { anchor: { anchor: TourRect; viewport: TourViewport } }) {
  const spotlight = buildTourSpotlight(anchor.anchor, anchor.viewport);
  const panels = buildTourScrimPanels(spotlight, anchor.viewport);

  return createPortal(
    <div
      data-testid="studio-tour-scrim"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[44]"
    >
      {panels.map((panel) => (
        <div
          key={`${panel.top}:${panel.left}:${panel.width}:${panel.height}`}
          className="pointer-events-auto absolute bg-black/45"
          style={{
            top: panel.top,
            left: panel.left,
            width: panel.width,
            height: panel.height,
          }}
        />
      ))}
      {/* The halo. Purely decorative and never hit-tested, so the control
          underneath it keeps every pixel of its own click target. */}
      <div
        className="absolute rounded-lg ring-2 ring-primary/70"
        style={{
          top: spotlight.top,
          left: spotlight.left,
          width: spotlight.width,
          height: spotlight.height,
        }}
      />
    </div>,
    document.body,
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
