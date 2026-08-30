"use client";

import { useSyncExternalStore } from "react";

/*
  Multi-agent canvas v0 — persona enablement, the proposal's low-friction
  mapping (§3.7): a localStorage list of enabled persona slugs for THIS
  browser session. No Convex row — when Convex Auth's anonymous→claimed
  upgrade lands (v2), this map moves to a `userAgentPreferences` table and
  localStorage stays the anonymous fallback. Exposed via
  `useSyncExternalStore` (the app-settings.ts pattern) so SSR/hydration see
  the empty default and the stored value applies right after mount; a
  "storage" listener keeps multiple tabs in sync.
*/

const ENABLED_PERSONAS_STORAGE_KEY = "flock_enabled_agents";
/*
  Pause flag ("1" = paused) — persisted beside the enablement list.
*/
const PERSONAS_PAUSED_STORAGE_KEY = "flock_agents_paused";

/*
  Stable snapshot (useSyncExternalStore requires reference equality).
*/
let cachedSlugs: readonly string[] = [];
let hasReadStorage = false;

const listeners = new Set<() => void>();

function readSlugsFromStorage(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(ENABLED_PERSONAS_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((slug): slug is string => typeof slug === "string");
  } catch {
    /*
      localStorage unavailable (SSR, privacy mode) or corrupt — none enabled.
    */
    return [];
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): readonly string[] {
  if (!hasReadStorage) {
    cachedSlugs = readSlugsFromStorage();
    hasReadStorage = true;
  }
  return cachedSlugs;
}

const EMPTY_SLUGS: readonly string[] = [];

function getServerSnapshot(): readonly string[] {
  return EMPTY_SLUGS;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const handleStorage = (event: StorageEvent): void => {
    if (event.key === ENABLED_PERSONAS_STORAGE_KEY || event.key === null) {
      cachedSlugs = readSlugsFromStorage();
      notifyListeners();
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

/*
  The enabled persona slugs for this browser session (reactive).
*/
export function useEnabledPersonaSlugs(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/*
  Swap one enabled slug for another, preserving enablement (copy-on-edit
  plumbing): when saving a built-in's edit forks a session copy — or a reset
  deletes one — the ENABLED slug must follow the row that now defines the
  persona, so the advisors hook/runner reads the right markdown on its next
  turn. No-op when `fromSlug` isn't enabled or the slugs match.
*/
export function replaceEnabledPersonaSlug({
  fromSlug,
  toSlug,
}: {
  fromSlug: string;
  toSlug: string;
}): void {
  const current = getSnapshot();
  if (fromSlug === toSlug || !current.includes(fromSlug)) {
    return;
  }
  const next = [
    ...current.filter((slug) => slug !== fromSlug && slug !== toSlug),
    toSlug,
  ];
  cachedSlugs = next;
  try {
    window.localStorage.setItem(ENABLED_PERSONAS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /*
      In-memory enablement still applies for this tab.
    */
  }
  notifyListeners();
}

/*
  ---------------------------------------------------------------------------
  Pause flag (credit conservation)
  ---------------------------------------------------------------------------
*/

/*
  "Recommendations paused" — a browser-session flag that stops the persona
  watcher from calling /api/personas AT ALL (zero Gemini spend; the gate
  lives at the trigger in use-persona-advisors.ts) WITHOUT touching which
  personas are enabled. Open findings stay visible and actionable while
  paused; unpausing resumes normal triggering. Persisted beside the
  enablement list so it survives reload.
*/

let cachedIsPaused = false;
let hasReadPausedStorage = false;

const pausedListeners = new Set<() => void>();

function readIsPausedFromStorage(): boolean {
  try {
    return window.localStorage.getItem(PERSONAS_PAUSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getPausedSnapshot(): boolean {
  if (!hasReadPausedStorage) {
    cachedIsPaused = readIsPausedFromStorage();
    hasReadPausedStorage = true;
  }
  return cachedIsPaused;
}

function getPausedServerSnapshot(): boolean {
  return false;
}

function subscribePaused(listener: () => void): () => void {
  pausedListeners.add(listener);
  const handleStorage = (event: StorageEvent): void => {
    if (event.key === PERSONAS_PAUSED_STORAGE_KEY || event.key === null) {
      cachedIsPaused = readIsPausedFromStorage();
      for (const pausedListener of pausedListeners) {
        pausedListener();
      }
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    pausedListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

/*
  Reactive: are persona recommendations paused for this browser session?
*/
export function useArePersonasPaused(): boolean {
  return useSyncExternalStore(subscribePaused, getPausedSnapshot, getPausedServerSnapshot);
}

/*
  Non-reactive read for dispatch-time gates (never render-stale).
*/
export function getArePersonasPaused(): boolean {
  return getPausedSnapshot();
}

/*
  Pause or resume persona recommendations (best-effort persistence).
*/
export function setPersonasPaused(isPaused: boolean): void {
  cachedIsPaused = isPaused;
  hasReadPausedStorage = true;
  try {
    if (isPaused) {
      window.localStorage.setItem(PERSONAS_PAUSED_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(PERSONAS_PAUSED_STORAGE_KEY);
    }
  } catch {
    /*
      In-memory pause still applies for this tab's lifetime.
    */
  }
  for (const pausedListener of pausedListeners) {
    pausedListener();
  }
}

/*
  Enable or disable one persona for this browser session (best-effort persistence).
*/
export function setPersonaEnabled({
  slug,
  isEnabled,
}: {
  slug: string;
  isEnabled: boolean;
}): void {
  const current = getSnapshot();
  const next = isEnabled
    ? current.includes(slug)
      ? current
      : [...current, slug]
    : current.filter((enabledSlug) => enabledSlug !== slug);
  if (next === current) {
    return;
  }
  cachedSlugs = next;
  try {
    window.localStorage.setItem(ENABLED_PERSONAS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /*
      In-memory enablement still applies for this tab.
    */
  }
  notifyListeners();
}
