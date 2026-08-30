"use client";

import { useSyncExternalStore } from "react";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEMO_SESSION_STORAGE_KEY,
  ENABLED_PERSONAS_STORAGE_KEY,
  TOUR_PROGRESS_STORAGE_KEY,
  buildDemoAppSettingsRaw,
  buildDemoEnabledPersonasRaw,
  buildDemoRestoreSnapshot,
  buildDemoTourProgressRaw,
  buildRestoredTourProgressRaw,
  parseDemoSession,
  selectIsDemoDocument,
  type DemoSession,
} from "./demo-preset";

/*
  The localStorage shell over demo-preset.ts's pure rules — the house idiom
  (app-settings.ts, enabled-personas.ts, tour-progress.ts): module state read
  through useSyncExternalStore with a getServerSnapshot returning the default
  so SSR and first paint agree, a "storage" listener for sibling tabs, and
  every read and write wrapped so a browser that cannot persist still gets a
  working demo for the life of the tab.

  ONE THING HERE IS NOT THE HOUSE IDIOM, and it is deliberate: writing the
  preset dispatches a synthetic `storage` event at this window. Those events
  normally only arrive from OTHER tabs, so the three stores whose keys the
  preset overwrites would keep serving their cached snapshots for the life of
  this tab — /demo hands over to /studio by client-side navigation, so the
  modules are never re-imported and never re-read. Dispatching the event walks
  them down the refresh path they were already designed for, instead of adding
  a second "someone changed you from outside" mechanism to each one.

  ISOLATION between concurrent visitors is a property of the DOCUMENT, not of
  anything in here: /demo provisions a fresh document (and therefore a fresh
  presence room, which is keyed per document) per visit. Two strangers loading
  /demo at the same moment get two documents, two rooms, two sets of persona
  presence rows, and never see each other. The only thing they share is this
  browser-global preset — and they are, by construction, not in the same
  browser.
*/

let cachedSession: DemoSession | null = null;
let hasReadStorage = false;

const listeners = new Set<() => void>();

function readSessionFromStorage(): DemoSession | null {
  try {
    return parseDemoSession(window.localStorage.getItem(DEMO_SESSION_STORAGE_KEY));
  } catch {
    return null;
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): DemoSession | null {
  if (!hasReadStorage) {
    cachedSession = readSessionFromStorage();
    hasReadStorage = true;
  }
  return cachedSession;
}

function getServerSnapshot(): DemoSession | null {
  return null;
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== DEMO_SESSION_STORAGE_KEY) {
    return;
  }
  cachedSession = readSessionFromStorage();
  hasReadStorage = true;
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

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw({ key, value }: { key: string; value: string | null }): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    /*
      Private mode / quota. The demo still runs for this tab's lifetime off
      the in-memory snapshot; only persistence across a reload is lost.
    */
  }
}

/*
  Make every localStorage-backed store in THIS tab re-read (see the header).
  `key: null` is the "everything changed" signal all three of them already
  honour, so one event refreshes app settings, persona enablement and tour
  progress together.
*/
function broadcastStorageRefresh(): void {
  try {
    window.dispatchEvent(new StorageEvent("storage"));
  } catch {
    /*
      Older engines without a constructible StorageEvent: the values are on
      disk and correct, they just apply on the next full page load.
    */
  }
}

/*
  Enter the demo: snapshot what the visitor had, write the preset, and record
  which document this run belongs to.

  Called AFTER the scratch document exists, so the session record is never
  written pointing at a document that failed to provision.
*/
export function beginDemoSession({ documentId }: { documentId: string }): void {
  const restore = buildDemoRestoreSnapshot({
    current: {
      appSettingsRaw: readRaw(APP_SETTINGS_STORAGE_KEY),
      enabledPersonasRaw: readRaw(ENABLED_PERSONAS_STORAGE_KEY),
      tourProgressRaw: readRaw(TOUR_PROGRESS_STORAGE_KEY),
    },
    /*
      Re-entering /demo ("Start over") must not snapshot the demo's own
      settings as the visitor's prior ones — see buildDemoRestoreSnapshot.
    */
    activeSession: getSnapshot(),
  });
  const session: DemoSession = { documentId, startedAtMs: Date.now(), restore };
  writeRaw({
    key: APP_SETTINGS_STORAGE_KEY,
    value: buildDemoAppSettingsRaw(restore.appSettingsRaw),
  });
  writeRaw({ key: ENABLED_PERSONAS_STORAGE_KEY, value: buildDemoEnabledPersonasRaw() });
  writeRaw({ key: TOUR_PROGRESS_STORAGE_KEY, value: buildDemoTourProgressRaw() });
  writeRaw({ key: DEMO_SESSION_STORAGE_KEY, value: JSON.stringify(session) });
  cachedSession = session;
  hasReadStorage = true;
  notifyListeners();
  broadcastStorageRefresh();
}

/*
  Leave the demo: put back exactly the three raw values the visitor had, and
  forget the session. The demo's scratch document is deliberately NOT deleted
  — it is an ordinary session document that the existing 30-day cleanup sweep
  already collects, and nothing about this route should teach that cron a new
  trick (convex/model/cleanup.ts has a documented data-loss history).
*/
export function endDemoSession(): void {
  const session = getSnapshot();
  if (session !== null) {
    writeRaw({ key: APP_SETTINGS_STORAGE_KEY, value: session.restore.appSettingsRaw });
    writeRaw({ key: ENABLED_PERSONAS_STORAGE_KEY, value: session.restore.enabledPersonasRaw });
    /*
      App settings and persona enablement go back verbatim; tour progress is
      the one value that does not, because a first-time visitor's stashed
      "never seen" would auto-start the walkthrough on top of the studio they
      just landed back on. See buildRestoredTourProgressRaw — a real tour
      state is still restored byte for byte.
    */
    writeRaw({
      key: TOUR_PROGRESS_STORAGE_KEY,
      value: buildRestoredTourProgressRaw(session.restore.tourProgressRaw),
    });
  }
  writeRaw({ key: DEMO_SESSION_STORAGE_KEY, value: null });
  cachedSession = null;
  hasReadStorage = true;
  notifyListeners();
  broadcastStorageRefresh();
}

/*
  The active demo session, reactive (null during SSR and first paint).
*/
export function useDemoSession(): DemoSession | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/*
  Is this document the scripted demo's scratch document? Read imperatively —
  the persona advisors' run gate needs the value at the moment of a trigger,
  never a render-stale one.
*/
export function getIsScriptedDemoDocument(documentId: string | null): boolean {
  return selectIsDemoDocument({ session: getSnapshot(), documentId });
}
