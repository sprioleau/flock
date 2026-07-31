"use client";

import { useSyncExternalStore } from "react";

/**
 * Per-browser layout preferences for the studio's side panels, persisted in
 * localStorage the same way app-settings.ts persists its toggles (defaults
 * during SSR/first paint, stored values right after mount, "storage" events
 * keep sibling tabs in sync).
 *
 * Defaults are owner decisions: the CHAT PANEL starts COLLAPSED (the canvas
 * is the product; the collapsed rail's badge still surfaces pending
 * recommendations) and the right rail starts expanded. Any expand/collapse —
 * a click, a shortcut, a composer handoff that needs the panel visible —
 * writes through here, so the user's last state wins on the next visit.
 */

const PANEL_PREFERENCES_STORAGE_KEY = "tandem:panel-preferences";

export interface PanelPreferences {
  isChatPanelExpanded: boolean;
  isRightRailExpanded: boolean;
}

const DEFAULT_PANEL_PREFERENCES: PanelPreferences = {
  isChatPanelExpanded: false,
  isRightRailExpanded: true,
};

/** Stable snapshot object (useSyncExternalStore requires reference equality). */
let cachedPreferences: PanelPreferences = DEFAULT_PANEL_PREFERENCES;
let hasReadStorage = false;

const listeners = new Set<() => void>();

function readPreferencesFromStorage(): PanelPreferences {
  try {
    const raw = window.localStorage.getItem(PANEL_PREFERENCES_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_PANEL_PREFERENCES;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_PANEL_PREFERENCES;
    }
    const candidate = parsed as Partial<PanelPreferences>;
    return {
      ...DEFAULT_PANEL_PREFERENCES,
      ...(typeof candidate.isChatPanelExpanded === "boolean"
        ? { isChatPanelExpanded: candidate.isChatPanelExpanded }
        : {}),
      ...(typeof candidate.isRightRailExpanded === "boolean"
        ? { isRightRailExpanded: candidate.isRightRailExpanded }
        : {}),
    };
  } catch {
    return DEFAULT_PANEL_PREFERENCES;
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): PanelPreferences {
  if (!hasReadStorage) {
    cachedPreferences = readPreferencesFromStorage();
    hasReadStorage = true;
  }
  return cachedPreferences;
}

function getServerSnapshot(): PanelPreferences {
  return DEFAULT_PANEL_PREFERENCES;
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== PANEL_PREFERENCES_STORAGE_KEY) {
    return;
  }
  cachedPreferences = readPreferencesFromStorage();
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

/** Merge a partial update into the preferences, persist, and notify subscribers. */
export function updatePanelPreferences(partial: Partial<PanelPreferences>): void {
  cachedPreferences = { ...getSnapshot(), ...partial };
  try {
    window.localStorage.setItem(PANEL_PREFERENCES_STORAGE_KEY, JSON.stringify(cachedPreferences));
  } catch {
    // Storage unavailable (private mode quota etc.) — the in-memory value
    // still applies for this tab's lifetime.
  }
  notifyListeners();
}

/** Current preferences OUTSIDE React (shortcut handlers toggle from here). */
export function getPanelPreferences(): PanelPreferences {
  return getSnapshot();
}

/** Reactive preferences (defaults during SSR/first paint, stored after mount). */
export function usePanelPreferences(): PanelPreferences {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
