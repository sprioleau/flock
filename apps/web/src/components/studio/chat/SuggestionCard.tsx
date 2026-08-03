"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  MessageSquarePlusIcon,
  SparklesIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import type { PersonaAdvisorsController, PersonaCard } from "@/lib/personas/use-persona-advisors";
import type { SuggestionsController } from "@/lib/suggestions/use-suggestions";
import type { Suggestion, SuggestionRungId } from "@/lib/suggestions/types";
import {
  formatSuggestionShortcutHint,
  resolveSuggestionShortcut,
} from "@/lib/suggestions/shortcuts";
import { getIsEditableEventTarget } from "../shortcuts/keyboard-guards";
import { getIsApplePlatform } from "../shortcuts/shortcut-keys";
import { cn } from "@/lib/utils";
import { handOffPromptToComposer } from "./composer-handoff";

/**
 * The Phase 7.3 suggestion surface: one slim, dismissible card directly above
 * the composer. Deliberately quiet — muted colors, small type, no motion, and
 * it renders nothing at all when no suggestion is live (passive v1: it
 * appears after a settled user gesture and never interrupts).
 *
 * - Rung buttons apply that scope's pre-validated ops instantly.
 * - The confirm-gated rung (whole-email re-theme) swaps the card body to an
 *   inline confirm before anything is dispatched.
 * - ⌥A (Alt+A) applies the DEFAULT (non-gated) rung and Esc dismisses, so a
 *   suggestion never costs a trip to the mouse. ⌥A deliberately fires inside
 *   text fields too — the composer owns Enter, and the property fields whose
 *   edits generate these suggestions are exactly where focus tends to be.
 *   The binding lives on the body below rather than with the controllers in
 *   ChatPanel: it reads the card-local confirm state it must not bypass, and
 *   it should exist only while a suggestion is actually on screen.
 *   shortcuts.ts holds the decision table and the full rationale.
 * - After Apply the card shows a brief "Applied — Revert" state wired to the
 *   same history.revertBatch path as chat-turn revert chips (suggestions
 *   apply outside a chat turn, so the affordance lives here — see
 *   use-suggestions.ts), then clears on its own.
 *
 * Multi-agent canvas v0: persona ADVISORY findings (source:"analysis") render
 * here too — up to 3 quiet cards, each chipped with its persona's name and
 * color, stacked above the rule card. A finding with pre-validated ops gets
 * one-click Apply (same instant dispatch + revert path, `persona:<slug>`
 * provenance); a finding without ops is informational — dismiss, plus, when
 * the runner authored a suggestedPrompt, an "Ask in chat" handoff that
 * inserts that prompt into the composer (focused, editable, never auto-sent)
 * so the user partners with the main chat agent on the fix.
 *
 * Both controllers are OWNED by ChatPanel (which always mounts, collapsed or
 * not) and passed down: ChatPanel also needs the pending-recommendation count
 * for the collapsed rail's notification badge, and the hooks must mount
 * exactly once (usePersonaAdvisors hosts the presence heartbeat + runner).
 *
 * "Dismiss all" (shown from 2 pending cards up) routes every card through
 * the SAME per-card dismiss paths — persona rows get their Convex status
 * update (cross-tab convergence), the rule card its local/localStorage
 * dismissal.
 */
export interface SuggestionCardProps {
  /** Keeps the card's controls out of the tab order while the panel is collapsed. */
  isPanelExpanded: boolean;
  /** The rule-suggestion controller (owned by ChatPanel — see above). */
  suggestions: SuggestionsController;
  /** The persona-findings controller (owned by ChatPanel — see above). */
  personaAdvisors: PersonaAdvisorsController;
}

const quietButtonClassName = cn(
  "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
  "text-muted-foreground hover:bg-muted hover:text-foreground",
);

/**
 * Collapsed/expanded tray preference — a tiny module-level store exposed via
 * useSyncExternalStore (the app-settings.ts pattern): SSR/first paint see the
 * expanded default, the stored value applies right after mount, no hydration
 * mismatch, no setState-in-effect.
 */
const TRAY_COLLAPSED_STORAGE_KEY = "flock_suggestions_tray_collapsed";
let cachedIsTrayCollapsed = false;
let hasReadTrayStorage = false;
const trayListeners = new Set<() => void>();

function getTrayCollapsedSnapshot(): boolean {
  if (!hasReadTrayStorage) {
    try {
      cachedIsTrayCollapsed = window.localStorage.getItem(TRAY_COLLAPSED_STORAGE_KEY) === "1";
    } catch {
      cachedIsTrayCollapsed = false;
    }
    hasReadTrayStorage = true;
  }
  return cachedIsTrayCollapsed;
}

function subscribeTrayCollapsed(listener: () => void): () => void {
  trayListeners.add(listener);
  return () => {
    trayListeners.delete(listener);
  };
}

function setIsTrayCollapsed(isCollapsed: boolean): void {
  cachedIsTrayCollapsed = isCollapsed;
  hasReadTrayStorage = true;
  try {
    if (isCollapsed) {
      window.localStorage.setItem(TRAY_COLLAPSED_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(TRAY_COLLAPSED_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable — session-only preference.
  }
  for (const listener of trayListeners) {
    listener();
  }
}

export function SuggestionCard({ isPanelExpanded, suggestions, personaAdvisors }: SuggestionCardProps) {
  const { visibleSuggestion, appliedState, applyRung, dismiss, revertApplied } = suggestions;

  const isTrayCollapsed = useSyncExternalStore(
    subscribeTrayCollapsed,
    getTrayCollapsedSnapshot,
    () => false,
  );
  const toggleTrayCollapsed = (): void => {
    setIsTrayCollapsed(!isTrayCollapsed);
  };

  if (visibleSuggestion === null && appliedState === null && personaAdvisors.cards.length === 0) {
    return null;
  }
  const tabIndex = isPanelExpanded ? 0 : -1;

  // Every card a single click could dismiss right now (applied cards are in
  // their transient revert state — not dismissible, not counted).
  const dismissiblePersonaCards = personaAdvisors.cards.filter((card) => card.appliedState === null);
  const dismissibleCount = dismissiblePersonaCards.length + (visibleSuggestion !== null ? 1 : 0);
  const visibleCardCount =
    personaAdvisors.cards.length + (visibleSuggestion !== null || appliedState !== null ? 1 : 0);

  const dismissAll = (): void => {
    for (const card of dismissiblePersonaCards) {
      personaAdvisors.dismissSuggestion(card.suggestion.id);
    }
    if (visibleSuggestion !== null) {
      dismiss();
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t px-3 py-2" data-testid="suggestion-card">
      {/* Tray header — always present: the count (live while collapsed) and
          the collapse/expand toggle; Dismiss all only in the expanded state
          (from 2 dismissible cards up). */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          tabIndex={tabIndex}
          onClick={toggleTrayCollapsed}
          aria-expanded={!isTrayCollapsed}
          className={cn(
            "flex cursor-pointer items-center gap-1 text-[10px] font-medium tracking-wide",
            "text-muted-foreground uppercase hover:text-foreground",
          )}
          data-testid="suggestions-tray-toggle"
        >
          <ChevronDownIcon
            className={cn("size-3 transition-transform", isTrayCollapsed && "-rotate-90")}
          />
          Suggestions · {visibleCardCount}
        </button>
        {!isTrayCollapsed && dismissibleCount >= 2 && (
          <button
            type="button"
            tabIndex={tabIndex}
            onClick={dismissAll}
            className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
            data-testid="suggestions-dismiss-all"
          >
            Dismiss all
          </button>
        )}
      </div>
      {/* The tray body: height-capped with internal scrolling so open cards
          never crowd out the conversation (the chat stays the dominant
          surface); collapsed = just the header row above "Editing:". */}
      {!isTrayCollapsed && (
      <div
        className="flex max-h-40 flex-col gap-2 overflow-y-auto"
        data-testid="suggestions-tray"
      >
      {personaAdvisors.cards.map((card) => (
        <PersonaFindingCard
          key={card.suggestion.id}
          card={card}
          tabIndex={tabIndex}
          onApply={() => personaAdvisors.applySuggestion(card.suggestion.id)}
          onDismiss={() => personaAdvisors.dismissSuggestion(card.suggestion.id)}
          onRevert={() => personaAdvisors.revertApplied(card.suggestion.id)}
        />
      ))}
      {(visibleSuggestion !== null || appliedState !== null) && (
      <div className="rounded-lg border bg-muted/30 px-2.5 py-2">
        {appliedState !== null ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <p
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                data-testid="suggestion-applied"
              >
                Applied — {appliedState.rungLabel}
              </p>
              <button
                type="button"
                tabIndex={tabIndex}
                onClick={revertApplied}
                className={quietButtonClassName}
                data-testid="suggestion-revert"
              >
                <Undo2Icon className="size-3" />
                Revert
              </button>
            </div>
            {appliedState.revertErrorMessage !== null && (
              <p className="text-[11px] text-destructive">{appliedState.revertErrorMessage}</p>
            )}
          </div>
        ) : visibleSuggestion !== null ? (
          // Keyed by suggestion id so the inline confirm state resets whenever
          // a fresh suggestion replaces the current one.
          <SuggestionBody
            key={visibleSuggestion.id}
            suggestion={visibleSuggestion}
            tabIndex={tabIndex}
            isPanelExpanded={isPanelExpanded}
            applyRung={applyRung}
            dismiss={dismiss}
          />
        ) : null}
      </div>
      )}
      </div>
      )}
    </div>
  );
}

/**
 * One persona finding: identity chip (persona color dot + name), title,
 * description, target hints, and either Apply+Dismiss (ops pre-validated by
 * the runner + re-dry-run at click time) or Dismiss only (informational).
 */
function PersonaFindingCard({
  card,
  tabIndex,
  onApply,
  onDismiss,
  onRevert,
}: {
  card: PersonaCard;
  tabIndex: number;
  onApply: () => void;
  onDismiss: () => void;
  onRevert: () => void;
}) {
  const { suggestion, appliedState } = card;
  return (
    <div
      className="rounded-lg border bg-muted/30 px-2.5 py-2"
      data-testid="persona-finding-card"
      data-persona-slug={suggestion.personaSlug}
    >
      {appliedState !== null ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <p
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              data-testid="persona-finding-applied"
            >
              Applied — {suggestion.personaName}&apos;s suggestion
            </p>
            <button
              type="button"
              tabIndex={tabIndex}
              onClick={onRevert}
              className={quietButtonClassName}
              data-testid="persona-finding-revert"
            >
              <Undo2Icon className="size-3" />
              Revert
            </button>
          </div>
          {appliedState.revertErrorMessage !== null && (
            <p className="text-[11px] text-destructive">{appliedState.revertErrorMessage}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <PersonaChip name={suggestion.personaName} color={suggestion.personaColor} />
            <button
              type="button"
              aria-label={`Dismiss ${suggestion.personaName} suggestion`}
              tabIndex={tabIndex}
              onClick={onDismiss}
              className="ml-auto cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
              data-testid="persona-finding-dismiss"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
          <p className="text-xs font-medium" data-testid="persona-finding-title">
            {suggestion.title}
          </p>
          <p className="text-[11px] text-muted-foreground" data-testid="persona-finding-description">
            {suggestion.description}
          </p>
          {suggestion.ops.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                type="button"
                tabIndex={tabIndex}
                onClick={onApply}
                className={quietButtonClassName}
                data-testid="persona-finding-apply"
              >
                <CheckIcon className="size-3" />
                Apply
              </button>
            </div>
          ) : suggestion.suggestedPrompt !== undefined ? (
            // Op-less finding with a runner-authored handoff prompt: insert
            // it into the composer for the user to review and send (or edit).
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                type="button"
                tabIndex={tabIndex}
                onClick={() => handOffPromptToComposer(suggestion.suggestedPrompt!)}
                className={quietButtonClassName}
                data-testid="persona-finding-ask-in-chat"
              >
                <MessageSquarePlusIcon className="size-3" />
                Ask in chat
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The persona identity chip: color dot + name, quiet by design. */
function PersonaChip({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
      style={{ borderColor: color, color }}
      data-testid="persona-finding-chip"
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {name}
    </span>
  );
}

function SuggestionBody({
  suggestion,
  tabIndex,
  isPanelExpanded,
  applyRung,
  dismiss,
}: {
  suggestion: Suggestion;
  tabIndex: number;
  /** Gates the shortcut: while collapsed the card is rendered but unreachable. */
  isPanelExpanded: boolean;
  applyRung: (rungId: SuggestionRungId) => void;
  dismiss: () => void;
}) {
  const [confirmingRungId, setConfirmingRungId] = useState<SuggestionRungId | null>(null);
  const confirmingRung =
    confirmingRungId !== null
      ? suggestion.rungs.find((rung) => rung.id === confirmingRungId)
      : undefined;

  // ⌘↵ applies / Esc dismisses. This component mounts ONLY while a suggestion
  // is live and the tray is open, so "no suggestion, no shortcut" is
  // structural; shortcuts.ts re-checks it anyway and owns every other rule
  // (gate, typing contexts, modifiers). The listener re-binds when any input
  // to that decision changes — a keystroke must never read a stale rung
  // ladder or a stale confirm state.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const action = resolveSuggestionShortcut({
        event: {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          isDefaultPrevented: event.defaultPrevented,
          isTypingContext: getIsEditableEventTarget(event.target),
        },
        suggestion,
        confirmingRungId,
        isCardInteractive: isPanelExpanded,
      });
      if (action.name === "ignore") {
        return;
      }
      event.preventDefault();
      if (action.name === "apply") {
        applyRung(action.rungId);
        return;
      }
      if (action.name === "dismiss") {
        dismiss();
        return;
      }
      setConfirmingRungId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [suggestion, confirmingRungId, isPanelExpanded, applyRung, dismiss]);

  // Platform notation for the hint. Safe to read at render time: the card
  // only ever appears after a client-side op-log evaluation, so it cannot
  // render during SSR/hydration.
  const shortcutHint = formatSuggestionShortcutHint({
    isApplePlatform: getIsApplePlatform(),
    isConfirming: confirmingRung !== undefined,
  });

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-xs font-medium" data-testid="suggestion-title">
          {suggestion.title}
        </p>
        <button
          type="button"
          aria-label="Dismiss suggestion"
          tabIndex={tabIndex}
          onClick={dismiss}
          className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
          data-testid="suggestion-dismiss"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {confirmingRung !== undefined ? (
        <>
          <p className="pl-5.5 text-[11px] text-muted-foreground">
            {confirmingRung.confirmDescription}
          </p>
          <div className="flex flex-wrap gap-1.5 pl-5.5 pt-1">
            <button
              type="button"
              tabIndex={tabIndex}
              onClick={() => applyRung(confirmingRung.id)}
              className={cn(
                "inline-flex cursor-pointer items-center rounded-md bg-primary px-2 py-1",
                "text-[11px] text-primary-foreground hover:bg-primary/90",
              )}
              data-testid="suggestion-confirm-apply"
            >
              Re-theme the email
            </button>
            <button
              type="button"
              tabIndex={tabIndex}
              onClick={() => setConfirmingRungId(null)}
              className={quietButtonClassName}
              data-testid="suggestion-confirm-cancel"
            >
              Cancel
            </button>
          </div>
          <ShortcutHint text={shortcutHint} />
        </>
      ) : (
        <>
          <p className="pl-5.5 text-[11px] text-muted-foreground" data-testid="suggestion-description">
            {suggestion.description}
          </p>
          <div className="flex flex-wrap gap-1.5 pl-5.5 pt-1">
            {suggestion.rungs.map((rung) => (
              <button
                key={rung.id}
                type="button"
                tabIndex={tabIndex}
                onClick={() =>
                  rung.needsConfirm === true ? setConfirmingRungId(rung.id) : applyRung(rung.id)
                }
                className={quietButtonClassName}
                data-testid={`suggestion-rung-${rung.id}`}
              >
                {rung.label}
              </button>
            ))}
          </div>
          <ShortcutHint text={shortcutHint} />
        </>
      )}
    </div>
  );
}

/**
 * The keyboard hint under the card's actions — the quietest thing on a
 * deliberately quiet card: smallest type, muted, no motion. `aria-hidden`
 * because it describes a shortcut, not content: every action it names is
 * already reachable as a real, labeled button in the tab order, and screen
 * reader users would otherwise hear the same offer twice.
 */
function ShortcutHint({ text }: { text: string }) {
  return (
    <p
      className="pt-0.5 pl-5.5 text-[10px] text-muted-foreground"
      data-testid="suggestion-shortcut-hint"
      aria-hidden
    >
      {text}
    </p>
  );
}
