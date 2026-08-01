/**
 * Per-draft, per-revision dismissal of the "Updated brand available" pill
 * (brand-kit architecture §5.2): dismissing hides the pill for THAT kit
 * revision in THIS client only — the next revision bump re-arms it, and a
 * rapid-iteration session stays quiet after one dismissal per revision
 * (risk 6). Same localStorage pattern as suggestion dismissals
 * (lib/suggestions/dismissals.ts).
 */

const STORAGE_KEY_PREFIX = "flock:brand:pill-dismissed:";

function getStorageKey(documentId: string): string {
  return `${STORAGE_KEY_PREFIX}${documentId}`;
}

/** Same-tab dismissal listeners (localStorage "storage" events are cross-tab only). */
const dismissalListeners = new Set<() => void>();

function notifyDismissalListeners(): void {
  for (const listener of dismissalListeners) {
    listener();
  }
}

/**
 * Subscribe to dismissal changes (useSyncExternalStore contract): same-tab
 * writes notify via the local listener set; other tabs arrive through the
 * browser's "storage" event.
 */
export function subscribeToBrandDismissals(listener: () => void): () => void {
  dismissalListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    dismissalListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The value a dismissal stores: the exact (kit, revision) that was dismissed. */
export function buildBrandDismissalToken({
  kitId,
  revision,
}: {
  kitId: string;
  revision: number;
}): string {
  return `${kitId}:r${revision}`;
}

/** The dismissed token for a draft, or null (nothing dismissed / SSR / storage off). */
export function readDismissedBrandToken(documentId: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(getStorageKey(documentId));
  } catch {
    return null;
  }
}

/** Persist a dismissal (best effort — storage may be unavailable). */
export function persistDismissedBrandToken({
  documentId,
  token,
}: {
  documentId: string;
  token: string;
}): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(getStorageKey(documentId), token);
  } catch {
    // Ignore: the pill simply reappears next visit.
  }
  notifyDismissalListeners();
}
