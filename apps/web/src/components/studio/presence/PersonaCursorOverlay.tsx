"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import { useEditorStore } from "@/lib/editor-store";
import {
  useOptionalPresenceRoster,
  type PresenceData,
  type PresenceRosterEntry,
} from "@/lib/presence";
import { cn } from "@/lib/utils";
import {
  buildFindingHoverAnchor,
  buildReadingLaneX,
  extractPersonaSlugFromPresenceUserId,
} from "./persona-cursor-helpers";
import { PointerCursorArrow, resolvePointerPosition } from "./PointerPresenceOverlay";
import "./pointer-presence.css";

/**
 * Multi-agent canvas v1 — simulated persona mouse cursors (owner spec
 * 2026-07-30, overriding the proposal §3.5 chip recommendation: literal
 * cursor glyphs matching the human remote-cursor grammar, with a
 * thinking/status badge at the cursor that rhymes with the facepile's
 * PersonaStatusDot).
 *
 * CHOREOGRAPHY IS 100% CLIENT-SIDE — zero new presence writes. Both driver
 * signals are already shared reactive state on every collaborator's client,
 * which is what makes the cursors cross-collaborator-consistent for free:
 *
 * - the persona's `status` in the presence roster (written server-side on
 *   state TRANSITIONS only by the existing runner: reading → thinking →
 *   idle, convex/personas.ts setPersonaStatus — §3.5 cost rule);
 * - the document's open findings (personaFindings.listOpenFindings —
 *   identical rows in every tab; dismiss/apply/stale-prune remove a row
 *   reactively everywhere at once).
 *
 * Per online persona, the cursor's activity derives as:
 *
 * 1. status "reading"  → a top-down walk over the local `[data-block-id]`
 *    blocks (~900ms per hop — presentation smoothing over the runner's real
 *    context-assembly phase, the §3.5 "one theatrical liberty"), amber
 *    pulsing badge (the facepile's reading treatment).
 * 2. status "thinking" → parks at its current spot, violet pulsing badge
 *    (a real pending LLM call — the facepile's thinking treatment).
 * 3. idle + an OPEN finding → glides to the newest finding's first target
 *    block and hovers there (gentle CSS bob) at a DETERMINISTIC anchor
 *    hashed from the Convex finding id — every tab computes the same spot —
 *    with the violet "thinking about something" badge at the cursor.
 * 4. idle, no finding → fades out (released). Dismissing/applying a finding
 *    reaches here reactively in all tabs.
 *
 * All motion is CSS interpolation between these sparse logical anchors
 * (~1.1s glide, slower than the humans' 180ms tracking so it reads as
 * attention, not telemetry). No LLM calls, no timers server-side, and the
 * human PointerPresenceOverlay is untouched — personas never write the
 * `pointer` presence field at all.
 */

type FindingRow = FunctionReturnType<typeof api.personaFindings.listOpenFindings>[number];

type PersonaStatus = NonNullable<PresenceData["status"]>;

/** What the cursor is doing right now (drives target, badge, and testids). */
type PersonaCursorActivity = "reading" | "thinking" | "hovering" | "hidden";

/** A logical cursor anchor — the same shape the human pointer payload uses. */
interface PersonaCursorTarget {
  blockId: string | null;
  x: number;
  y: number;
}

/** Reading-walk pace per block hop (≥300ms per §5.4; 900ms reads calmer). */
const READING_HOP_MS = 900;

export function PersonaCursorOverlay() {
  const roster = useOptionalPresenceRoster();
  const documentId = useEditorStore((state) => state.documentId);
  // Shares the subscription with use-persona-advisors' identical query —
  // Convex dedupes watchers, so this costs no extra server reads.
  const findingRows = useQuery(
    api.personaFindings.listOpenFindings,
    documentId !== null ? { documentId } : "skip",
  );
  if (roster === null) {
    return null; // no presence room (no document open / no provider)
  }
  return <PersonaCursorLayer roster={roster} findingRows={findingRows ?? []} />;
}

function PersonaCursorLayer({
  roster,
  findingRows,
}: {
  roster: PresenceRosterEntry[];
  findingRows: FindingRow[];
}) {
  const [layoutVersion, setLayoutVersion] = useState(0);
  const canvasRootRef = useRef<HTMLElement | null>(null);

  // STABLE ref callback — same contract as PointerPresenceOverlay (an inline
  // callback would detach during commits exactly when cursors position).
  const attachOverlayElement = useCallback((element: HTMLDivElement | null): void => {
    canvasRootRef.current = element?.parentElement ?? null;
  }, []);

  // Re-anchor on local layout shifts (viewport toggle, reflow, block churn).
  useEffect(() => {
    const canvasRoot = canvasRootRef.current;
    if (canvasRoot === null) {
      return;
    }
    const observer = new ResizeObserver(() => setLayoutVersion((version) => version + 1));
    observer.observe(canvasRoot);
    return () => observer.disconnect();
  }, []);

  const personaCursors = roster.flatMap((entry) => {
    const slug = extractPersonaSlugFromPresenceUserId(entry.userId);
    if (slug === null || !entry.isOnline) {
      return [];
    }
    // listOpenFindings is newest-first → `find` = the persona's most recent
    // open finding. Rows whose target list is empty can't anchor a hover.
    const finding =
      findingRows.find((row) => row.personaSlug === slug && row.targetBlockIds.length > 0) ??
      null;
    const anchor = finding !== null ? buildFindingHoverAnchor(finding.findingId) : null;
    return [
      {
        userId: entry.userId,
        slug,
        name: entry.data.name,
        color: entry.data.color,
        status: (entry.data.status ?? "idle") as PersonaStatus,
        findingBlockId: finding?.targetBlockIds[0] ?? null,
        findingAnchorX: anchor?.x ?? 0,
        findingAnchorY: anchor?.y ?? 0,
      },
    ];
  });

  return (
    <div
      ref={attachOverlayElement}
      className="tandem-pointer-overlay"
      aria-hidden
      data-testid="persona-cursor-overlay"
    >
      {personaCursors.map((cursor) => (
        <PersonaCursor
          key={cursor.userId}
          slug={cursor.slug}
          name={cursor.name}
          color={cursor.color}
          status={cursor.status}
          findingBlockId={cursor.findingBlockId}
          findingAnchorX={cursor.findingAnchorX}
          findingAnchorY={cursor.findingAnchorY}
          layoutVersion={layoutVersion}
        />
      ))}
    </div>
  );
}

/**
 * The logical anchor for the current activity, resolved against the LOCAL
 * DOM (same local-layout philosophy as the human overlay). Null → hidden.
 */
function resolveActivityTarget({
  activity,
  readingHopCount,
  slug,
  findingBlockId,
  findingAnchorX,
  findingAnchorY,
  overlayElement,
  lastTarget,
}: {
  activity: PersonaCursorActivity;
  readingHopCount: number;
  slug: string;
  findingBlockId: string | null;
  findingAnchorX: number;
  findingAnchorY: number;
  overlayElement: HTMLElement;
  lastTarget: PersonaCursorTarget | null;
}): PersonaCursorTarget | null {
  if (activity === "hovering" && findingBlockId !== null) {
    return { blockId: findingBlockId, x: findingAnchorX, y: findingAnchorY };
  }
  const blockElements =
    overlayElement.parentElement?.querySelectorAll<HTMLElement>("[data-block-id]") ?? null;
  if (activity === "reading") {
    if (blockElements === null || blockElements.length === 0) {
      return null;
    }
    const blockElement = blockElements[readingHopCount % blockElements.length];
    const blockId = blockElement?.dataset.blockId ?? null;
    if (blockId === null) {
      return null;
    }
    // Stable per-persona horizontal lane so two walking personas don't stack.
    return { blockId, x: buildReadingLaneX(slug), y: 0.45 };
  }
  if (activity === "thinking") {
    if (lastTarget !== null) {
      return lastTarget; // park where the walk left off
    }
    const firstBlockId = blockElements?.[0]?.dataset.blockId ?? null;
    return firstBlockId !== null
      ? { blockId: firstBlockId, x: 0.5, y: 0.4 }
      : { blockId: null, x: 0.5, y: 0.15 };
  }
  return null;
}

function PersonaCursor({
  slug,
  name,
  color,
  status,
  findingBlockId,
  findingAnchorX,
  findingAnchorY,
  layoutVersion,
}: {
  slug: string;
  name: string;
  color: string;
  status: PersonaStatus;
  /** Primitive fields (not the row object) so effects key on values. */
  findingBlockId: string | null;
  findingAnchorX: number;
  findingAnchorY: number;
  layoutVersion: number;
}) {
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const hasEverPositionedRef = useRef(false);
  const lastTargetRef = useRef<PersonaCursorTarget | null>(null);

  // A live run's reading phase drives the walk clock. Each phase restarts
  // from the top (render-time state adjustment on the isReading edge) so
  // every tab walks the same block order.
  const isReading = status === "reading";
  const [walk, setWalk] = useState<{ isReading: boolean; hopCount: number }>({
    isReading,
    hopCount: 0,
  });
  if (walk.isReading !== isReading) {
    setWalk({ isReading, hopCount: 0 });
  }
  const readingHopCount = walk.hopCount;
  useEffect(() => {
    if (!isReading) {
      return;
    }
    const intervalId = window.setInterval(
      () => setWalk((current) => ({ ...current, hopCount: current.hopCount + 1 })),
      READING_HOP_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [isReading]);

  // A live run (reading/thinking) outranks the finding hover; back to idle
  // the cursor settles on the persona's newest open finding, if any.
  const activity: PersonaCursorActivity =
    status === "reading"
      ? "reading"
      : status === "thinking"
        ? "thinking"
        : findingBlockId !== null
          ? "hovering"
          : "hidden";

  useLayoutEffect(() => {
    const cursorElement = cursorRef.current;
    const overlayElement = cursorElement?.parentElement ?? null;
    if (cursorElement === null || overlayElement === null) {
      return;
    }
    const target = resolveActivityTarget({
      activity,
      readingHopCount,
      slug,
      findingBlockId,
      findingAnchorX,
      findingAnchorY,
      overlayElement,
      lastTarget: lastTargetRef.current,
    });
    const position =
      target !== null ? resolvePointerPosition({ pointer: target, overlayElement }) : null;
    if (position !== null) {
      lastTargetRef.current = target;
      const transform = `translate(${position.left}px, ${position.top}px)`;
      if (hasEverPositionedRef.current) {
        cursorElement.style.transform = transform;
      } else {
        // Materialize at the first known position instead of gliding in from
        // the overlay origin (the human overlay's exact trick).
        hasEverPositionedRef.current = true;
        cursorElement.style.transition = "none";
        cursorElement.style.transform = transform;
        void cursorElement.getBoundingClientRect();
        cursorElement.style.transition = "";
      }
    }
    cursorElement.style.opacity = position !== null ? "1" : "0";
  }, [
    activity,
    readingHopCount,
    slug,
    findingBlockId,
    findingAnchorX,
    findingAnchorY,
    layoutVersion,
  ]);

  return (
    <div
      ref={cursorRef}
      className="tandem-persona-cursor"
      data-testid="persona-cursor"
      data-persona-slug={slug}
      data-activity={activity}
    >
      <div className="tandem-persona-cursor__bob">
        <PointerCursorArrow color={color} />
        <span className="tandem-pointer-cursor__label" style={{ backgroundColor: color }}>
          {name}
        </span>
        {activity !== "hidden" && (
          /* Status badge at the cursor — the facepile PersonaStatusDot's
           * exact color/pulse grammar: amber while reading, violet while
           * thinking (a pending call) AND while dwelling on an open finding
           * ("thinking about something" — the owner's ask). */
          <span
            className={cn(
              "tandem-persona-cursor__badge animate-pulse",
              activity === "reading" ? "bg-amber-500" : "bg-violet-500",
            )}
            data-testid="persona-cursor-badge"
            data-status={activity}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}
