/*
  The walkthrough's dimming layer, as geometry.

  WHY A HAND-ROLLED SCRIM AND NOT `modal={true}`. @base-ui/react's `modal`
  prop does three things at once — traps focus, locks page scroll, and
  DISABLES POINTER EVENTS ON EVERY OUTSIDE ELEMENT — and the third one is fatal
  here. Every stop of this tour says "click this control", and the control is
  an outside element to the card's body-level portal, so a modal popover would
  make the instruction impossible to follow. Four of the six surfaces the tour
  points at are Base UI `Dialog`s, which is exactly why the tour anchors to
  CLOSED triggers and is never interactive inside a modal in the first place
  (see the file comment in tour-stops.ts). Turning the tour itself modal would
  reintroduce the focus trap the whole design exists to avoid.

  So the dimming is built out of four plain rectangles instead. They tile the
  viewport AROUND a spotlight cut out over the stop's anchor: everything else
  is dimmed and swallows clicks, and the hole leaves the one control the card
  is talking about both visible and live. No focus is moved, no scroll is
  locked, and Escape still reaches the popover's own dismiss handler.

  This module is the geometry only, with no DOM and no React in it — the same
  split tour-stops.ts uses, and for the same reason: vitest.config.ts pins
  `environment: "node"` for src/**, so a rectangle is testable here and an
  element is not. StudioTour.tsx measures, this decides, StudioTour.tsx paints.
*/

export interface TourRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TourViewport {
  width: number;
  height: number;
}

/*
  Breathing room between the anchor's own box and the edge of the hole.

  A control's bounding box is usually tight against its label, so cutting the
  hole at exactly that box makes the highlight look like a clipping error. Six
  pixels reads as a deliberate halo at every size the studio's toolbar uses.
*/
export const TOUR_SPOTLIGHT_PADDING = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/*
  The hole: the anchor's box, padded, snapped OUTWARD to whole pixels, and
  clipped to the viewport.

  Outward rounding is the load-bearing part. Every panel edge below is derived
  from these four integers, so they land on the same device pixel from both
  sides and the tiling has no antialiased hairline down it. Rounding outward
  rather than to nearest also guarantees the padded hole still contains the
  anchor, which is what keeps the control the card is pointing at clickable.
*/
export function buildTourSpotlight(
  target: TourRect,
  viewport: TourViewport,
  padding: number = TOUR_SPOTLIGHT_PADDING,
): TourRect {
  const left = clamp(Math.floor(target.left - padding), 0, viewport.width);
  const top = clamp(Math.floor(target.top - padding), 0, viewport.height);
  const right = clamp(Math.ceil(target.left + target.width + padding), left, viewport.width);
  const bottom = clamp(Math.ceil(target.top + target.height + padding), top, viewport.height);
  return { top, left, width: right - left, height: bottom - top };
}

/*
  The four dimmed panels around a spotlight, in reading order: above, below,
  and the two flanks between them.

  The flanks are deliberately the SHORT ones — they span only the spotlight's
  own rows — so that no two panels ever overlap. Overlapping translucent
  panels would double their alpha and paint a visible cross through the dim.
  Any panel that would be empty (an anchor flush against a viewport edge)
  comes back with a zero dimension rather than a negative one, so the caller
  can render the list without special cases.
*/
export function buildTourScrimPanels(
  spotlight: TourRect,
  viewport: TourViewport,
): readonly TourRect[] {
  const spotlightRight = spotlight.left + spotlight.width;
  const spotlightBottom = spotlight.top + spotlight.height;
  return [
    { top: 0, left: 0, width: viewport.width, height: Math.max(0, spotlight.top) },
    {
      top: spotlightBottom,
      left: 0,
      width: viewport.width,
      height: Math.max(0, viewport.height - spotlightBottom),
    },
    { top: spotlight.top, left: 0, width: Math.max(0, spotlight.left), height: spotlight.height },
    {
      top: spotlight.top,
      left: spotlightRight,
      width: Math.max(0, viewport.width - spotlightRight),
      height: spotlight.height,
    },
  ];
}
