"use client";

import { useSyncExternalStore } from "react";
import { MOCK_MODEL_HEADER } from "@/lib/chat-contract";
import { recordPersonaRunStart } from "./persona-run-clock";

/**
 * Manual persona sweep — "Check now" (owner ask, 2026-07-31): the human can
 * walk into a document and ask the enabled agents for a fresh review of the
 * CURRENT state, without waiting for a settled edit or a cooldown window.
 *
 * Semantics:
 * - Bypasses the client-side settled-edit trigger entirely (this module
 *   calls /api/personas directly) and sends `isManualSweep: true`, which
 *   tells the route to skip its cooldown + outline-unchanged backstops.
 * - LEGITIMATE WHILE PAUSED: pause stops the ambient watcher's spend; an
 *   explicit click is the user choosing to spend one call. The pause flag is
 *   not touched.
 * - Single-flight across every "Check now" button (module-level flag exposed
 *   via useIsPersonaSweepInFlight) — one batched Gemini call at most; the
 *   route's per-document in-flight guard is the server backstop.
 * - Stamps the run clock for the swept personas so the facepile popover's
 *   "checks again" countdown reflects the manual run too.
 *
 * Findings land in Convex exactly like an ambient run's (the route persists
 * them; reactive queries deliver them to every tab), and the status
 * choreography (reading → thinking → idle, cursor presentation) plays as
 * normal because the route writes the same presence statuses.
 */

let isSweepInFlight = false;

const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reactive: is a manual sweep currently running? (Disables the buttons.) */
export function useIsPersonaSweepInFlight(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isSweepInFlight,
    () => false,
  );
}

interface SweepResult {
  isOk: boolean;
  /** Server-side skip (e.g. another run already in flight). */
  skippedReason?: string;
}

/** Fresh-tokens note the model sees for a manual sweep. */
const MANUAL_SWEEP_TRIGGER_SUMMARY =
  "The user explicitly asked for a fresh review of the email as it is right now.";

/**
 * Run one manual sweep for the given personas (all enabled ones for the
 * sweep-all button; a single slug for a persona popover's button).
 */
export async function requestPersonaSweep({
  documentId,
  personaSlugs,
  isMockRun = false,
}: {
  documentId: string;
  personaSlugs: readonly string[];
  /*
    Ask the route for its deterministic mock findings instead of a model call —
    the chat route's `x-flock-mock: 1` convention, and everything downstream of
    the call (dry-run, persistence, presence choreography, staleness) stays
    real. The scripted /demo run is the caller that wants this: a public route
    cannot spend a shared free-tier quota per visitor.

    Note where the authority sits. A client header can only ever ask for LESS
    spend, so it is safe for a caller to set — but it is not a guard, because
    an abuser can simply not send it. Forcing the mock server-side from the
    document itself needs an `isDemo` field on `documents`, which is a schema
    change and therefore a separate stage.
  */
  isMockRun?: boolean;
}): Promise<SweepResult> {
  if (isSweepInFlight || personaSlugs.length === 0) {
    return { isOk: false };
  }
  isSweepInFlight = true;
  notifyListeners();
  try {
    const nowMs = Date.now();
    for (const slug of personaSlugs) {
      recordPersonaRunStart({ documentId, slug, atMs: nowMs });
    }
    const response = await fetch("/api/personas", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isMockRun ? { [MOCK_MODEL_HEADER]: "1" } : {}),
      },
      body: JSON.stringify({
        documentId,
        personaSlugs: [...personaSlugs],
        triggerSummary: MANUAL_SWEEP_TRIGGER_SUMMARY,
        isManualSweep: true,
      }),
    });
    const payload = (await response.json()) as
      | { isOk: true; skippedReason?: string }
      | { isOk: false; message: string };
    if (!payload.isOk) {
      console.warn("[personas] manual sweep failed:", payload.message);
      return { isOk: false };
    }
    return { isOk: true, ...(payload.skippedReason !== undefined ? { skippedReason: payload.skippedReason } : {}) };
  } catch (error) {
    console.warn("[personas] manual sweep failed:", error);
    return { isOk: false };
  } finally {
    isSweepInFlight = false;
    notifyListeners();
  }
}
