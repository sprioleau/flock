"use client";

import { useEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { generateDocumentOutline } from "@flock/agent";
import { applyOperations, type EmailDocument, type Operation } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { getIsScriptedDemoDocument } from "@/lib/demo/demo-session";
import { useEditorStore } from "@/lib/editor-store";
import { getIsTourRunning } from "@/lib/tour/tour-progress";
import {
  persistDismissedPatternKey,
  readDismissedPatternKeys,
} from "@/lib/suggestions/dismissals";
import { serializeBlock } from "@/lib/suggestions/serialize-block";
import type { PersonaSuggestion } from "@/lib/suggestions/types";
import {
  getArePersonasPaused,
  useArePersonasPaused,
  useEnabledPersonaSlugs,
} from "./enabled-personas";
import {
  getPersonaCheckedHash,
  recordPersonaCheckedHash,
  recordPersonaRunStart,
} from "./persona-run-clock";
import { useRevealedFindingIds } from "./use-finding-reveal";
import {
  computeWatchScopeHash,
  getPersonaStaggerMs,
  parsePersonaWatchScope,
} from "./watch-scope";

/**
 * Multi-agent canvas — the client half of the reactive advisory runner
 * (proposal §3.3 model A + §6 v0 item 4, findings persistence per §3.6).
 * One hook owns the whole persona lifecycle for the open document:
 *
 * PRESENCE — while personas are enabled, keep their roster identities alive
 * (personas.heartbeatPersonas every ~4s; identity+status writes happen
 * server-side only on first join, so runner-written statuses never get
 * clobbered). Toggling a persona off just stops its heartbeat — it drops off
 * the facepile naturally ~2.5× the interval later.
 *
 * WATCH — the suggestions watcher's exact trigger semantics (one op-log entry
 * per SETTLED gesture; see use-suggestions.ts): only a `author: "user"`
 * `kind: "edit"` entry qualifies. Agent-authored ops — including a human
 * applying a persona's own finding (author "agent", authorId
 * `persona:<slug>`) — never re-trigger, which is the loop-prevention rule
 * (§5.3). A short trailing debounce coalesces an editing burst into one run.
 *
 * BUDGET GATES (§5.1) — per-persona cooldowns (registry `cooldownSeconds`),
 * a single-flight guard, and an outline-unchanged skip, all client-side; the
 * route re-checks server-side. Net effect: ONE batched Gemini call per
 * settled-gesture trigger, at most one per cooldown window.
 *
 * FINDINGS (multi-agent v1) — the runner PERSISTS findings in the
 * `personaFindings` table; this hook no longer builds cards from the HTTP
 * response. Instead it reads the document's OPEN findings through the
 * reactive `personaFindings.listOpenFindings` query — so findings appear in
 * EVERY tab and for every collaborator, not just the tab whose edit
 * triggered the run — and surfaces them as {@link PersonaSuggestion}s
 * (source:"analysis"). Dismiss and Apply write the row's status back to
 * Convex (dismissFinding / markFindingApplied), so all tabs converge.
 *
 * STALENESS stays LOCAL-ONLY on purpose: each tab compares the persisted
 * `targetSnapshots` (recorded server-side from the same doc the ops were
 * dry-run against) with its OWN rendered doc — instant against the local
 * overlay, and convergent because every tab's doc converges. No mutation is
 * issued for staleness (that's what keeps apply-vs-staleness race-free
 * across tabs); the runner prunes stale open rows server-side each run.
 */

type OperationsPage = FunctionReturnType<typeof api.documents.getOperations>;
type FindingRow = FunctionReturnType<typeof api.personaFindings.listOpenFindings>[number];

/*
  Op-log tail to subscribe to (matches the suggestions watcher).
*/
const OPS_TAIL_LIMIT = 30;

/*
  Trailing debounce between a settled gesture and the runner call.
*/
const RUN_DEBOUNCE_MS = 1_200;

/*
  Keep-alive cadence for enabled persona presence rows. Item 27 (owner:
  heartbeats "need to chill" — idle burn on the free Convex plan): raised
  4s → 25s against the server's 30s presence interval (the component times
  out at 2.5× = 75s, so 25s beats keep ~3× headroom, enough for
  background-tab timer throttling). Facepile drop-off after disabling a
  persona is correspondingly slower (≤ ~75s) — accepted cost trade.
*/
const PRESENCE_HEARTBEAT_MS = 25_000;

/*
  Deterministic per-persona stagger window (item 27): each persona's
  cooldown is lengthened by hash(slug) % this, so personas drift apart
  instead of all coming due at the same moment. Eligibility-only — runs
  stay BATCHED (one /api/personas call per trigger window).
*/
const STAGGER_WINDOW_MS = 20_000;

/*
  Global visible-findings cap (owner §10.1 row-1 constraint).
*/
const MAX_VISIBLE_FINDINGS = 3;

/*
  How long an applied card's Revert affordance lingers before clearing.
*/
const APPLIED_STATE_TTL_MS = 8_000;

/*
  Dev-only trace so in-browser verification can see WHY a run did/didn't fire.
*/
declare global {
  interface Window {
    __flockPersonasDebug?: unknown[];
  }
}
function tracePersonas(event: Record<string, unknown>): void {
  if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
    (window.__flockPersonasDebug ??= []).push({ atMs: Date.now(), ...event });
  }
}

/*
  Whether an advisory run should be skipped right now — read LIVE at both the
  trigger and inside the debounced run, so a state change between the two never
  lets a request through.

  Three reasons, and the second is the onboarding tour: WHILE THE WALKTHROUGH IS
  ON SCREEN, ADVISORY RUNS ARE SUPPRESSED ENTIRELY. Findings arrive as their own
  cards in the chat panel, and the tour's first stop deliberately expands that
  panel — so left alone, an agent's finding would land under a card that is
  mid-sentence explaining what agents are. It also costs a Gemini call per
  settled gesture, spent on a user who has not asked for anything yet.

  The third reason is the SCRIPTED DEMO (/demo, lib/demo/): on that document
  the demo's own sequencer is the only trigger, and it runs each agent alone,
  in order, against the deterministic mock. Leaving the ambient watcher armed
  as well would fire a BATCHED two-persona run on the visitor's first
  keystroke — pre-empting the very turn the narration is about to introduce,
  and doing it with no mock header, which is a real model call on a public
  route. Gated per DOCUMENT, so the visitor's own drafts in other tabs keep
  their ambient agents exactly as they were.

  Note this is the RUN gate only, not the presence heartbeat: enabled personas
  keep their avatars on the facepile throughout, because quietly removing
  collaborators the user already turned on would be a visible regression, not a
  suppression. (This is also why the demo does not simply reuse the pause flag,
  which stops the heartbeat and would empty the demo's facepile.)
*/
function shouldSkipAdvisorRun(documentId: string | null): boolean {
  return (
    getArePersonasPaused() || getIsTourRunning() || getIsScriptedDemoDocument(documentId)
  );
}

type RunnerResponse =
  | {
      isOk: true;
      findings: unknown[];
      skippedReason?: string;
    }
  | { isOk: false; message: string };

/*
  One locally applied finding: the card's revert affordance state.
*/
interface AppliedCardState {
  suggestion: PersonaSuggestion;
  findingId: string;
  batchId: string;
  revertErrorMessage: string | null;
}

export interface PersonaCard {
  suggestion: PersonaSuggestion;
  appliedState: { revertErrorMessage: string | null } | null;
}

export interface PersonaAdvisorsController {
  cards: PersonaCard[];
  applySuggestion: (suggestionId: string) => void;
  dismissSuggestion: (suggestionId: string) => void;
  revertApplied: (suggestionId: string) => void;
}

/*
  A persisted findings row → the suggestions surface's card shape.
*/
function toPersonaSuggestion(row: FindingRow): PersonaSuggestion {
  return {
    /*
      The Convex row id IS the card id: stable across renders AND tabs.
    */
    id: row.findingId,
    source: "analysis",
    personaSlug: row.personaSlug,
    personaName: row.personaName,
    personaColor: row.personaColor,
    patternKey: row.patternKey,
    title: row.title,
    description: row.description,
    targetBlockNames: row.targetBlockNames,
    targetBlockIds: row.targetBlockIds as PersonaSuggestion["targetBlockIds"],
    ops: row.ops as Operation[],
    ...(row.suggestedPrompt !== undefined ? { suggestedPrompt: row.suggestedPrompt } : {}),
  };
}

/*
  Short prompt-internal note about the ops that triggered this run.
*/
function summarizeTriggerOps(page: OperationsPage): string | undefined {
  const recentUserOps = page.operations
    .filter((entry) => entry.author === "user" && entry.kind === "edit")
    .slice(-4);
  if (recentUserOps.length === 0) {
    return undefined;
  }
  const parts = recentUserOps.map((entry) => {
    const op = entry.op as { name?: string; blockId?: string };
    return op.blockId !== undefined ? `${op.name} on ${op.blockId}` : `${op.name}`;
  });
  return `The user's most recent settled edits (oldest first): ${parts.join("; ")}.`;
}

export function usePersonaAdvisors(): PersonaAdvisorsController {
  const convexClient = useConvex();
  const documentId = useEditorStore((state) => state.documentId);
  const serverHeadVersion = useEditorStore((state) => state.serverHeadVersion);
  const enabledSlugs = useEnabledPersonaSlugs();
  const personaRows = useQuery(api.personas.listPersonas, enabledSlugs.length > 0 ? {} : "skip");

  /*
    THE findings feed: every open finding for this document, all tabs, all
    collaborators — reactive, so records/dismissals/applies converge live.
  */
  const findingRows = useQuery(
    api.personaFindings.listOpenFindings,
    documentId !== null ? { documentId } : "skip",
  );

  /*
    Rows hidden in THIS tab only: locally-detected stale findings ("dies
    quietly" — never resurrects even if the block changes back) and
    optimistically dismissed rows (hidden ahead of the mutation ack).
  */
  const [hiddenFindingIds, setHiddenFindingIds] = useState<ReadonlySet<string>>(new Set());
  /*
    Dismissed patternKeys: session dismissals ∪ the per-document localStorage
    bookkeeping (the pre-persistence twin of the dismissed rows' patternKey
    skip in personaFindings.recordFindings). Loaded lazily on mount and
    reloaded in the document-switch render adjustment below.
  */
  const [dismissedPatternKeys, setDismissedPatternKeys] = useState<ReadonlySet<string>>(() =>
    documentId !== null ? readDismissedPatternKeys(documentId) : new Set(),
  );
  /*
    Cards this tab applied — they carry the revert affordance locally.
  */
  const [appliedCards, setAppliedCards] = useState<AppliedCardState[]>([]);
  /*
    Ids of findings whose ops were (or are being) applied. A REF, not state,
    on purpose: dispatching a card's ops mutates its own target blocks, which
    fires the editor-store staleness subscription SYNCHRONOUSLY — before any
    state update commits — and the applied card would hide itself as stale.
    The ref updates synchronously ahead of the dispatch, so the staleness
    check can exempt the card immediately.
  */
  const appliedFindingIdsRef = useRef<Set<string>>(new Set());
  /*
    Per-document runner bookkeeping (cooldowns, dedup key, high-water mark).
  */
  const runnerRef = useRef<{
    documentId: string | null;
    lastEvaluatedVersion: number;
    lastRunAtMsBySlug: Map<string, number>;
    lastRunKey: string | null;
    isRunInFlight: boolean;
  }>({
    documentId: null,
    lastEvaluatedVersion: 0,
    lastRunAtMsBySlug: new Map(),
    lastRunKey: null,
    isRunInFlight: false,
  });
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appliedClearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /*
    Refs so the debounced run always sees current values without re-arming
    the watcher effect on every enablement/registry change (synced in an
    effect — never during render, per the React Compiler contract).
  */
  const enabledSlugsRef = useRef(enabledSlugs);
  const personaRowsRef = useRef(personaRows);
  useEffect(() => {
    enabledSlugsRef.current = enabledSlugs;
    personaRowsRef.current = personaRows;
  }, [enabledSlugs, personaRows]);

  /*
    Document switch: drop carried-over local card state (render-time state
    adjustment; refs/timers are cleared in the effect below).
  */
  const [boundDocumentId, setBoundDocumentId] = useState<Id<"documents"> | null>(documentId);
  if (boundDocumentId !== documentId) {
    setBoundDocumentId(documentId);
    setHiddenFindingIds(new Set());
    setDismissedPatternKeys(documentId !== null ? readDismissedPatternKeys(documentId) : new Set());
    setAppliedCards([]);
  }

  /*
    Document switch / unmount: clear timers and the applied-exemption ref.
  */
  useEffect(() => {
    const timers = appliedClearTimersRef.current;
    const appliedIds = appliedFindingIdsRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      appliedIds.clear();
    };
  }, [documentId]);

  const removeAppliedCard = (findingId: string): void => {
    const timer = appliedClearTimersRef.current.get(findingId);
    if (timer !== undefined) {
      clearTimeout(timer);
      appliedClearTimersRef.current.delete(findingId);
    }
    appliedFindingIdsRef.current.delete(findingId);
    /*
      Keep the id hidden: if markFindingApplied failed (row still open), the
      card must not pop back after its applied affordance cleared.
    */
    setHiddenFindingIds((current) => new Set([...current, findingId]));
    setAppliedCards((current) => current.filter((card) => card.findingId !== findingId));
  };

  /*
    -------------------------------------------------------------------------
    PRESENCE keep-alive for enabled personas
    -------------------------------------------------------------------------
  */
  const enabledKey = [...enabledSlugs].sort().join(",");
  const arePersonasPaused = useArePersonasPaused();
  useEffect(() => {
    /*
      While paused the heartbeat stops too, so persona avatars/cursors go
      idle (explicitly fine per the pause design) and resume on unpause.
    */
    if (documentId === null || enabledKey.length === 0 || arePersonasPaused) {
      return;
    }
    const slugs = enabledKey.split(",");
    const beat = (): void => {
      convexClient
        .mutation(api.personas.heartbeatPersonas, { documentId, slugs })
        .catch((error: unknown) => {
          console.warn("[personas] presence heartbeat failed", error);
        });
    };
    beat();
    const intervalId = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    return () => clearInterval(intervalId);
  }, [convexClient, documentId, enabledKey, arePersonasPaused]);

  /*
    -------------------------------------------------------------------------
    WATCH + RUN (findings land in Convex — nothing card-shaped comes back)
    -------------------------------------------------------------------------
  */
  useEffect(() => {
    if (documentId === null) {
      return;
    }

    const runAdvisors = async (page: OperationsPage): Promise<void> => {
      /*
        Paused = ZERO /api/personas requests (credit conservation). Checked
        LIVE here too — a debounce armed just before pausing must not fire.
      */
      if (shouldSkipAdvisorRun(documentId)) {
        tracePersonas({ step: "skip-paused" });
        return;
      }
      const runner = runnerRef.current;
      const rows = personaRowsRef.current;
      if (rows === undefined || runner.isRunInFlight) {
        tracePersonas({ step: "skip-not-ready", isRunInFlight: runner.isRunInFlight });
        return;
      }
      const rowsBySlug = new Map(rows.map((row) => [row.slug, row]));
      const now = Date.now();
      /*
        Per-persona cooldown gate — with the deterministic stagger offset
        (item 27) so personas' windows drift apart instead of all expiring
        together. Only personas past cooldown+offset may join this batch.
      */
      const eligibleSlugs = enabledSlugsRef.current.filter((slug) => {
        const row = rowsBySlug.get(slug);
        if (row === undefined) {
          return false;
        }
        const lastRunAtMs = runner.lastRunAtMsBySlug.get(slug) ?? 0;
        const staggerMs = getPersonaStaggerMs({ slug, windowMs: STAGGER_WINDOW_MS });
        return now - lastRunAtMs >= row.cooldownSeconds * 1000 + staggerMs;
      });
      if (eligibleSlugs.length === 0) {
        tracePersonas({ step: "skip-cooldown" });
        return;
      }

      /*
        Outline-unchanged skip: a gesture that didn't change what the model
        would see (e.g. an edit + its undo) never spends a call. Depth "full"
        matches the route: styling-only edits must count as outline changes.
      */
      const doc = useEditorStore.getState().doc;
      const outline = generateDocumentOutline({ doc, options: { depth: "full" } });

      /*
        Hash-gated checks (item 27): a persona whose WATCHED SCOPE hash is
        unchanged since its last check skips silently — no API call, no
        presence churn — even when its cooldown is due. Scope comes from the
        persona's `watch:` frontmatter (whole document by default); the
        baseline lives in localStorage beside the run clock, so reloads and
        sibling tabs share it.
      */
      const scopeHashBySlug = new Map<string, string>();
      const dueSlugs = eligibleSlugs.filter((slug) => {
        const row = rowsBySlug.get(slug);
        if (row === undefined) {
          return false;
        }
        const scope = parsePersonaWatchScope(row.personaMarkdown);
        const scopeHash = computeWatchScopeHash({
          doc: doc as EmailDocument,
          scope,
          documentOutline: outline,
        });
        scopeHashBySlug.set(slug, scopeHash);
        return scopeHash !== getPersonaCheckedHash({ documentId, slug });
      });
      if (dueSlugs.length === 0) {
        tracePersonas({ step: "skip-scope-unchanged", eligibleSlugs });
        return;
      }

      const runKey = `${[...dueSlugs].sort().join(",")}\n${outline}`;
      if (runner.lastRunKey === runKey) {
        tracePersonas({ step: "skip-outline-unchanged" });
        return;
      }

      runner.isRunInFlight = true;
      /*
        Stamp cooldowns + checked-scope hashes at run START so a burst can't
        double-spend. The run-clock twin feeds the facepile popover's
        "checks again in ~Ns" (localStorage — shared across this browser's
        tabs, zero presence writes).
      */
      for (const slug of dueSlugs) {
        runner.lastRunAtMsBySlug.set(slug, now);
        recordPersonaRunStart({ documentId, slug, atMs: now });
        const scopeHash = scopeHashBySlug.get(slug);
        if (scopeHash !== undefined) {
          recordPersonaCheckedHash({ documentId, slug, hash: scopeHash, atMs: now });
        }
      }
      tracePersonas({ step: "run-start", eligibleSlugs: dueSlugs });
      try {
        const response = await fetch("/api/personas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentId,
            personaSlugs: dueSlugs,
            triggerSummary: summarizeTriggerOps(page),
          }),
        });
        const payload = (await response.json()) as RunnerResponse;
        if (!payload.isOk) {
          tracePersonas({ step: "run-failed", message: payload.message });
          return;
        }
        runner.lastRunKey = runKey;
        if (payload.skippedReason !== undefined) {
          tracePersonas({ step: "run-skipped-server", reason: payload.skippedReason });
          return;
        }
        /*
          The route persisted the findings; the reactive listOpenFindings
          query delivers them to this tab AND every other one.
        */
        tracePersonas({ step: "run-findings", count: payload.findings.length });
      } catch (error) {
        tracePersonas({ step: "run-error", message: String(error) });
      } finally {
        runnerRef.current.isRunInFlight = false;
      }
    };

    const evaluatePage = (page: OperationsPage): void => {
      if (!page.isDone) {
        return;
      }
      const runner = runnerRef.current;
      const entries = page.operations;
      const newest = entries[entries.length - 1];
      if (runner.documentId !== documentId) {
        /*
          First page for this document: BASELINE only, never evaluate (item
          27, owner: "don't check on initial load"). Whatever op history the
          document arrives with — including a user edit from a previous
          session — is old news; the first check happens only after the
          first NEW settled user edit.
        */
        runnerRef.current = {
          documentId,
          lastEvaluatedVersion: newest?.version ?? 0,
          lastRunAtMsBySlug: new Map(),
          lastRunKey: null,
          isRunInFlight: false,
        };
        tracePersonas({ step: "baseline", version: newest?.version ?? 0 });
        return;
      }
      if (newest === undefined || newest.version <= runnerRef.current.lastEvaluatedVersion) {
        return;
      }
      runnerRef.current.lastEvaluatedVersion = newest.version;
      /*
        THE loop-prevention rule (§5.3): only a settled USER edit triggers.
        Agent ops — chat turns, rule-suggestion applies, and persona-finding
        applies (author "agent", authorId `persona:<slug>`) — never do.
      */
      if (newest.author !== "user" || newest.kind !== "edit") {
        tracePersonas({ step: "skip-not-user-edit", author: newest.author, kind: newest.kind });
        return;
      }
      if (enabledSlugsRef.current.length === 0) {
        return;
      }
      /*
        Gate at the TRIGGER while paused: no debounce armed, no request made.
      */
      if (shouldSkipAdvisorRun(documentId)) {
        tracePersonas({ step: "skip-paused" });
        return;
      }
      /*
        Trailing debounce: an editing burst coalesces into one run.
      */
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void runAdvisors(page);
      }, RUN_DEBOUNCE_MS);
    };

    const watch = convexClient.watchQuery(api.documents.getOperations, {
      documentId,
      sinceVersion: Math.max(0, serverHeadVersion - OPS_TAIL_LIMIT),
      limit: OPS_TAIL_LIMIT,
    });
    const runFromLocalResult = (): void => {
      const page = watch.localQueryResult();
      if (page !== undefined) {
        evaluatePage(page);
      }
    };
    const unsubscribe = watch.onUpdate(runFromLocalResult);
    let isDisposed = false;
    queueMicrotask(() => {
      if (!isDisposed) {
        runFromLocalResult();
      }
    });
    return () => {
      isDisposed = true;
      unsubscribe();
      /*
        Deliberately NOT clearing the debounce timer here: this effect
        re-runs on EVERY committed op (serverHeadVersion advances → the watch
        window re-anchors), and the very op that scheduled the run would
        cancel it in the same breath. The timer is cleared only on document
        switch / unmount (the effect below).
      */
    };
  }, [convexClient, documentId, serverHeadVersion]);

  /*
    Pending-run lifetime: a debounced run belongs to ONE document; drop it
    when the document changes or the hook unmounts.
  */
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [documentId]);

  /*
    -------------------------------------------------------------------------
    STALENESS: any drift between a finding's persisted targetSnapshots and
    THIS tab's rendered doc hides it here, permanently ("dies quietly").
    Local-only — no mutation — so it can never race an apply in another tab;
    every tab converges to the same doc and reaches the same verdict, and
    the runner prunes the stale rows server-side on its next pass. Findings
    this tab applied are exempt (their revert affordance must survive the
    very change the apply itself made).
    -------------------------------------------------------------------------
  */
  useEffect(() => {
    if (findingRows === undefined || findingRows.length === 0) {
      return;
    }
    const checkStaleness = (doc: EmailDocument): void => {
      const staleIds = findingRows
        .filter(
          (row) =>
            !hiddenFindingIds.has(row.findingId) &&
            !appliedFindingIdsRef.current.has(row.findingId) &&
            Object.entries(row.targetSnapshots).some(
              ([blockId, snapshot]) =>
                serializeBlock(doc[blockId as keyof EmailDocument]) !== snapshot,
            ),
        )
        .map((row) => row.findingId);
      if (staleIds.length > 0) {
        tracePersonas({ step: "stale", staleIds });
        setHiddenFindingIds((current) => new Set([...current, ...staleIds]));
      }
    };
    const unsubscribe = useEditorStore.subscribe((state) =>
      checkStaleness(state.doc as EmailDocument),
    );
    let isDisposed = false;
    queueMicrotask(() => {
      if (!isDisposed) {
        checkStaleness(useEditorStore.getState().doc as EmailDocument);
      }
    });
    return () => {
      isDisposed = true;
      unsubscribe();
    };
  }, [findingRows, hiddenFindingIds]);

  /*
    -------------------------------------------------------------------------
    The visible card set: this tab's applied cards (revert affordance) on
    top, then the freshest open findings that aren't locally hidden,
    dismissed, or being applied — capped at MAX_VISIBLE_FINDINGS total.
  */
  //
  /*
    DWELL-GATE (owner feedback 2026-07-31 — wander → dwell → select → post):
    a FRESH finding's card stays hidden until FINDING_CARD_REVEAL_MS after
    its server-stamped createdAtMs, i.e. until just after its persona's
    cursor has dwell-hovered the target block and visibly selected it — so
    the human connects the motion to the message. Rows that arrive already
    old (late-joining tab, reload) reveal instantly.
    -------------------------------------------------------------------------
  */
  const revealedFindingIds = useRevealedFindingIds({
    findings: (findingRows ?? []).map((row) => ({
      findingId: row.findingId,
      createdAtMs: row.createdAtMs,
    })),
  });
  /*
    Applied ids from STATE here (never the ref — refs must not be read in
    render): by the re-render after an apply, the card is in appliedCards.
  */
  const appliedFindingIds = new Set(appliedCards.map((card) => card.findingId));
  const visibleOpenRows = (findingRows ?? [])
    .filter(
      (row) =>
        revealedFindingIds.has(row.findingId) &&
        !hiddenFindingIds.has(row.findingId) &&
        !appliedFindingIds.has(row.findingId) &&
        !dismissedPatternKeys.has(row.patternKey),
    )
    .slice(0, Math.max(0, MAX_VISIBLE_FINDINGS - appliedCards.length));

  /*
    -------------------------------------------------------------------------
    Actions
    -------------------------------------------------------------------------
  */
  const applySuggestion = (suggestionId: string): void => {
    const row = visibleOpenRows.find((candidate) => candidate.findingId === suggestionId);
    if (row === undefined || row.ops.length === 0) {
      return;
    }
    const suggestion = toPersonaSuggestion(row);
    const store = useEditorStore.getState();
    if (!applyOperations(store.doc, suggestion.ops).isOk) {
      /*
        Raced a concurrent edit — quietly drop (locally; the runner prunes).
      */
      setHiddenFindingIds((current) => new Set([...current, suggestionId]));
      return;
    }
    /*
      Persona provenance (proposal §3.2): author "agent", authorId
      `persona:<slug>` (its own undo stack + History identity), one batch per
      apply so history.revertBatch reverts it in one click.
    */
    const batchId = `persona:${suggestion.personaSlug}:${crypto.randomUUID()}`;
    /*
      Exempt this card from staleness BEFORE dispatching (see appliedFindingIdsRef).
    */
    appliedFindingIdsRef.current.add(suggestionId);
    for (const op of suggestion.ops) {
      const result = store.dispatch(op, {
        caller: "frontend",
        author: "agent",
        authorId: `persona:${suggestion.personaSlug}`,
        batchId,
      });
      if (!result.isOk) {
        /*
          Unreachable after the dry-run; partial batch stays revertable in History.
        */
        appliedFindingIdsRef.current.delete(suggestionId);
        setHiddenFindingIds((current) => new Set([...current, suggestionId]));
        return;
      }
    }
    setAppliedCards((current) => [
      { suggestion, findingId: suggestionId, batchId, revertErrorMessage: null },
      ...current,
    ]);
    /*
      Converge the row for every tab: open → applied (+ the revert handle).
    */
    convexClient
      .mutation(api.personaFindings.markFindingApplied, {
        findingId: row.findingId,
        appliedBatchId: batchId,
      })
      .catch((error: unknown) => {
        console.warn("[personas] markFindingApplied failed", error);
      });
    const timer = setTimeout(() => {
      appliedClearTimersRef.current.delete(suggestionId);
      removeAppliedCard(suggestionId);
    }, APPLIED_STATE_TTL_MS);
    appliedClearTimersRef.current.set(suggestionId, timer);
  };

  const dismissSuggestion = (suggestionId: string): void => {
    if (appliedCards.some((card) => card.findingId === suggestionId)) {
      removeAppliedCard(suggestionId);
      return;
    }
    const row = visibleOpenRows.find((candidate) => candidate.findingId === suggestionId);
    if (row === undefined) {
      return;
    }
    /*
      Local bookkeeping first (instant hide + the localStorage twin) ...
    */
    setDismissedPatternKeys((current) => new Set([...current, row.patternKey]));
    setHiddenFindingIds((current) => new Set([...current, suggestionId]));
    if (documentId !== null) {
      persistDismissedPatternKey({ documentId, patternKey: row.patternKey });
    }
    /*
      ... then the authoritative row status: every other tab converges, and
      recordFindings will refuse to re-record this patternKey.
    */
    convexClient
      .mutation(api.personaFindings.dismissFinding, { findingId: row.findingId })
      .catch((error: unknown) => {
        console.warn("[personas] dismissFinding failed", error);
      });
  };

  const revertApplied = (suggestionId: string): void => {
    const card = appliedCards.find((candidate) => candidate.findingId === suggestionId);
    if (card === undefined) {
      return;
    }
    void useEditorStore
      .getState()
      .revertAgentBatch(card.batchId)
      .then((result) => {
        if (result.isOk) {
          removeAppliedCard(suggestionId);
          return;
        }
        setAppliedCards((current) =>
          current.map((candidate) =>
            candidate.findingId === suggestionId
              ? { ...candidate, revertErrorMessage: result.message }
              : candidate,
          ),
        );
      });
  };

  return {
    cards: [
      ...appliedCards.map((card) => ({
        suggestion: card.suggestion,
        appliedState: { revertErrorMessage: card.revertErrorMessage },
      })),
      ...visibleOpenRows.map((row) => ({
        suggestion: toPersonaSuggestion(row),
        appliedState: null,
      })),
    ],
    applySuggestion,
    dismissSuggestion,
    revertApplied,
  };
}
