"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useOptionalPresenceRoster,
  type PresenceData,
  type PresenceRosterEntry,
} from "@/lib/presence";
import { usePointerPresence } from "./usePointerPresence";
import "./pointer-presence.css";

/**
 * Pointer presence RENDER (read half) + capture mount: Figma-style live mouse
 * cursors for every OTHER online room member, plus the local capture hook
 * ({@link usePointerPresence}) attached to the canvas root.
 *
 * Mounted as the last child of the `[data-dnd-canvas-root]` div (which is
 * `relative`), so the overlay lives in canvas-CONTENT space: each remote
 * `blockId` + fractions payload is resolved against the LOCAL layout (anchor
 * block rect measured relative to the overlay rect), which makes positions
 * land on the same content regardless of canvas width or preview mode, makes
 * scrolling free (the overlay scrolls with the content), and clips offscreen
 * cursors naturally at the `.email-canvas` scrollport (v1: no edge
 * affordances).
 *
 * Smoothing is pure CSS: the provider delivers ~5 positions/sec and a
 * `transform` transition (~180ms linear) glides between them — no JS
 * animation loop, zero layout impact (see pointer-presence.css for the layer
 * contract and z-order).
 *
 * Hide rules: self, offline, no `pointer` payload (sender cleared it), anchor
 * block missing in the local DOM, or payload unchanged for >6s of local
 * receipt time (belt-and-braces against a tab that died between heartbeats —
 * no clock sync needed). Unresolvable/stale cursors fade out in place.
 */

type PointerPresencePayload = NonNullable<PresenceData["pointer"]>;

/*
  Local-receipt staleness: same pointer value for this long → fade out.
*/
const STALE_HIDE_MS = 6000;

export function PointerPresenceOverlay() {
  const roster = useOptionalPresenceRoster();
  if (roster === null) {
    return null; /* no presence room (no document open / no provider) */
  }
  return <PointerOverlayLayer roster={roster} />;
}

function PointerOverlayLayer({ roster }: { roster: PresenceRosterEntry[] }) {
  const canvasRootRef = useRef<HTMLElement | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);

  /*
    STABLE ref callback (identity must never change): an inline callback
    would be detached (ref set to null) in every commit's mutation phase and
    re-attached only AFTER child layout effects ran — exactly when the
    cursors need the canvas root.
  */
  const attachOverlayElement = useCallback((element: HTMLDivElement | null): void => {
    canvasRootRef.current = element?.parentElement ?? null;
  }, []);

  /*
    Write half: capture THIS user's pointer on the canvas root (our parent).
  */
  usePointerPresence({ canvasRootRef });

  /*
    Re-anchor cursors on local layout shifts (viewport toggle, text reflow,
    blocks added/removed) — content height/width changes resize the canvas
    root, so one ResizeObserver covers them.
  */
  useEffect(() => {
    const canvasRoot = canvasRootRef.current;
    if (canvasRoot === null) {
      return;
    }
    const observer = new ResizeObserver(() => setLayoutVersion((version) => version + 1));
    observer.observe(canvasRoot);
    return () => observer.disconnect();
  }, []);

  const remoteCursors = roster.flatMap((entry) => {
    const pointer = entry.data.pointer;
    if (entry.isSelf || !entry.isOnline || pointer === undefined) {
      return [];
    }
    return [{ userId: entry.userId, name: entry.data.name, color: entry.data.color, pointer }];
  });

  return (
    <div
      ref={attachOverlayElement}
      className="flock-pointer-overlay"
      aria-hidden
      data-testid="pointer-presence-overlay"
    >
      {remoteCursors.map((cursor) => (
        <RemotePointerCursor
          key={cursor.userId}
          name={cursor.name}
          color={cursor.color}
          blockId={cursor.pointer.blockId}
          x={cursor.pointer.x}
          y={cursor.pointer.y}
          layoutVersion={layoutVersion}
        />
      ))}
    </div>
  );
}

/*
  Anchor-relative position of a remote pointer in overlay (= canvas-content)
  space, or null when it can't be resolved locally (anchor block deleted /
  not yet rendered here, zero-size rects mid-layout). Shared with
  PersonaCursorOverlay so persona cursors land on the same content geometry
  as human ones.
*/
export function resolvePointerPosition({
  pointer,
  overlayElement,
}: {
  pointer: PointerPresencePayload;
  overlayElement: HTMLElement;
}): { left: number; top: number } | null {
  const overlayRect = overlayElement.getBoundingClientRect();
  if (overlayRect.width <= 0 || overlayRect.height <= 0) {
    return null;
  }
  if (pointer.blockId !== null) {
    /*
      Scoped to THIS overlay's canvas (multi-frame editing): several frames
      render live canvases at once and forked sibling drafts share block
      ids, so a document-wide query could anchor the cursor to another
      frame's copy of the block.
    */
    const canvasRoot = overlayElement.closest<HTMLElement>("[data-dnd-canvas-root]");
    const blockElement = (canvasRoot ?? document).querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(pointer.blockId)}"]`,
    );
    if (blockElement === null) {
      return null; /* anchor block missing locally → hidden until the next update */
    }
    const blockRect = blockElement.getBoundingClientRect();
    if (blockRect.width <= 0 || blockRect.height <= 0) {
      return null;
    }
    return {
      left: blockRect.left - overlayRect.left + pointer.x * blockRect.width,
      top: blockRect.top - overlayRect.top + pointer.y * blockRect.height,
    };
  }
  /*
    Canvas-fraction fallback (off-block hover): horizontally exact,
    vertically approximate across differing canvas widths.
  */
  return { left: pointer.x * overlayRect.width, top: pointer.y * overlayRect.height };
}

function RemotePointerCursor({
  name,
  color,
  blockId,
  x,
  y,
  layoutVersion,
}: {
  name: string;
  color: string;
  /*
    Primitive pointer fields (not the payload object) so the positioning
    effect keys on values, immune to roster identity churn.
  */
  blockId: string | null;
  x: number;
  y: number;
  layoutVersion: number;
}) {
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const hasEverPositionedRef = useRef(false);
  const staleTimerRef = useRef<number | null>(null);

  /*
    Imperative positioning: resolve against the local layout and move the
    chip via transform — the CSS transition supplies the smoothing. The
    overlay is read as parentElement (not a ref prop): a parent's callback
    ref would be detached during commits exactly when this effect runs. The
    same effect (re)arms the reader-side stale fuse (hide rule 4): a pointer
    whose VALUE hasn't changed for ~6s of local receipt time fades out,
    covering a sender that died between heartbeats — no clock sync needed.
  */
  useLayoutEffect(() => {
    const cursorElement = cursorRef.current;
    const overlayElement = cursorElement?.parentElement ?? null;
    if (cursorElement === null || overlayElement === null) {
      return;
    }
    const position = resolvePointerPosition({ pointer: { blockId, x, y }, overlayElement });
    if (position !== null) {
      const transform = `translate(${position.left}px, ${position.top}px)`;
      if (hasEverPositionedRef.current) {
        cursorElement.style.transform = transform;
      } else {
        /*
          Materialize at the first known position instead of gliding in from
          the overlay origin: place it with the transition disarmed, flush,
          then re-arm for subsequent moves.
        */
        hasEverPositionedRef.current = true;
        cursorElement.style.transition = "none";
        cursorElement.style.transform = transform;
        void cursorElement.getBoundingClientRect();
        cursorElement.style.transition = "";
      }
    }
    cursorElement.style.opacity = position !== null ? "1" : "0";
    if (staleTimerRef.current !== null) {
      window.clearTimeout(staleTimerRef.current);
    }
    staleTimerRef.current = window.setTimeout(() => {
      cursorElement.style.opacity = "0";
    }, STALE_HIDE_MS);
    return () => {
      if (staleTimerRef.current !== null) {
        window.clearTimeout(staleTimerRef.current);
        staleTimerRef.current = null;
      }
    };
  }, [blockId, x, y, layoutVersion]);

  return (
    <div ref={cursorRef} className="flock-pointer-cursor" data-testid="remote-pointer-cursor">
      <PointerCursorArrow color={color} />
      <span className="flock-pointer-cursor__label" style={{ backgroundColor: color }}>
        {name}
      </span>
    </div>
  );
}

/*
  The shared cursor arrow glyph — its tip sits at the element origin, exactly
  on the resolved point. Used by human remote cursors here and by
  PersonaCursorOverlay (personas share the human cursor grammar on purpose —
  owner decision 2026-07-30 overriding the §3.5 chip recommendation).
*/
export function PointerCursorArrow({ color }: { color: string }) {
  return (
    <svg
      className="flock-pointer-cursor__arrow"
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
    >
      <path
        d="M1 1 L1 12.5 L4.2 9.6 L6.3 13.8 L8.6 12.7 L6.6 8.6 L10.9 8.6 Z"
        fill={color}
        stroke="white"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
