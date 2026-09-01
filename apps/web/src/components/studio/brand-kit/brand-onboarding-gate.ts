/*
  Brand-first onboarding (owner: a user with no brand should be prompted to
  set one up before landing in the editor, but never trapped there).

  This module holds the React-free half: the gating decision, and per-session
  dismissal persistence — the same localStorage-as-external-store shape
  brand-pill-dismissals.ts already uses. BrandOnboardingGate.tsx is the
  presentational half that reads these.
*/

const STORAGE_KEY_PREFIX = "flock:brand-onboarding-dismissed:";

function getStorageKey(sessionId: string): string {
  return `${STORAGE_KEY_PREFIX}${sessionId}`;
}

/*
  THE gating decision (advisory-but-prominent, never a hard wall):

  - never before the document itself is ready — no gate can point at, or
    style, a draft that has not loaded yet;
  - never once a saved kit resolved (the reactive Convex query already
    answers "does this session have a brand");
  - never once the user has skipped, or picked a placeholder look, for this
    browser — that is the escape hatch, and it must actually stick.
*/
export function shouldShowBrandOnboardingGate({
  isDocumentReady,
  hasSavedKit,
  isDismissed,
}: {
  isDocumentReady: boolean;
  hasSavedKit: boolean;
  isDismissed: boolean;
}): boolean {
  return isDocumentReady && !hasSavedKit && !isDismissed;
}

/*
  The gate's two phases (owner: SEQUENTIAL, not all-options-at-once). "url"
  is what a returning visitor always sees first — the encouraged, primary
  path. "archetypes" is reached only two ways: a scrape failure, or the
  person saying up front they have no website — never shown alongside the
  URL box by default.
*/
export type BrandOnboardingPhase = "url" | "archetypes";

/*
  What a generate attempt's OUTCOME does to the phase — the rule the owner
  stated directly: success previews the scraped kit (still the "url" phase,
  with a preview attached), failure reveals the curated fallback. Getting
  this backwards (archetypes on success, a bare preview on failure) is the
  one regression this function exists to catch.
*/
export function nextPhaseAfterGenerate({ isOk }: { isOk: boolean }): BrandOnboardingPhase {
  return isOk ? "url" : "archetypes";
}

/*
  Same-tab dismissal listeners (localStorage "storage" events are cross-tab only).
*/
const dismissalListeners = new Set<() => void>();

function notifyDismissalListeners(): void {
  for (const listener of dismissalListeners) {
    listener();
  }
}

export function subscribeToBrandOnboardingDismissal(listener: () => void): () => void {
  dismissalListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    dismissalListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/*
  True once this browser has skipped, or picked a placeholder look, for the
  given session (SSR / storage-unavailable reads as "not dismissed" — never
  block the gate from rendering).
*/
export function readIsBrandOnboardingDismissed(sessionId: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(getStorageKey(sessionId)) !== null;
  } catch {
    return false;
  }
}

/*
  Persist a dismissal (best effort — storage may be unavailable).
*/
export function persistBrandOnboardingDismissed(sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(getStorageKey(sessionId), String(Date.now()));
  } catch {
    /*
      Ignore: the gate simply reappears next visit.
    */
  }
  notifyDismissalListeners();
}
