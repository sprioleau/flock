"use client";

import { useSyncExternalStore } from "react";

/**
 * A tiny module-scope broadcast of the chat agent's busy state, for surfaces
 * that mount OUTSIDE ChatPanel (the drafts menu's AI generation items disable
 * themselves while a turn is running). Same seam shape as composer-handoff.ts:
 * ChatPanel — the one owner of the chat status — publishes on every status
 * change; consumers read reactively through `useSyncExternalStore`.
 *
 * "Busy" here matches ChatPanel's own definition: a turn is submitted or
 * streaming, or a tool approval is pending. Queued messages are deliberately
 * NOT included — consumers that care about queue depth own that decision.
 */

let isAgentBusy = false;

const listeners = new Set<() => void>();

/** ChatPanel publishes its live busy state here (no-op when unchanged). */
export function publishAgentBusyState(nextIsAgentBusy: boolean): void {
  if (nextIsAgentBusy === isAgentBusy) {
    return;
  }
  isAgentBusy = nextIsAgentBusy;
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

const getSnapshot = (): boolean => isAgentBusy;

/** SSR/first paint: the agent is never busy before ChatPanel mounts. */
const getServerSnapshot = (): boolean => false;

/** Reactive agent busy state for surfaces outside ChatPanel. */
export function useIsAgentBusy(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
