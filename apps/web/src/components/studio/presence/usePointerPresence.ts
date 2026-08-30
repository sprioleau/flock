"use client";

import { useEffect, type RefObject } from "react";
import { useBroadcastPresence, type PresenceData } from "@/lib/presence";

/*
  Pointer-presence CAPTURE (write half). Listens for pointer movement on the
  editing canvas root (`[data-dnd-canvas-root]`) and broadcasts hybrid
  block-anchored coordinates through the presence provider:

  - primary anchor: the innermost `[data-block-id]` on the event's target
    chain (same hit-test family as dnd's drop-target resolution, but
    `event.target.closest()` — no elementFromPoint needed on a real pointer
    event), with `x`/`y` as 0..1 fractions of that block's rect;
  - fallback anchor (`blockId: null`): fractions of the canvas root rect
    itself, so the cursor never blinks out in the gutters between blocks.

  Every position update goes straight to `broadcast` — the provider's ~200ms
  trailing throttle is the ONLY pacing (never a local debounce; owner latency
  law). This hook additionally skips no-op positions so a resting-but-jittery
  pointer writes nothing.

  Sender-side clears (`pointer: undefined`, i.e. the key is removed): canvas
  `pointerleave`, window blur, and >3s without movement. Timers here exist
  only for CLEARING — they never delay a position update.
*/

type PointerPresencePayload = NonNullable<PresenceData["pointer"]>;

/*
  Idle time without pointer movement before the pointer is cleared for peers.
*/
const IDLE_CLEAR_MS = 3000;

/*
  Clamp to the anchor rect and round to ~0.1% so micro-jitter becomes a no-op.
*/
function toAnchorFraction(args: {
  pointerCoordinate: number;
  rectStart: number;
  rectSize: number;
}): number {
  const fraction = (args.pointerCoordinate - args.rectStart) / args.rectSize;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 1000;
}

export function usePointerPresence({
  canvasRootRef,
}: {
  /*
    The `[data-dnd-canvas-root]` element (the email surface).
  */
  canvasRootRef: RefObject<HTMLElement | null>;
}): void {
  const broadcast = useBroadcastPresence();

  useEffect(() => {
    const canvasRoot = canvasRootRef.current;
    if (canvasRoot === null) {
      return;
    }

    let lastSentPointer: PointerPresencePayload | null = null;
    let idleTimerId: number | null = null;

    const cancelIdleTimer = (): void => {
      if (idleTimerId !== null) {
        window.clearTimeout(idleTimerId);
        idleTimerId = null;
      }
    };

    const clearPointer = (): void => {
      cancelIdleTimer();
      if (lastSentPointer === null) {
        return; /* already cleared — zero writes while idle */
      }
      lastSentPointer = null;
      broadcast({ pointer: undefined });
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const targetElement = event.target instanceof Element ? event.target : null;
      const blockElement = targetElement?.closest<HTMLElement>("[data-block-id]") ?? null;
      const anchorRect = (blockElement ?? canvasRoot).getBoundingClientRect();
      if (anchorRect.width <= 0 || anchorRect.height <= 0) {
        return;
      }
      cancelIdleTimer();
      idleTimerId = window.setTimeout(clearPointer, IDLE_CLEAR_MS);
      const pointer: PointerPresencePayload = {
        blockId: blockElement?.dataset.blockId ?? null,
        x: toAnchorFraction({
          pointerCoordinate: event.clientX,
          rectStart: anchorRect.left,
          rectSize: anchorRect.width,
        }),
        y: toAnchorFraction({
          pointerCoordinate: event.clientY,
          rectStart: anchorRect.top,
          rectSize: anchorRect.height,
        }),
      };
      const isSamePosition =
        lastSentPointer !== null &&
        lastSentPointer.blockId === pointer.blockId &&
        lastSentPointer.x === pointer.x &&
        lastSentPointer.y === pointer.y;
      if (isSamePosition) {
        return;
      }
      lastSentPointer = pointer;
      broadcast({ pointer });
    };

    const handlePointerLeave = (): void => clearPointer();
    const handleWindowBlur = (): void => clearPointer();

    canvasRoot.addEventListener("pointermove", handlePointerMove);
    canvasRoot.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      canvasRoot.removeEventListener("pointermove", handlePointerMove);
      canvasRoot.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("blur", handleWindowBlur);
      clearPointer(); /* don't leave a ghost cursor behind on unmount */
    };
  }, [broadcast, canvasRootRef]);
}
