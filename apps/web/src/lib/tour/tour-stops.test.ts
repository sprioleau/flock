import { describe, expect, it } from "vitest";
import {
  FIRST_TOUR_STOP_ID,
  findTourStop,
  getNextTourStopId,
  getPreviousTourStopId,
  getTourStopNumber,
  isTourStopId,
  TOUR_STOP_COUNT,
  TOUR_STOPS,
  type TourStopId,
} from "./tour-stops";

/*
  The tour's content and shape.

  These are the invariants that would each produce a specific, real bug — a
  card pinned to a hidden element, a tour that cannot finish, a card that
  appears twice on the same icon — rather than restatements of the array.
*/

describe("the stop list", () => {
  it("starts where FIRST_TOUR_STOP_ID says it does", () => {
    /*
      Two independent declarations of the same fact, and they must agree:
      selectActiveTourStopId sends every unseen and every recovered user to
      FIRST_TOUR_STOP_ID, so a reorder that moves a different stop into slot 0
      without updating the constant would start half the users on stop 2.
    */
    expect(TOUR_STOPS[0].id).toBe(FIRST_TOUR_STOP_ID);
  });

  it("gives every stop a distinct id", () => {
    /*
      findTourStop, getNextTourStopId and the persisted resume point all key on
      the id. A duplicate resolves to the first match, which can send the tour
      backwards forever instead of ending.
    */
    const ids = TOUR_STOPS.map((stop) => stop.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points each stop at a different element", () => {
    /* Two cards on one icon is a content mistake no type can catch. */
    const anchors = TOUR_STOPS.map((stop) => stop.anchorTestId);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("says something on every card", () => {
    for (const stop of TOUR_STOPS) {
      expect(stop.title.length).toBeGreaterThan(0);
      expect(stop.body.length).toBeGreaterThan(0);
      expect(stop.anchorTestId.length).toBeGreaterThan(0);
    }
  });
});

describe("the chat stop", () => {
  /*
    THE failure mode this feature was warned about. panel-preferences.ts
    defaults `isChatPanelExpanded: false`, and the composer stays MOUNTED while
    collapsed (the panel cross-fades), so a lookup for it succeeds and returns
    an element clipped inside a hidden 48px rail. Without a declared
    preparation the card anchors there and points at nothing, and no "did we
    find the anchor" check anywhere would notice.
  */
  it("declares that the chat panel must be expanded first", () => {
    const chatStop = findTourStop("chat");
    expect(chatStop?.prepare).toBe("expand-chat-panel");
  });

  it("is the only stop that needs preparing — the rest anchor to the toolbar", () => {
    /*
      The whole point of anchoring to closed triggers is that toolbar buttons
      are mounted for the studio's entire life. A second stop growing a
      preparation is a signal that it stopped pointing at a trigger and started
      pointing inside a surface, which is the modality problem coming back.
    */
    const preparedStops = TOUR_STOPS.filter((stop) => stop.prepare !== undefined);
    expect(preparedStops.map((stop) => stop.id)).toEqual(["chat"]);
  });
});

describe("the openable surfaces", () => {
  it("offers the 'Open it' exit only where the app can open something by name", () => {
    /*
      The card renders that button off `stop.surface`. A stop naming a surface
      the openPanel enum does not have would not compile; what this checks is
      the other direction — that the two stops with no panel behind them (the
      chat panel is a layout region, comments is a canvas mode) do not offer an
      exit that would finish the tour and open nothing.
    */
    const stopsWithSurface = TOUR_STOPS.filter((stop) => stop.surface !== undefined);
    expect(stopsWithSurface.map((stop) => stop.id)).toEqual(["brand-kit", "library", "agents"]);
  });
});

describe("walking the tour", () => {
  it("reaches every stop in order and then ends", () => {
    /*
      The termination proof: following getNextTourStopId from the first stop
      must visit each stop exactly once and arrive at null. A cycle here is an
      unfinishable tour.
    */
    const visited: TourStopId[] = [];
    let current: TourStopId | null = FIRST_TOUR_STOP_ID;
    while (current !== null && visited.length <= TOUR_STOP_COUNT) {
      visited.push(current);
      current = getNextTourStopId(current);
    }
    expect(current).toBeNull();
    expect(visited).toEqual(TOUR_STOPS.map((stop) => stop.id));
  });

  it("has nowhere to go back to from the first stop", () => {
    expect(getPreviousTourStopId(FIRST_TOUR_STOP_ID)).toBeNull();
  });

  it("goes back to where it came from", () => {
    for (const stop of TOUR_STOPS) {
      const nextId = getNextTourStopId(stop.id);
      if (nextId !== null) {
        expect(getPreviousTourStopId(nextId)).toBe(stop.id);
      }
    }
  });

  it("numbers the stops 1..N for the card's counter", () => {
    expect(TOUR_STOPS.map((stop) => getTourStopNumber(stop.id))).toEqual(
      TOUR_STOPS.map((_stop, index) => index + 1),
    );
    expect(TOUR_STOP_COUNT).toBe(TOUR_STOPS.length);
  });
});

describe("reading an id back out of storage", () => {
  it("accepts a live id and rejects anything else", () => {
    /*
      This is the guard on a resume point written by an older release. A stop
      id that has since been retired must not survive the parse, or a returning
      user resumes onto a stop that no longer exists and sees no card at all.
    */
    expect(isTourStopId("brand-kit")).toBe(true);
    expect(isTourStopId("retired-stop")).toBe(false);
    expect(isTourStopId(null)).toBe(false);
    expect(isTourStopId(2)).toBe(false);
  });

  it("resolves nothing for a null or unknown id", () => {
    expect(findTourStop(null)).toBeUndefined();
    expect(findTourStop("retired-stop" as TourStopId)).toBeUndefined();
  });
});
