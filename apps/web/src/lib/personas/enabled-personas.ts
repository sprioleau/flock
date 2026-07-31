"use client";

import { useSyncExternalStore } from "react";

/**
 * Multi-agent canvas v0 — persona enablement, the proposal's low-friction
 * mapping (§3.7): a localStorage list of enabled persona slugs for THIS
 * browser session. No Convex row — when Convex Auth's anonymous→claimed
 * upgrade lands (v2), this map moves to a `userAgentPreferences` table and
 * localStorage stays the anonymous fallback. Exposed via
 * `useSyncExternalStore` (the app-settings.ts pattern) so SSR/hydration see
 * the empty default and the stored value applies right after mount; a
 * "storage" listener keeps multiple tabs in sync.
 */

const ENABLED_PERSONAS_STORAGE_KEY = "tandem_enabled_agents";

/** Stable snapshot (useSyncExternalStore requires reference equality). */
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
    // localStorage unavailable (SSR, privacy mode) or corrupt — none enabled.
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

/** The enabled persona slugs for this browser session (reactive). */
export function useEnabledPersonaSlugs(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Enable or disable one persona for this browser session (best-effort persistence). */
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
    // In-memory enablement still applies for this tab.
  }
  notifyListeners();
}
