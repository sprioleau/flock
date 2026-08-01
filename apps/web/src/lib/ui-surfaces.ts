"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { UiPanel } from "@flock/email-sdk";

/**
 * ui-surfaces — the agent-parity "open a panel" seam (openPanel command).
 *
 * A tiny module store (the panel-preferences/app-settings idiom:
 * useSyncExternalStore over module state) holding the LATEST open request.
 * Each surface host (BrandKitPanel, LibraryPanel, HistoryPanel, …) keeps its
 * existing local open state and subscribes with {@link useUiSurfaceOpenRequest};
 * when a new request targets its panel name it runs its own open mechanism.
 * The chat's editor-command dispatcher calls {@link requestUiSurfaceOpen} —
 * no component refs, no prop drilling, and human-owned open state is
 * untouched.
 *
 * Requests are monotonic ({@link UiSurfaceOpenRequest.requestId}) so the same
 * panel can be requested repeatedly, and a host mounted AFTER a request was
 * issued ignores it (open commands belong to the moment they were issued,
 * matching the dropped-view-command rule in use-flock-chat).
 */

export interface UiSurfaceOpenRequest {
  panel: UiPanel;
  /** Monotonic per-request id — a repeat open of the same panel still fires. */
  requestId: number;
}

let latestRequest: UiSurfaceOpenRequest | null = null;
let nextRequestId = 1;

const listeners = new Set<() => void>();

/** Ask the surface registered under `panel` to open itself. */
export function requestUiSurfaceOpen(panel: UiPanel): void {
  latestRequest = { panel, requestId: nextRequestId };
  nextRequestId += 1;
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

function getSnapshot(): UiSurfaceOpenRequest | null {
  return latestRequest;
}

function getServerSnapshot(): UiSurfaceOpenRequest | null {
  return null;
}

/**
 * Subscribe one surface host to its open requests: `onOpenRequested` runs
 * once per {@link requestUiSurfaceOpen} call targeting `panel` (issued after
 * mount). The handler is kept in a ref so hosts can pass inline closures over
 * their local `setIsOpen` without effect-dependency churn.
 */
export function useUiSurfaceOpenRequest(panel: UiPanel, onOpenRequested: () => void): void {
  const request = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const handlerRef = useRef(onOpenRequested);
  useEffect(() => {
    handlerRef.current = onOpenRequested;
  });

  // Requests issued before this host mounted are stale — never replay them.
  const lastHandledRequestIdRef = useRef(latestRequest?.requestId ?? 0);

  useEffect(() => {
    if (request === null || request.panel !== panel) {
      return;
    }
    if (request.requestId <= lastHandledRequestIdRef.current) {
      return;
    }
    lastHandledRequestIdRef.current = request.requestId;
    handlerRef.current();
  }, [request, panel]);
}
