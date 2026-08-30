"use client";

import { useSyncExternalStore } from "react";

/*
  Persona run clock — the client-side source for the facepile popover's
  "time until next check" line. The advisors runner (use-persona-advisors.ts)
  records when each persona's run STARTED (the same instant it stamps its
  in-memory cooldown); the popover derives "checks again in about Ns" from
  lastRunAtMs + the persona's registry cooldownSeconds.

  Scope & honesty:
  - localStorage-backed per (documentId, slug), so every tab of THIS browser
    shares one clock (a `storage` listener keeps them reactive) — matching
    how runs actually behave: any tab's run consumes the shared budget.
  - It deliberately does NOT see other collaborators' browsers. That is
    acceptable honesty for a countdown: each client triggers its own runs,
    and the server re-checks cooldowns regardless.
  - ZERO presence writes — this is pure local bookkeeping (presence fan-out
    pushes the full roster to every subscriber; a ticking countdown must
    never ride that channel).

  The user-facing label logic (buildNextCheckLabel) lives here too so it is
  unit-testable: internal states map to user language, never raw ms.
*/

const RUN_CLOCK_STORAGE_KEY = "flock_persona_last_run";

/*
  Bound on retained entries — old documents' stamps get evicted.
*/
const MAX_RUN_CLOCK_ENTRIES = 64;

type RunClockMap = Record<string, number>;

let cachedMap: RunClockMap = {};
let hasReadStorage = false;

const listeners = new Set<() => void>();

function buildEntryKey({ documentId, slug }: { documentId: string; slug: string }): string {
  return `${documentId}|${slug}`;
}

function readMapFromStorage(): RunClockMap {
  try {
    const raw = window.localStorage.getItem(RUN_CLOCK_STORAGE_KEY);
    if (raw === null) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    );
    return Object.fromEntries(entries);
  } catch {
    /*
      localStorage unavailable (SSR, privacy mode) or corrupt — no stamps.
    */
    return {};
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshotMap(): RunClockMap {
  if (!hasReadStorage) {
    cachedMap = readMapFromStorage();
    hasReadStorage = true;
  }
  return cachedMap;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const handleStorage = (event: StorageEvent): void => {
    if (event.key === RUN_CLOCK_STORAGE_KEY || event.key === null) {
      cachedMap = readMapFromStorage();
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
  Stamp a persona's run start (called where the runner stamps its cooldown).
*/
export function recordPersonaRunStart({
  documentId,
  slug,
  atMs,
}: {
  documentId: string;
  slug: string;
  atMs: number;
}): void {
  const current = getSnapshotMap();
  const next: RunClockMap = { ...current, [buildEntryKey({ documentId, slug })]: atMs };
  const keys = Object.keys(next);
  if (keys.length > MAX_RUN_CLOCK_ENTRIES) {
    /*
      Evict the oldest stamps (stale documents) to keep the record bounded.
    */
    const sortedByAge = keys.sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0));
    for (const key of sortedByAge.slice(0, keys.length - MAX_RUN_CLOCK_ENTRIES)) {
      delete next[key];
    }
  }
  cachedMap = next;
  hasReadStorage = true;
  try {
    window.localStorage.setItem(RUN_CLOCK_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /*
      In-memory stamp still applies for this tab.
    */
  }
  notifyListeners();
}

/*
  ---------------------------------------------------------------------------
  Last-checked watch-scope hash (item 27 hash-gated checks)
  ---------------------------------------------------------------------------
*/

/*
  Beside the run clock: the last watch-scope hash each (document, persona)
  was checked against. The runner skips a due persona entirely — no API
  call, no presence churn — when its scope hash hasn't changed since the
  last check. localStorage so reloads and sibling tabs share the baseline;
  non-reactive on purpose (only the runner reads it, at call time).
*/
const CHECKED_HASH_STORAGE_KEY = "flock_persona_last_hash";

interface CheckedHashEntry {
  hash: string;
  atMs: number;
}

type CheckedHashMap = Record<string, CheckedHashEntry>;

let cachedHashMap: CheckedHashMap | null = null;

function readHashMapFromStorage(): CheckedHashMap {
  try {
    const raw = window.localStorage.getItem(CHECKED_HASH_STORAGE_KEY);
    if (raw === null) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, CheckedHashEntry] => {
        const value = entry[1] as { hash?: unknown; atMs?: unknown };
        return typeof value === "object" && value !== null && typeof value.hash === "string" && typeof value.atMs === "number";
      },
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function getHashMap(): CheckedHashMap {
  if (cachedHashMap === null) {
    cachedHashMap = readHashMapFromStorage();
  }
  return cachedHashMap;
}

/*
  The last-checked scope hash for one (document, persona), or null.
*/
export function getPersonaCheckedHash({
  documentId,
  slug,
}: {
  documentId: string;
  slug: string;
}): string | null {
  return getHashMap()[buildEntryKey({ documentId, slug })]?.hash ?? null;
}

/*
  Stamp the scope hash a check ran against (called beside the run stamp).
*/
export function recordPersonaCheckedHash({
  documentId,
  slug,
  hash,
  atMs,
}: {
  documentId: string;
  slug: string;
  hash: string;
  atMs: number;
}): void {
  const next: CheckedHashMap = {
    ...getHashMap(),
    [buildEntryKey({ documentId, slug })]: { hash, atMs },
  };
  const keys = Object.keys(next);
  if (keys.length > MAX_RUN_CLOCK_ENTRIES) {
    const sortedByAge = keys.sort((a, b) => (next[a]?.atMs ?? 0) - (next[b]?.atMs ?? 0));
    for (const key of sortedByAge.slice(0, keys.length - MAX_RUN_CLOCK_ENTRIES)) {
      delete next[key];
    }
  }
  cachedHashMap = next;
  try {
    window.localStorage.setItem(CHECKED_HASH_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /*
      In-memory stamp still applies for this tab.
    */
  }
}

const NO_RUN_AT_MS = null;

/*
  Reactive last-run stamp for one persona on one document (null = this
  browser has never triggered a run for it).
*/
export function usePersonaLastRunAtMs({
  documentId,
  slug,
}: {
  documentId: string | null;
  slug: string;
}): number | null {
  return useSyncExternalStore(
    subscribe,
    () =>
      documentId === null
        ? NO_RUN_AT_MS
        : (getSnapshotMap()[buildEntryKey({ documentId, slug })] ?? NO_RUN_AT_MS),
    () => NO_RUN_AT_MS,
  );
}

/*
  ---------------------------------------------------------------------------
  User-facing "next check" label
  ---------------------------------------------------------------------------
*/

/*
  The popover's one-line answer to "when does this agent check again?" —
  user-facing language only (owner principle: never internal names or raw
  timings):
  - paused                          → "Paused — check manually" (the manual
    "Check now" button beside it still works while paused)
  - a run in flight (reading/
    thinking presence status)       → "Checking now…"
  - inside the cooldown window      → "Checks again in about Ns" (or minutes)
  - past cooldown / never ran       → "Waiting for changes" (honest: a check
    fires on the next edit, not on a timer)
*/
export function buildNextCheckLabel({
  isPaused,
  personaStatus,
  lastRunAtMs,
  cooldownSeconds,
  nowMs,
}: {
  isPaused: boolean;
  personaStatus: "idle" | "reading" | "thinking" | undefined;
  lastRunAtMs: number | null;
  cooldownSeconds: number | null;
  nowMs: number;
}): string {
  if (isPaused) {
    return "Paused — check manually";
  }
  if (personaStatus === "reading" || personaStatus === "thinking") {
    return "Checking now…";
  }
  if (lastRunAtMs === null || cooldownSeconds === null) {
    return "Waiting for changes";
  }
  const remainingMs = lastRunAtMs + cooldownSeconds * 1000 - nowMs;
  if (remainingMs <= 0) {
    return "Waiting for changes";
  }
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  if (remainingSeconds >= 90) {
    return `Checks again in about ${Math.round(remainingSeconds / 60)} minutes`;
  }
  return remainingSeconds === 1
    ? "Checks again in about 1 second"
    : `Checks again in about ${remainingSeconds} seconds`;
}
