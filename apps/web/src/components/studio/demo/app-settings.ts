"use client";

import { useSyncExternalStore } from "react";

import { chatProviderIdSchema, type ChatProviderId } from "@/lib/chat-provider";

/*
  App-wide settings, persisted in localStorage (per-browser, like the
  anonymous session id) and exposed through `useSyncExternalStore` so the
  server render / first hydration pass sees the defaults and the stored
  values apply right after mount — no hydration mismatch, no flash of the
  wrong control. A "storage" listener keeps multiple tabs in sync.

  Settings all live behind the settings FAB:
  - Demo mode: reveals the chat panel's "Queue demo messages" button (and
    the ghost-collaborator control).
  - Time-travel replay / Op inspector: reveal their toolbar buttons —
    power-user surfaces hidden by default.
  - Suggestions: whether proactive suggestion cards are SHOWN. Unlike the
    others this defaults ON, because the feature shipped visible and with no
    toggle at all — defaulting off would silently take away behavior users
    already have. Flip the default below to change that.
*/

const APP_SETTINGS_STORAGE_KEY = "flock:app-settings";

export interface AppSettings {
  isDemoModeEnabled: boolean;
  isTimeTravelReplayEnabled: boolean;
  isOpInspectorEnabled: boolean;
  /*
    Show proactive suggestion cards. A VISIBILITY setting only — it never
    gates the op log, which is the shared history spine (see
    lib/suggestions/use-suggestions.ts).
  */
  isSuggestionsEnabled: boolean;
  /*
    Which inference provider chat turns ask for, or `null` for "whatever the
    deployment is configured for" — the state everyone is in until an owner
    deliberately picks one. Only ever HONOURED for a caller holding a valid
    owner override; the server decides, this is a request (see
    lib/chat-provider.ts and the providerId field in lib/chat-contract.ts).
  */
  chatProviderId: ChatProviderId | null;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  isDemoModeEnabled: false,
  isTimeTravelReplayEnabled: false,
  isOpInspectorEnabled: false,
  isSuggestionsEnabled: true,
  chatProviderId: null,
};

/*
  Stable snapshot object (useSyncExternalStore requires reference equality).
*/
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
      /*
        Absent for everyone who stored settings before this key existed —
        they keep the default (ON), which is the behavior they already had.
      */
      ...(typeof candidate.isSuggestionsEnabled === "boolean"
        ? { isSuggestionsEnabled: candidate.isSuggestionsEnabled }
        : {}),
      /*
        A provider id retired between releases must not pin a browser to a
        provider that no longer exists — an unparseable value reverts to the
        deployment default rather than persisting.
      */
      ...(chatProviderIdSchema.safeParse(candidate.chatProviderId).success
        ? { chatProviderId: candidate.chatProviderId as ChatProviderId }
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

/*
  Merge a partial update into the settings, persist, and notify subscribers.
*/
export function updateAppSettings(partial: Partial<AppSettings>): void {
  cachedSettings = { ...getSnapshot(), ...partial };
  try {
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(cachedSettings));
  } catch {
    /*
      Storage unavailable (private mode quota etc.) — the in-memory value
      still applies for this tab's lifetime.
    */
  }
  notifyListeners();
}

/**
 * Current settings, read imperatively. For the non-React callers that need a
 * value at the moment of an action rather than on render — the chat
 * transport's per-request body is the reason this exists. Components should
 * use {@link useAppSettings} so they re-render when a setting changes.
 */
export function getAppSettings(): AppSettings {
  return getSnapshot();
}

/*
  Reactive app settings (defaults during SSR/first paint, stored values after mount).
*/
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
