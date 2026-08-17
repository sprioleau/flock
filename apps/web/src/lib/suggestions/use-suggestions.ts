"use client";

import { useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  applyOperations,
  updateBlockPropertiesOperationSchema,
  type EmailDocument,
} from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAppSettings } from "@/components/studio/demo/app-settings";
import { useEditorStore } from "@/lib/editor-store";
import { useIsTourRunning } from "@/lib/tour/tour-progress";
import { persistDismissedPatternKey, readDismissedPatternKeys } from "./dismissals";
import { serializeBlock } from "./serialize-block";
import {
  evaluateSuggestionRules,
  isSuggestiblePropertyEdit,
  MAX_RECENT_USER_OPS,
  RECENT_EDIT_WINDOW_MS,
} from "./rules";
import type { RecentPropertyEdit, Suggestion, SuggestionRungId } from "./types";

/**
 * The op-log watcher hook (Phase 7.3 v1) — the whole suggestion lifecycle:
 *
 * WATCH — a reactive Convex watch on `documents.getOperations` over the
 * recent tail of the op log (the same query the history panel pages). The
 * store's gesture coalescing means one log entry per SETTLED user gesture,
 * which is exactly the "quiet moment" trigger. Only a user-authored
 * `updateBlockProperties` edit is a qualifying gesture — agent ops (including
 * our own suggestion applies), undo/redo entries, and structural edits never
 * generate.
 *
 * GENERATE — run the deterministic rule registry over the recent user edits
 * against the CURRENT rendered doc, then dry-run every rung's ops with the
 * SDK's pure `applyOperations` (never surface a suggestion whose ops would
 * fail). One suggestion at a time; a newer qualifying gesture replaces it.
 *
 * INVALIDATE — snapshot every target block at generation time; any change to
 * one of them (user, agent, or another tab — the rendered doc includes the
 * instant local overlay, so invalidation is immediate, not ack-delayed)
 * hides the card without applying anything. Regeneration then happens lazily
 * on the next qualifying gesture.
 *
 * THE "Suggest related edits" SETTING (app-settings.ts) gates GENERATION AND
 * DISPLAY ONLY — never the op log. That log is the shared history spine
 * (undo/redo, the history panel, revert, replay); a suggestions preference
 * has no business switching it off, and this hook only ever READS it. So
 * turning the setting back on re-runs the rules over the operations already
 * recorded and surfaces a suggestion immediately, instead of making the user
 * perform a fresh edit to coax the feature back. Turning it off clears any
 * live card rather than stranding one the user can no longer act on.
 *
 * APPLY — dispatch the chosen rung's ops through the store's normal dispatch
 * with agent provenance: author "agent", caller "frontend", batchId
 * `suggestion:<ruleId>:<uuid>`, authorId `suggestions:<sessionId>`. The
 * distinct authorId keeps these ops out of the user's per-author Cmd+Z stack
 * (matching how chat-agent ops use the chat id); revert rides the SAME
 * `history.revertBatch` path as chat-turn revert chips. Because suggestion
 * applies happen outside any chat turn there is no assistant message to hang
 * the transcript's revert chip off — so the card itself renders the
 * "Applied — Revert" affordance, wired to the identical mutation.
 */

type OperationsPage = FunctionReturnType<typeof api.documents.getOperations>;
type OperationEntry = OperationsPage["operations"][number];

/** Op-log tail to subscribe to (must comfortably cover MAX_RECENT_USER_OPS). */
const OPS_TAIL_LIMIT = 30;

/** How long the "Applied — Revert" state lingers before the card clears. */
const APPLIED_STATE_TTL_MS = 8_000;

type SuggestionPhase =
  | { name: "hidden" }
  | {
      name: "visible";
      suggestion: Suggestion;
      /** JSON of each target block at generation time (staleness baseline). */
      targetSnapshots: Record<string, string | undefined>;
    }
  | {
      name: "applied";
      suggestion: Suggestion;
      batchId: string;
      rungLabel: string;
      revertErrorMessage: string | null;
    };

// Staleness serialization moved to serialize-block.ts (shared with the
// /api/personas route, which persists snapshots in personaFindings — the two
// sides must produce byte-identical output). Re-exported for compatibility.
export { serializeBlock, stableStringify } from "./serialize-block";

// Dev-only trace of the watcher's evaluation steps, so in-browser verification
// (agents, debugging) can see WHY a suggestion did or didn't surface.
declare global {
  interface Window {
    __flockSuggestionsDebug?: unknown[];
  }
}
function traceEvaluation(event: Record<string, unknown>): void {
  if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
    (window.__flockSuggestionsDebug ??= []).push({ atMs: Date.now(), ...event });
  }
}

/** Extract suggestible user property edits from the op-log tail (oldest → newest). */
function collectRecentPropertyEdits({
  entries,
  doc,
  nowMs,
}: {
  entries: OperationEntry[];
  doc: EmailDocument;
  nowMs: number;
}): RecentPropertyEdit[] {
  const userEditEntries = entries.filter(
    (entry) => entry.author === "user" && entry.kind === "edit" && entry.isUndone !== true,
  );
  const windowedEntries = userEditEntries
    .slice(-MAX_RECENT_USER_OPS)
    .filter((entry) => nowMs - entry.createdAtMs <= RECENT_EDIT_WINDOW_MS);

  const edits: RecentPropertyEdit[] = [];
  for (const entry of windowedEntries) {
    const parsed = updateBlockPropertiesOperationSchema.safeParse(entry.op);
    if (!parsed.success) {
      continue;
    }
    const block = doc[parsed.data.blockId];
    if (block === undefined) {
      continue; // target since deleted — not a live pattern signal
    }
    for (const [propertyKey, value] of Object.entries(parsed.data.properties)) {
      if (isSuggestiblePropertyEdit({ propertyKey, value })) {
        edits.push({
          blockId: parsed.data.blockId,
          blockType: block.type,
          propertyKey,
          value,
          version: entry.version,
          createdAtMs: entry.createdAtMs,
        });
      }
    }
  }
  return edits;
}

/** Drop rungs whose ops fail a dry-run; null unless a non-gated rung survives. */
function dropInvalidRungs({
  doc,
  suggestion,
}: {
  doc: EmailDocument;
  suggestion: Suggestion;
}): Suggestion | null {
  const validRungs = suggestion.rungs.filter((rung) => applyOperations(doc, rung.ops).isOk);
  const hasDirectRung = validRungs.some((rung) => rung.id !== "retheme");
  return hasDirectRung ? { ...suggestion, rungs: validRungs } : null;
}

export interface SuggestionsController {
  /** The one visible suggestion, or null. */
  visibleSuggestion: Suggestion | null;
  /** The brief post-apply state (revert affordance), or null. */
  appliedState: { rungLabel: string; revertErrorMessage: string | null } | null;
  applyRung: (rungId: SuggestionRungId) => void;
  dismiss: () => void;
  revertApplied: () => void;
}

export function useSuggestions(): SuggestionsController {
  const convexClient = useConvex();
  const documentId = useEditorStore((state) => state.documentId);
  const serverHeadVersion = useEditorStore((state) => state.serverHeadVersion);
  const { isSuggestionsEnabled: isSuggestionsSettingEnabled } = useAppSettings();
  /*
    THE ONBOARDING TOUR SUPPRESSES SUGGESTIONS WHILE IT IS ON SCREEN.

    Both features are unprompted popups anchored to a specific element, so left
    alone they compete for the same corner of the canvas — and a first-time
    visitor being told "this icon is your brand kit" is exactly the person least
    equipped to work out which of two cards is talking to them. The tour is
    finite and the user is mid-sentence in it; suggestions are ambient and will
    still be there afterwards.

    Folding it into `isSuggestionsEnabled` rather than adding a second gate is
    what makes this cheap: every behaviour the setting already has is now the
    tour's too. Starting the tour clears any live card instead of stranding one
    behind it, and finishing the tour re-runs the rules over the operations
    already recorded — so a suggestion the user earned while the tour was up
    appears the moment it closes, rather than needing a fresh edit to coax back.
    It never touches the op log; that stays the shared history spine either way.
  */
  const isTourRunning = useIsTourRunning();
  const isSuggestionsEnabled = isSuggestionsSettingEnabled && !isTourRunning;

  const [phase, setPhase] = useState<SuggestionPhase>({ name: "hidden" });
  // In-memory dismissals for this session (union'd with localStorage, which
  // is also written — so dismissal works even where persistence doesn't).
  const sessionDismissedKeysRef = useRef<Set<string>>(new Set());
  // Generation high-water mark, reset whenever the bound document changes.
  const evaluationRef = useRef<{ documentId: string | null; lastEvaluatedVersion: number }>({
    documentId: null,
    lastEvaluatedVersion: 0,
  });
  const appliedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Document switch: hide any carried-over card (render-time state adjustment).
  const [boundDocumentId, setBoundDocumentId] = useState<Id<"documents"> | null>(documentId);
  if (boundDocumentId !== documentId) {
    setBoundDocumentId(documentId);
    setPhase({ name: "hidden" });
  }

  // Setting switched OFF: clear the live card rather than strand one the user
  // can no longer act on (same render-time adjustment as the document switch
  // above). The switched-ON half is handled in the watch effect below, where
  // rewinding the generation mark is legal.
  const [wasSuggestionsEnabled, setWasSuggestionsEnabled] = useState(isSuggestionsEnabled);
  if (wasSuggestionsEnabled !== isSuggestionsEnabled) {
    setWasSuggestionsEnabled(isSuggestionsEnabled);
    if (!isSuggestionsEnabled) {
      setPhase({ name: "hidden" });
    }
  }
  // Mirrors the setting, but written only from the effect below — the render
  // pass must not touch refs.
  const wasGenerationEnabledRef = useRef(isSuggestionsEnabled);

  const clearAppliedTimer = (): void => {
    if (appliedClearTimerRef.current !== null) {
      clearTimeout(appliedClearTimerRef.current);
      appliedClearTimerRef.current = null;
    }
  };
  const scheduleAppliedClear = (): void => {
    clearAppliedTimer();
    appliedClearTimerRef.current = setTimeout(() => {
      appliedClearTimerRef.current = null;
      setPhase((current) => (current.name === "applied" ? { name: "hidden" } : current));
    }, APPLIED_STATE_TTL_MS);
  };
  useEffect(() => clearAppliedTimer, []);

  // GENERATION: watch the op-log tail; evaluate once per newly settled gesture.
  // The sinceVersion anchor tracks the server head so the window stays bounded
  // (the watch is re-established as the head advances — cheap indexed query).
  useEffect(() => {
    traceEvaluation({ step: "watch-effect", documentId, serverHeadVersion });
    // Switched back ON: rewind the generation high-water mark so the op-log
    // tail this hook has ALREADY seen is re-evaluated. That is what returns
    // suggestions built from edits made while the setting was off, instead of
    // making the user perform a fresh edit to coax the feature back.
    if (isSuggestionsEnabled && !wasGenerationEnabledRef.current) {
      traceEvaluation({ step: "suggestions-re-enabled" });
      evaluationRef.current.lastEvaluatedVersion = 0;
    }
    wasGenerationEnabledRef.current = isSuggestionsEnabled;
    if (documentId === null) {
      return;
    }

    const isPatternDismissed = (patternKey: string): boolean =>
      sessionDismissedKeysRef.current.has(patternKey) ||
      readDismissedPatternKeys(documentId).has(patternKey);

    const evaluatePage = (page: OperationsPage): void => {
      traceEvaluation({ step: "page", isDone: page.isDone, count: page.operations.length });
      // Visibility gate. Deliberately BEFORE the high-water mark advances, so
      // versions that stream past while the setting is off are not marked as
      // evaluated and stay eligible when it comes back on.
      if (!isSuggestionsEnabled) {
        traceEvaluation({ step: "skip-suggestions-disabled" });
        return;
      }
      if (!page.isDone) {
        return; // the tail outran this window; the next anchor catches up
      }
      if (evaluationRef.current.documentId !== documentId) {
        evaluationRef.current = { documentId, lastEvaluatedVersion: 0 };
      }
      const entries = page.operations;
      const newest = entries[entries.length - 1];
      if (newest === undefined || newest.version <= evaluationRef.current.lastEvaluatedVersion) {
        traceEvaluation({
          step: "skip-already-evaluated",
          newestVersion: newest?.version,
          lastEvaluatedVersion: evaluationRef.current.lastEvaluatedVersion,
        });
        return;
      }
      evaluationRef.current.lastEvaluatedVersion = newest.version;

      // Only a settled USER edit is a qualifying gesture — agent-authored ops
      // (including our own suggestion applies) and undo/redo never generate.
      if (newest.author !== "user" || newest.kind !== "edit") {
        traceEvaluation({ step: "skip-not-user-edit", author: newest.author, kind: newest.kind });
        return;
      }

      const currentDoc = useEditorStore.getState().doc;
      const recentEdits = collectRecentPropertyEdits({
        entries,
        doc: currentDoc,
        nowMs: Date.now(),
      });
      const anchorEdit = recentEdits[recentEdits.length - 1];
      // The triggering op itself must have produced a suggestible edit — a
      // label/text/content change never resurfaces an older pattern.
      if (anchorEdit === undefined || anchorEdit.version !== newest.version) {
        traceEvaluation({
          step: "skip-no-anchor",
          recentEditCount: recentEdits.length,
          anchorVersion: anchorEdit?.version,
          newestVersion: newest.version,
        });
        return;
      }

      const suggestion = evaluateSuggestionRules({
        doc: currentDoc,
        recentEdits,
        anchorEdit,
        isPatternDismissed,
      });
      if (suggestion === null) {
        traceEvaluation({ step: "no-rule-matched", anchorEdit });
        return; // leave any existing (still-fresh) suggestion in place
      }
      const validatedSuggestion = dropInvalidRungs({ doc: currentDoc, suggestion });
      if (validatedSuggestion === null) {
        traceEvaluation({ step: "dry-run-dropped-all-rungs", ruleId: suggestion.ruleId });
        return;
      }
      traceEvaluation({ step: "suggestion-visible", ruleId: suggestion.ruleId });
      clearAppliedTimer();
      setPhase({
        name: "visible",
        suggestion: validatedSuggestion,
        targetSnapshots: Object.fromEntries(
          validatedSuggestion.targetBlockIds.map((blockId) => [
            blockId,
            serializeBlock(currentDoc[blockId]),
          ]),
        ),
      });
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
    // A result may already be cached for these args (deferred so the initial
    // evaluation never sets state synchronously inside the effect body).
    let isDisposed = false;
    queueMicrotask(() => {
      if (!isDisposed) {
        runFromLocalResult();
      }
    });
    return () => {
      isDisposed = true;
      unsubscribe();
    };
    // isSuggestionsEnabled is a dependency so switching it ON re-establishes
    // the watch and re-runs the cached page through evaluatePage — the
    // immediate-return path described in the header.
  }, [convexClient, documentId, serverHeadVersion, isSuggestionsEnabled]);

  // STALENESS: subscribe to the rendered doc (local overlay included); the
  // moment any target block changes or disappears, the suggestion invalidates.
  useEffect(() => {
    if (phase.name !== "visible") {
      return;
    }
    const checkStaleness = (doc: EmailDocument): void => {
      const staleBlockId = phase.suggestion.targetBlockIds.find(
        (blockId) => serializeBlock(doc[blockId]) !== phase.targetSnapshots[blockId],
      );
      if (staleBlockId !== undefined) {
        traceEvaluation({
          step: "stale",
          staleBlockId,
          suggestionId: phase.suggestion.id,
          was: phase.targetSnapshots[staleBlockId],
          now: serializeBlock(doc[staleBlockId]),
        });
        // Hide only THIS suggestion: a store change can both stale the old
        // card and generate its replacement (e.g. the second recolor of the
        // canonical demo), and this check — subscribed for the OLD phase —
        // may run after the new suggestion was set. It must not clobber it.
        setPhase((current) =>
          current.name === "visible" && current.suggestion.id === phase.suggestion.id
            ? { name: "hidden" }
            : current,
        );
      }
    };
    const unsubscribe = useEditorStore.subscribe((state) => checkStaleness(state.doc));
    // The doc may have moved between generation and this subscription.
    let isDisposed = false;
    queueMicrotask(() => {
      if (!isDisposed) {
        checkStaleness(useEditorStore.getState().doc);
      }
    });
    return () => {
      isDisposed = true;
      unsubscribe();
    };
  }, [phase]);

  const applyRung = (rungId: SuggestionRungId): void => {
    if (phase.name !== "visible") {
      return;
    }
    const rung = phase.suggestion.rungs.find((candidate) => candidate.id === rungId);
    if (rung === undefined) {
      return;
    }
    const store = useEditorStore.getState();
    // Belt-and-braces dry-run against the LIVE doc right before dispatch (the
    // staleness watcher makes a failure here effectively impossible).
    if (!applyOperations(store.doc, rung.ops).isOk) {
      setPhase({ name: "hidden" });
      return;
    }
    const batchId = `suggestion:${phase.suggestion.ruleId}:${crypto.randomUUID()}`;
    const suggestionAuthorId = `suggestions:${store.authorId ?? "local"}`;
    for (const op of rung.ops) {
      const result = store.dispatch(op, {
        caller: "frontend",
        author: "agent",
        authorId: suggestionAuthorId,
        batchId,
      });
      if (!result.isOk) {
        // Unreachable after the dry-run; any partial batch remains revertable
        // from the history panel under this batchId.
        setPhase({ name: "hidden" });
        return;
      }
    }
    setPhase({
      name: "applied",
      suggestion: phase.suggestion,
      batchId,
      rungLabel: rung.label,
      revertErrorMessage: null,
    });
    scheduleAppliedClear();
  };

  const dismiss = (): void => {
    if (phase.name === "visible") {
      const { patternKey } = phase.suggestion;
      sessionDismissedKeysRef.current.add(patternKey);
      if (documentId !== null) {
        persistDismissedPatternKey({ documentId, patternKey });
      }
    }
    clearAppliedTimer();
    setPhase({ name: "hidden" });
  };

  const revertApplied = (): void => {
    if (phase.name !== "applied") {
      return;
    }
    clearAppliedTimer();
    void useEditorStore
      .getState()
      .revertAgentBatch(phase.batchId)
      .then((result) => {
        if (result.isOk) {
          setPhase({ name: "hidden" });
          return;
        }
        setPhase((current) =>
          current.name === "applied"
            ? { ...current, revertErrorMessage: result.message }
            : current,
        );
        scheduleAppliedClear();
      });
  };

  return {
    // The `isSuggestionsEnabled` term is belt-and-braces: the render-time
    // adjustment above already hides the card, but this guarantees no card
    // (and so no ⌥A hint) can survive a single render with the setting off.
    // appliedState is deliberately NOT gated — it is the revert affordance
    // for a change the user already made, and hiding it would strand that.
    visibleSuggestion: isSuggestionsEnabled && phase.name === "visible" ? phase.suggestion : null,
    appliedState:
      phase.name === "applied"
        ? { rungLabel: phase.rungLabel, revertErrorMessage: phase.revertErrorMessage }
        : null,
    applyRung,
    dismiss,
    revertApplied,
  };
}
