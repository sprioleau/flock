"use client";

import { useEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { generateDocumentOutline } from "@tandem/agent";
import { applyOperations, type EmailDocument, type Operation } from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useEditorStore } from "@/lib/editor-store";
import {
  persistDismissedPatternKey,
  readDismissedPatternKeys,
} from "@/lib/suggestions/dismissals";
import { serializeBlock } from "@/lib/suggestions/use-suggestions";
import type { PersonaSuggestion } from "@/lib/suggestions/types";
import { useEnabledPersonaSlugs } from "./enabled-personas";

/**
 * Multi-agent canvas v0 — the client half of the reactive advisory runner
 * (proposal §3.3 model A + §6 v0 item 4). One hook owns the whole persona
 * lifecycle for the open document:
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
 * FINDINGS — runner findings become {@link PersonaSuggestion}s
 * (source:"analysis") and inherit the whole suggestions machinery: dry-run
 * re-validation against the LIVE doc, target-block staleness snapshots,
 * patternKey dismissal persistence, apply with `persona:<slug>` provenance
 * and per-batch revert (history.revertBatch via the store).
 */

type OperationsPage = FunctionReturnType<typeof api.documents.getOperations>;

/** Op-log tail to subscribe to (matches the suggestions watcher). */
const OPS_TAIL_LIMIT = 30;

/** Trailing debounce between a settled gesture and the runner call. */
const RUN_DEBOUNCE_MS = 1_200;

/** Keep-alive cadence for enabled persona presence rows. */
const PRESENCE_HEARTBEAT_MS = 4_000;

/** Global visible-findings cap (owner §10.1 row-1 constraint). */
const MAX_VISIBLE_FINDINGS = 3;

/** How long an applied card's Revert affordance lingers before clearing. */
const APPLIED_STATE_TTL_MS = 8_000;

// Dev-only trace so in-browser verification can see WHY a run did/didn't fire.
declare global {
  interface Window {
    __tandemPersonasDebug?: unknown[];
  }
}
function tracePersonas(event: Record<string, unknown>): void {
  if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
    (window.__tandemPersonasDebug ??= []).push({ atMs: Date.now(), ...event });
  }
}

interface RunnerFindingPayload {
  personaSlug: string;
  personaName: string;
  personaColor: string;
  title: string;
  description: string;
  targetBlockNames: string[];
  targetBlockIds: string[];
  ops: Operation[];
}

type RunnerResponse =
  | {
      isOk: true;
      findings: RunnerFindingPayload[];
      skippedReason?: string;
    }
  | { isOk: false; message: string };

interface PersonaCardState {
  suggestion: PersonaSuggestion;
  /** JSON of each target block at arrival time (staleness baseline). */
  targetSnapshots: Record<string, string | undefined>;
  /** Set after the human applies the ops; carries the revert handle. */
  applied: { batchId: string; revertErrorMessage: string | null } | null;
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

function buildPatternKey({
  personaSlug,
  targetBlockIds,
}: {
  personaSlug: string;
  targetBlockIds: string[];
}): string {
  return `persona:${personaSlug}|${[...targetBlockIds].sort().join(",")}`;
}

/** Short prompt-internal note about the ops that triggered this run. */
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

  const [cardStates, setCardStates] = useState<PersonaCardState[]>([]);
  const sessionDismissedKeysRef = useRef<Set<string>>(new Set());
  /**
   * Ids of cards whose ops were (or are being) applied. A REF, not state, on
   * purpose: dispatching a card's ops mutates its own target blocks, which
   * fires the editor-store staleness subscription SYNCHRONOUSLY — before the
   * applied state update commits — and the applied card would remove itself.
   * The ref updates synchronously ahead of the dispatch, so the staleness
   * check can exempt the card immediately.
   */
  const appliedCardIdsRef = useRef<Set<string>>(new Set());
  // Per-document runner bookkeeping (cooldowns, dedup key, high-water mark).
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

  // Refs so the debounced run always sees current values without re-arming
  // the watcher effect on every enablement/registry change (synced in an
  // effect — never during render, per the React Compiler contract).
  const enabledSlugsRef = useRef(enabledSlugs);
  const personaRowsRef = useRef(personaRows);
  useEffect(() => {
    enabledSlugsRef.current = enabledSlugs;
    personaRowsRef.current = personaRows;
  }, [enabledSlugs, personaRows]);

  // Document switch: drop carried-over cards (render-time state adjustment).
  const [boundDocumentId, setBoundDocumentId] = useState<Id<"documents"> | null>(documentId);
  if (boundDocumentId !== documentId) {
    setBoundDocumentId(documentId);
    setCardStates([]);
  }

  const removeCard = (suggestionId: string): void => {
    const timer = appliedClearTimersRef.current.get(suggestionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      appliedClearTimersRef.current.delete(suggestionId);
    }
    appliedCardIdsRef.current.delete(suggestionId);
    setCardStates((current) =>
      current.filter((card) => card.suggestion.id !== suggestionId),
    );
  };
  useEffect(() => {
    const timers = appliedClearTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  // -------------------------------------------------------------------------
  // PRESENCE keep-alive for enabled personas
  // -------------------------------------------------------------------------
  const enabledKey = [...enabledSlugs].sort().join(",");
  useEffect(() => {
    if (documentId === null || enabledKey.length === 0) {
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
  }, [convexClient, documentId, enabledKey]);

  // -------------------------------------------------------------------------
  // WATCH + RUN
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (documentId === null) {
      return;
    }

    const isPatternDismissed = (patternKey: string): boolean =>
      sessionDismissedKeysRef.current.has(patternKey) ||
      readDismissedPatternKeys(documentId).has(patternKey);

    const runAdvisors = async (page: OperationsPage): Promise<void> => {
      const runner = runnerRef.current;
      const rows = personaRowsRef.current;
      if (rows === undefined || runner.isRunInFlight) {
        tracePersonas({ step: "skip-not-ready", isRunInFlight: runner.isRunInFlight });
        return;
      }
      const rowsBySlug = new Map(rows.map((row) => [row.slug, row]));
      const now = Date.now();
      // Per-persona cooldown gate: only personas past their window run.
      const eligibleSlugs = enabledSlugsRef.current.filter((slug) => {
        const row = rowsBySlug.get(slug);
        if (row === undefined) {
          return false;
        }
        const lastRunAtMs = runner.lastRunAtMsBySlug.get(slug) ?? 0;
        return now - lastRunAtMs >= row.cooldownSeconds * 1000;
      });
      if (eligibleSlugs.length === 0) {
        tracePersonas({ step: "skip-cooldown" });
        return;
      }

      // Outline-unchanged skip: a gesture that didn't change what the model
      // would see (e.g. an edit + its undo) never spends a call. Depth "full"
      // matches the route: styling-only edits must count as outline changes.
      const doc = useEditorStore.getState().doc;
      const outline = generateDocumentOutline({ doc, options: { depth: "full" } });
      const runKey = `${[...eligibleSlugs].sort().join(",")}\n${outline}`;
      if (runner.lastRunKey === runKey) {
        tracePersonas({ step: "skip-outline-unchanged" });
        return;
      }

      runner.isRunInFlight = true;
      // Stamp cooldowns at run START so a burst can't double-spend.
      for (const slug of eligibleSlugs) {
        runner.lastRunAtMsBySlug.set(slug, now);
      }
      tracePersonas({ step: "run-start", eligibleSlugs });
      try {
        const response = await fetch("/api/personas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentId,
            personaSlugs: eligibleSlugs,
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
        tracePersonas({ step: "run-findings", count: payload.findings.length });

        // Findings → PersonaSuggestions: re-validate ops against the LIVE doc
        // (it may have moved since the server snapshot — belt and braces, the
        // same dry-run discipline as rule suggestions), filter dismissals,
        // dedupe by patternKey, snapshot targets, cap the visible set.
        const liveDoc = useEditorStore.getState().doc;
        const arrivals: PersonaCardState[] = [];
        for (const finding of payload.findings) {
          const patternKey = buildPatternKey({
            personaSlug: finding.personaSlug,
            targetBlockIds: finding.targetBlockIds,
          });
          if (isPatternDismissed(patternKey)) {
            continue;
          }
          const targetsExist = finding.targetBlockIds.every(
            (blockId) => (liveDoc as EmailDocument)[blockId as keyof EmailDocument] !== undefined,
          );
          if (!targetsExist) {
            continue; // already stale on arrival
          }
          const hasValidOps =
            finding.ops.length > 0 && applyOperations(liveDoc, finding.ops).isOk;
          arrivals.push({
            suggestion: {
              id: crypto.randomUUID(),
              source: "analysis",
              personaSlug: finding.personaSlug,
              personaName: finding.personaName,
              personaColor: finding.personaColor,
              patternKey,
              title: finding.title,
              description: finding.description,
              targetBlockNames: finding.targetBlockNames,
              targetBlockIds: finding.targetBlockIds,
              ops: hasValidOps ? finding.ops : [],
            },
            targetSnapshots: Object.fromEntries(
              finding.targetBlockIds.map((blockId) => [
                blockId,
                serializeBlock((liveDoc as EmailDocument)[blockId as keyof EmailDocument]),
              ]),
            ),
            applied: null,
          });
        }
        if (arrivals.length > 0) {
          setCardStates((current) => {
            const arrivalKeys = new Set(arrivals.map((card) => card.suggestion.patternKey));
            const kept = current.filter(
              (card) => card.applied !== null || !arrivalKeys.has(card.suggestion.patternKey),
            );
            return [...arrivals, ...kept].slice(0, MAX_VISIBLE_FINDINGS);
          });
        }
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
      if (runner.documentId !== documentId) {
        runnerRef.current = {
          documentId,
          lastEvaluatedVersion: 0,
          lastRunAtMsBySlug: new Map(),
          lastRunKey: null,
          isRunInFlight: false,
        };
      }
      const entries = page.operations;
      const newest = entries[entries.length - 1];
      if (newest === undefined || newest.version <= runnerRef.current.lastEvaluatedVersion) {
        return;
      }
      runnerRef.current.lastEvaluatedVersion = newest.version;
      // THE loop-prevention rule (§5.3): only a settled USER edit triggers.
      // Agent ops — chat turns, rule-suggestion applies, and persona-finding
      // applies (author "agent", authorId `persona:<slug>`) — never do.
      if (newest.author !== "user" || newest.kind !== "edit") {
        tracePersonas({ step: "skip-not-user-edit", author: newest.author, kind: newest.kind });
        return;
      }
      if (enabledSlugsRef.current.length === 0) {
        return;
      }
      // Trailing debounce: an editing burst coalesces into one run.
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
      // Deliberately NOT clearing the debounce timer here: this effect
      // re-runs on EVERY committed op (serverHeadVersion advances → the watch
      // window re-anchors), and the very op that scheduled the run would
      // cancel it in the same breath. The timer is cleared only on document
      // switch / unmount (the effect below).
    };
  }, [convexClient, documentId, serverHeadVersion]);

  // Pending-run lifetime: a debounced run belongs to ONE document; drop it
  // when the document changes or the hook unmounts.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [documentId]);

  // -------------------------------------------------------------------------
  // STALENESS: any change to a card's target blocks invalidates it (applied
  // cards are exempt — their revert affordance must survive the very change
  // the apply itself made).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (cardStates.every((card) => card.applied !== null)) {
      return;
    }
    const checkStaleness = (doc: EmailDocument): void => {
      const staleIds = cardStates
        .filter(
          (card) =>
            card.applied === null &&
            !appliedCardIdsRef.current.has(card.suggestion.id) &&
            card.suggestion.targetBlockIds.some(
              (blockId) =>
                serializeBlock(doc[blockId as keyof EmailDocument]) !==
                card.targetSnapshots[blockId],
            ),
        )
        .map((card) => card.suggestion.id);
      if (staleIds.length > 0) {
        tracePersonas({ step: "stale", staleIds });
        setCardStates((current) =>
          current.filter(
            (card) =>
              card.applied !== null ||
              appliedCardIdsRef.current.has(card.suggestion.id) ||
              !staleIds.includes(card.suggestion.id),
          ),
        );
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
  }, [cardStates]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const applySuggestion = (suggestionId: string): void => {
    const card = cardStates.find((candidate) => candidate.suggestion.id === suggestionId);
    if (card === undefined || card.applied !== null || card.suggestion.ops.length === 0) {
      return;
    }
    const store = useEditorStore.getState();
    if (!applyOperations(store.doc, card.suggestion.ops).isOk) {
      removeCard(suggestionId); // raced a concurrent edit — quietly drop
      return;
    }
    // Persona provenance (proposal §3.2): author "agent", authorId
    // `persona:<slug>` (its own undo stack + History identity), one batch per
    // apply so history.revertBatch reverts it in one click.
    const batchId = `persona:${card.suggestion.personaSlug}:${crypto.randomUUID()}`;
    // Exempt this card from staleness BEFORE dispatching (see appliedCardIdsRef).
    appliedCardIdsRef.current.add(suggestionId);
    for (const op of card.suggestion.ops) {
      const result = store.dispatch(op, {
        caller: "frontend",
        author: "agent",
        authorId: `persona:${card.suggestion.personaSlug}`,
        batchId,
      });
      if (!result.isOk) {
        removeCard(suggestionId); // unreachable after the dry-run; partial batch stays revertable in History
        return;
      }
    }
    setCardStates((current) =>
      current.map((candidate) =>
        candidate.suggestion.id === suggestionId
          ? { ...candidate, applied: { batchId, revertErrorMessage: null } }
          : candidate,
      ),
    );
    const timer = setTimeout(() => {
      appliedClearTimersRef.current.delete(suggestionId);
      removeCard(suggestionId);
    }, APPLIED_STATE_TTL_MS);
    appliedClearTimersRef.current.set(suggestionId, timer);
  };

  const dismissSuggestion = (suggestionId: string): void => {
    const card = cardStates.find((candidate) => candidate.suggestion.id === suggestionId);
    if (card !== undefined && card.applied === null) {
      sessionDismissedKeysRef.current.add(card.suggestion.patternKey);
      if (documentId !== null) {
        persistDismissedPatternKey({ documentId, patternKey: card.suggestion.patternKey });
      }
    }
    removeCard(suggestionId);
  };

  const revertApplied = (suggestionId: string): void => {
    const card = cardStates.find((candidate) => candidate.suggestion.id === suggestionId);
    if (card === undefined || card.applied === null) {
      return;
    }
    void useEditorStore
      .getState()
      .revertAgentBatch(card.applied.batchId)
      .then((result) => {
        if (result.isOk) {
          removeCard(suggestionId);
          return;
        }
        setCardStates((current) =>
          current.map((candidate) =>
            candidate.suggestion.id === suggestionId && candidate.applied !== null
              ? {
                  ...candidate,
                  applied: { ...candidate.applied, revertErrorMessage: result.message },
                }
              : candidate,
          ),
        );
      });
  };

  return {
    cards: cardStates.map((card) => ({
      suggestion: card.suggestion,
      appliedState:
        card.applied !== null ? { revertErrorMessage: card.applied.revertErrorMessage } : null,
    })),
    applySuggestion,
    dismissSuggestion,
    revertApplied,
  };
}
