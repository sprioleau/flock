"use client";

import { useSyncExternalStore } from "react";
import {
  FIRST_TOUR_STOP_ID,
  getNextTourStopId,
  getPreviousTourStopId,
  isTourStopId,
  type TourStopId,
} from "./tour-stops";

/*
  Where the walkthrough is up to, per browser.

  LOCALSTORAGE, NOT CONVEX, and that is the load-bearing decision here. The
  users who most need this tour are the ones who have not made an account, so
  progress cannot live behind one. Two specifics of this app make that more
  than a preference: Better Auth anonymous identities only exist when
  NEXT_PUBLIC_FLOCK_AUTH_ENABLED is true, so keying on identity would break the
  tour in every configuration with auth off (local development included), and
  convex/schema.ts has no per-session preferences table, so the Convex version
  means schema work for a boolean.

  So this is the house idiom, unchanged: module state over localStorage, read
  through useSyncExternalStore with a getServerSnapshot returning defaults so
  SSR and first paint agree, a "storage" listener to keep sibling tabs in step,
  and every read and write wrapped so that a browser which cannot persist
  ("private mode", storage disabled) still gets a working tour for the life of
  the tab rather than an exception. See panel-preferences.ts,
  demo/app-settings.ts and personas/enabled-personas.ts for the same shape.

  The honest cost, stated rather than papered over: A NEW BROWSER SEES THE TOUR
  AGAIN. Panel preferences and suggestion dismissals already behave that way,
  and for a first-run tour it is arguably correct — a different device is a
  different first run. If it ever needs to be durable across devices, the
  Convex row becomes cheap the moment any per-user preferences table exists,
  and nothing here blocks that migration.

  Everything below the store is a PURE function over a plain TourProgress, so
  ordering, resume, skip and restart are unit-tested directly rather than
  through a component that this app's node-only vitest environment could not
  render anyway.
*/

const TOUR_PROGRESS_STORAGE_KEY = "flock:tour-progress";

/*
  Four states, and the two terminal ones are deliberately distinct.

  - "unseen"      never run in this browser. The tour AUTO-STARTS from here.
  - "in-progress" started, not finished. Carries where to resume.
  - "dismissed"   the user pressed Skip. Never shows again unless reset.
  - "completed"   the user reached the end (or took an "Open it" exit).

  Both terminal states hide the tour identically, so nothing in the UI branches
  on the difference. They are separate because "I did not want this" and "I did
  this" are different facts about a user, and collapsing them into one boolean
  throws that away permanently for the sake of no simplification worth having.
*/
export type TourStatus = "unseen" | "in-progress" | "dismissed" | "completed";

export interface TourProgress {
  status: TourStatus;
  /*
    Where a returning user picks up, stored as an ID rather than an index.

    An index resumes someone onto whatever stop happens to occupy slot 3 in the
    release they came back to, which is a silently wrong card. An id that no
    longer exists is instead detectable, and selectActiveTourStopId sends that
    user back to the start rather than showing them nothing.
  */
  resumeStopId: TourStopId | null;
}

export const DEFAULT_TOUR_PROGRESS: TourProgress = {
  status: "unseen",
  resumeStopId: null,
};

/* ------------------------------------------------------------------------ */
/* Pure state — every decision the tour makes, testable without a DOM.        */
/* ------------------------------------------------------------------------ */

function isTourStatus(value: unknown): value is TourStatus {
  return (
    value === "unseen" || value === "in-progress" || value === "dismissed" || value === "completed"
  );
}

/*
  Read stored JSON into a TourProgress, tolerating anything.

  Never throws and never returns a half-parsed object: a corrupt or
  hand-edited value costs the user a repeated tour, which is a far better
  failure than a studio that will not mount. A stored resume id that has since
  been retired is dropped here rather than at the read site, so the rest of the
  module can trust the field.
*/
export function parseTourProgress(raw: string | null): TourProgress {
  if (raw === null) {
    return DEFAULT_TOUR_PROGRESS;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_TOUR_PROGRESS;
    }
    const candidate = parsed as Partial<Record<keyof TourProgress, unknown>>;
    return {
      status: isTourStatus(candidate.status) ? candidate.status : DEFAULT_TOUR_PROGRESS.status,
      resumeStopId: isTourStopId(candidate.resumeStopId) ? candidate.resumeStopId : null,
    };
  } catch {
    return DEFAULT_TOUR_PROGRESS;
  }
}

/*
  The stop to show right now, or null for "show nothing".

  This is the whole gate. "unseen" resolves to the first stop, which is what
  makes the tour automatic on a first visit (proposal §6 Q1: automatic, once,
  skippable at every step, plus a permanent way to re-run it — the settings
  entry). Both terminal states resolve to null. An "in-progress" row whose
  resume id did not survive a release falls back to the first stop, because
  restarting a returning user is recoverable and showing them nothing forever
  is not.
*/
export function selectActiveTourStopId(progress: TourProgress): TourStopId | null {
  if (progress.status === "dismissed" || progress.status === "completed") {
    return null;
  }
  if (progress.status === "unseen") {
    return FIRST_TOUR_STOP_ID;
  }
  return progress.resumeStopId ?? FIRST_TOUR_STOP_ID;
}

/** Next stop, or completion at the last one. Advancing a finished tour is a no-op. */
export function advanceTourProgress(progress: TourProgress): TourProgress {
  const activeStopId = selectActiveTourStopId(progress);
  if (activeStopId === null) {
    return progress;
  }
  const nextStopId = getNextTourStopId(activeStopId);
  if (nextStopId === null) {
    return { status: "completed", resumeStopId: null };
  }
  return { status: "in-progress", resumeStopId: nextStopId };
}

/** Previous stop. At the first stop there is nowhere to go, so nothing moves. */
export function rewindTourProgress(progress: TourProgress): TourProgress {
  const activeStopId = selectActiveTourStopId(progress);
  if (activeStopId === null) {
    return progress;
  }
  const previousStopId = getPreviousTourStopId(activeStopId);
  if (previousStopId === null) {
    return progress;
  }
  return { status: "in-progress", resumeStopId: previousStopId };
}

/* Skip. The resume point goes with it — a restart begins at the beginning. */
export function dismissTourProgress(): TourProgress {
  return { status: "dismissed", resumeStopId: null };
}

/* Reached the end, or took an "Open it" exit — both are a finished tour. */
export function completeTourProgress(): TourProgress {
  return { status: "completed", resumeStopId: null };
}

/*
  What the settings entry writes.

  Deliberately "in-progress" at the first stop rather than "unseen": the
  distinction matters if the auto-start rule is ever narrowed (say, to first
  visits only), because a user who explicitly asked to see this again must not
  be filtered out by a rule about people who have never seen it.
*/
export function restartTourProgress(): TourProgress {
  return { status: "in-progress", resumeStopId: FIRST_TOUR_STOP_ID };
}

/* ------------------------------------------------------------------------ */
/* The store — the localStorage shell over the pure state above.              */
/* ------------------------------------------------------------------------ */

/** Stable snapshot object (useSyncExternalStore requires reference equality). */
let cachedProgress: TourProgress = DEFAULT_TOUR_PROGRESS;
let hasReadStorage = false;

const listeners = new Set<() => void>();

function readProgressFromStorage(): TourProgress {
  try {
    return parseTourProgress(window.localStorage.getItem(TOUR_PROGRESS_STORAGE_KEY));
  } catch {
    /* No storage at all (SSR, privacy mode) — a first run every time is fine. */
    return DEFAULT_TOUR_PROGRESS;
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): TourProgress {
  if (!hasReadStorage) {
    cachedProgress = readProgressFromStorage();
    hasReadStorage = true;
  }
  return cachedProgress;
}

function getServerSnapshot(): TourProgress {
  return DEFAULT_TOUR_PROGRESS;
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== TOUR_PROGRESS_STORAGE_KEY) {
    return;
  }
  cachedProgress = readProgressFromStorage();
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", handleStorageEvent);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", handleStorageEvent);
    }
  };
}

/*
  Persist a new progress value and wake every subscriber.

  Takes a reducer rather than a value so that callers always compose against
  the CURRENT state — the settings menu and the card can both be on screen, and
  a stale closure over progress would let one of them undo the other.
*/
function writeProgress(reduce: (current: TourProgress) => TourProgress): void {
  cachedProgress = reduce(getSnapshot());
  hasReadStorage = true;
  try {
    window.localStorage.setItem(TOUR_PROGRESS_STORAGE_KEY, JSON.stringify(cachedProgress));
  } catch {
    /* Storage unavailable — the in-memory value still holds for this tab. */
  }
  notifyListeners();
}

/** Move to the next stop, completing the tour at the last one. */
export function advanceTour(): void {
  writeProgress(advanceTourProgress);
}

/** Step back one stop. A no-op on the first. */
export function rewindTour(): void {
  writeProgress(rewindTourProgress);
}

/** Skip. Nothing shows again in this browser until the settings entry resets it. */
export function dismissTour(): void {
  writeProgress(dismissTourProgress);
}

/** Finish — the last stop's Done, and the "Open it" exit. */
export function completeTour(): void {
  writeProgress(completeTourProgress);
}

/** The settings entry: wipe progress and start over from the first stop. */
export function restartTour(): void {
  writeProgress(restartTourProgress);
}

/**
 * Current progress, read imperatively — the getPanelPreferences /
 * getAppSettings counterpart, for callers that need the value at the moment of
 * an action rather than on render. Components should use
 * {@link useTourProgress} so they re-render when it moves.
 */
export function getTourProgress(): TourProgress {
  return getSnapshot();
}

/** Reactive progress (defaults during SSR/first paint, stored value after mount). */
export function useTourProgress(): TourProgress {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/*
  Is a card on screen right now?

  Exists for the two background systems the tour would otherwise fight — the
  persona advisors and the related-edit suggestions, both of which surface
  their own cards unprompted. See use-persona-advisors.ts and use-suggestions.ts
  for what each one does with this.
*/
export function getIsTourRunning(): boolean {
  return selectActiveTourStopId(getTourProgress()) !== null;
}

/** Reactive {@link getIsTourRunning}, for the hooks that gate on render. */
export function useIsTourRunning(): boolean {
  return selectActiveTourStopId(useTourProgress()) !== null;
}
