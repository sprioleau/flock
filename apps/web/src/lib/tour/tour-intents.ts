"use client";

import { updatePanelPreferences } from "@/components/studio/panel-preferences";
import { requestUiSurfaceOpen } from "@/lib/ui-surfaces";
import type { TourStop } from "./tour-stops";

/*
  The two things the tour is allowed to DO to the app, and the only file that
  knows how to do them.

  THE RULE, inherited from the openPanel editor command that requestUiSurfaceOpen
  was built for: A TOUR STEP NAMES AN INTENT THE APP ALREADY SUPPORTS, NEVER A
  DOM INTERACTION. No `document.querySelector(...).click()` anywhere in this
  feature. A synthesized click needs a selector that can go stale, races the
  dialog's mount, and diverges from what a real click does the first time
  either end changes; calling the app takes the same code path the user's own
  click takes and cannot drift from it.

  Keeping both behind named functions here (rather than inline in StudioTour)
  is what makes them testable at all: vitest pins `environment: "node"` for
  src/**, so the component cannot be rendered, but these can be called with a
  stop and their effects asserted through mocked modules.
*/

/*
  Make a stop's anchor worth pointing at, before the card is positioned.

  Only the chat stop needs this today, and it is the failure mode most likely
  to bite: panel-preferences.ts defaults `isChatPanelExpanded: false`, so on a
  first visit the chat panel is a 48px rail. The composer element is still
  MOUNTED while collapsed — the panel cross-fades rather than unmounting — so a
  lookup for it succeeds and hands back an element clipped inside a hidden
  column. Anchoring there puts the card over the rail, pointing at nothing the
  user can see, while every "did we find the anchor" check reports success.
  Expanding first is what makes the anchor mean what it appears to mean.

  This writes through the user's real panel preference, which is deliberate on
  both counts: it is the exact call ChatPanel's own expand button makes, and
  the panel STAYS expanded after the tour moves on. Collapsing it again would
  undo the one thing that stop just taught.

  The switch is exhaustive over TourStopPreparation rather than defaulted, so
  adding a preparation kind without teaching this function to perform it is a
  compile error rather than a stop that silently prepares nothing.
*/
export function prepareTourStop(stop: TourStop): void {
  if (stop.prepare === undefined) {
    return;
  }
  switch (stop.prepare) {
    case "expand-chat-panel":
      updatePanelPreferences({ isChatPanelExpanded: true });
      return;
  }
}

/*
  The card's "Open it" exit: open the real surface behind the trigger.

  Returns whether there was anything to open, so the caller cannot end the tour
  on a stop that has no surface and leave the user with neither a card nor the
  thing the card promised. Stops without a `surface` (chat, comments) simply do
  not render the button.

  The caller is expected to COMPLETE the tour on a true return — see the
  `surface` field's comment in tour-stops.ts for why ending beats advancing: the
  surface that just opened is a focus-trapping Base UI dialog, and a tour card
  still on screen behind it would be precisely the unclickable-Next-button
  problem this design exists to avoid.
*/
export function openTourStopSurface(stop: TourStop): boolean {
  if (stop.surface === undefined) {
    return false;
  }
  requestUiSurfaceOpen(stop.surface);
  return true;
}
