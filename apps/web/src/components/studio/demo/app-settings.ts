"use client";

import { useSyncExternalStore } from "react";

/**
 * App-wide settings, persisted in localStorage (per-browser, like the
 * anonymous session id) and exposed through `useSyncExternalStore` so the
 * server render / first hydration pass sees the defaults and the stored
 * values apply right after mount — no hydration mismatch, no flash of the
 * wrong control. A "storage" listener keeps multiple tabs in sync.
 *
 * Settings all live behind the settings FAB:
 * - Demo mode: reveals the chat panel's "Queue demo messages" button (and
 *   the ghost-collaborator control).
 * - Time-travel replay / Op inspector: reveal their toolbar buttons —
 *   power-user surfaces hidden by default.
 */

const APP_SETTINGS_STORAGE_KEY = "tandem:app-settings";

export interface AppSettings {
  isDemoModeEnabled: boolean;
  isTimeTravelReplayEnabled: boolean;
  isOpInspectorEnabled: boolean;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  isDemoModeEnabled: false,
  isTimeTravelReplayEnabled: false,
  isOpInspectorEnabled: false,
};

/** Stable snapshot object (useSyncExternalStore requires reference equality). */
let cachedSettings: AppSettings = DEFAULT_APP_SETTINGS;
let hasReadStorage = false;

const listeners = new Set<() => void>();

function readSettingsFromStorage(): AppSettings {
  try {
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_APP_SETTINGS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_APP_SETTINGS;
    }
    const candidate = parsed as Partial<AppSettings>;
    return {
      ...DEFAULT_APP_SETTINGS,
      ...(typeof candidate.isDemoModeEnabled === "boolean"
        ? { isDemoModeEnabled: candidate.isDemoModeEnabled }
        : {}),
      ...(typeof candidate.isTimeTravelReplayEnabled === "boolean"
        ? { isTimeTravelReplayEnabled: candidate.isTimeTravelReplayEnabled }
        : {}),
      ...(typeof candidate.isOpInspectorEnabled === "boolean"
        ? { isOpInspectorEnabled: candidate.isOpInspectorEnabled }
        : {}),
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): AppSettings {
  if (!hasReadStorage) {
    cachedSettings = readSettingsFromStorage();
    hasReadStorage = true;
  }
  return cachedSettings;
}

function getServerSnapshot(): AppSettings {
  return DEFAULT_APP_SETTINGS;
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== APP_SETTINGS_STORAGE_KEY) {
    return;
  }
  cachedSettings = readSettingsFromStorage();
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

/** Merge a partial update into the settings, persist, and notify subscribers. */
export function updateAppSettings(partial: Partial<AppSettings>): void {
  cachedSettings = { ...getSnapshot(), ...partial };
  try {
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(cachedSettings));
  } catch {
    // Storage unavailable (private mode quota etc.) — the in-memory value
    // still applies for this tab's lifetime.
  }
  notifyListeners();
}

/** Reactive app settings (defaults during SSR/first paint, stored values after mount). */
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
