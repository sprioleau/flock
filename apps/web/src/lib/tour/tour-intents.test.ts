import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The two things the tour does to the app.

  The rule under test is the one the whole feature rests on: A TOUR STEP NAMES
  AN INTENT THE APP ALREADY SUPPORTS, NEVER A DOM INTERACTION. So these mock the
  seams the tour is supposed to call and then check that it called them — and,
  just as importantly, that it never went looking for an element to click
  instead.
*/

const requestUiSurfaceOpen = vi.hoisted(() => vi.fn());
const updatePanelPreferences = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ui-surfaces", () => ({ requestUiSurfaceOpen }));
vi.mock("@/components/studio/panel-preferences", () => ({ updatePanelPreferences }));

import { openTourStopSurface, prepareTourStop } from "./tour-intents";
import { findTourStop, TOUR_STOPS, type TourStop } from "./tour-stops";

function requireStop(stopId: TourStop["id"]): TourStop {
  const stop = findTourStop(stopId);
  if (stop === undefined) {
    throw new Error(`no such stop: ${stopId}`);
  }
  return stop;
}

/* A document whose every lookup is watched, so a stray click is detectable. */
const querySelector = vi.fn(() => null);

beforeEach(() => {
  requestUiSurfaceOpen.mockReset();
  updatePanelPreferences.mockReset();
  querySelector.mockClear();
  vi.stubGlobal("document", { querySelector, querySelectorAll: querySelector });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preparing a stop", () => {
  it("expands the chat panel before the chat stop is targeted", () => {
    /*
      Without this the card anchors to a composer clipped inside the collapsed
      48px rail — present in the DOM, invisible on screen, and reported as a
      successful anchor by any selector-based check. It is the single most
      likely way this feature breaks.
    */
    prepareTourStop(requireStop("chat"));
    expect(updatePanelPreferences).toHaveBeenCalledWith({ isChatPanelExpanded: true });
  });

  it("leaves the layout alone for a stop that points at the toolbar", () => {
    /*
      Toolbar triggers are mounted for the studio's whole life. A stop that
      moved panels around on the way past would be changing the user's layout
      to say a sentence about an icon.
    */
    for (const stop of TOUR_STOPS.filter((candidate) => candidate.prepare === undefined)) {
      prepareTourStop(stop);
    }
    expect(updatePanelPreferences).not.toHaveBeenCalled();
  });

  it("never reaches for an element", () => {
    for (const stop of TOUR_STOPS) {
      prepareTourStop(stop);
    }
    expect(querySelector).not.toHaveBeenCalled();
  });
});

describe("the 'Open it' exit", () => {
  it("opens a closed surface by calling the app, not by clicking its trigger", () => {
    /*
      requestUiSurfaceOpen is the same seam the copilot's openPanel command
      uses, so this takes the identical code path a user's own click takes —
      no selector to go stale, and no race against the dialog's mount.
    */
    expect(openTourStopSurface(requireStop("brand-kit"))).toBe(true);
    expect(requestUiSurfaceOpen).toHaveBeenCalledWith("brand-kit");
    expect(querySelector).not.toHaveBeenCalled();
  });

  it("opens each stop's own surface", () => {
    openTourStopSurface(requireStop("library"));
    openTourStopSurface(requireStop("agents"));
    expect(requestUiSurfaceOpen.mock.calls).toEqual([["library"], ["agents"]]);
  });

  it("reports that it opened nothing for a stop with no named surface", () => {
    /*
      The card ends the tour on a true return. A stop with nothing behind it
      (the chat panel is a layout region; comments is a canvas mode) must say
      so, or the tour finishes AND nothing opens.
    */
    expect(openTourStopSurface(requireStop("chat"))).toBe(false);
    expect(openTourStopSurface(requireStop("comments"))).toBe(false);
    expect(requestUiSurfaceOpen).not.toHaveBeenCalled();
  });
});
