/*
  What entering /demo writes into this browser, and what leaving it puts back.

  /demo IS THE REAL STUDIO, not a second application (demo-mode.md §C). It
  provisions a scratch document, writes a PRESET into the same localStorage
  keys the settings FAB already owns, and hands the visitor to /studio. That
  buys a demo with zero new gating branches anywhere in the studio: every
  surface it wants revealed (time-travel replay, the op inspector, the two
  agents) is already reading these keys, so nothing needs to learn the word
  "demo" to take part.

  The cost of a browser-global preset, and how it is paid: persona enablement
  and app settings are per-BROWSER, not per-document, so a visitor who tries
  the demo and then opens their own draft would otherwise find demo mode on and
  two agents enabled that they never asked for. Entering therefore SNAPSHOTS
  the three raw localStorage values first, and the exit path writes them back
  verbatim. Residual risk, stated rather than hidden: someone who closes the
  tab mid-demo keeps the preset until they come back and exit properly.

  Raw STRINGS in and out, never parsed-and-rebuilt values, for the restore
  half: a snapshot that re-serializes what it read can silently drop a key some
  other release added, and the whole point of the snapshot is that the visitor
  gets back exactly what they had.

  Every function here is pure so the two rules that would actually hurt if they
  broke — the preset enables the right things, and re-entering /demo never
  overwrites the real prior settings with demo ones — are unit-testable.
*/

import { DEMO_PERSONA_SLUGS } from "./demo-turns";

/* The keys the preset touches, owned by app-settings.ts, enabled-personas.ts
   and tour-progress.ts respectively. Re-declared rather than imported because
   those modules are "use client" localStorage stores and this one is pure. */
export const APP_SETTINGS_STORAGE_KEY = "flock:app-settings";
export const ENABLED_PERSONAS_STORAGE_KEY = "flock_enabled_agents";
export const TOUR_PROGRESS_STORAGE_KEY = "flock:tour-progress";
export const DEMO_SESSION_STORAGE_KEY = "flock:demo-session";

/** The three raw values as they were before the demo touched them. */
export interface DemoRestoreSnapshot {
  appSettingsRaw: string | null;
  enabledPersonasRaw: string | null;
  tourProgressRaw: string | null;
}

export interface DemoSession {
  /** The scratch document this demo run belongs to. */
  documentId: string;
  startedAtMs: number;
  restore: DemoRestoreSnapshot;
}

/**
 * The app-settings value the demo writes: the visitor's own settings with the
 * three power-user lenses forced on.
 *
 * A MERGE over the prior value, not a fresh object — an unrelated setting
 * (their chat provider choice, their suggestions preference) must survive the
 * demo, because the demo is their own browser and not a sandbox.
 */
export function buildDemoAppSettingsRaw(priorRaw: string | null): string {
  let prior: Record<string, unknown> = {};
  try {
    const parsed: unknown = priorRaw === null ? null : JSON.parse(priorRaw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      prior = parsed as Record<string, unknown>;
    }
  } catch {
    /* Corrupt stored settings cost the visitor their preferences for one
       demo, which is a far better failure than a demo that will not start. */
  }
  return JSON.stringify({
    ...prior,
    /* Reveals the chat panel's demo controls and the ghost collaborator. */
    isDemoModeEnabled: true,
    /* Stop 5 of the narration: the visitor rewinds what they just did. */
    isTimeTravelReplayEnabled: true,
    /* "None of this is magic — it's a log." */
    isOpInspectorEnabled: true,
  });
}

/**
 * Exactly the two agents the demo is about. Not a union with whatever the
 * visitor already had enabled: four agents on a demo canvas is noise, and the
 * narration names two.
 */
export function buildDemoEnabledPersonasRaw(): string {
  return JSON.stringify([...DEMO_PERSONA_SLUGS]);
}

/**
 * The tour progress the demo writes: dismissed.
 *
 * The first-run walkthrough AUTO-STARTS for anyone who has never seen it, and
 * a stranger arriving at /demo is exactly that person. Left alone, its card
 * would appear over the demo and the two would narrate at each other — and
 * worse, `shouldSkipAdvisorRun()` suppresses every advisory run while the tour
 * is on screen, so the agents this route exists to show would go quiet.
 *
 * Suppress rather than sequence, and put it back on exit: whichever entry the
 * visitor came in through wins, and the two never run for the same person at
 * the same time.
 */
export function buildDemoTourProgressRaw(): string {
  return JSON.stringify({ status: "dismissed", resumeStopId: null });
}

/**
 * The snapshot to persist when entering /demo.
 *
 * The load-bearing rule is the second argument: if a demo session is ALREADY
 * active, its snapshot is carried forward untouched. "Start over" re-enters
 * /demo, and without this rule the second entry would snapshot the DEMO's own
 * settings as the visitor's prior ones and cement them forever.
 */
export function buildDemoRestoreSnapshot({
  current,
  activeSession,
}: {
  current: DemoRestoreSnapshot;
  activeSession: DemoSession | null;
}): DemoRestoreSnapshot {
  return activeSession?.restore ?? current;
}

/** Tolerant read of the stored session; null for anything unrecognizable. */
export function parseDemoSession(raw: string | null): DemoSession | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    const restore = candidate.restore;
    if (typeof candidate.documentId !== "string" || candidate.documentId.length === 0) {
      return null;
    }
    if (typeof restore !== "object" || restore === null) {
      return null;
    }
    const restoreCandidate = restore as Record<string, unknown>;
    return {
      documentId: candidate.documentId,
      startedAtMs: typeof candidate.startedAtMs === "number" ? candidate.startedAtMs : 0,
      restore: {
        appSettingsRaw: readNullableString(restoreCandidate.appSettingsRaw),
        enabledPersonasRaw: readNullableString(restoreCandidate.enabledPersonasRaw),
        tourProgressRaw: readNullableString(restoreCandidate.tourProgressRaw),
      },
    };
  } catch {
    return null;
  }
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Is THIS document the scripted demo's scratch document?
 *
 * Every demo surface gates on this rather than on "a demo session exists", so
 * a stale session record can never make the demo panel appear over somebody's
 * real draft in another tab.
 */
export function selectIsDemoDocument({
  session,
  documentId,
}: {
  session: DemoSession | null;
  documentId: string | null;
}): boolean {
  return session !== null && documentId !== null && session.documentId === documentId;
}
