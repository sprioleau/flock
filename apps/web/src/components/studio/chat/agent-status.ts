"use client";

import { useSyncExternalStore } from "react";
import type { Id } from "@convex/_generated/dataModel";

/**
 * A tiny module-scope broadcast of the chat agent's busy state, for surfaces
 * that mount OUTSIDE ChatPanel (the drafts menu's AI generation items disable
 * themselves while a turn is running; the frames canvas shows the generation
 * working state on the targeted frame). Same seam shape as
 * composer-handoff.ts: ChatPanel — the one owner of the chat status —
 * publishes on every status change; consumers read reactively through
 * `useSyncExternalStore`.
 *
 * "Busy" here matches ChatPanel's own definition: a turn is submitted or
 * streaming, or a tool approval is pending. Queued messages are deliberately
 * NOT included — consumers that care about queue depth own that decision.
 *
 * GENERATION TARGET: the drafts menu's AI flows ("Ideate with AI" / "Add
 * design variation") additionally publish WHICH document the generation turn
 * streams into, right before handing the prompt to the composer. Only that
 * frame shows the working state (spinner, glow border, edit lock). The
 * target clears automatically on the next busy→idle edge — turn settled OR
 * error-paused — so a frame can never stay locked behind a finished turn.
 */

let isAgentBusy = false;
let generationTargetDocumentId: Id<"documents"> | null = null;

const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** ChatPanel publishes its live busy state here (no-op when unchanged). */
export function publishAgentBusyState(nextIsAgentBusy: boolean): void {
  if (nextIsAgentBusy === isAgentBusy) {
    return;
  }
  isAgentBusy = nextIsAgentBusy;
  if (!nextIsAgentBusy) {
    // The busy→idle edge is the one settle signal every outcome shares
    // (finished turn AND error pause), so the generation target can never
    // outlive its turn.
    generationTargetDocumentId = null;
  }
  notifyListeners();
}

/**
 * The drafts menu's AI flows publish the generation turn's target document
 * here at send time (null to cancel a handoff that never sent).
 */
export function publishGenerationTargetDocument(
  documentId: Id<"documents"> | null,
): void {
  if (documentId === generationTargetDocumentId) {
    return;
  }
  generationTargetDocumentId = documentId;
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getBusySnapshot = (): boolean => isAgentBusy;

/** SSR/first paint: the agent is never busy before ChatPanel mounts. */
const getBusyServerSnapshot = (): boolean => false;

/** Reactive agent busy state for surfaces outside ChatPanel. */
export function useIsAgentBusy(): boolean {
  return useSyncExternalStore(subscribe, getBusySnapshot, getBusyServerSnapshot);
}

const getGenerationTargetSnapshot = (): Id<"documents"> | null => generationTargetDocumentId;

const getGenerationTargetServerSnapshot = (): Id<"documents"> | null => null;

/** The document a live generation turn streams into, or null when none is running. */
export function useGenerationTargetDocumentId(): Id<"documents"> | null {
  return useSyncExternalStore(
    subscribe,
    getGenerationTargetSnapshot,
    getGenerationTargetServerSnapshot,
  );
}
