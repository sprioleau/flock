"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  getMsUntilPresentationPhaseChange,
  getPresentationPhase,
  type FindingPresentationPhase,
} from "./persona-cursor-helpers";
import { AgentCursorGlyph } from "./AgentCursorGlyph";
import { resolvePointerPosition } from "./PointerPresenceOverlay";
import "./pointer-presence.css";

/**
 * Multi-agent canvas v1 — simulated persona mouse cursors (owner spec
 * 2026-07-30, overriding the proposal §3.5 chip recommendation: literal
 * cursor glyphs matching the human remote-cursor grammar, with a
 * thinking/status badge at the cursor that rhymes with the facepile's
 * PersonaStatusDot).
 *
 * Owner revision 2026-08-25: agents diverge from the human arrow. They render
 * the larger bird glyph (AgentCursorGlyph, 24x30 vs the humans' 15x15) so it
 * is obvious at a glance that something is working, and their name tag is
 * hover-revealed rather than always-on. The human cursors keep the original
 * arrow and always-on tag — both live on their own components/classes now.
 *
 * CHOREOGRAPHY IS 100% CLIENT-SIDE — zero new presence writes. The driver
 * signals are shared reactive state on every collaborator's client:
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
 * 1. status "reading"  → a RANDOMIZED walk over the local `[data-block-id]`
 *    blocks: random start block, jittered hop cadence, occasional two-block
 *    skips, and per-hop pose scatter (owner feedback 2026-07-31: personas
 *    must never "perform the same motions at the same time" — plain
 *    Math.random per tab is the accepted trade against cross-tab identical
 *    walks; the walk is presentation smoothing over the runner's real
 *    context-assembly phase either way). Amber pulsing badge.
 * 2. status "thinking" → parks at its current spot, violet pulsing badge
 *    (a real pending LLM call — the facepile's thinking treatment).
 * 3. idle + a FRESH open finding (its presentation window, measured from the
 *    server-stamped createdAtMs, still open — same verdict in every tab):
 *    the legible found-something flow (owner feedback 2026-07-31) —
 *      a. DWELL beat (first FINDING_DWELL_MS): the cursor hovers AROUND the
 *         finding's first target block, wandering gently near a
 *         deterministic anchor hashed from the finding id;
 *      b. SELECT beat (the rest of the window): the cursor tucks to the
 *         block's top-right corner while the persona's presence-level
 *         selection chrome appears on the block
 *         (BlockPresenceIndicator's delayed persona treatment) and,
 *         moments later, the finding's card posts
 *         (FINDING_CARD_REVEAL_MS gate in use-persona-advisors).
 *    The beats share the server-stamped clock, so every tab agrees.
 * 4. otherwise → fades out (released). Owner rule (2026-07-31): cursors fade
 *    whenever the persona is not actively looking at something — a finding
 *    staying OPEN no longer keeps its cursor camped on the target; the
 *    presentation window ends and the cursor fades while the card remains.
 *    Dismissing/applying a finding mid-presentation also reaches here
 *    reactively in all tabs.
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
type PersonaCursorActivity = "reading" | "thinking" | "dwelling" | "selecting" | "hidden";

/** A logical cursor anchor — the same shape the human pointer payload uses. */
interface PersonaCursorTarget {
  blockId: string | null;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Choreography parameters (owner feedback 2026-07-31: de-synchronized,
// randomized persona motion; per-tab Math.random is the accepted trade)
// ---------------------------------------------------------------------------

/** Reading-walk hop cadence bounds, jittered per hop (≥300ms per §5.4). */
const READING_HOP_MIN_MS = 650;
const READING_HOP_MAX_MS = 1_250;

/** Random pre-walk delay so two personas' first hops never coincide. */
const READING_START_DELAY_MAX_MS = 600;

/** Chance a hop skips ahead two blocks (a scan, not a metronome). */
const READING_DOUBLE_HOP_CHANCE = 0.3;

/** Per-hop pose scatter: x around the persona's lane, y inside the block. */
const READING_POSE_X_JITTER = 0.06;
const READING_POSE_Y_MIN = 0.32;
const READING_POSE_Y_MAX = 0.58;
const READING_POSE_Y_DEFAULT = 0.45;

/** Dwell-beat wander: cadence + reach around the finding's hashed anchor. */
const DWELL_WANDER_MIN_MS = 620;
const DWELL_WANDER_MAX_MS = 950;
const DWELL_WANDER_RANGE = 0.09;

/**
 * Where the cursor tucks once it SELECTS the found block — the block's
 * top-right corner, right beside the presence name tag that appears with the
 * selection chrome. Deterministic so every tab sees the same select pose.
 */
const SELECTING_POSE_X = 0.88;
const SELECTING_POSE_Y = 0.16;

/** Keep cursor anchors comfortably inside the anchor rect. */
function clampAnchorFraction(fraction: number): number {
  return Math.min(0.94, Math.max(0.06, fraction));
}

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
    // (A re-affirming runner pass refreshes an open row's createdAtMs, which
    // re-opens its presentation window — the persona really did just look at
    // it again.)
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
        findingCreatedAtMs: finding?.createdAtMs ?? 0,
        findingAnchorX: anchor?.x ?? 0,
        findingAnchorY: anchor?.y ?? 0,
      },
    ];
  });

  return (
    <div
      ref={attachOverlayElement}
      className="flock-pointer-overlay"
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
          findingCreatedAtMs={cursor.findingCreatedAtMs}
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
  slug,
  walkStartFraction,
  walkStepTotal,
  walkPoseX,
  walkPoseY,
  wanderX,
  wanderY,
  findingBlockId,
  findingAnchorX,
  findingAnchorY,
  overlayElement,
  lastTarget,
}: {
  activity: PersonaCursorActivity;
  slug: string;
  /** This reading phase's random start position, as a 0..1 fraction of the block list. */
  walkStartFraction: number;
  /** Blocks advanced since the walk started (hops may skip — see the walk effect). */
  walkStepTotal: number;
  /** Per-hop pose scatter: x offset around the persona's lane, y inside the block. */
  walkPoseX: number;
  walkPoseY: number;
  /** Dwell-beat wander offsets around the finding's hashed anchor. */
  wanderX: number;
  wanderY: number;
  findingBlockId: string | null;
  findingAnchorX: number;
  findingAnchorY: number;
  overlayElement: HTMLElement;
  lastTarget: PersonaCursorTarget | null;
}): PersonaCursorTarget | null {
  if (activity === "dwelling" && findingBlockId !== null) {
    // Hover AROUND the found block: gentle wander near the deterministic
    // anchor — the visible "it found something there" dwell.
    return {
      blockId: findingBlockId,
      x: clampAnchorFraction(findingAnchorX + wanderX),
      y: clampAnchorFraction(findingAnchorY + wanderY),
    };
  }
  if (activity === "selecting" && findingBlockId !== null) {
    return { blockId: findingBlockId, x: SELECTING_POSE_X, y: SELECTING_POSE_Y };
  }
  const blockElements =
    overlayElement.parentElement?.querySelectorAll<HTMLElement>("[data-block-id]") ?? null;
  if (activity === "reading") {
    if (blockElements === null || blockElements.length === 0) {
      return null;
    }
    const startIndex = Math.floor(walkStartFraction * blockElements.length) % blockElements.length;
    const blockElement = blockElements[(startIndex + walkStepTotal) % blockElements.length];
    const blockId = blockElement?.dataset.blockId ?? null;
    if (blockId === null) {
      return null;
    }
    // Stable per-persona horizontal lane (so two walking personas don't
    // stack) + per-hop scatter so no two hops strike the same pose.
    return {
      blockId,
      x: clampAnchorFraction(buildReadingLaneX(slug) + walkPoseX),
      y: walkPoseY,
    };
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

/**
 * The finding's live presentation phase (dwell → select → closed) as a tiny
 * external "clock store": the snapshot derives the phase from the
 * server-stamped createdAtMs and the subscription arms one timeout for the
 * next phase boundary — no ticking, no render-time clock reads. Every tab
 * agrees on the beats because the timestamp is server-stamped; findings that
 * arrive already old (e.g. this tab loaded later) read as closed from the
 * first render. `findingCreatedAtMs` 0 = no finding (always closed).
 */
function usePresentationPhase({
  findingCreatedAtMs,
}: {
  findingCreatedAtMs: number;
}): FindingPresentationPhase {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let timerId: number | null = null;
      const armPhaseTimer = (): void => {
        const delayMs = getMsUntilPresentationPhaseChange({
          findingCreatedAtMs,
          nowMs: Date.now(),
        });
        if (delayMs === null) {
          return; // closed — nothing will change
        }
        // Re-arm after firing: covers both the dwell → select boundary and a
        // future-stamped createdAtMs (clock skew) that keeps reading as open.
        timerId = window.setTimeout(() => {
          onStoreChange();
          armPhaseTimer();
        }, delayMs);
      };
      armPhaseTimer();
      return () => {
        if (timerId !== null) {
          window.clearTimeout(timerId);
        }
      };
    },
    [findingCreatedAtMs],
  );
  const getPhaseSnapshot = useCallback(
    () => getPresentationPhase({ findingCreatedAtMs, nowMs: Date.now() }),
    [findingCreatedAtMs],
  );
  return useSyncExternalStore(subscribe, getPhaseSnapshot, () => "closed" as const);
}

function PersonaCursor({
  slug,
  name,
  color,
  status,
  findingBlockId,
  findingCreatedAtMs,
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
  findingCreatedAtMs: number;
  findingAnchorX: number;
  findingAnchorY: number;
  layoutVersion: number;
}) {
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const hasEverPositionedRef = useRef(false);
  const lastTargetRef = useRef<PersonaCursorTarget | null>(null);

  // A live run's reading phase drives the walk clock. Each phase restarts
  // (render-time state adjustment on the isReading edge) with a FRESH random
  // plan: the start block is re-rolled (walkPlanRef, lazily seeded in the
  // positioning effect, cleared by the walk effect's cleanup) and every hop
  // re-rolls its own stride, cadence, and pose — so two personas reading at
  // once never mirror each other (owner feedback 2026-07-31).
  const isReading = status === "reading";
  const walkPlanRef = useRef<{ startFraction: number } | null>(null);
  const [walk, setWalk] = useState<{
    isReading: boolean;
    stepTotal: number;
    poseX: number;
    poseY: number;
  }>({ isReading, stepTotal: 0, poseX: 0, poseY: READING_POSE_Y_DEFAULT });
  if (walk.isReading !== isReading) {
    setWalk({ isReading, stepTotal: 0, poseX: 0, poseY: READING_POSE_Y_DEFAULT });
  }
  useEffect(() => {
    if (!isReading) {
      return;
    }
    let timerId: number | null = null;
    const scheduleNextHop = (delayMs: number): void => {
      timerId = window.setTimeout(() => {
        setWalk((current) => ({
          ...current,
          stepTotal:
            current.stepTotal + (Math.random() < READING_DOUBLE_HOP_CHANCE ? 2 : 1),
          poseX: (Math.random() * 2 - 1) * READING_POSE_X_JITTER,
          poseY:
            READING_POSE_Y_MIN + Math.random() * (READING_POSE_Y_MAX - READING_POSE_Y_MIN),
        }));
        scheduleNextHop(
          READING_HOP_MIN_MS + Math.random() * (READING_HOP_MAX_MS - READING_HOP_MIN_MS),
        );
      }, delayMs);
    };
    // Random initial delay: two personas whose runs start together still
    // take their first hops at different moments.
    scheduleNextHop(Math.random() * READING_START_DELAY_MAX_MS);
    return () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      walkPlanRef.current = null; // next reading phase re-rolls its start
    };
  }, [isReading]);

  // A live run (reading/thinking) outranks the presentation; back to idle
  // the cursor plays the found-something beats for its newest finding while
  // the presentation window is open — dwell-hover first, then select — and
  // fades when the window closes (owner: fade whenever the persona is not
  // actively looking at something).
  const presentationPhase = usePresentationPhase({ findingCreatedAtMs });
  const activity: PersonaCursorActivity =
    status === "reading"
      ? "reading"
      : status === "thinking"
        ? "thinking"
        : findingBlockId !== null && presentationPhase !== "closed"
          ? presentationPhase === "dwell"
            ? "dwelling"
            : "selecting"
          : "hidden";

  // Dwell-beat wander: small random offsets around the hashed anchor on a
  // jittered cadence — the CSS glide turns them into a continuous hover.
  const isDwelling = activity === "dwelling";
  const [wander, setWander] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    if (!isDwelling) {
      return;
    }
    let timerId: number | null = null;
    const scheduleNextWander = (): void => {
      timerId = window.setTimeout(
        () => {
          setWander({
            x: (Math.random() * 2 - 1) * DWELL_WANDER_RANGE,
            y: (Math.random() * 2 - 1) * DWELL_WANDER_RANGE,
          });
          scheduleNextWander();
        },
        DWELL_WANDER_MIN_MS + Math.random() * (DWELL_WANDER_MAX_MS - DWELL_WANDER_MIN_MS),
      );
    };
    scheduleNextWander();
    return () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      setWander({ x: 0, y: 0 }); // the select pose starts from the anchor
    };
  }, [isDwelling]);

  useLayoutEffect(() => {
    const cursorElement = cursorRef.current;
    const overlayElement = cursorElement?.parentElement ?? null;
    if (cursorElement === null || overlayElement === null) {
      return;
    }
    // Lazily seed this reading phase's random start block (layout effects
    // run before the walk effect on the first reading render).
    if (activity === "reading" && walkPlanRef.current === null) {
      walkPlanRef.current = { startFraction: Math.random() };
    }
    const target = resolveActivityTarget({
      activity,
      slug,
      walkStartFraction: walkPlanRef.current?.startFraction ?? 0,
      walkStepTotal: walk.stepTotal,
      walkPoseX: walk.poseX,
      walkPoseY: walk.poseY,
      wanderX: wander.x,
      wanderY: wander.y,
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
    const isVisible = position !== null;
    cursorElement.style.opacity = isVisible ? "1" : "0";
    /* Gates the glyph's pointer-events in pointer-presence.css — set in the
     * same breath as opacity so the two can never disagree. A faded-out
     * cursor is still in the DOM and still hit-testable, so without this an
     * invisible glyph would sit on the canvas swallowing clicks. The
     * attribute is absent until the first positioning pass, which reads as
     * "not visible" — the safe default. */
    cursorElement.dataset.isVisible = String(isVisible);
  }, [
    activity,
    slug,
    walk.stepTotal,
    walk.poseX,
    walk.poseY,
    wander.x,
    wander.y,
    findingBlockId,
    findingAnchorX,
    findingAnchorY,
    layoutVersion,
  ]);

  return (
    <div
      ref={cursorRef}
      className="flock-persona-cursor"
      data-testid="persona-cursor"
      data-persona-slug={slug}
      data-activity={activity}
    >
      <div className="flock-persona-cursor__bob">
        <AgentCursorGlyph color={color} />
        {/* Hover-revealed name chip (owner 2026-08-25). MUST stay the glyph's
         * immediate next sibling — pointer-presence.css reveals it with an
         * adjacent-sibling selector off the glyph's :hover. Its own class,
         * not the humans' .flock-pointer-cursor__label, whose name tag stays
         * always-on. */}
        <span className="flock-persona-cursor__label" style={{ backgroundColor: color }}>
          {name}
        </span>
        {activity !== "hidden" && (
          /* Status badge at the cursor — the facepile PersonaStatusDot's
           * exact color/pulse grammar: amber while reading, violet while
           * thinking (a pending call) AND through the dwell/select beats
           * (the bounded post-run presentation before the cursor fades). */
          <span
            className={cn(
              "flock-persona-cursor__badge animate-pulse",
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
