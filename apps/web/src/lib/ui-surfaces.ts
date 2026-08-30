"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { UiPanel } from "@flock/email-sdk";

/*
  ui-surfaces — the named-intent seam between "something asked" and "a surface
  answered".

  THE RULE THIS FILE EXISTS TO ENFORCE (stated in full in lib/tour/tour-intents.ts):
  a caller NAMES AN INTENT THE APP ALREADY SUPPORTS, never a DOM interaction.
  No `document.querySelector(...).click()` anywhere downstream of here. A
  synthesized click needs a selector that can go stale, races the target's
  mount, and diverges from what a real interaction does the first time either
  end changes.

  The mechanism is a tiny module store (the panel-preferences/app-settings
  idiom: useSyncExternalStore over module state) holding the LATEST request on
  a channel. Each host keeps its own local state and subscribes; when a request
  names it, it runs its own mechanism. No component refs, no prop drilling, and
  human-owned state is untouched.

  Requests are monotonic, so the same name can be requested repeatedly and
  still fire; and a host mounted AFTER a request was issued ignores it —
  requests belong to the moment they were issued, matching the
  dropped-view-command rule in use-flock-chat.

  TWO CHANNELS, DELIBERATELY SEPARATE (see the attention channel below for the
  why): "open this surface" and "you are already looking at this surface —
  here" are different intents with different vocabularies, and only the first
  one is a published agent capability.
*/

/*
  One request on a channel: which host it names, and when it was issued.
*/
export interface UiIntentRequest<TName extends string> {
  name: TName;
  /*
    Monotonic per-request id — a repeat request of the same name still fires.
  */
  requestId: number;
}

export interface UiIntentChannel<TName extends string> {
  request: (name: TName) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UiIntentRequest<TName> | null;
  getServerSnapshot: () => UiIntentRequest<TName> | null;
}

/*
  One channel's worth of module state, in a closure rather than at file scope,
  so a second channel is a second call rather than a second copy of this logic.
  Exported because it is also the only way to exercise the round trip in a test:
  vitest pins `environment: "node"` for src/**, so the hook below cannot be
  rendered, but a fresh channel can be driven directly and asserted on.
*/
export function createUiIntentChannel<TName extends string>(): UiIntentChannel<TName> {
  let latestRequest: UiIntentRequest<TName> | null = null;
  let nextRequestId = 1;
  const listeners = new Set<() => void>();

  return {
    request(name: TName): void {
      latestRequest = { name, requestId: nextRequestId };
      nextRequestId += 1;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): UiIntentRequest<TName> | null {
      return latestRequest;
    },
    /*
      Nothing has been requested during SSR by definition, and returning the
      live value here would be a hydration mismatch waiting to happen.
    */
    getServerSnapshot(): UiIntentRequest<TName> | null {
      return null;
    },
  };
}

/*
  The whole of a subscriber's decision, as a pure function: is this request
  mine, and is it newer than the last one I ran? Both halves are load-bearing —
  dropping the name check runs every host on every request, and dropping the id
  check re-runs the same request on every unrelated re-render.
*/
export function getShouldHandleUiIntent<TName extends string>({
  request,
  name,
  lastHandledRequestId,
}: {
  request: UiIntentRequest<TName>;
  name: TName;
  lastHandledRequestId: number;
}): boolean {
  return request.name === name && request.requestId > lastHandledRequestId;
}

/*
  Subscribe one host to one name on one channel. The handler is kept in a ref so
  hosts can pass inline closures over their local state setters without
  effect-dependency churn.
*/
function useUiIntentRequest<TName extends string>({
  channel,
  name,
  onRequested,
}: {
  channel: UiIntentChannel<TName>;
  name: TName;
  onRequested: () => void;
}): void {
  const request = useSyncExternalStore(
    channel.subscribe,
    channel.getSnapshot,
    channel.getServerSnapshot,
  );

  const handlerRef = useRef(onRequested);
  useEffect(() => {
    handlerRef.current = onRequested;
  });

  /*
    Requests issued before this host mounted are stale — never replay them.
  */
  const lastHandledRequestIdRef = useRef(channel.getSnapshot()?.requestId ?? 0);

  useEffect(() => {
    if (request === null) {
      return;
    }
    if (
      !getShouldHandleUiIntent({
        request,
        name,
        lastHandledRequestId: lastHandledRequestIdRef.current,
      })
    ) {
      return;
    }
    lastHandledRequestIdRef.current = request.requestId;
    handlerRef.current();
  }, [channel, request, name]);
}

/*
  CHANNEL 1 — "open this surface" (the agent-parity openPanel command).

  `UiPanel` is the SDK's published enum (packages/email-sdk §editor-commands):
  every name on it is something the copilot can be asked to open, and its
  descriptions are part of the model-facing tool schema.
*/
const openChannel = createUiIntentChannel<UiPanel>();

/*
  Ask the surface registered under `panel` to open itself.
*/
export function requestUiSurfaceOpen(panel: UiPanel): void {
  openChannel.request(panel);
}

/*
  Subscribe one surface host to its open requests: `onOpenRequested` runs once
  per requestUiSurfaceOpen call naming `panel` (issued after mount).
*/
export function useUiSurfaceOpenRequest(panel: UiPanel, onOpenRequested: () => void): void {
  useUiIntentRequest({ channel: openChannel, name: panel, onRequested: onOpenRequested });
}

/*
  CHANNEL 2 — "draw the eye here" (added 2026-08-18 for the /demo dead end).

  WHY A SECOND CHANNEL RATHER THAN A SECOND `UiPanel` NAME. The two intents are
  genuinely different and the surfaces answering them are different too:

  - `UiPanel` is a MODEL-FACING SCHEMA. Adding "suggestions" to it would widen
    what the copilot can be asked to do and change a published tool description
    — a large blast radius for an in-app cue nobody is asking an agent for.
  - "Open" and "attend" are not the same request. The suggestions tray is not a
    dialog with an open state; it is already on screen. Asking it to OPEN would
    be answered by the thing that is already true, which is precisely the bug
    this channel was added to fix: /demo step 2's "Show the agents' cards"
    expanded an already-expanded chat panel and produced nothing observable.

  WHAT A HOST IS EXPECTED TO DO WITH IT — and this is the part that is not
  optional: reveal whatever it has collapsed, MOVE FOCUS to itself, and show a
  brief highlight. Focus is not decoration here. A cue made only of animation is
  invisible to a screen reader and to anyone driving by keyboard, and it is also
  the cue most likely to be missed by a sighted visitor looking at the other
  side of the screen. Focus lands the caret where the next action is for
  everyone, and the highlight tells the eye the same thing.
*/
export type UiAttentionRegion = "suggestions";

const attentionChannel = createUiIntentChannel<UiAttentionRegion>();

/*
  Ask the region registered under `region` to reveal and announce itself.
*/
export function requestUiSurfaceAttention(region: UiAttentionRegion): void {
  attentionChannel.request(region);
}

/*
  Subscribe one region to its attention requests: `onAttentionRequested` runs
  once per requestUiSurfaceAttention call naming `region` (issued after mount).
*/
export function useUiSurfaceAttentionRequest(
  region: UiAttentionRegion,
  onAttentionRequested: () => void,
): void {
  useUiIntentRequest({
    channel: attentionChannel,
    name: region,
    onRequested: onAttentionRequested,
  });
}
