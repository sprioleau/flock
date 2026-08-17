import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceTourProgress,
  completeTourProgress,
  DEFAULT_TOUR_PROGRESS,
  dismissTourProgress,
  parseTourProgress,
  restartTourProgress,
  rewindTourProgress,
  selectActiveTourStopId,
  type TourProgress,
} from "./tour-progress";
import { FIRST_TOUR_STOP_ID, TOUR_STOPS } from "./tour-stops";

/*
  Where the walkthrough is up to.

  Two halves, tested two ways. The reducers are pure and are called directly.
  The persistence half is exercised through a fake browser, because the
  promises that actually matter to a user — "I skipped this and it stayed
  skipped", "settings really did start it over" — are promises about what
  survives a page load, and a reducer test cannot make them.
*/

const LAST_STOP_ID = TOUR_STOPS[TOUR_STOPS.length - 1].id;
const SECOND_STOP_ID = TOUR_STOPS[1].id;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/*
  A localStorage that outlives a module reset, which is what makes "across a
  reload" testable: resetModules throws away the store's cached snapshot and
  the next import reads this same backing map again — exactly what a returning
  browser does.
*/
function installFakeBrowser(seed: Record<string, string> = {}): Map<string, string> {
  const backingStore = new Map(Object.entries(seed));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string): string | null => backingStore.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        backingStore.set(key, value);
      },
    },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  });
  return backingStore;
}

/** A freshly-loaded copy of the store, as a page load would get. */
async function loadStoreAfterReload(): Promise<typeof import("./tour-progress")> {
  vi.resetModules();
  return import("./tour-progress");
}

describe("who sees a card", () => {
  it("starts a browser that has never run it, at the first stop", () => {
    /*
      This is what makes the tour automatic on a first visit — the proposal's
      recommendation of automatic, once, skippable at every step, backed by the
      settings entry as the permanent way back.
    */
    expect(selectActiveTourStopId(DEFAULT_TOUR_PROGRESS)).toBe(FIRST_TOUR_STOP_ID);
  });

  it("shows nothing once it has been skipped or finished", () => {
    expect(selectActiveTourStopId({ status: "dismissed", resumeStopId: SECOND_STOP_ID })).toBeNull();
    expect(selectActiveTourStopId({ status: "completed", resumeStopId: SECOND_STOP_ID })).toBeNull();
  });

  it("resumes an unfinished tour where it left off", () => {
    expect(selectActiveTourStopId({ status: "in-progress", resumeStopId: SECOND_STOP_ID })).toBe(
      SECOND_STOP_ID,
    );
  });

  it("restarts rather than disappearing when the resume point is gone", () => {
    /*
      An in-progress row whose stop id did not survive a release. Sending that
      user back to the start costs them a repeat; showing them nothing forever
      is unrecoverable without clearing site data.
    */
    expect(selectActiveTourStopId({ status: "in-progress", resumeStopId: null })).toBe(
      FIRST_TOUR_STOP_ID,
    );
  });
});

describe("moving through it", () => {
  it("advances one stop at a time", () => {
    expect(advanceTourProgress(DEFAULT_TOUR_PROGRESS)).toEqual({
      status: "in-progress",
      resumeStopId: SECOND_STOP_ID,
    });
  });

  it("completes at the last stop instead of falling off the end", () => {
    const atLastStop: TourProgress = { status: "in-progress", resumeStopId: LAST_STOP_ID };
    expect(advanceTourProgress(atLastStop)).toEqual({ status: "completed", resumeStopId: null });
  });

  it("does nothing to a tour that is already over", () => {
    /*
      The card is gone, but a stale click or the anchor-failure skip can still
      call this. It must not resurrect a dismissed tour.
    */
    const dismissed: TourProgress = { status: "dismissed", resumeStopId: null };
    expect(advanceTourProgress(dismissed)).toEqual(dismissed);
    expect(rewindTourProgress(dismissed)).toEqual(dismissed);
  });

  it("goes back, and stays put at the first stop", () => {
    const atSecondStop: TourProgress = { status: "in-progress", resumeStopId: SECOND_STOP_ID };
    expect(rewindTourProgress(atSecondStop)).toEqual({
      status: "in-progress",
      resumeStopId: FIRST_TOUR_STOP_ID,
    });
    expect(rewindTourProgress(DEFAULT_TOUR_PROGRESS)).toEqual(DEFAULT_TOUR_PROGRESS);
  });

  it("keeps skipping and finishing as separate facts", () => {
    /*
      Both hide the card, so nothing in the UI branches on the difference. They
      stay distinct because "I did not want this" and "I did this" are different
      things to know about a user, and one boolean throws that away for good.
    */
    expect(dismissTourProgress().status).toBe("dismissed");
    expect(completeTourProgress().status).toBe("completed");
  });

  it("restarts at the beginning, from any state", () => {
    expect(restartTourProgress()).toEqual({
      status: "in-progress",
      resumeStopId: FIRST_TOUR_STOP_ID,
    });
  });
});

describe("reading stored progress", () => {
  it("treats a browser with nothing stored as a first run", () => {
    expect(parseTourProgress(null)).toEqual(DEFAULT_TOUR_PROGRESS);
  });

  it("round-trips what it wrote", () => {
    const stored: TourProgress = { status: "in-progress", resumeStopId: SECOND_STOP_ID };
    expect(parseTourProgress(JSON.stringify(stored))).toEqual(stored);
  });

  it("survives junk rather than taking the studio down with it", () => {
    /*
      A corrupt value costs the user a repeated tour. Throwing here would cost
      them the editor, because this parses during the shell's first render.
    */
    for (const raw of ["not json", "null", '"a string"', "[]", "42"]) {
      expect(parseTourProgress(raw)).toEqual(DEFAULT_TOUR_PROGRESS);
    }
  });

  it("drops a resume point that no longer names a real stop", () => {
    const parsed = parseTourProgress(
      JSON.stringify({ status: "in-progress", resumeStopId: "retired-stop" }),
    );
    expect(parsed.resumeStopId).toBeNull();
    /* And that user gets the tour from the top rather than a blank screen. */
    expect(selectActiveTourStopId(parsed)).toBe(FIRST_TOUR_STOP_ID);
  });

  it("ignores a status it does not recognise", () => {
    expect(parseTourProgress(JSON.stringify({ status: "halfway" })).status).toBe("unseen");
  });
});

describe("across a page load", () => {
  it("a skipped tour stays skipped", async () => {
    installFakeBrowser();
    const beforeReload = await loadStoreAfterReload();
    expect(selectActiveTourStopId(beforeReload.getTourProgress())).toBe(FIRST_TOUR_STOP_ID);
    beforeReload.dismissTour();

    const afterReload = await loadStoreAfterReload();
    expect(selectActiveTourStopId(afterReload.getTourProgress())).toBeNull();
  });

  it("an unfinished tour resumes on the stop it was on", async () => {
    installFakeBrowser();
    const beforeReload = await loadStoreAfterReload();
    beforeReload.advanceTour();

    const afterReload = await loadStoreAfterReload();
    expect(selectActiveTourStopId(afterReload.getTourProgress())).toBe(SECOND_STOP_ID);
  });

  it("the settings reset really does start it over", async () => {
    /*
      The owner's "there should be a way to trigger the onboarding flow from
      settings", end to end: skip it, reload (so nothing is left in memory),
      hit the reset, and the first card is back — and stays back through
      another reload, because the reset is persisted rather than in-session.
    */
    installFakeBrowser();
    const firstVisit = await loadStoreAfterReload();
    firstVisit.dismissTour();

    const secondVisit = await loadStoreAfterReload();
    expect(selectActiveTourStopId(secondVisit.getTourProgress())).toBeNull();
    secondVisit.restartTour();
    expect(selectActiveTourStopId(secondVisit.getTourProgress())).toBe(FIRST_TOUR_STOP_ID);

    const thirdVisit = await loadStoreAfterReload();
    expect(selectActiveTourStopId(thirdVisit.getTourProgress())).toBe(FIRST_TOUR_STOP_ID);
  });

  it("keeps working in a browser that cannot store anything", async () => {
    /*
      Private mode, or storage switched off. Every read and write is guarded,
      so the tour still runs for the life of the tab — it just starts over on
      the next one, which is the same bargain panel preferences already make.
    */
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (): string => {
          throw new Error("storage disabled");
        },
        setItem: (): void => {
          throw new Error("storage disabled");
        },
      },
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
    });
    const store = await loadStoreAfterReload();
    expect(selectActiveTourStopId(store.getTourProgress())).toBe(FIRST_TOUR_STOP_ID);
    store.advanceTour();
    expect(selectActiveTourStopId(store.getTourProgress())).toBe(SECOND_STOP_ID);
  });
});

describe("what the background systems are told", () => {
  it("reports the tour as running only while a card is up", async () => {
    /*
      use-persona-advisors.ts and use-suggestions.ts both gate on this, so a
      wrong answer here either silences those features permanently or lets them
      pop cards over the walkthrough.
    */
    installFakeBrowser();
    const store = await loadStoreAfterReload();
    expect(store.getIsTourRunning()).toBe(true);
    store.dismissTour();
    expect(store.getIsTourRunning()).toBe(false);
    store.restartTour();
    expect(store.getIsTourRunning()).toBe(true);
  });
});
