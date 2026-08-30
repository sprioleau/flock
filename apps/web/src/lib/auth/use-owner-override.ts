"use client";

import { useCallback, useSyncExternalStore } from "react";

/*
  "Does this browser hold the owner override?" — asked from two places (the
  /override page and the settings menu's owner-only provider control), so it
  is answered once, here, rather than by two copies of the same fetch.

  A module-level store rather than per-component `useEffect`, mirroring
  components/studio/demo/app-settings.ts: mounting the hook twice on one page
  makes ONE request, and redeeming the override on the /override page updates
  every mounted consumer without a second round trip.

  FAIL CLOSED. A network error, a non-JSON body, a 500 — anything short of an
  explicit `{ isUnlocked: true }` — leaves this at locked. The consequence of
  guessing wrong in the optimistic direction is showing an owner-only control
  to someone who does not hold the override; the consequence of guessing wrong
  the other way is that the owner reloads. Those are not equal.

  Note this is a UI-CONVENIENCE signal, never an authorization decision. The
  server re-checks the cookie on every request that matters (see
  lib/auth/owner-override.ts); a client that lies to itself here gains nothing
  but a control whose selection the server will ignore.
*/

export const OWNER_OVERRIDE_STATUS_PATH = "/api/auth/override";

export interface OwnerOverrideStatus {
  /*
    True until the first answer lands — distinct from "answered: locked".
  */
  isChecking: boolean;
  isUnlocked: boolean;
}

/*
  Ask the server whether this browser holds a valid override. Resolves to
  `false` for every failure mode rather than rejecting, so callers never have
  to decide what an error means — it means "not unlocked".
*/
export async function readOwnerOverrideStatus(): Promise<boolean> {
  try {
    const response = await fetch(OWNER_OVERRIDE_STATUS_PATH, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      return false;
    }
    const body: unknown = await response.json();
    return (body as { isUnlocked?: unknown } | null)?.isUnlocked === true;
  } catch {
    return false;
  }
}

/*
  The pre-answer snapshot, and the server snapshot, are the SAME object. A
  fresh object per render would make `useSyncExternalStore` loop.
*/
const CHECKING_SNAPSHOT: OwnerOverrideStatus = { isChecking: true, isUnlocked: false };

let snapshot: OwnerOverrideStatus = CHECKING_SNAPSHOT;
let inFlight: Promise<void> | null = null;
let hasEverRequested = false;

const listeners = new Set<() => void>();

function publish(next: OwnerOverrideStatus): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

/*
  Re-ask the server. Concurrent callers share the one in-flight request.
*/
export function refreshOwnerOverride(): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }
  hasEverRequested = true;
  inFlight = readOwnerOverrideStatus()
    .then((isUnlocked) => {
      publish({ isChecking: false, isUnlocked });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/*
  Record an answer we already know first-hand — the redeem/release responses
  on the /override page say outright what the new state is. Owner law: instant
  feedback. Waiting on a confirming round trip to flip UI we just watched the
  server change would be a delay with nothing behind it.
*/
export function setOwnerOverrideUnlocked(isUnlocked: boolean): void {
  hasEverRequested = true;
  publish({ isChecking: false, isUnlocked });
}

/*
  Current status, read imperatively (non-React callers and tests).
*/
export function getOwnerOverrideStatus(): OwnerOverrideStatus {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  /*
    First subscriber kicks the fetch. `subscribe` runs in the commit phase, so
    this is the same timing a `useEffect` would give — without every consumer
    needing to own one.
  */
  if (!hasEverRequested) {
    void refreshOwnerOverride();
  }
  return () => {
    listeners.delete(listener);
  };
}

function getServerSnapshot(): OwnerOverrideStatus {
  return CHECKING_SNAPSHOT;
}

export interface UseOwnerOverrideResult extends OwnerOverrideStatus {
  /*
    Re-ask the server (after redeeming or releasing elsewhere).
  */
  refresh: () => void;
  /*
    Apply an answer the caller already has, without a round trip.
  */
  setUnlocked: (isUnlocked: boolean) => void;
}

export function useOwnerOverride(): UseOwnerOverrideResult {
  const status = useSyncExternalStore(subscribe, getOwnerOverrideStatus, getServerSnapshot);
  const refresh = useCallback((): void => {
    void refreshOwnerOverride();
  }, []);
  return {
    isChecking: status.isChecking,
    isUnlocked: status.isUnlocked,
    refresh,
    setUnlocked: setOwnerOverrideUnlocked,
  };
}
